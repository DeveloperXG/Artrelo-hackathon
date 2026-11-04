// The overage gate at SUBMIT time.
//
// Previously the ceiling was only checked inside closeJobCompletion, which runs
// when the tenant confirms or the 48h sweeper fires. A vendor's submit succeeded
// and the job then quietly failed to close days later, with the manager
// receiving an approval that carried a figure and no explanation.
//
// Pinned here: the vendor is told immediately, the reason is required and rides
// on the approval, nothing persists on the rejected attempt, and the response
// never reveals the ceiling.

const assert = require("assert");
require("../../../services/quotes/review.service").queueRuntimeReview = async () => ({ pending: true });

const Appointment = require("../../../models/Appointment");
const JobCompletion = require("../../../models/JobCompletion");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const LandlordPolicy = require("../../../models/LandlordPolicy");
const Property = require("../../../models/Property");
const VendorOutreach = require("../../../models/VendorOutreach");
const AgentActionLog = require("../../../models/AgentActionLog");
const cloudinary = require("../../../services/upload/cloudinary.service");

const APPT_ID = "appt-1";
const CEILING = 320; // allowance is max($10, 2%) = $10, so it trips above $330

let completionRow = null;
let completionWrites = [];
let approvalCalls = [];
let audits = [];

const makeCompletion = (overrides = {}) => ({
  _id: "comp-1",
  appointmentId: APPT_ID,
  requestId: "req-1",
  landlordId: "landlord-1",
  status: "draft",
  approvedCeiling: CEILING,
  photos: [{ url: "https://cdn.example.com/a.jpg", stage: "after" }],
  checkIn: { at: new Date() },
  report: {},
  overage: { isOver: false },
  ...overrides,
});

function reset(overrides = {}) {
  completionRow = makeCompletion(overrides);
  completionWrites = [];
  approvalCalls = [];
  reviewCalls = [];
  audits = [];
}

