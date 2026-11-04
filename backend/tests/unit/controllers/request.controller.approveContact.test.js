// approveVendorRecommendationContact: the guard that keeps a closed round from
// being reopened.
//
// The deadlock this pins: approving a vendor who already declined activated the
// candidate, then called sendVendorOutreach, which collided with the unique
// index on { requestId, candidateKey, attempt }. That collision is deliberately
// swallowed as non-fatal (a mail outage must not roll back a committed
// approval), so the request was left holding an active candidate behind a dead
// outreach — Generate locked by the active candidate, every other candidate
// held, and no live offer for the sweeper to expire. Nothing could move.
//
// Models and the outreach sender are stubbed BEFORE the controller is required,
// the same idiom as request.controller.decideApproval.test.js — the controller
// destructures sendVendorOutreach at load time.

const assert = require("assert");

const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const VendorOutreach = require("../../../models/VendorOutreach");
const ApprovalRequest = require("../../../models/ApprovalRequest");
const AgentActionLog = require("../../../models/AgentActionLog");

let requestRow = null;
let priorOutreachRow = null;
let sendCalls = [];
let sendError = null;
let onSend = null;

// loadLandlordRequestForRecommendations chains five .populate() calls.
const populateChain = (doc) => {
  const chain = {
    populate: () => chain,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
  return chain;
};

// findById is awaited directly by releaseCandidateActivation and used with
// .select() for the response re-read.
const findByIdResult = () => ({
  select: async () => requestRow,
  then: (resolve, reject) => Promise.resolve(requestRow).then(resolve, reject),
});

MaintenanceRequest.findOne = () => populateChain(requestRow);
MaintenanceRequest.findById = () => findByIdResult();
VendorOutreach.findOne = () => ({
  sort: () => ({ select: async () => priorOutreachRow,
    then: (resolve, reject) => Promise.resolve(priorOutreachRow).then(resolve, reject) }),
});
ApprovalRequest.findOne = async () => null;
AgentActionLog.create = async () => ({});

require("../../../services/vendor/vendorOutreach.service").sendVendorOutreach = async (args) => {
  sendCalls.push(args);
  if (onSend) onSend();
  if (sendError) throw sendError;
  return { outreach: { _id: { toString: () => "outreach-new" } }, delivered: true };
};

// The routing-setup gate (routingSetup.service) reads the landlord's vendor
// count and vendor cap. A landlord with both, so these tests exercise what they
// were written for; `routingSetupReady = false` flips it.
let routingSetupReady = true;
const VendorModel = require("../../../models/Vendor");
const PolicyModel = require("../../../models/LandlordPolicy");
VendorModel.countDocuments = async () => (routingSetupReady ? 2 : 0);
const policyQuery = { lean: async () => ({ maxOutreachAttempts: routingSetupReady ? 3 : 0 }) };
PolicyModel.findOne = () => ({ ...policyQuery, select: () => policyQuery });

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

const makeReq = (candidateKey) => ({
  params: { id: "req-1", vendorId: candidateKey },
  body: {},
  user: { id: "landlord-1" },
});

function reset(candidateOverrides = {}) {
  requestRow = {
    intakeFollowUp: {state: "reviewed", revision: 2, remainingTopics: []},
    _id: "req-1",
    landlordId: "landlord-1",
    status: "approved",
    routingStatus: "approval_needed",
    timeline: [],
    vendorRecommendationSnapshot: {
      decision: { actionType: "request_vendor_contact_approval", approvalRequired: true },
      candidateLedger: [
        {
          candidateKey: "preset__vendor-1",
          name: "Vendor A",
          state: "recommended",
          displayGroup: "recommended",
          score: 90,
          draftMessage: "Hello Vendor A",
          contactApproval: { status: "pending", approvedAt: null, approvedBy: null },
          ...candidateOverrides,
        },
        {
          candidateKey: "preset__vendor-2",
          name: "Vendor B",
          state: "recommended",
          displayGroup: "recommended",
          score: 80,
          draftMessage: "Hello Vendor B",
        },
      ],
    },
    save: async function save() {
      return this;
    },
  };
  priorOutreachRow = null;
  sendCalls = [];
  sendError = null;
}

const candidate = (key) =>
  requestRow.vendorRecommendationSnapshot.candidateLedger.find((e) => e.candidateKey === key);

/* ------------------------------------------------------------------ *
 * A vendor who declined cannot be re-approved.
 * ------------------------------------------------------------------ */
async function testDeclinedVendorIsRefused() {
  reset();
  priorOutreachRow = {
    status: "declined",
    response: { declineReason: "Booked solid this week" },
  };
  const res = makeRes();

  await ctrl.approveVendorRecommendationContact(makeReq("preset__vendor-1"), res);

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "vendor_outreach_closed");
  assert.ok(res.body.message.includes("Vendor A"), "names the vendor");
  assert.ok(res.body.message.includes("Booked solid this week"), "and why they said no");
  assert.ok(res.body.message.includes("next vendor"), "and points at the way forward");

  assert.strictEqual(sendCalls.length, 0, "no second email is attempted");
  assert.strictEqual(
    candidate("preset__vendor-1").state,
    "recommended",
    "the candidate is NOT activated — activating it is what deadlocked the request"
  );
  assert.strictEqual(
    candidate("preset__vendor-2").state,
    "recommended",
    "and the rest of the queue is not put on hold behind it"
  );
}

