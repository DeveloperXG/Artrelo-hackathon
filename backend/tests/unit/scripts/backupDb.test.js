// The backup and restore scripts' pure parts.
//
// THE RULE THIS FILE EXISTS TO PROTECT: pruneOld DELETES DIRECTORIES. It is the
// only code in this repo that removes things from a filesystem, and it runs with
// a path the operator passed on the command line. So it must never touch
// anything it did not create, and it must never prune below the requested
// retention.
//
// The round-trip itself (dump, restore, compare) needs a live database and is
// exercised by hand -- see deploy/BACKUPS.md, which asks you to restore into a
// throwaway database periodically, because a backup nobody has restored is not a
// backup.

const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { parseArgs, pruneOld, stamp, MANIFEST } = require("../../../scripts/backup_db");
const { withDatabase, parseArgs: parseRestoreArgs, readManifest } = require("../../../scripts/restore_db");

async function main() {
  /* -------------- 1) Argument parsing --------------------------------- */

  assert.deepStrictEqual(parseArgs(["--out", "D:/b", "--keep", "7", "--dry-run"]), {
    dryRun: true,
    out: "D:/b",
    keep: "7",
  });
  assert.deepStrictEqual(parseArgs([]), { dryRun: false });
  // A flag whose value is missing must not swallow the next flag.
  assert.deepStrictEqual(parseArgs(["--out", "--dry-run"]), { dryRun: true });

  assert.deepStrictEqual(parseRestoreArgs(["--from", "x", "--into", "y", "--drop"]), {
    dryRun: false,
    drop: true,
    from: "x",
    into: "y",
  });

  /* -------------- 2) The timestamp sorts chronologically -------------- */
  //
  // pruneOld relies on this: it sorts directory NAMES and treats that as time
  // order. If the format ever stopped being lexicographically sortable, pruning
  // would delete the wrong backups.

  const early = stamp(new Date("2026-01-02T03:04:05.678Z"));
  const later = stamp(new Date("2026-11-30T23:59:59.999Z"));
  assert.ok(early < later, `${early} must sort before ${later}`);
  assert.ok(!/[:.]/.test(early), `no characters that are illegal in a filename: ${early}`);
  assert.match(early, /^2026-01-02T030405Z$/);

  /* -------------- 3) --into rewrites the database, keeping options ---- */
  //
  // The query string carries retryWrites, appName and the auth source. Losing it
  // would silently change connection behaviour on a restore.

  assert.strictEqual(
    withDatabase("mongodb+srv://u:p@c.mongodb.net/ronarai?retryWrites=true&w=majority", "restore-check"),
    "mongodb+srv://u:p@c.mongodb.net/restore-check?retryWrites=true&w=majority"
  );
  assert.strictEqual(
    withDatabase("mongodb+srv://u:p@c.mongodb.net/?retryWrites=true", "target"),
    "mongodb+srv://u:p@c.mongodb.net/target?retryWrites=true"
  );
  assert.strictEqual(
    withDatabase("mongodb://127.0.0.1:27017/dev", "other"),
    "mongodb://127.0.0.1:27017/other"
  );
  // No name means leave the URI exactly as it is.
  const untouched = "mongodb+srv://u:p@c.mongodb.net/ronarai?retryWrites=true";
  assert.strictEqual(withDatabase(untouched, undefined), untouched);
  assert.strictEqual(withDatabase(untouched, ""), untouched);

  /* -------------- 4) An unfinished backup is refused ------------------ */
  //
  // The manifest is written LAST, so its absence means the run died partway. A
  // restore from that would look like a success and be missing data.

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "artrelo-backup-test-"));
  try {
    const halfDone = path.join(tmp, "ronarai-2026-01-01T000000Z");
    await fsp.mkdir(halfDone, { recursive: true });
    await fsp.writeFile(path.join(halfDone, "accounts.jsonl.gz"), "not-really-gzip");
    await assert.rejects(() => readManifest(halfDone), /did not finish/, "a backup with no manifest is not trusted");

    /* -------------- 5) pruneOld keeps the newest N ------------------- */

    const make = async (name, withManifest = true) => {
      const dir = path.join(tmp, name);
      await fsp.mkdir(dir, { recursive: true });
      if (withManifest) await fsp.writeFile(path.join(dir, MANIFEST), "{}");
      return dir;
    };

    await fsp.rm(halfDone, { recursive: true, force: true });
    for (const n of ["01", "02", "03", "04", "05"]) await make(`ronarai-2026-01-${n}T000000Z`);

    let pruned = await pruneOld({ outDir: tmp, dbName: "ronarai", keep: 2 });
    assert.strictEqual(pruned.length, 3, "three oldest removed");
    let left = (await fsp.readdir(tmp)).sort();
    assert.deepStrictEqual(left, ["ronarai-2026-01-04T000000Z", "ronarai-2026-01-05T000000Z"], "the NEWEST two survive");

    /* -------------- 6) It never touches what it did not make --------- */
    //
    // The dangerous case: --out pointed at a folder that holds other things.
    // Only directories matching this database's naming AND carrying our manifest
    // may be removed.

    await fsp.mkdir(path.join(tmp, "my-holiday-photos"), { recursive: true });
    await fsp.writeFile(path.join(tmp, "important.txt"), "do not delete");
    await make("artrelo-prod-2026-01-01T000000Z"); // a DIFFERENT database
    await make("ronarai-2026-01-06T000000Z", false); // ours by name, but no manifest
    await make("ronarai-2026-01-07T000000Z");

    pruned = await pruneOld({ outDir: tmp, dbName: "ronarai", keep: 1 });
    left = (await fsp.readdir(tmp)).sort();

    assert.ok(left.includes("my-holiday-photos"), "an unrelated directory is untouched");
    assert.ok(left.includes("important.txt"), "an unrelated file is untouched");
    assert.ok(left.includes("artrelo-prod-2026-01-01T000000Z"), "another database's backups are untouched");
    assert.ok(
      left.includes("ronarai-2026-01-06T000000Z"),
      "a directory without our manifest is left alone — it is not provably ours"
    );
    assert.ok(left.includes("ronarai-2026-01-07T000000Z"), "and the newest is kept");

    /* -------------- 7) keep=0 or nonsense prunes NOTHING ------------- */
    //
    // Fail safe. A mistyped --keep must never mean "delete everything".

    const before = (await fsp.readdir(tmp)).sort();
    for (const keep of [0, -1, NaN, undefined, "abc"]) {
      const none = await pruneOld({ outDir: tmp, dbName: "ronarai", keep });
      assert.deepStrictEqual(none, [], `keep=${JSON.stringify(keep)} must prune nothing`);
    }
    assert.deepStrictEqual((await fsp.readdir(tmp)).sort(), before, "nothing was removed");

    /* -------------- 8) A missing directory is not an error ----------- */

    assert.deepStrictEqual(
      await pruneOld({ outDir: path.join(tmp, "does-not-exist"), dbName: "ronarai", keep: 3 }),
      [],
      "a first-ever run has nothing to prune and must not throw"
    );
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  assert.ok(!fs.existsSync(path.join(os.tmpdir(), "artrelo-backup-test-never")), "sanity");

  console.log("backupDb tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