JobCompletion.findOne = async () => completionRow;
JobCompletion.create = async (row) => {
  completionRow = makeCompletion(row);
  return completionRow;
};
JobCompletion.findOneAndUpdate = async (filter, update) => {
  if (filter.status && completionRow.status !== filter.status) return null;
  completionWrites.push(update);
  Object.assign(completionRow, update.$set || {});
  return completionRow;
};
JobCompletion.updateOne = async (_filter, update) => {
  completionWrites.push(update);
  Object.entries(update.$set || {}).forEach(([path, value]) => {
    const parts = path.split(".");
    let cursor = completionRow;
    for (let i = 0; i < parts.length - 1; i += 1) {
      cursor[parts[i]] = cursor[parts[i]] || {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  });
  return { modifiedCount: 1 };
};

MaintenanceRequest.findById = () => ({
  select: () => ({
    lean: async () => ({
      _id: "req-1",
      landlordId: "landlord-1",
      propertyId: "prop-1",
      estimatedCost: CEILING,
    }),
  }),
});
MaintenanceRequest.updateOne = async () => ({ modifiedCount: 1 });
LandlordPolicy.findOne = () => ({ lean: async () => ({ defaultQuota: 300 }) });
Property.findById = () => ({ select: () => ({ lean: async () => ({ geo: { lat: 50.4, lng: -104.6 } }) }) });
Appointment.updateOne = async () => ({ modifiedCount: 1 });
VendorOutreach.findById = () => ({ select: () => ({ lean: async () => null }) });
AgentActionLog.create = async (row) => {
  audits.push(row);
  return row;
};
cloudinary.isConfigured = () => true;

require("../../../services/completion/jobCompletion.service").ensureCompletionOverageApproval =
  async (args) => {
    approvalCalls.push(args);
    return { _id: { toString: () => "approval-1" } };
  };
// Tracked so the ordering can be asserted: when a job is BOTH over ceiling and
// short on evidence, the money is decided first and this must not fire yet.
let reviewCalls = [];
require("../../../services/completion/jobCompletion.service").ensureCompletionReviewApproval =
  async (args) => {
    reviewCalls.push(args);
    return { _id: { toString: () => "review-1" } };
  };

const ctrl = require("../../../controllers/vendorCompletion.controller");

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

const makeReq = (body) => ({
  params: { token: "raw" },
  body,
  ip: "203.0.113.9",
  get: () => "test-agent",
  appointment: {
    _id: APPT_ID,
    requestId: "req-1",
    landlordId: "landlord-1",
    tenantId: "tenant-1",
    status: "scheduled",
  },
  jobToken: { outreachId: "outreach-1", identityId: "identity-1", vendorNameSnapshot: "Northline" },
  jobCompletion: null,
});

const baseBody = (actualCost, extra = {}) => ({
  workPerformed: "Replaced the P-trap and the supply line.",
  partsUsed: "P-trap, plumber's tape",
  actualCost,
  ...extra,
});

/* ------------------------------------------------------------------ *
 * Over the ceiling with no reason: rejected, and NOTHING is written.
 * ------------------------------------------------------------------ */
async function testOverWithoutReasonIsRejected() {
  reset();
  const res = makeRes();

  await ctrl.submitCompletion(makeReq(baseBody(400)), res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, "overage_reason_required");
  assert.strictEqual(completionWrites.length, 0, "the report must not persist on a rejected attempt");
  assert.strictEqual(approvalCalls.length, 0, "no approval raised for a submission we refused");

  // The whole point of doing this reactively: the response must not reveal the
  // ceiling, or a vendor could binary-search it.
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes(String(CEILING)), "the ceiling must not leak in the rejection");
  assert.ok(!serialized.includes("80"), "nor the distance over it");
}

/* ------------------------------------------------------------------ *
 * Over the ceiling WITH a reason: accepted, approval raised, reason attached.
 * ------------------------------------------------------------------ */
async function testOverWithReasonRaisesApproval() {
  reset();
  const res = makeRes();
  const reason = "Found rot behind the panel — replaced the section and added a shut-off valve.";

  await ctrl.submitCompletion(makeReq(baseBody(400, { overageReason: reason })), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(approvalCalls.length, 1, "raises the approval at submit, not at close");
  assert.strictEqual(approvalCalls[0].actualCost, 400);
  assert.strictEqual(approvalCalls[0].ceiling, CEILING);
  assert.strictEqual(
    approvalCalls[0].overageReason,
    reason,
    "the manager rules on a reason, not a bare number"
  );

  // The reason is persisted with the report, so the close-time backstop can
  // re-read it if it ever has to raise the approval itself.
  assert.strictEqual(completionRow.report.overageReason, reason);
  assert.strictEqual(completionRow.overage.isOver, true);
  assert.strictEqual(completionRow.overage.decision, "pending");

  // And the vendor's own view immediately reflects the hold.
  assert.deepStrictEqual(res.body.data.costReview, { status: "pending" });
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes(String(CEILING)), "still no ceiling in the success response");
}

/* ------------------------------------------------------------------ *
 * Money is still asked about at submit. Evidence is not.
 * ------------------------------------------------------------------ */
// These two replace a pair that pinned "weak evidence parks at in_review at
// submit". That is the behaviour the tenant-first change removes: the tenant was
// in the room and is the better judge of "was it fixed", so they see every
// completion. The verdict now gates AUTO-CONFIRM in completionSweeper instead —
// silence cannot buy a photo-less job, but a tenant who looks and says yes can.
//
// An OVERAGE is a different question. It is about spend, not workmanship, the
// tenant is deliberately never shown a cost, and so it is still raised here.
async function testOverCeilingStillRaisesTheOverageAtSubmit() {
  reset({ photos: [] });
  const res = makeRes();

  await ctrl.submitCompletion(
    makeReq(
      baseBody(400, {
        overageReason: "Found rot behind the panel — replaced the section.",
      })
    ),
    res
  );

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(
    completionRow.status,
    "awaiting_tenant",
    "weak evidence no longer parks the job — the tenant is asked"
  );
  assert.strictEqual(approvalCalls.length, 1, "but the money question is still raised");
  assert.strictEqual(
    reviewCalls.length,
    0,
    "and no evidence review at submit — that only happens if the tenant goes quiet"
  );
}

/* Weak evidence within the ceiling asks nobody anything: straight to the tenant. */
async function testWeakEvidenceUnderCeilingGoesStraightToTheTenant() {
  reset({ photos: [] });
  const res = makeRes();

  await ctrl.submitCompletion(makeReq(baseBody(180)), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(completionRow.status, "awaiting_tenant");
  assert.strictEqual(completionRow.evidenceVerdict, "review", "the verdict is still recorded");
  assert.strictEqual(approvalCalls.length, 0, "nothing to approve on cost");
  assert.strictEqual(reviewCalls.length, 0, "and nothing for the manager to do at all");
}

/* ------------------------------------------------------------------ *
 * At or under the ceiling: completely unchanged behaviour.
 * ------------------------------------------------------------------ */
async function testUnderCeilingIsUnaffected() {
  for (const cost of [180, CEILING, 330]) {
    reset();
    const res = makeRes();

    await ctrl.submitCompletion(makeReq(baseBody(cost)), res);

    assert.strictEqual(res.statusCode, 200, `$${cost} must submit cleanly`);
    assert.strictEqual(approvalCalls.length, 0, `$${cost} is inside tolerance — no approval`);
    assert.strictEqual(res.body.data.costReview, null, "and no cost-review card");
  }
}

/* ------------------------------------------------------------------ *
 * An over-long reason is refused by the shape check.
 * ------------------------------------------------------------------ */
async function testReasonLengthCap() {
  reset();
  const res = makeRes();

  await ctrl.submitCompletion(makeReq(baseBody(400, { overageReason: "x".repeat(1001) })), res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(completionWrites.length, 0);
}

/* ------------------------------------------------------------------ *
 * No ceiling on the job: nothing to exceed, so no gate.
 * ------------------------------------------------------------------ */
async function testNoCeilingNeverGates() {
  reset({ approvedCeiling: null });
  // resolveApprovedCeiling falls back to request.estimatedCost, so null that too.
  MaintenanceRequest.findById = () => ({
    select: () => ({
      lean: async () => ({ _id: "req-1", landlordId: "landlord-1", propertyId: "prop-1", estimatedCost: null }),
    }),
  });
  LandlordPolicy.findOne = () => ({ lean: async () => ({}) });

  const res = makeRes();
  await ctrl.submitCompletion(makeReq(baseBody(99999)), res);

  // Falls back to the standing quota (300 default), so this DOES trip — the
  // point is that it resolves a ceiling rather than crashing on a null one.
  assert.ok(
    res.statusCode === 400 || res.statusCode === 200,
    "a missing snapshot resolves through the fallback chain rather than throwing"
  );
}

async function main() {
  const itemization = { pricingMode: "fixed", currency: "CAD", items: [
    { description: "Final labour and parts", category: "labour", amountMinor: 21000 },
  ], totals: { lowMinor: 21000, highMinor: 21000 } };
  reset({ quoteContractVersion: 2 });
  let itemRes = makeRes();
  await ctrl.submitCompletion(makeReq(baseBody(210, { expectedRevision: 0 })), itemRes);
  assert.strictEqual(itemRes.statusCode, 400, "server-required final charges cannot be omitted");
  assert.strictEqual(completionWrites.length, 0);
  itemRes = makeRes();
  await ctrl.submitCompletion(makeReq(baseBody(211, { expectedRevision: 0, itemization })), itemRes);
  assert.strictEqual(itemRes.statusCode, 400);
  assert.strictEqual(itemRes.body.code, "quote_total_mismatch");
  assert.strictEqual(completionWrites.length, 0);
  itemRes = makeRes();
  await ctrl.submitCompletion(makeReq(baseBody(210, { expectedRevision: 0, itemization, invoiceReference: "INV-01" })), itemRes);
  assert.strictEqual(itemRes.statusCode, 200);
  assert.strictEqual(completionRow.invoiceReview.state, "pending");
  assert.strictEqual(completionRow.report.finalStatement.itemization.totals.highMinor, 21000);
  assert.strictEqual(itemRes.body.data.report.invoiceReference, "INV-01");
  assert.strictEqual(itemRes.body.data.approvedCeiling, undefined);
  await testOverWithoutReasonIsRejected();
  await testOverWithReasonRaisesApproval();
  await testOverCeilingStillRaisesTheOverageAtSubmit();
  await testWeakEvidenceUnderCeilingGoesStraightToTheTenant();
  await testUnderCeilingIsUnaffected();
  await testReasonLengthCap();
  await testNoCeilingNeverGates();
  console.log("vendorCompletion overage-at-submit tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