/* An expired round points at Resend instead, which is a real path. */
async function testExpiredVendorPointsAtResend() {
  reset();
  priorOutreachRow = { status: "expired", response: {} };
  const res = makeRes();

  await ctrl.approveVendorRecommendationContact(makeReq("preset__vendor-1"), res);

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "vendor_outreach_closed");
  assert.ok(res.body.message.includes("Resend"), "expired outreach is resendable, so say so");
  assert.strictEqual(sendCalls.length, 0);
}

/* An outreach still in flight keeps the old, correct 409. */
async function testLiveOutreachIsAlreadyApproved() {
  reset({ state: "approved_for_contact" });
  priorOutreachRow = { status: "sent", response: {} };
  const res = makeRes();

  await ctrl.approveVendorRecommendationContact(makeReq("preset__vendor-1"), res);

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "contact_already_approved");
  assert.strictEqual(sendCalls.length, 0);
}

/* ------------------------------------------------------------------ *
 * Approved but never sent still falls through and retries the send.
 * ------------------------------------------------------------------ */
// Deliberate pre-existing behaviour: a send can fail after the approval
// commits, and refusing on state alone would strand the request with nothing to
// resend and regeneration blocked. The new guard asks the outreach record, so
// this path is unchanged.
async function testApprovedButNeverSentStillSends() {
  reset({ state: "approved_for_contact", contactApproval: { status: "approved" } });
  priorOutreachRow = null;
  const res = makeRes();

  await ctrl.approveVendorRecommendationContact(makeReq("preset__vendor-1"), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(sendCalls.length, 1, "the send is retried");
  assert.strictEqual(res.body.outreach.sent, true);
}

/* ------------------------------------------------------------------ *
 * A duplicate-attempt collision releases the activation.
 * ------------------------------------------------------------------ */
// The belt-and-braces net behind the guard above. This error means the
// activation was never valid, so unlike a mail outage there is nothing to wait
// for — leaving the candidate active would deadlock the request.
async function testDuplicateAttemptRollsBackTheActivation() {
  reset();
  priorOutreachRow = null; // guard passes; the unique index catches it instead
  sendError = Object.assign(new Error("Outreach has already been sent to this vendor"), {
    code: "outreach_already_sent",
    statusCode: 409,
  });
  const res = makeRes();

  await ctrl.approveVendorRecommendationContact(makeReq("preset__vendor-1"), res);

  assert.strictEqual(res.statusCode, 200, "the approval itself still committed");
  assert.strictEqual(res.body.outreach.sent, false);
  assert.strictEqual(res.body.outreach.code, "outreach_already_sent");

  const ledger = requestRow.vendorRecommendationSnapshot.candidateLedger;
  const released = ledger.find((e) => e.candidateKey === "preset__vendor-1");
  assert.strictEqual(released.state, "excluded", "the dead candidate is retired, not left active");
  assert.strictEqual(
    requestRow.vendorRecommendationSnapshot.activeCandidateKey,
    null,
    "so the request is not locked behind an outreach that can never answer"
  );
  const nextUp = ledger.find((e) => e.candidateKey === "preset__vendor-2");
  assert.strictEqual(nextUp.state, "recommended", "and the queue is re-dealt and approvable");
  assert.strictEqual(nextUp.holdReason, null);
}

/* ------------------------------------------------------------------ *
 * No vendors, or a vendor cap of 0: nothing is contacted.
 * ------------------------------------------------------------------ */
async function testRoutingSetupIncompleteIsRefused() {
  reset();
  routingSetupReady = false;
  const res = makeRes();
  try {
    await ctrl.approveVendorRecommendationContact(makeReq("preset__vendor-1"), res);
  } finally {
    routingSetupReady = true;
  }

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "routing_setup_incomplete");
  assert.deepStrictEqual(res.body.setup.missing, ["vendors", "max_vendors"]);
  assert.strictEqual(sendCalls.length, 0, "no email goes out");
  assert.strictEqual(candidate("preset__vendor-1").state, "recommended", "nothing is activated");
}

async function main() {
  reset();
  requestRow.intakeFollowUp = {state:'awaiting_answers',revision:1,remainingTopics:['timeline']};
  const holdRes = makeRes();
  await ctrl.approveVendorRecommendationContact(makeReq('preset__vendor-1'),holdRes);
  assert.strictEqual(holdRes.statusCode,409);
  assert.strictEqual(holdRes.body.code,'intake_review_required');
  assert.strictEqual(sendCalls.length,0);
  assert.strictEqual(candidate('preset__vendor-1').state,'recommended','review hold precedes activation');
  await testDeclinedVendorIsRefused();
  await testRoutingSetupIncompleteIsRefused();
  await testExpiredVendorPointsAtResend();
  await testLiveOutreachIsAlreadyApproved();
  await testApprovedButNeverSentStillSends();
  await testDuplicateAttemptRollsBackTheActivation();
  reset(); requestRow.status = "cancelled";
  const closedRes = makeRes();
  await ctrl.approveVendorRecommendationContact(makeReq("preset__vendor-1"), closedRes);
  assert.strictEqual(closedRes.statusCode, 409);
  assert.strictEqual(sendCalls.length, 0, "cancelled requests cannot dispatch a prepared approval");
  reset();
  onSend = () => { priorOutreachRow = { status: "sent" }; };
  sendError = Object.assign(new Error("concurrent send won"), { code: "outreach_already_sent" });
  const res = makeRes();
  await ctrl.approveVendorRecommendationContact(makeReq("preset__vendor-1"), res);
  assert.strictEqual(res.body.outreach.sent, true, "a live duplicate is already started");
  assert.strictEqual(candidate("preset__vendor-1").state, "approved_for_contact", "never retire the active vendor after a concurrent send");
  console.log("approveVendorRecommendationContact closed-round guard tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
