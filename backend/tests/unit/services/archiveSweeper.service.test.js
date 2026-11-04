// Archiving finished requests.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * only completed and cancelled requests archive, and only once they have
//     been finished for the full window (7 days by default);
//   * a request is archived once -- the sweep never re-stamps archivedAt;
//   * a request finished before cancelledAt existed still archives, by the
//     date it was last written;
//   * archiving is an update, never a delete.

const assert = require("assert");
const { archiveDueFilter, archiveFinishedRequests } = require("../../../services/request/archiveSweeper.service");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-08T12:00:00.000Z");

// Evaluate the filter against a plain object -- just the operators it uses.
function matches(filter, doc) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return cond.some((branch) => matches(branch, doc));
    const value = doc[key];
    if (cond === null) return value === null || value === undefined;
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$exists" in cond && (value !== undefined) !== cond.$exists) return false;
      if ("$lte" in cond && !(value instanceof Date && value <= cond.$lte)) return false;
      return true;
    }
    return value === cond;
  });
}

function main() {
  const filter = archiveDueFilter(NOW, 7);
  const ago = (days) => new Date(NOW.getTime() - days * DAY);

  /* -------------- 1) The window boundary -------------------------------- */
  assert.ok(matches(filter, { status: "completed", completedAt: ago(7), archivedAt: null }), "exactly 7 days archives");
  assert.ok(!matches(filter, { status: "completed", completedAt: ago(6.99), archivedAt: null }), "6d23h does not");
  assert.ok(matches(filter, { status: "cancelled", cancelledAt: ago(10), archivedAt: null }));
  assert.ok(!matches(filter, { status: "cancelled", cancelledAt: ago(1), archivedAt: null }));

  /* -------------- 2) Only finished requests ----------------------------- */
  for (const status of ["queued", "approved", "assigned", "in_progress", "rejected", "pending"]) {
    assert.ok(
      !matches(filter, { status, completedAt: ago(30), cancelledAt: ago(30), updatedAt: ago(30), archivedAt: null }),
      `${status} must never archive`
    );
  }

  /* -------------- 3) Archived once ------------------------------------- */
  assert.ok(
    !matches(filter, { status: "completed", completedAt: ago(30), archivedAt: ago(20) }),
    "an archived request is not re-stamped"
  );
  assert.ok(
    matches(filter, { status: "completed", completedAt: ago(30) }),
    "a request from before archivedAt existed (field missing) counts as unarchived"
  );

  /* -------------- 4) Legacy cancelled without cancelledAt -------------- */
  assert.ok(matches(filter, { status: "cancelled", updatedAt: ago(8), archivedAt: null }));
  assert.ok(!matches(filter, { status: "cancelled", updatedAt: ago(2), archivedAt: null }));

  /* -------------- 5) The window is configurable ------------------------ */
  assert.ok(matches(archiveDueFilter(NOW, 0), { status: "completed", completedAt: NOW, archivedAt: null }));
}

async function sweeps() {
  const calls = [];
  const model = {
    updateMany: async (filter, update) => {
      calls.push({ filter, update });
      return { modifiedCount: 3 };
    },
    deleteMany: async () => {
      throw new Error("archiving must never delete");
    },
  };
  const count = await archiveFinishedRequests({ now: NOW, days: 7, model });
  assert.strictEqual(count, 3);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].update, { $set: { archivedAt: NOW } }, "only archivedAt is written");
  assert.strictEqual(calls[0].filter.archivedAt, null, "the update is guarded on not-yet-archived");
}

try {
  main();
  sweeps()
    .then(() => console.log("archiveSweeper.service tests passed"))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} catch (err) {
  console.error(err);
  process.exit(1);
}
