// routingGuidance.service: the single author of what the request page may
// offer (Regenerate, Reject, which pause it is). The page shows these answers
// as-is, so these are the rules the landlord sees.

const assert = require("assert");
const {
  buildRoutingGuidance,
  getOutreachLoopLockReason,
  getRegenerateBlockReason,
  isRejectable,
} = require("../../../services/request/routingGuidance.service");

// Reads declined; Pipe Pros is queued next and hasn't been contacted.
const midLoop = (routingStatus) => ({
  status: "approved",
  intakeFollowUp: {state:"reviewed",revision:1,remainingTopics:[]},
  routingStatus,
  vendorRecommendationSnapshot: {
    candidateLedger: [
      { candidateKey: "reads", name: "Reads", state: "excluded", contactApproval: { status: "approved" }, outreach: { status: "declined" } },
      { candidateKey: "pipe", name: "Pipe Pros", state: "recommended", outreach: { status: "not_sent" } },
    ],
  },
});

/* -------- the loop lock says what it is actually waiting on -------- */
const awaiting = getOutreachLoopLockReason(midLoop("approval_needed"));
assert.match(awaiting, /^Waiting on your approval to contact Pipe Pros\./);
assert.ok(!/still running/.test(awaiting), "nothing is running -- it is waiting on the manager");

const queued = getOutreachLoopLockReason(midLoop("routed"));
assert.match(queued, /^Pipe Pros is next in line/);

assert.strictEqual(getOutreachLoopLockReason(midLoop("paused")), "", "a paused loop is where a new search belongs");

/* -------- a stale selection is not a block; a live one is -------- */
const stale = { status: "approved", routingStatus: "paused", selectedVendorId: "v1", vendorRecommendationSnapshot: { candidateLedger: [] } };
assert.strictEqual(getRegenerateBlockReason(stale, { selectionIsLive: false }), "");
assert.match(getRegenerateBlockReason(stale, { selectionIsLive: true }), /selected vendor candidate exists/);
assert.match(getRegenerateBlockReason({ status: "completed" }), /completed requests/);

/* -------- rejectable once every approved vendor is retired -------- */
assert.strictEqual(isRejectable(midLoop("paused")), true);
const engaged = midLoop("routed");
engaged.vendorRecommendationSnapshot.candidateLedger[1].state = "approved_for_contact";
assert.strictEqual(isRejectable(engaged), false);
assert.strictEqual(isRejectable({ status: "completed" }), false);

/* -------- the payload shapes -------- */
const exhausted = {
  ...midLoop("paused"),
  vendorRecommendationSnapshot: { candidateLedger: [], lastRound: { resolution: "exhausted", at: "2026-10-07T10:00:00Z" } },
};
assert.deepStrictEqual(buildRoutingGuidance(exhausted), {
  contactBlockReason: '',
  rejectable: true,
  pauseKind: "vendors_exhausted",
  regenerateBlockReason: "",
});
assert.deepStrictEqual(
  buildRoutingGuidance(midLoop("routed"), { includeRegenerate: false }),
  { contactBlockReason: '', rejectable: true, pauseKind: null },
  "lists get no regenerate answer, and a request that isn't paused has no pause kind"
);

/* -------- a closed request has no pause to explain -------- */
// Rejecting sets routingStatus "paused" too; that must not read as "every
// vendor has been tried" with a way forward on a request that is closed.
for (const status of ["rejected", "cancelled", "completed"]) {
  assert.strictEqual(buildRoutingGuidance({ ...exhausted, status }).pauseKind, null, status);
}

console.log("routingGuidance.service tests passed");
