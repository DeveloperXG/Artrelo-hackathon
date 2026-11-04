// DELETE /properties/:id and /units/:id re-check on the server and never trust
// the dialog: a stale tab or a raw DELETE must hit the same wall.
//
//   - blocked -> 409 deletion_blocked with the blockers, and NOTHING is written
//   - clear with history -> archived; clear without -> deleted
//   - not yours (or already archived) -> 404
// The rules themselves are covered in services/deletionGuard.service.test.js;
// this pins the translation to HTTP.

const assert = require("assert");
const guard = require("../../../services/portfolio/deletionGuard.service");

let nextCheck = null;
let retired = [];
guard.checkDeletion = async () => nextCheck;
guard.retireTarget = async (check) => {
  retired.push(check);
  return { action: check.hasHistory ? "archived" : "deleted" };
};

const ctrl = require("../../../controllers/landlord.controller");

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}
const req = (id = "u1") => ({ user: { id: "landlord-1" }, params: { id }, query: {}, body: {} });

const makeCheck = ({ tenants = [], openRequests = 0, hasHistory = false, archivedAt = null } = {}) => ({
  target: {
    kind: "unit",
    label: "Unit 101",
    property: { _id: "p1", name: "Maple" },
    unit: { _id: "u1", unitNumber: "101", archivedAt },
    units: [],
  },
  blockers: { tenants, openRequests },
  hasHistory,
  blocked: tenants.length > 0 || openRequests > 0,
});

async function main() {
  // Tenants attached: 409, blockers returned, nothing retired.
  retired = [];
  nextCheck = makeCheck({ tenants: [{ _id: "t1", name: "Ada Lee", unitLabel: "Unit 101", moveOut: null }] });
  let res = makeRes();
  await ctrl.deleteUnit(req(), res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "deletion_blocked");
  assert.strictEqual(res.body.data.blockers.tenants.length, 1);
  assert.match(res.body.message, /move out/);
  assert.strictEqual(retired.length, 0, "a blocked delete must touch nothing");

  // Open requests only.
  nextCheck = makeCheck({ openRequests: 2 });
  res = makeRes();
  await ctrl.deleteUnit(req(), res);
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.message, /open requests/);
  assert.strictEqual(retired.length, 0);

  // Clear with history: archived.
  nextCheck = makeCheck({ hasHistory: true });
  res = makeRes();
  await ctrl.deleteUnit(req(), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.action, "archived");

  // Clear, no history: deleted.
  nextCheck = makeCheck();
  res = makeRes();
  await ctrl.deleteUnit(req(), res);
  assert.strictEqual(res.body.data.action, "deleted");

  // Not yours, or already archived: 404.
  nextCheck = null;
  res = makeRes();
  await ctrl.deleteUnit(req(), res);
  assert.strictEqual(res.statusCode, 404);
  nextCheck = makeCheck({ archivedAt: new Date() });
  res = makeRes();
  await ctrl.deleteUnit(req(), res);
  assert.strictEqual(res.statusCode, 404, "an archived unit cannot be deleted again");

  // The check endpoint says what confirming will do.
  nextCheck = makeCheck({ hasHistory: true });
  res = makeRes();
  await ctrl.unitDeletionCheck(req(), res);
  assert.strictEqual(res.body.data.action, "archive");
  assert.strictEqual(res.body.data.blocked, false);
  assert.ok(!("target" in res.body.data), "no raw documents in the response");

  console.log("landlordDeletion.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
