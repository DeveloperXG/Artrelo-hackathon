// decideApprovalRequest: the vendor-quote branch.
//
// This is where the manager's authorization is turned into either a booking or a
// counter-offer. Two things get pinned hardest:
//
//   1. ORDERING. The approval is marked decided early and the handler refuses to
//      re-decide a decided approval, so any 400 raised AFTER that write strands
//      the approval permanently — un-approvable, un-rejectable, un-re-raisable.
//   2. BACKWARDS COMPATIBILITY. Approving with no explicit amount must behave
//      exactly as it always did.

const assert = require("assert");

const ApprovalRequest = require("../../../models/ApprovalRequest");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const VendorOutreach = require("../../../models/VendorOutreach");
const AgentActionLog = require("../../../models/AgentActionLog");

const QUOTE_LOW = 180;
const QUOTE_HIGH = 320;

let approvalRow = null;
let requestRow = null;
let outreachRow = null;
let approvalSaves = [];
let finalizeCalls = [];
let counterOfferCalls = [];
let advanceCalls = [];
let routingCalls = [];
let claims = [];
let rollbacks = [];
let readBarrier = null;
let afterClaim = null;
let beforeRollback = null;
let completionReviewResult = {};
let completionReviewCalls = [];
const published = [];
require("../../../services/realtime/liveEvents.service").publish = (owner, topic) => published.push({ owner: String(owner), topic });

function makeApproval(overrides = {}) {
  return {
    _id: { toString: () => "approval-1" },
    landlordId: "landlord-1",
    requestId: "req-1",
    type: "quota_increase",
    status: "pending",
    expiresAt: new Date(Date.now() + 3600000),
    amountRequested: QUOTE_HIGH,
    payload: {
      source: "vendor_quote",
      outreachId: "outreach-1",
      candidateKey: "preset__vendor-1",
      quota: { limit: 300, quotedAmount: QUOTE_HIGH, quotedLow: QUOTE_LOW },
    },
    save: async function save() {
      approvalSaves.push({ status: this.status });
      return this;
    },
    ...overrides,
  };
}

function reset(approvalOverrides = {}) {
  approvalRow = makeApproval(approvalOverrides);
  requestRow = {
    intakeFollowUp: {state: "reviewed", revision: 2, remainingTopics: []},
    _id: "req-1",
    landlordId: "landlord-1",
    status: "approved",
    timeline: [],
    quotaOverride: null,
    quotaSnapshot: null,
    routingStatus: "approval_needed",
    vendorRecommendationSnapshot: {
      decision: { actionType: "recommend_preset_vendor", quotaLimit: 300 },
      candidateLedger: [{ candidateKey: "preset__vendor-1", state: "approved_for_contact" }],
    },
    save: async function save() {
      return this;
    },
  };
  outreachRow = {
    _id: { toString: () => "outreach-1" },
    landlordId: "landlord-1",
    requestId: "req-1",
    vendorNameSnapshot: "Prairie Plumbing Partners",
    status: "accepted",
    response: { quoteLow: QUOTE_LOW, quoteHigh: QUOTE_HIGH },
  };
  approvalSaves = [];
  finalizeCalls = [];
  counterOfferCalls = [];
  advanceCalls = [];
  routingCalls = []; claims = []; rollbacks = []; readBarrier = null; afterClaim = null; beforeRollback = null; published.length = 0;
  completionReviewResult = {}; completionReviewCalls = [];
}

