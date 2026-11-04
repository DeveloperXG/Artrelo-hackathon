// Moving on from a vendor whose email couldn't be delivered.
//
// Found in production: three failed sends left a request with no action at
// all -- Resend refused (attempts exhausted), and Regenerate and manual
// assignment stayed locked behind a vendor still "being contacted". The
// sweeper never closes a delivery_failed row. Pins:
//   1. dismiss-response accepts a delivery_failed outreach, retires its link
//      and hands the round to advanceOutreach as "delivery_failed"
//   2. it still refuses anything that isn't accepted or delivery_failed
//   3. an accepted response still goes through the old dismiss path

const assert = require("assert");

const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const VendorOutreach = require("../../../models/VendorOutreach");
const AgentActionLog = require("../../../models/AgentActionLog");

const advanced = [];
// Stubbed before the controller loads: it destructures this on require.
require("../../../services/vendor/vendorOutreachSweeper.service").advanceOutreach = async (args) => {
  advanced.push(args);
  return { awaitingApproval: true };
};

let outreachRow = null;
const updates = [];
const audit = [];

const chain = (value) => ({ select: async () => value, then: (resolve) => resolve(value) });
MaintenanceRequest.findOne = () => chain({ _id: "req-1", landlordId: "landlord-1", status: "approved" });
MaintenanceRequest.findById = () => chain({ vendorRecommendationSnapshot: { lastRound: { reason: "delivery_failed" } } });
VendorOutreach.findOne = async () => outreachRow;
VendorOutreach.findById = async () => outreachRow;
VendorOutreach.updateOne = async (filter, update) => {
  updates.push(update);
  if (update.$set) Object.assign(outreachRow, update.$set);
  return {};
};
AgentActionLog.create = async (row) => {
  audit.push(row);
  return row;
};
// The accepted-quote path claims the response atomically (vendorQuoteDismissal).
VendorOutreach.findOneAndUpdate = async (filter, update) => {
  if (outreachRow?.status !== "accepted") return null;
  Object.assign(outreachRow, { status: "declined" });
  updates.push(update);
  return outreachRow;
};
require("../../../models/ApprovalRequest").updateMany = async () => ({ modifiedCount: 0 });

const ctrl = require("../../../controllers/request.controller");

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
const req = () => ({ params: { id: "req-1", outreachId: "out-1" }, body: {}, user: { id: "landlord-1" } });

const run = async () => {
  /* 1) delivery_failed -> next vendor ===== */
  outreachRow = {
    _id: "out-1",
    status: "delivery_failed",
    attempt: 3,
    candidateKey: "preset__v1",
    vendorNameSnapshot: "Plumbing Helpers",
    deliveryError: "Vendor email is switched off on the server, so nothing was sent.",
  };
  let res = makeRes();
  await ctrl.dismissVendorResponse(req(), res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(advanced.length, 1);
  assert.strictEqual(advanced[0].reason, "delivery_failed");
  assert.strictEqual(advanced[0].outreach, outreachRow);
  assert.deepStrictEqual(updates[0], { $unset: { tokenHash: 1 } }, "the dead link is retired");
  assert.strictEqual(audit[0].actionType, "vendor_outreach_skipped");

  /* 2) other states are still refused ===== */
  outreachRow = { ...outreachRow, status: "sent" };
  res = makeRes();
  await ctrl.dismissVendorResponse(req(), res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "outreach_not_dismissable");
  assert.strictEqual(advanced.length, 1);

  /* 3) an accepted quote is dismissed through vendorQuoteDismissal ===== */
  outreachRow = { ...outreachRow, status: "accepted", appointmentId: null };
  res = makeRes();
  await ctrl.dismissVendorResponse(req(), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(advanced[1].reason, "manager_dismissed");

  /* 4) a completed request's quotes can't be dismissed ===== */
  MaintenanceRequest.findOne = () => chain({ _id: "req-1", landlordId: "landlord-1", status: "completed" });
  outreachRow = { ...outreachRow, status: "accepted", appointmentId: null };
  const before = advanced.length;
  res = makeRes();
  await ctrl.dismissVendorResponse(req(), res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "request_closed");
  assert.strictEqual(advanced.length, before, "nothing advanced, nobody emailed");

  console.log("skip failed delivery tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
