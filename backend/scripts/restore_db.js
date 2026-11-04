// Restore a backup taken by scripts/backup_db.js.
//
//   node scripts/restore_db.js --from backups/ronarai-2026-09-28T044512Z --dry-run
//   ALLOW_DB_RESTORE=true node scripts/restore_db.js --from <dir> --into artrelo-restore-check
//   ALLOW_DB_RESTORE=true node scripts/restore_db.js --from <dir> --drop
//
// THIS EXISTS BECAUSE A BACKUP NOBODY HAS RESTORED IS NOT A BACKUP. It is a
// directory of files that are believed to be a backup. The believing is the
// problem: the failure modes -- a format that loses ObjectIds, indexes that were
// never captured, a truncated run -- all produce files that look completely
// fine. So this ships alongside the backup script, and deploy/BACKUPS.md asks
// you to run it into a throwaway database periodically.
//
// GUARDS, because this writes over data:
//
//   * ALLOW_DB_RESTORE=true is required for any write, following the pattern in
//     reset_request_data.js. A restore is the most destructive thing in this
//     repo and must not be one typo away;
//   * --into names a DIFFERENT database, which is how you rehearse without
//     touching anything real. Strongly preferred;
//   * restoring into a database that already has documents needs --drop, which
//     says out loud that you mean to replace them;
//   * a backup directory with no manifest is refused. The manifest is written
//     last, so its absence means the backup never finished.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");

const mongoose = require("mongoose");
const { EJSON } = require("bson");

const env = require("../config/env");
const { MANIFEST } = require("./backup_db");

const BATCH = 500;

function parseArgs(argv) {
  const args = { dryRun: false, drop: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--drop") {
      args.drop = true;
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

/** Swap the database in a mongodb+srv URI, so --into can target another one. */
function withDatabase(uri, dbName) {
  if (!dbName) return uri;
  // The path segment between the host and the query string is the database.
  const [beforeQuery, query] = String(uri).split("?");
  const trimmed = beforeQuery.replace(/\/[^/]*$/, "");
  return `${trimmed}/${dbName}${query ? `?${query}` : ""}`;
}

async function readManifest(dir) {
  const file = path.join(dir, MANIFEST);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No ${MANIFEST} in ${dir}. The manifest is written last, so this backup did not finish — do not trust it.`
    );
  }
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

/** Stream one gzipped ndjson file back in, in batches. */
async function restoreCollection({ db, dir, entry, dryRun }) {
  const file = path.join(dir, entry.file || `${entry.name}.jsonl.gz`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${path.basename(file)} for collection ${entry.name}`);

  const coll = db.collection(entry.name);
  let inserted = 0;
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    if (!dryRun) {
      // ordered:false so one bad document does not abandon the rest; the count
      // comparison at the end is what catches a shortfall.
      await coll.insertMany(batch, { ordered: false });
    }
    inserted += batch.length;
    batch = [];
  };

  const lines = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (!line.trim()) continue;
    // EJSON.parse restores ObjectId, Date, Decimal128 and friends as the real
    // BSON types. JSON.parse here would insert strings that look identical in a
    // console and match nothing in a query.
    batch.push(EJSON.parse(line, { relaxed: false }));
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  // Rebuilt from the manifest. Skipping this is the quiet failure: the data is
  // all there, and nothing stops a duplicate email or a second landlord profile
  // on one account.
  let indexes = 0;
  if (!dryRun && entry.indexes?.length) {
    for (const ix of entry.indexes) {
      const { key, name, v, ns, background, ...options } = ix;
      try {
        await coll.createIndex(key, { name, ...options });
        indexes += 1;
      } catch (err) {
        console.error(`  ! index ${name} on ${entry.name}: ${err.message}`);
      }
    }
  }

  return { inserted, indexes };
}

async function restoreDatabase({ from, into, drop = false, dryRun = false } = {}) {
  if (!from) throw new Error("--from <backup directory> is required");
  const dir = path.resolve(from);
  const manifest = await readManifest(dir);

  if (!dryRun && process.env.ALLOW_DB_RESTORE !== "true") {
    throw new Error("Set ALLOW_DB_RESTORE=true to permit a restore. Run with --dry-run first.");
  }
  if (!env.mongodb_uri) throw new Error("MONGODB_URI is not set");

  const uri = withDatabase(env.mongodb_uri, into);
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`Backup:   ${dir}`);
  console.log(`  taken from "${manifest.database}" at ${manifest.finishedAt}`);
  console.log(`  ${manifest.collections.length} collection(s), ${manifest.totalDocuments} document(s)`);
  console.log(`Restoring into database: ${db.databaseName}${into ? "  (--into)" : ""}`);

  if (into && into === manifest.database) {
    console.log("  note: --into names the SAME database the backup came from");
  }

  try {
    const existing = (await db.listCollections({ type: "collection" }).toArray())
      .map((c) => c.name)
      .filter((n) => !n.startsWith("system."));

    let occupied = [];
    for (const name of existing) {
      if ((await db.collection(name).estimatedDocumentCount()) > 0) occupied.push(name);
    }

    if (occupied.length && !drop && !dryRun) {
      throw new Error(
        `${db.databaseName} already holds documents in: ${occupied.join(", ")}.\n` +
          "Pass --drop to replace them, or --into <other-db> to restore somewhere harmless."
      );
    }

    if (dryRun) {
      console.log(`\n--dry-run: nothing written.`);
      if (occupied.length) console.log(`  target is NOT empty: ${occupied.join(", ")} (a real run would need --drop)`);
      for (const entry of manifest.collections) {
        const file = path.join(dir, entry.file || `${entry.name}.jsonl.gz`);
        const ok = fs.existsSync(file);
        console.log(`  ${ok ? "ok  " : "MISSING"} ${entry.name}: ${entry.count} document(s), ${entry.indexes?.length || 0} index(es)`);
      }
      return { dryRun: true, manifest };
    }

    if (drop && occupied.length) {
      for (const name of occupied) await db.collection(name).drop().catch(() => {});
      console.log(`  dropped ${occupied.length} existing collection(s)`);
    }

    const results = [];
    let mismatch = false;
    for (const entry of manifest.collections) {
      const { inserted, indexes } = await restoreCollection({ db, dir, entry, dryRun });
      const actual = await db.collection(entry.name).countDocuments();
      const ok = actual === entry.count;
      if (!ok) mismatch = true;
      console.log(
        `  ${ok ? "ok  " : "FAIL"} ${entry.name}: ${inserted} read, ${actual} in place (expected ${entry.count}), ${indexes} index(es)`
      );
      results.push({ name: entry.name, expected: entry.count, actual, indexes });
    }

    if (mismatch) throw new Error("Restored document counts do not match the manifest. Investigate before trusting this.");

    console.log(`\nRestored ${results.reduce((n, r) => n + r.actual, 0)} document(s) into ${db.databaseName}`);
    return { manifest, results };
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  restoreDatabase({ from: args.from, into: args.into, drop: args.drop, dryRun: args.dryRun }).catch((err) => {
    console.error(`\n[restore_db] ${err.message}`);
    console.error(
      "\nUsage: node scripts/restore_db.js --from <dir> [--into <db>] [--drop] [--dry-run]\n" +
        "       ALLOW_DB_RESTORE=true is required for a real run."
    );
    process.exitCode = 1;
  });
}

module.exports = { restoreDatabase, restoreCollection, parseArgs, withDatabase, readManifest };
