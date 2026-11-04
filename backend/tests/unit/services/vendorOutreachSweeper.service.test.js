// The decline fallback loop: what advanceOutreach does to the ledger when a
// vendor says no.
//
// Two regressions are pinned here.
//
// 1. The next candidate used to stay `held`. Held entries render in a collapsed
//    section with no Approve action, and activateCandidateState refuses them
//    outright — so the fallback approval this function raises named a vendor
//    the manager had no way to approve, and approving it from the Decisions
//    page threw *after* the approval had already been marked decided.
//
// 2. The attempt cap counted outreach ROWS while the policy behind it is shown
//    to the manager as "Max vendors contacted per request". A resend writes a
//    second row for the same candidateKey, so one resend silently spent another
//    vendor's slot of the budget.
//
// Models are stubbed by assigning over their statics BEFORE requiring the
// module under test, the same idiom as vendorAcceptance.service.test.js.

const assert = require("assert");

const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const LandlordPolicy = require("../../../models/LandlordPolicy");
const ApprovalRequest = require("../../../models/ApprovalRequest");
const VendorOutreach = require("../../../models/VendorOutreach");
const Vendor = require("../../../models/Vendor");
const AgentActionLog = require("../../../models/AgentActionLog");

let requestRow = null;
let approvalsCreated = [];
let audits = [];
let distinctCandidateKeys = [];
let policyRow = { maxOutreachAttempts: 3, autoAdvanceOnVendorDecline: true };

MaintenanceRequest.findById = async () => requestRow;
LandlordPolicy.findOne = () => ({ lean: async () => policyRow });
VendorOutreach.distinct = async () => distinctCandidateKeys;
Vendor.updateOne = async () => ({ modifiedCount: 1 });
ApprovalRequest.create = async (row) => {
  approvalsCreated.push(row);
  return { ...row, _id: { toString: () => "approval-round-2" } };
};
AgentActionLog.create = async (row) => {
  audits.push(row);
  return row;
};

const { advanceOutreach } = require("../../../services/vendor/vendorOutreachSweeper.service");

const makeCandidate = (candidateKey, name, score, overrides = {}) => ({
  candidateKey,
  name,
  score,
  state: "held",
  displayGroup: "held",
  holdReason: "On hold while Vendor A is the active vendor candidate.",
  contact: { hasEmail: true },
  outreach: { status: "not_sent", attempt: 0 },
  priceEstimate: { amountHigh: 200 },
  draftMessage: `Hello ${name}`,
  humanReadableReasons: [],
  ...overrides,
});

// Vendor A was approved and emailed; B..F were parked in `held` by
// applyHoldStateToRemainingCandidates the moment A became the active candidate.
const makeSnapshot = () => ({
  decision: {
    actionType: "request_vendor_contact_approval",
    approvalRequired: true,
    managerSummary: "Approve contacting Vendor A.",
  },
  // The FIRST round's approval, already granted. Leaving this in place is what
  // made the routing tile report an approval for a round that was over.
  approvalRequest: {
    approvalRequestId: "approval-round-1",
    type: "vendor_contact_approval",
    status: "approved",
    candidateKey: "preset__a",
  },
  candidateLedger: [
    makeCandidate("preset__a", "Vendor A", 99, {
      state: "approved_for_contact",
      displayGroup: "active",
      holdReason: null,
      outreach: { status: "declined", attempt: 1 },
    }),
    makeCandidate("preset__b", "Vendor B", 90),
    makeCandidate("preset__c", "Vendor C", 80),
    makeCandidate("preset__d", "Vendor D", 70),
    makeCandidate("preset__e", "Vendor E", 60),
    makeCandidate("preset__f", "Vendor F", 50),
  ],
});

const makeRequest = () => ({
  _id: "req-1",
  landlordId: "landlord-1",
  status: "approved",
  routingStatus: "routed",
  // Vendor A, the one about to decline.
  selectedVendorId: "vendor-a",
  vendorRecommendationSnapshot: makeSnapshot(),
  save: async function save() {
    return this;
  },
});

const makeOutreach = (overrides = {}) => ({
  _id: { toString: () => "outreach-a" },
  requestId: "req-1",
  candidateKey: "preset__a",
  vendorNameSnapshot: "Vendor A",
  vendorId: "vendor-a",
  attempt: 1,
  tier: "normal",
  status: "declined",
  response: { outcome: "declined", declineReason: "Booked solid this week" },
  counterOffer: { status: "none" },
  ...overrides,
});

const reset = (contacted) => {
  requestRow = makeRequest();
  approvalsCreated = [];
  audits = [];
  distinctCandidateKeys = contacted;
};

