// The request's status label, decided once on the server.

const assert = require("assert");
const { deriveRequestLifecycleStatus } = require("../../../services/request/requestLifecycle.service");

const landlord = (request) => deriveRequestLifecycleStatus(request, { audience: "landlord" });

// Two vendors declined, the third was turned down: routing paused, nobody left.
const allTurnedDown = {
  status: "approved",
  routingStatus: "paused",
  vendorRecommendationSnapshot: {
    candidateLedger: [
      { candidateKey: "a", state: "excluded", contactApproval: { status: "approved" }, outreach: { status: "declined" } },
      { candidateKey: "b", state: "excluded", contactApproval: { status: "approved" }, outreach: { status: "declined" } },
    ],
  },
};

/* -------- no longer "approved" once every vendor is gone -------- */
assert.strictEqual(landlord(allTurnedDown), "needs_vendor");
// The tenant's view is unchanged: from their side it was approved.
assert.strictEqual(deriveRequestLifecycleStatus(allTurnedDown), "approved");

/* -------- a retired vendor alone doesn't make a request "approved" -------- */
assert.strictEqual(
  landlord({ ...allTurnedDown, status: "queued", routingStatus: "pending" }),
  "queued",
  "a declined vendor's leftover contactApproval is not an approval"
);

/* -------- the routing states a manager acts on -------- */
const contacting = {
  status: "approved",
  routingStatus: "routed",
  vendorRecommendationSnapshot: {
    activeCandidateKey: "c",
    candidateLedger: [{ candidateKey: "c", state: "approved_for_contact", outreach: { status: "sent" } }],
  },
};
assert.strictEqual(landlord(contacting), "contacting_vendor", "emailed, waiting on their answer");
assert.strictEqual(
  landlord({ ...contacting, routingStatus: "paused" }),
  "contacting_vendor",
  "someone is still being contacted, so it doesn't need a vendor"
);
// An over-quota quote: the vendor was contacted, but the next move is ours.
assert.strictEqual(landlord({ ...contacting, routingStatus: "approval_needed" }), "needs_approval");

// A vendor declined and the next one waits on approval: not "approved".
assert.strictEqual(
  landlord({
    status: "approved",
    routingStatus: "approval_needed",
    vendorRecommendationSnapshot: {
      candidateLedger: [
        { candidateKey: "a", state: "excluded", contactApproval: { status: "approved" }, outreach: { status: "declined" } },
        { candidateKey: "b", state: "recommended", outreach: { status: "not_sent" } },
      ],
    },
  }),
  "needs_approval"
);
// Approved, but no search has run: that is what "approved" means now.
assert.strictEqual(landlord({ status: "approved", routingStatus: "pending" }), "approved");

const scheduled = {
  ...contacting,
  vendorRecommendationSnapshot: {
    activeCandidateKey: "c",
    candidateLedger: [{ candidateKey: "c", state: "approved_for_contact", outreach: { status: "scheduled" } }],
  },
};
assert.strictEqual(landlord(scheduled), "outreach_scheduled", "the server copy finally knows this state");
assert.strictEqual(deriveRequestLifecycleStatus(scheduled), "approved", "tenants never saw it");

/* -------- the rest as before -------- */
assert.strictEqual(landlord({ status: "completed" }), "completed");
assert.strictEqual(landlord({ status: "approved", vendorId: "v1" }), "assigned");
assert.strictEqual(landlord({ status: "queued" }), "queued");

console.log("requestLifecycle.service tests passed");
