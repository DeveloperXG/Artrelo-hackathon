// Manual assignment contacts the vendor.
//
// The stuck request this pins: after every vendor declined, the manager picked
// one by hand. markManualVendorAssignmentRequired marked the candidate
// `selected` and stopped -- no outreach was ever sent, the timeline claimed
// "assigned", and routingStatus moved off "paused", which re-armed the
// outreach-loop lock and named that SAME vendor as "next in line". Nothing on
// the page could move the request.
//
//   1. a manual pick is activated as approved_for_contact AND sent outreach
//   2. an excluded vendor needs an override reason, and gets a built draft
//   3. a vendor who already declined cannot be re-picked
//   4. a legacy `selected` candidate with no outreach is recoverable via Send
//   5. the loop lock no longer fires while a vendor is active
//   6. an approved routing decision ("contact X next?") sends to X

const assert = require("assert");

const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const VendorOutreach = require("../../../models/VendorOutreach");
const ApprovalRequest = require("../../../models/ApprovalRequest");
const AgentActionLog = require("../../../models/AgentActionLog");

let requestRow = null;
let priorOutreachRow = null;
let sendCalls = [];

const populateChain = (doc) => {
  const chain = {
    populate: () => chain,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
  return chain;
};

MaintenanceRequest.findOne = () => populateChain(requestRow);
MaintenanceRequest.findById = () => ({
  select: async () => requestRow,
  then: (resolve, reject) => Promise.resolve(requestRow).then(resolve, reject),
});
// Awaited both as .sort().select() (the refusal guard) and as .sort() alone
// (the resend handler).
const thenable = () => ({
  select: async () => priorOutreachRow,
  then: (resolve, reject) => Promise.resolve(priorOutreachRow).then(resolve, reject),
});
VendorOutreach.findOne = () => ({ sort: thenable, ...thenable() });
ApprovalRequest.findOne = async () => null;
ApprovalRequest.updateMany = async () => ({});
AgentActionLog.create = async () => ({});

require("../../../services/vendor/vendorOutreach.service").sendVendorOutreach = async (args) => {
  sendCalls.push(args);
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

function reset() {
  requestRow = {
    intakeFollowUp: {state: "reviewed", revision: 2, remainingTopics: []},
    _id: "req-1",
    landlordId: "landlord-1",
    status: "queued",
    category: "Plumbing",
    vendorTypeNeeded: "Plumbing",
    ai: { summary: "leak under the sink" },
    propertyId: { address: "1 Main St, Regina, SK" },
    // Every vendor in the queue has closed a round: the request is paused.
    routingStatus: "paused",
    timeline: [],
    vendorRecommendationSnapshot: {
      decision: { actionType: "recommend_preset_vendor" },
      candidateLedger: [
        {
          candidateKey: "preset__declined",
          name: "We Plumb IT All",
          state: "excluded",
          displayGroup: "excluded",
          outreach: { status: "declined", respondedAt: "2026-10-03T01:07:00.000Z" },
        },
        {
          candidateKey: "preset__reads",
          name: "Reads",
          state: "excluded",
          displayGroup: "excluded",
          reasonCodes: ["service_mismatch"],
          draftMessage: null,
          outreach: { status: "not_sent" },
        },
      ],
    },
    save: async function save() {
      return this;
    },
  };
  priorOutreachRow = null;
  sendCalls = [];
}

const entry = (key) =>
  requestRow.vendorRecommendationSnapshot.candidateLedger.find((e) => e.candidateKey === key);
const assign = (body) =>
  ctrl.markManualVendorAssignmentRequired(
    { params: { id: "req-1" }, body, user: { id: "landlord-1" } },
    makeRes()
  );

async function main() {
  /* 2) excluded needs a reason ---------------------------------------- */
  reset();
  let res = makeRes();
  await ctrl.markManualVendorAssignmentRequired(
    { params: { id: "req-1" }, body: { candidateKey: "preset__reads" }, user: { id: "landlord-1" } },
    res
  );
  assert.strictEqual(res.statusCode, 400, "an excluded vendor needs an override reason");
  assert.strictEqual(sendCalls.length, 0);

  /* 1) the pick is contacted ------------------------------------------ */
  reset();
  res = makeRes();
  await ctrl.markManualVendorAssignmentRequired(
    {
      params: { id: "req-1" },
      body: { candidateKey: "preset__reads", overrideReason: "They do plumbing too" },
      user: { id: "landlord-1" },
    },
    res
  );
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(sendCalls.length, 1, "the manually chosen vendor is sent the job");
  assert.strictEqual(sendCalls[0].candidate.candidateKey, "preset__reads");
  assert.ok(sendCalls[0].draftMessage.startsWith("We have a plumbing job"), "a draft is built for an excluded pick");
  assert.deepStrictEqual(res.body.outreach, { sent: true, scheduled: false, scheduledFor: null });

  const reads = entry("preset__reads");
  assert.strictEqual(reads.state, "approved_for_contact", "not the dead-end `selected`");
  assert.strictEqual(reads.manualSelection.selectionMethod, "manual");
  assert.strictEqual(reads.manualSelection.overrideReason, "They do plumbing too");
  assert.deepStrictEqual(reads.manualSelection.overriddenConstraints, ["service_mismatch"]);
  assert.strictEqual(requestRow.vendorRecommendationSnapshot.activeCandidateKey, "preset__reads");
  assert.strictEqual(requestRow.vendorRecommendationSnapshot.selectedCandidateKey, null);
  assert.strictEqual(requestRow.routingStatus, "routed");
  // The stub save skips schema validation, so check the enum here: an unlisted
  // value made the real save throw and manual assignment return a 500.
  assert.ok(
    MaintenanceRequest.VENDOR_RECOMMENDATION_DECISIONS.includes(requestRow.routingDecision),
    `routingDecision "${requestRow.routingDecision}" is a valid enum value`
  );
  assert.strictEqual(requestRow.status, "approved", "contact approved, not yet assigned");
  assert.ok(
    !requestRow.timeline.some((row) => row.status === "assigned"),
    "nothing is assigned until the vendor accepts"
  );

  /* 5) no "Reads is next in line" while Reads is active ---------------- */
  res = makeRes();
  await ctrl.generateVendorRecommendations(
    { params: { id: "req-1" }, body: {}, user: { id: "landlord-1" } },
    res
  );
  assert.strictEqual(res.statusCode, 409);
  assert.ok(!/next in line/.test(res.body.message), res.body.message);
  assert.match(res.body.message, /Reads is being contacted/);

  /* 3) a vendor who declined cannot be re-picked ----------------------- */
  reset();
  priorOutreachRow = { status: "declined", response: { declineReason: "Booked" } };
  res = makeRes();
  await ctrl.markManualVendorAssignmentRequired(
    {
      params: { id: "req-1" },
      body: { candidateKey: "preset__declined", overrideReason: "Try again" },
      user: { id: "landlord-1" },
    },
    res
  );
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "vendor_outreach_closed");
  assert.strictEqual(sendCalls.length, 0);

  /* 4) legacy stranded `selected` recovers through Send ---------------- */
  reset();
  Object.assign(entry("preset__reads"), { state: "selected", displayGroup: "active" });
  res = makeRes();
  await ctrl.resendVendorOutreach(
    { params: { id: "req-1", vendorId: "preset__reads" }, body: {}, user: { id: "landlord-1" } },
    res
  );
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(sendCalls.length, 1, "Send contacts the stranded vendor");
  assert.strictEqual(entry("preset__reads").state, "approved_for_contact");
  assert.strictEqual(requestRow.routingStatus, "routed");

  // ...and approve-contact no longer refuses it either.
  reset();
  Object.assign(entry("preset__reads"), { state: "selected", displayGroup: "active", draftMessage: "Hi" });
  res = makeRes();
  await ctrl.approveVendorRecommendationContact(
    { params: { id: "req-1", vendorId: "preset__reads" }, body: {}, user: { id: "landlord-1" } },
    res
  );
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(sendCalls.length, 1);

  /* 6) an approved routing decision sends to the named vendor ---------- */
  reset();
  requestRow.vendorRecommendationSnapshot.candidateLedger.push({
    candidateKey: "preset__next",
    name: "Next Plumbing",
    state: "recommended",
    displayGroup: "recommended",
    draftMessage: "Hello Next",
  });
  const approval = {
    _id: "approval-1",
    expiresAt: new Date(Date.now() + 3600000),
    type: "vendor_contact_approval",
    status: "pending",
    requestId: "req-1",
    landlordId: "landlord-1",
    payload: { source: "outreach_fallback", candidateKey: "preset__next", draftMessage: "Hello Next" },
    save: async function save() {
      return this;
    },
  };
  ApprovalRequest.findOne = async () => ({ ...approval });
  ApprovalRequest.findOneAndUpdate = async (filter, update) => {
    if (approval.status !== filter.status) return null;
    Object.assign(approval, update.$set);
    return { _id: approval._id };
  };
  res = makeRes();
  await ctrl.decideApprovalRequest(
    { params: { id: "approval-1" }, body: { status: "approved" }, user: { id: "landlord-1" } },
    res
  );
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(sendCalls.length, 1, "approving 'contact X next?' contacts X");
  assert.strictEqual(sendCalls[0].candidate.candidateKey, "preset__next");
  assert.strictEqual(sendCalls[0].draftMessage, "Hello Next");

  /* 7) scheduled send: locked with the time, cancellable ---------------- */
  reset();
  Object.assign(entry("preset__reads"), {
    state: "approved_for_contact",
    displayGroup: "active",
    outreach: { status: "scheduled", outreachId: "o-sched", scheduledFor: "2026-08-03T14:00:00.000Z" },
  });
  requestRow.vendorRecommendationSnapshot.candidateLedger.push({
    candidateKey: "preset__other",
    name: "Other Plumbing",
    state: "held",
    displayGroup: "held",
    score: 50,
  });
  res = makeRes();
  await ctrl.generateVendorRecommendations({ params: { id: "req-1" }, body: {}, user: { id: "landlord-1" } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.message, /scheduled for Mon, Aug 3/, res.body.message);
  assert.match(res.body.message, /— cancel the scheduled send first\.$/);
  assert.ok(!/\.\./.test(res.body.message), "no doubled period after a.m./p.m.");

  let deleted = null;
  VendorOutreach.findOneAndDelete = async (filter) => {
    deleted = filter;
    return { _id: "o-sched", candidateKey: "preset__reads", vendorNameSnapshot: "Reads", scheduledFor: new Date() };
  };
  res = makeRes();
  await ctrl.cancelScheduledOutreach(
    { params: { id: "req-1", outreachId: "o-sched" }, body: {}, user: { id: "landlord-1" } },
    res
  );
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(deleted.status, "scheduled", "only a still-scheduled row can be cancelled");
  assert.notStrictEqual(entry("preset__reads").state, "approved_for_contact", "the vendor goes back in line");
  assert.strictEqual(entry("preset__reads").outreach.status, "not_sent", "not a closed round — approvable again");
  assert.notStrictEqual(entry("preset__other").state, "held", "everyone held behind it is released");
  assert.strictEqual(requestRow.vendorRecommendationSnapshot.activeCandidateKey, null);
  assert.strictEqual(requestRow.routingStatus, "pending");

  // Already sent by the time Cancel lands: refused, nothing changes.
  VendorOutreach.findOneAndDelete = async () => null;
  res = makeRes();
  await ctrl.cancelScheduledOutreach(
    { params: { id: "req-1", outreachId: "o-sched" }, body: {}, user: { id: "landlord-1" } },
    res
  );
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "outreach_not_scheduled");

  console.log("manual assignment tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