async function main() {
  /* -------- a decline re-deals the queue instead of leaving it held -------- */
  reset(["preset__a"]);

  const result = await advanceOutreach({ outreach: makeOutreach(), reason: "declined" });
  assert.deepStrictEqual(result, { awaitingApproval: true, nextCandidateKey: "preset__b" });

  const snapshot = requestRow.vendorRecommendationSnapshot;
  const byKey = Object.fromEntries(snapshot.candidateLedger.map((e) => [e.candidateKey, e]));

  assert.strictEqual(byKey.preset__a.state, "excluded", "the vendor who declined is retired");
  assert.strictEqual(
    requestRow.selectedVendorId,
    null,
    "and is no longer the selected vendor -- left set, it locked Generate for good"
  );
  assert.ok(
    byKey.preset__a.humanReadableReasons.some((line) => line.includes("Booked solid this week")),
    "the decline reason is kept on the ledger"
  );

  assert.deepStrictEqual(
    snapshot.recommendations.map((e) => e.name),
    ["Vendor B", "Vendor C", "Vendor D"],
    "the next three are promoted into Recommended"
  );
  assert.deepStrictEqual(
    snapshot.eligibleButNotTopCandidates.map((e) => e.name),
    ["Vendor E", "Vendor F"],
    "the remainder sit in Eligible backup"
  );
  assert.deepStrictEqual(
    snapshot.heldCandidates,
    [],
    "nobody is left held — a held candidate cannot be approved"
  );
  assert.ok(
    snapshot.candidateLedger.every((entry) => !entry.holdReason),
    "hold reasons are cleared with the holds"
  );

  assert.strictEqual(
    snapshot.approvalRequest.status,
    "pending",
    "the outstanding approval is the NEW one, not round one's"
  );
  assert.strictEqual(snapshot.approvalRequest.candidateKey, "preset__b");
  assert.strictEqual(snapshot.approvalRequest.approvalRequestId, "approval-round-2");
  assert.strictEqual(requestRow.routingStatus, "approval_needed");

  assert.strictEqual(snapshot.lastRound.resolution, "awaiting_approval");
  assert.strictEqual(snapshot.lastRound.vendorName, "Vendor A");
  assert.strictEqual(snapshot.lastRound.nextVendorName, "Vendor B");
  assert.strictEqual(snapshot.lastRound.detail, "Booked solid this week");
  assert.strictEqual(snapshot.lastRound.vendorsContacted, 1);
  assert.strictEqual(snapshot.lastRound.maxVendors, 3);
  assert.strictEqual(
    snapshot.lastRound.effectiveMaxVendors,
    3,
    "five vendors still queued: the policy cap is the binding limit"
  );

  assert.strictEqual(approvalsCreated.length, 1, "exactly one fallback approval is raised");
  assert.strictEqual(approvalsCreated[0].payload.source, "outreach_fallback");
  assert.strictEqual(approvalsCreated[0].payload.candidateKey, "preset__b");

  /* -------- the cap counts VENDORS, not outreach rows -------- */
  // Vendor A was emailed twice: a send, then a resend after the SLA lapsed.
  // That is one vendor of a three-vendor budget, not two.
  reset(["preset__a"]);

  const afterResend = await advanceOutreach({
    outreach: makeOutreach({ attempt: 2, status: "expired" }),
    reason: "timeout",
  });
  assert.strictEqual(
    afterResend.awaitingApproval,
    true,
    "a resend to the same vendor does not spend a second vendor"
  );
  assert.strictEqual(requestRow.vendorRecommendationSnapshot.lastRound.vendorsContacted, 1);

  /* -------- the loop ends once the vendor budget is spent -------- */
  reset(["preset__a", "preset__b", "preset__c"]);

  const done = await advanceOutreach({ outreach: makeOutreach(), reason: "declined" });
  assert.deepStrictEqual(done, { exhausted: true });
  assert.strictEqual(
    requestRow.routingStatus,
    "paused",
    "paused is the signal that unlocks Generate again"
  );
  assert.strictEqual(requestRow.vendorRecommendationSnapshot.lastRound.resolution, "exhausted");
  assert.strictEqual(
    requestRow.vendorRecommendationSnapshot.approvalRequest,
    null,
    "no phantom approval when nothing is being asked of the manager"
  );
  assert.strictEqual(approvalsCreated.length, 0);

  /* -------- a small network lowers the cap the panel reports -------- */
  // Two vendors and a cap of three: the third never exists, so the panel must
  // say "vendor 2 of 2", not "2 of 3" with nobody left in line.
  reset(["preset__a"]);
  requestRow.vendorRecommendationSnapshot.candidateLedger =
    requestRow.vendorRecommendationSnapshot.candidateLedger.slice(0, 2);

  await advanceOutreach({ outreach: makeOutreach(), reason: "declined" });
  assert.strictEqual(requestRow.vendorRecommendationSnapshot.lastRound.maxVendors, 3);
  assert.strictEqual(requestRow.vendorRecommendationSnapshot.lastRound.effectiveMaxVendors, 2);

  /* -------- emergencies escalate rather than advancing -------- */
  reset(["preset__a"]);

  const escalated = await advanceOutreach({
    outreach: makeOutreach({ tier: "emergency" }),
    reason: "declined",
  });
  assert.deepStrictEqual(escalated, { escalated: true });
  assert.strictEqual(requestRow.vendorRecommendationSnapshot.lastRound.resolution, "escalated");
  assert.strictEqual(requestRow.routingStatus, "approval_needed");
  assert.strictEqual(approvalsCreated.length, 0, "escalation asks a human, not the next name");

  console.log("vendorOutreachSweeper decline-fallback tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
