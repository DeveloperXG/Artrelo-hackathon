// Take a full backup of the database.
//
//   node scripts/backup_db.js                     # into backups/
//   node scripts/backup_db.js --out D:/artrelo-backups
//   node scripts/backup_db.js --dry-run           # counts only, writes nothing
//   node scripts/backup_db.js --keep 14           # prune older backups
//
// Against production, from backend/:
//
//   railway run node scripts/backup_db.js --out <somewhere-off-this-machine>
//
// WHY THIS EXISTS. The production cluster is an Atlas Free tier, and Atlas does
// not back those up at all — its own documentation says so and points at
// mongodump:
//
//   "Atlas backups are not available for Free clusters (formerly known as M0).
//    You may use mongodump to back up your Free cluster data and mongorestore
//    to restore that data."
//   https://www.mongodb.com/docs/atlas/backup-restore-cluster/
//
// So until the cluster is moved to Flex or M10+ (which have daily snapshots and
// is the real fix -- see deploy/BACKUPS.md), this script IS the backup. As of
// the landlord-invite work the database holds real accounts, so "no backups"
// stopped being an acceptable position.
//
// WHY NOT mongodump. It is not installed here, it is not in the Railway image,
// and it is a separate versioned binary to keep in step with the server. This
// uses the driver the app already depends on, so it runs anywhere the app runs
// -- including inside `railway run`.
//
// FORMAT: one canonical Extended JSON document per line, gzipped, one file per
// collection, plus a manifest holding the index definitions. Canonical EJSON
// rather than plain JSON because plain JSON silently destroys the type
// information that makes the data work: every ObjectId becomes a string, every
// Date becomes a string, and a restore would produce a database that looks right
// and matches nothing. Line-delimited so a huge collection streams instead of
// being held in memory, and so a corrupt tail costs one document rather than the
// file.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const mongoose = require("mongoose");
const { EJSON } = require("bson");

const env = require("../config/env");

const DEFAULT_OUT = path.resolve(__dirname, "..", "backups");
const MANIFEST = "manifest.json";

/** `--out x --keep 7` and `--dry-run`. */
function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) continue;
    args[arg.slice(2)] = value;
    i += 1;
  }
  return args;
}

// Sortable, filename-safe, and unambiguous about its timezone: 2026-09-28T044512Z.
const stamp = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "");

/**
 * Remove all but the newest `keep` backups for this database.
 *
 * Only ever touches directories this script's own naming produced, so pointing
 * --out at a folder holding anything else cannot delete it.
 */
async function pruneOld({ outDir, dbName, keep }) {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const prefix = `${dbName}-`;
  let entries;
  try {
    entries = await fsp.readdir(outDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const mine = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    // The timestamp is lexicographically sortable, so name order is time order.
    .map((e) => e.name)
    .sort();

  const doomed = mine.slice(0, Math.max(0, mine.length - keep));
  for (const name of doomed) {
    // Belt and braces: it must look like ours AND contain our manifest.
    const dir = path.join(outDir, name);
    if (!fs.existsSync(path.join(dir, MANIFEST))) continue;
    await fsp.rm(dir, { recursive: true, force: true });
  }
  return doomed;
}

async function backupDatabase({ out = DEFAULT_OUT, dryRun = false, keep } = {}) {
  if (!env.mongodb_uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(env.mongodb_uri);
  const db = mongoose.connection.db;
  const dbName = db.databaseName;
  console.log(`Connected to database: ${dbName}`);

  try {
    // Read the live list rather than the models, so a collection no model knows
    // about is still backed up. A backup that quietly omits data is worse than
    // no backup, because it is trusted.
    const collections = (await db.listCollections({ type: "collection" }).toArray())
      .map((c) => c.name)
      .filter((name) => !name.startsWith("system."))
      .sort();

    const dir = path.join(out, `${dbName}-${stamp()}`);
    const manifest = {
      database: dbName,
      startedAt: new Date().toISOString(),
      format: "ndjson-canonical-ejson-gzip",
      tool: "scripts/backup_db.js",
      collections: [],
    };

    let totalDocs = 0;
    if (!dryRun) await fsp.mkdir(dir, { recursive: true });

    for (const name of collections) {
      const coll = db.collection(name);
      const count = await coll.estimatedDocumentCount();

      // Captured so a restore rebuilds them. Without this a restored database
      // has no unique indexes -- which for this schema means duplicate emails
      // and duplicate accountIds become possible, silently.
      const indexes = (await coll.indexes()).filter((ix) => ix.name !== "_id_");

      if (dryRun) {
        console.log(`  ${name}: ~${count} document(s), ${indexes.length} index(es)`);
        manifest.collections.push({ name, count, indexes });
        totalDocs += count;
        continue;
      }

      const file = path.join(dir, `${name}.jsonl.gz`);
      let written = 0;
      const cursor = coll.find({}, { noCursorTimeout: false });

      // A generator feeding gzip, so memory stays flat no matter how large the
      // collection gets.
      const lines = Readable.from(
        (async function* () {
          for await (const doc of cursor) {
            written += 1;
            // relaxed:false is the whole point: it keeps $oid/$date/$numberLong
            // instead of collapsing them to strings and numbers.
            yield `${EJSON.stringify(doc, { relaxed: false })}\n`;
          }
        })()
      );

      await pipeline(lines, zlib.createGzip({ level: 9 }), fs.createWriteStream(file));

      const { size } = await fsp.stat(file);
      console.log(`  ${name}: ${written} document(s) -> ${path.basename(file)} (${(size / 1024).toFixed(1)} KiB)`);
      manifest.collections.push({ name, count: written, indexes, file: path.basename(file), bytes: size });
      totalDocs += written;
    }

    manifest.finishedAt = new Date().toISOString();
    manifest.totalDocuments = totalDocs;

    if (dryRun) {
      console.log(`\n--dry-run: nothing written. ${collections.length} collection(s), ~${totalDocs} document(s).`);
      return { dryRun: true, manifest };
    }

    // Written LAST, on purpose. Its presence is what marks a backup complete,
    // so a run killed halfway leaves a directory that restore_db.js refuses
    // rather than one it half-trusts.
    await fsp.writeFile(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const pruned = keep ? await pruneOld({ outDir: out, dbName, keep: Number(keep) }) : [];

    console.log(`\nBacked up ${totalDocs} document(s) from ${collections.length} collection(s)`);
    console.log(`  -> ${dir}`);
    if (pruned.length) console.log(`  pruned ${pruned.length} older backup(s): ${pruned.join(", ")}`);
    console.log("\nRestore with:  node scripts/restore_db.js --from <dir>   (see deploy/BACKUPS.md)");

    return { dir, manifest, pruned };
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  backupDatabase({ out: args.out ? path.resolve(args.out) : DEFAULT_OUT, dryRun: args.dryRun, keep: args.keep }).catch(
    (err) => {
      console.error(`\n[backup_db] ${err.message}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { backupDatabase, parseArgs, pruneOld, stamp, DEFAULT_OUT, MANIFEST };
