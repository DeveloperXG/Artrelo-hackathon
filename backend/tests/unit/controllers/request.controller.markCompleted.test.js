// putMarkRequestCompleted: the landlord's manual "Mark complete" must settle the
// job, not just relabel the request.
//
// The settlement itself (pay vs void, keys, guards) is pinned against the real
// ledger in manualCompletion.service.test.js. This file pins the WIRING: what
// the controller hands the service, that a settlement failure cannot 500 a
// completion the landlord has already recorded, and that a confirmed
// completion still goes through closeJobCompletion rather than this path.
//
// Services are stubbed BEFORE the controller is required — it destructures
// them at load time, the same idiom as request.controller.decideApproval.test.js.

const assert = require("assert");

const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const JobCompletion = require("../../../models/JobCompletion");
const AgentActionLog = require("../../../models/AgentActionLog");

let requestRow = null;
let openCompletion = null;
let completionUpdates = [];
let settleCalls = [];
let settleResult = null;
let settleError = null;
let closeCalls = [];
let closeResult = null;
let notifications = [];
let actionLogs = [];

MaintenanceRequest.findOne = async () => requestRow;
JobCompletion.findOne = async () => openCompletion;
JobCompletion.updateOne = async (filter, update) => {
  completionUpdates.push({ filter, update });
  return { matchedCount: 1, modifiedCount: 1 };
};
AgentActionLog.create = async (doc) => {
  actionLogs.push(doc);
  return doc;
};

require("../../../services/completion/manualCompletion.service").settleManualCompletion = async (args) => {
  settleCalls.push({ ...args, statusAtCall: args.request.status, savesAtCall: args.request.saves });
  if (settleError) throw settleError;
  return settleResult;
};
require("../../../services/completion/jobCompletion.service").closeJobCompletion = async (args) => {
  closeCalls.push(args);
  return closeResult;
};
require("../../../services/notification/notify.service").notifyUser = async (args) => {
  notifications.push(args);
};
require("../../../services/vendor/jobToken.service").revokeJobToken = async () => ({});

const ctrl = require("../../../controllers/request.controller");

const makeRes = () => ({
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
});

const makeReq = (body = {}) => ({ params: { id: "req-1" }, body, user: { id: "landlord-1" } });

function reset() {
  requestRow = {
    _id: { toString: () => "req-1" },
    landlordId: "landlord-1",
    tenantId: "tenant-1",
    issueTitle: "Leaking tap",
    status: "in_progress",
    estimatedCost: 400,
    appointmentStatus: "scheduled",
    timeline: [],
    saves: 0,
    save: async function save() {
      this.saves += 1;
      return this;
    },
  };
  openCompletion = null;
  completionUpdates = [];
  settleCalls = [];
  settleResult = { workedAppointmentId: "appt-1", outcomes: [{ appointmentId: "appt-1", action: "paid" }], shortfall: false };
  settleError = null;
  closeCalls = [];
  closeResult = null;
  notifications = [];
  actionLogs = [];
}

async function main() {
  /* ---- 1) With a cost: settled at that cost, appointment mirrored. ------ */
  reset();
  let res = makeRes();
  await ctrl.putMarkRequestCompleted(makeReq({ finalCost: "312.50" }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(settleCalls.length, 1, "the manual path must settle the job");
  assert.strictEqual(settleCalls[0].finalCost, 312.5, "the validated number, not the raw string");
  assert.strictEqual(settleCalls[0].request, requestRow);
  assert.strictEqual(settleCalls[0].statusAtCall, "completed");
  assert.strictEqual(settleCalls[0].savesAtCall, 1, "the request is saved before settlement runs");
  assert.strictEqual(requestRow.appointmentStatus, "completed", "mirrors the appointment it settled");
  assert.deepStrictEqual(actionLogs[0].output.settlement, settleResult.outcomes, "the audit trail says what money did");

  /* ---- 2) Without a cost: null goes through, which the service voids. --- */
  reset();
  await ctrl.putMarkRequestCompleted(makeReq({}), makeRes());
  assert.strictEqual(settleCalls[0].finalCost, null);

  /* ---- 3) No appointment: the request's appointmentStatus is left alone.  */
  reset();
  settleResult = { workedAppointmentId: null, outcomes: [], shortfall: false };
  await ctrl.putMarkRequestCompleted(makeReq({ finalCost: 50 }), makeRes());
  assert.strictEqual(requestRow.appointmentStatus, "scheduled");

  /* ---- 4) A shortfall is told to the landlord, as closeJobCompletion does. */
  reset();
  settleResult = { ...settleResult, shortfall: true };
  await ctrl.putMarkRequestCompleted(makeReq({ finalCost: 900 }), makeRes());
  const bill = notifications.find((n) => n.type === "payment_overdue");
  assert.ok(bill, "the landlord learns the payout went to arrears");
  assert.strictEqual(bill.userId, "landlord-1");

  /* ---- 5) A settlement failure cannot 500 a completion already recorded.  */
  reset();
  settleError = new Error("mongo blip");
  const originalError = console.error;
  console.error = () => {};
  res = makeRes();
  try {
    await ctrl.putMarkRequestCompleted(makeReq({ finalCost: 312 }), res);
  } finally {
    console.error = originalError;
  }
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(requestRow.status, "completed");

  /* ---- 6) A confirmed completion is delegated — closeJobCompletion settles
   *         it, and this path must not settle it a second time. ---------- */
  reset();
  openCompletion = { _id: "comp-1", appointmentId: "appt-1", status: "confirmed" };
  closeResult = { closed: true, request: requestRow };
  await ctrl.putMarkRequestCompleted(makeReq({}), makeRes());
  assert.strictEqual(closeCalls.length, 1);
  assert.strictEqual(settleCalls.length, 0, "one close path per job");

  /* ---- 7) ...but if it declines (overage pending), the override voids the
   *         completion and THEN settles, so the hold does not strand. ------ */
  reset();
  openCompletion = { _id: "comp-1", appointmentId: "appt-1", status: "confirmed" };
  closeResult = { closed: false, reason: "overage_pending" };
  await ctrl.putMarkRequestCompleted(makeReq({}), makeRes());
  assert.strictEqual(completionUpdates[0].update.$set.status, "void");
  assert.strictEqual(settleCalls.length, 1);

  /* ---- 8) A cancelled or rejected request is refused before anything is
   *         touched. ------------------------------------------------------ */
  for (const status of ["cancelled", "rejected"]) {
    reset();
    requestRow.status = status;
    openCompletion = { _id: "comp-1", appointmentId: "appt-1", status: "confirmed" };
    res = makeRes();
    await ctrl.putMarkRequestCompleted(makeReq({ finalCost: 312 }), res);
    assert.strictEqual(res.statusCode, 400, `${status}: refused`);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.message, `Cannot complete a ${status} request`);
    assert.strictEqual(requestRow.status, status, `${status}: a job that was called off stays called off`);
    assert.strictEqual(requestRow.saves, 0);
    assert.strictEqual(settleCalls.length, 0, `${status}: no money moves`);
    assert.strictEqual(closeCalls.length, 0);
    assert.strictEqual(completionUpdates.length, 0);
    assert.strictEqual(actionLogs.length, 0);
    assert.strictEqual(notifications.length, 0, `${status}: the tenant is not told it was completed`);
  }

  /* ---- 9) A bad cost is refused before anything is touched. ------------- */
  reset();
  res = makeRes();
  await ctrl.putMarkRequestCompleted(makeReq({ finalCost: "-5" }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(settleCalls.length, 0);

  console.log("request.controller.markCompleted.test.js: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