ApprovalRequest.findOne = async (filter) => {
  if (!approvalRow || String(filter.landlordId) !== String(approvalRow.landlordId)) return null;
  const snapshot = { ...approvalRow, payload: { ...approvalRow.payload } };
  delete snapshot.decisionClaimToken;
  if (readBarrier) await readBarrier();
  return snapshot;
};
ApprovalRequest.findOneAndUpdate = async (filter, update) => {
  claims.push({ filter, update });
  if (approvalRow.status !== filter.status || String(approvalRow.landlordId) !== String(filter.landlordId) ||
      String(approvalRow.requestId) !== String(filter.requestId) || new Date(approvalRow.expiresAt) <= filter.expiresAt.$gt) return null;
  Object.assign(approvalRow, update.$set);
  if (afterClaim) afterClaim();
  return { _id: approvalRow._id };
};
ApprovalRequest.updateOne = async (filter, update) => {
  rollbacks.push({ filter, update });
  if (beforeRollback) beforeRollback();
  if (approvalRow.status !== filter.status || approvalRow.decisionClaimToken !== filter.decisionClaimToken) return { modifiedCount: 0 };
  Object.assign(approvalRow, update.$set);
  for (const key of Object.keys(update.$unset || {})) delete approvalRow[key];
  return { modifiedCount: 1 };
};
MaintenanceRequest.findOne = () => { const chain = { populate: () => chain, then: (resolve, reject) => Promise.resolve(requestRow).then(resolve, reject) }; return chain; };
require("../../../services/vendor/vendorOutreach.service").sendVendorOutreach = async (args) => { routingCalls.push(args); return { delivered: false, outreach: { status: "delivery_failed" } }; };
MaintenanceRequest.findById = async () => requestRow;
VendorOutreach.findById = async () => outreachRow;
AgentActionLog.create = async () => ({});
// Rejecting a vendor quote dismisses it (vendorQuoteDismissal): claim, settle
// approvals, email, advance. No toEmail here, so no email.
VendorOutreach.findOneAndUpdate = async () =>
  outreachRow?.status === "accepted" ? Object.assign(outreachRow, { status: "declined" }) : null;
ApprovalRequest.updateMany = async () => ({ modifiedCount: 0 });

require("../../../services/vendor/vendorAcceptance.service").finalizeVendorAcceptance = async (args) => {
  finalizeCalls.push(args);
  return {};
};
require("../../../services/vendor/vendorCounterOffer.service").raiseCounterOffer = async (args) => {
  counterOfferCalls.push(args);
  return {};
};
require("../../../services/vendor/vendorOutreachSweeper.service").advanceOutreach = async (args) => {
  advanceCalls.push(args);
  return {};
};
require("../../../services/completion/jobCompletion.service").resolveCompletionReview = async (args) => { completionReviewCalls.push(args); return completionReviewResult; };

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
  params: { id: "approval-1" },
  body,
  user: { id: "landlord-1" },
});

/* ------------------------------------------------------------------ *
 * The ordering test.
 * ------------------------------------------------------------------ */
async function testBelowFloorRejectedBeforeAnythingIsWritten() {
  reset();
  const res = makeRes();

  await ctrl.decideApprovalRequest(makeReq({ status: "approved", approvedAmount: 100 }), res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, "ceiling_below_vendor_floor");
  assert.strictEqual(res.body.data.minimum, QUOTE_LOW, "names the minimum so the UI can guide");

  // The whole point: the approval must still be decidable afterwards.
  assert.strictEqual(approvalSaves.length, 0, "the approval must NOT be saved as decided");
  assert.strictEqual(approvalRow.status, "pending", "it stays pending and retryable");
  assert.strictEqual(finalizeCalls.length, 0);
  assert.strictEqual(counterOfferCalls.length, 0, "no offer is sent below the vendor's floor");
  assert.strictEqual(requestRow.quotaOverride, null, "nothing is written to the request");
}

/* ------------------------------------------------------------------ *
 * At or above the quote: book, exactly as before.
 * ------------------------------------------------------------------ */
async function testAtOrAboveQuoteBooks() {
  reset();
  const res = makeRes();

  await ctrl.decideApprovalRequest(makeReq({ status: "approved", approvedAmount: 400 }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(requestRow.quotaOverride, 400);
  assert.strictEqual(requestRow.vendorRecommendationSnapshot.decision.quotaLimit, 400);
  assert.strictEqual(finalizeCalls.length, 1, "hands off to the booking gate");
  assert.strictEqual(counterOfferCalls.length, 0, "nothing to negotiate at or above the quote");
  // The flag that used to let this book at any price is gone from the call.
  assert.ok(
    !Object.prototype.hasOwnProperty.call(finalizeCalls[0], "quotaApproved"),
    "the quotaApproved bypass must not come back"
  );
}

/* ------------------------------------------------------------------ *
 * Mid-range: ask the vendor, and do NOT raise the standing limit.
 * ------------------------------------------------------------------ */
async function testMidRangeRaisesCounterOffer() {
  reset();
  const res = makeRes();

  await ctrl.decideApprovalRequest(makeReq({ status: "approved", approvedAmount: 250 }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(counterOfferCalls.length, 1, "asks the vendor");
  assert.strictEqual(counterOfferCalls[0].ceiling, 250);
  assert.strictEqual(finalizeCalls.length, 0, "must not book before the vendor agrees");

  // The important one: raising the standing limit now would silently authorize
  // whatever vendor comes next if this one declines.
  assert.strictEqual(
    requestRow.quotaOverride,
    null,
    "the request quota must NOT move until a vendor actually commits"
  );
  assert.strictEqual(requestRow.routingStatus, "routed", "in flight, not awaiting the manager");
}

/* ------------------------------------------------------------------ *
 * Backwards compatibility: no amount means "as requested".
 * ------------------------------------------------------------------ */
async function testOmittedAmountBooksAsBefore() {
  reset();
  const res = makeRes();

  await ctrl.decideApprovalRequest(makeReq({ status: "approved" }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(
    requestRow.quotaOverride,
    QUOTE_HIGH,
    "falls back to amountRequested, i.e. the quoted high"
  );
  assert.strictEqual(finalizeCalls.length, 1);
  assert.strictEqual(counterOfferCalls.length, 0, "approve-as-is still books directly");
}

/* ------------------------------------------------------------------ *
 * Rejection dismisses the quote and advances to the next vendor.
 * ------------------------------------------------------------------ */
async function testRejectAdvances() {
  reset();
  const res = makeRes();

  await ctrl.decideApprovalRequest(makeReq({ status: "rejected" }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(advanceCalls.length, 1);
  assert.strictEqual(advanceCalls[0].reason, "manager_dismissed");
  assert.strictEqual(outreachRow.status, "declined", "the response is closed, not left accepted");
  assert.strictEqual(finalizeCalls.length, 0);
  assert.strictEqual(counterOfferCalls.length, 0);
}

/* ------------------------------------------------------------------ *
 * A vanished outreach is a 409, and again leaves the approval decidable.
 * ------------------------------------------------------------------ */
async function testMissingOutreach() {
  reset();
  outreachRow = null;
  const res = makeRes();

  await ctrl.decideApprovalRequest(makeReq({ status: "approved", approvedAmount: 400 }), res);

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "outreach_missing");
  assert.strictEqual(approvalSaves.length, 0, "still not stranded");
  assert.strictEqual(approvalRow.status, "pending");
}

/* ------------------------------------------------------------------ *
 * The outreach fallback approval must actually activate the vendor it names.
 * ------------------------------------------------------------------ */
// advanceOutreach raises this when a vendor declines. It used to leave the
// named candidate parked in `held`, and activateCandidateState refuses held
// candidates outright — so approving it threw AFTER the approval was marked
// decided, leaving the manager with a consumed approval, an unchanged request,
// a 500, and no way to raise the decision again. This is the halt.
async function testOutreachFallbackApprovalActivatesNextVendor() {
  reset({
    type: "vendor_contact_approval",
    amountRequested: 200,
    payload: {
      source: "outreach_fallback",
      candidateKey: "preset__vendor-2",
      previousOutreachId: "outreach-1",
      draftMessage: "Hello Vendor B",
    },
  });
  requestRow.vendorRecommendationSnapshot = {
    decision: { actionType: "request_vendor_contact_approval", approvalRequired: true },
    candidateLedger: [
      {
        candidateKey: "preset__vendor-1",
        name: "Vendor A",
        state: "excluded",
        displayGroup: "excluded",
        outreach: { status: "declined" },
      },
      // The pre-fix shape: still parked in `held`. New declines are requeued
      // out of `held` by advanceOutreach, but requests already in flight are not.
      {
        candidateKey: "preset__vendor-2",
        name: "Vendor B",
        state: "held",
        displayGroup: "held",
        holdReason: "On hold while Vendor A is the active vendor candidate.",
        draftMessage: "Hello Vendor B",
      },
    ],
  };
  const res = makeRes();

  await ctrl.decideApprovalRequest(makeReq({ status: "approved" }), res);

  assert.strictEqual(res.statusCode, 200, "approving the fallback must not 500");
  const snapshot = requestRow.vendorRecommendationSnapshot;
  const next = snapshot.candidateLedger.find((e) => e.candidateKey === "preset__vendor-2");
  assert.strictEqual(next.state, "approved_for_contact", "the named vendor is activated");
  assert.strictEqual(next.holdReason, null, "and released from its hold");
  assert.strictEqual(snapshot.activeCandidateKey, "preset__vendor-2");
  assert.strictEqual(requestRow.routingStatus, "routed");
  assert.strictEqual(approvalRow.status, "approved", "consumed, but this time it did something");
}

/* A decision that cannot be applied must be handed back, not consumed. */
async function testUnapplicableRoutingApprovalStaysDecidable() {
  reset({
    type: "vendor_contact_approval",
    payload: { source: "outreach_fallback", candidateKey: "preset__gone" },
  });
  requestRow.vendorRecommendationSnapshot = {
    decision: { actionType: "request_vendor_contact_approval" },
    candidateLedger: [
      { candidateKey: "preset__vendor-1", name: "Vendor A", state: "excluded", displayGroup: "excluded" },
    ],
  };
  const res = makeRes();

  await ctrl.decideApprovalRequest(makeReq({ status: "approved" }), res);

  assert.ok(res.statusCode >= 400, "an unapplicable decision is an error, not a silent success");
  assert.strictEqual(approvalRow.status, "pending", "and the approval is handed back");
  assert.strictEqual(approvalRow.decidedAt, undefined);
}

function synchronizeTwoApprovalReads() {
  let arrivals = 0, release;
  const ready = new Promise((resolve) => { release = resolve; });
  readBarrier = async () => { if (++arrivals === 2) { readBarrier = null; release(); } await ready; };
}
function assertInvalidated() {
  for (const topic of ["requests", "request:req-1"]) assert(published.some((event) => event.owner === "landlord-1" && event.topic === topic), topic);
}
async function testSequentialAndConcurrentDecisionsExecuteOnce() {
  reset();
  const first = makeRes(), second = makeRes();
  await ctrl.decideApprovalRequest(makeReq({ status: "approved" }), first);
  await ctrl.decideApprovalRequest(makeReq({ status: "approved" }), second);
  assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 400);
  assert.equal(finalizeCalls.length, 1);
  assertInvalidated();
  assert(!JSON.stringify(first.body).includes("decisionClaimToken"));

  reset(); synchronizeTwoApprovalReads();
  const concurrent = [makeRes(), makeRes()];
  await Promise.all(concurrent.map((res) => ctrl.decideApprovalRequest(makeReq({ status: "approved" }), res)));
  assert.deepEqual(concurrent.map((res) => res.statusCode).sort(), [200, 409]);
  assert.equal(claims.length, 2, "both callers reached the atomic claim with stale pending snapshots");
  assert.equal(finalizeCalls.length, 1, "only the claim winner can resume acceptance");
  assert.equal(counterOfferCalls.length, 0);
  assertInvalidated();
}
function routingApproval() {
  reset({ type: "vendor_contact_approval", payload: { candidateKey: "preset__vendor-1", draftMessage: "Synthetic authorized request" } });
  requestRow.vendorRecommendationSnapshot.candidateLedger[0] = { candidateKey: "preset__vendor-1", name: "Synthetic Vendor", state: "recommended", displayGroup: "recommended" };
}
async function testRoutingResumeOnceAndRejectionPauses() {
  routingApproval(); synchronizeTwoApprovalReads();
  const concurrent = [makeRes(), makeRes()];
  await Promise.all(concurrent.map((res) => ctrl.decideApprovalRequest(makeReq({ status: "approved" }), res)));
  assert.deepEqual(concurrent.map((res) => res.statusCode).sort(), [200, 409]);
  assert.equal(routingCalls.length, 1, "one authorized resume attempt, transport is a disabled synthetic stub");
  assert.equal(routingCalls[0].candidate.candidateKey, "preset__vendor-1");
  assert.equal(requestRow.routingStatus, "routed");

  routingApproval();
  const rejected = makeRes();
  await ctrl.decideApprovalRequest(makeReq({ status: "rejected" }), rejected);
  assert.equal(rejected.statusCode, 200); assert.equal(approvalRow.status, "rejected");
  assert.equal(requestRow.routingStatus, "paused"); assert.equal(routingCalls.length, 0);
  assert.equal(requestRow.vendorRecommendationSnapshot.candidateLedger[0].state, "manager_rejected");
  assertInvalidated();
}
async function testPreconditionsExpiryAndExactRollback() {
  routingApproval(); routingSetupReady = false;
  const blocked = makeRes();
  await ctrl.decideApprovalRequest(makeReq({ status: "approved" }), blocked);
  assert(blocked.statusCode >= 400); assert.equal(claims.length, 0, "policy precondition precedes the claim");
  assert.equal(approvalRow.status, "pending"); assert.equal(routingCalls.length, 0);
  routingSetupReady = true;

  routingApproval(); afterClaim = () => { requestRow.status = "completed"; };
  const rollback = makeRes();
  await ctrl.decideApprovalRequest(makeReq({ status: "approved" }), rollback);
  assert.equal(rollback.statusCode, 409); assert.equal(approvalRow.status, "pending");
  assert.equal(approvalRow.decidedAt, undefined); assert.equal(routingCalls.length, 0);
  assert.equal(rollbacks.length, 1);
  assert.equal(rollbacks[0].filter.decisionClaimToken, claims[0].update.$set.decisionClaimToken);
  assert.equal(published.filter((event) => event.topic === "requests").length, 2, "claim and real rollback both invalidate");

  routingApproval(); afterClaim = () => { requestRow.status = "completed"; };
  beforeRollback = () => { approvalRow.decisionClaimToken = "newer-claim"; };
  await ctrl.decideApprovalRequest(makeReq({ status: "approved" }), makeRes());
  assert.equal(approvalRow.status, "approved", "a stale rollback cannot re-pend another claim");
  assert.equal(approvalRow.decisionClaimToken, "newer-claim");

  reset({ expiresAt: new Date(Date.now() - 1) });
  const expired = makeRes();
  await ctrl.decideApprovalRequest(makeReq({ status: "approved" }), expired);
  assert.equal(expired.statusCode, 409); assert.equal(expired.body.code, "approval_expired");
  assert.equal(claims.length, 0); assert.equal(finalizeCalls.length, 0);
  const foreign = makeReq({ status: "approved" }); foreign.user.id = "other-landlord";
  const denied = makeRes(); await ctrl.decideApprovalRequest(foreign, denied);
  assert.equal(denied.statusCode, 404); assert.equal(claims.length, 0);

  reset({ type: "completion_review", payload: { completionId: "synthetic-completion" } });
  completionReviewResult = null;
  const staleCompletion = makeRes();
  await ctrl.decideApprovalRequest(makeReq({ status: "approved" }), staleCompletion);
  assert.equal(staleCompletion.statusCode, 409); assert.equal(staleCompletion.body.code, "completion_not_in_review");
  assert.equal(approvalRow.status, "pending"); assert.equal(completionReviewCalls.length, 1);
  assert.equal(routingCalls.length, 0); assert.equal(finalizeCalls.length, 0);
  assert.equal(rollbacks.length, 1); assertInvalidated();
}

async function main() {
  for (const foreign of [{ landlordId: "other-landlord" }, { requestId: "other-request" }]) {
    reset(); Object.assign(outreachRow, foreign);
    const denied = makeRes();
    await ctrl.decideApprovalRequest(makeReq({ status: "approved", approvedAmount: QUOTE_HIGH }), denied);
    assert.equal(denied.statusCode, 409); assert.equal(denied.body.code, "outreach_missing");
    assert.equal(claims.length, 0, "foreign outreach cannot consume a financial Decision");
    assert.equal(approvalRow.status, "pending");
    assert.equal(finalizeCalls.length, 0); assert.equal(counterOfferCalls.length, 0);
  }
  await testBelowFloorRejectedBeforeAnythingIsWritten();
  await testAtOrAboveQuoteBooks();
  await testMidRangeRaisesCounterOffer();
  await testOmittedAmountBooksAsBefore();
  await testRejectAdvances();
  await testMissingOutreach();
  await testOutreachFallbackApprovalActivatesNextVendor();
  await testUnapplicableRoutingApprovalStaysDecidable();
  await testSequentialAndConcurrentDecisionsExecuteOnce();
  await testRoutingResumeOnceAndRejectionPauses();
  await testPreconditionsExpiryAndExactRollback();
  const CompletionModel = require("../../../models/JobCompletion");
  reset({ payload: { source: "completion_overage", completionId: "final-statement", quoteRevision: 1, quoteHash: "current-final" } });
  CompletionModel.findOne = filter => {
    assert.equal(filter.landlordId, requestRow.landlordId); assert.equal(filter.requestId, requestRow._id);
    return { select: () => ({ lean: async () => ({ quoteContractVersion: 2, report: { finalStatement: { revision: 1, hash: "current-final" } } }) }) };
  };
  let finalDecision = makeRes();
  await ctrl.decideApprovalRequest(makeReq({ status: "approved", approvedAmount: 194.375, expectedQuoteRevision: 1, expectedQuoteHash: "current-final" }), finalDecision);
  assert.equal(finalDecision.statusCode, 400); assert.equal(claims.length, 0);
  finalDecision = makeRes();
  await ctrl.decideApprovalRequest(makeReq({ status: "approved", approvedAmount: 194.37, expectedQuoteRevision: 1, expectedQuoteHash: "old-final" }), finalDecision);
  assert.equal(finalDecision.statusCode, 409); assert.equal(claims.length, 0);
  CompletionModel.findOne = () => ({ select: () => ({ lean: async () => null }) });
  finalDecision = makeRes();
  await ctrl.decideApprovalRequest(makeReq({ status: "approved", approvedAmount: 194.37, expectedQuoteRevision: 1, expectedQuoteHash: "current-final" }), finalDecision);
  assert.equal(finalDecision.statusCode, 409); assert.equal(claims.length, 0, "foreign/missing completion cannot consume a financial decision");
  reset({ type: "other", payload: {} }); requestRow.status = "queued";
  let step = makeRes(); await ctrl.decideApprovalRequest(makeReq({ status: "approved" }), step);
  assert.equal(step.statusCode, 409); assert.equal(claims.length, 0, "unknown queued context cannot be treated as routing permission");
  for (const status of ["approved", "rejected"]) {
    reset({ type: "other", payload: { actionScope: "coordination_step", stepId: "review_coordination", question: "Allow this step?" } });
    requestRow.status = "queued"; step = makeRes(); await ctrl.decideApprovalRequest(makeReq({ status }), step);
    assert.equal(step.statusCode, 200); assert.equal(requestRow.status, "queued", "step decision never rejects or approves the whole request");
    assert.equal(requestRow.routingStatus, status === "approved" ? "routed" : "paused");
    assert.equal(finalizeCalls.length, 0); assert.equal(routingCalls.length, 0);
  }
  const reviews = require("../../../services/quotes/review.service");
  let reviewApplications = 0, reviewFailure = false;
  reviews.validateDecision = async ({ body }) => {
    if (Object.hasOwn(body, "approvedAmount") || body.expectedQuoteHash !== "current") {
      throw Object.assign(new Error("Stale cost review"), { statusCode: 409, code: "stale_cost_review" });
    }
  };
  reviews.applyDecision = async () => {
    if (reviewFailure) throw Object.assign(new Error("Review changed"), { statusCode: 409, code: "stale_cost_review" });
    reviewApplications++;
  };
  reset({ type: "cost_review", payload: { source: "iris_cost_review" } });
  let cost = makeRes();
  await ctrl.decideApprovalRequest(makeReq({ status: "approved", expectedQuoteHash: "current", approvedAmount: 999 }), cost);
  assert.equal(cost.statusCode, 409); assert.equal(claims.length, 0, "reject monetary payload before consuming a review");
  synchronizeTwoApprovalReads();
  const costRace = [makeRes(), makeRes()];
  await Promise.all(costRace.map(res => ctrl.decideApprovalRequest(makeReq({ status: "approved", expectedQuoteHash: "current" }), res)));
  assert.deepEqual(costRace.map(res => res.statusCode).sort(), [200, 409]);
  assert.equal(reviewApplications, 1); assert.equal(finalizeCalls.length, 0); assert.equal(counterOfferCalls.length, 0);
  assert.equal(requestRow.quotaOverride, null, "typed cost review cannot fall into quota or generic approval branches");
  reset({ type: "cost_review", payload: { source: "iris_cost_review" } }); reviewFailure = true;
  cost = makeRes();
  await ctrl.decideApprovalRequest(makeReq({ status: "approved", expectedQuoteHash: "current" }), cost);
  assert.equal(cost.statusCode, 409); assert.equal(approvalRow.status, "pending"); assert.equal(rollbacks.length, 1);
  cost = makeRes();
  await ctrl.createApprovalRequest(makeReq({ requestId: "req-1", type: "cost_review", expiresAt: new Date() }), cost);
  assert.equal(cost.statusCode, 400); assert.equal(cost.body.code, "server_owned_review");
  console.log("decideApprovalRequest vendor-quote and fallback tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
