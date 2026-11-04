const assert = require("node:assert/strict");
const { screenCandidate, affectedCheckpointStages } = require("../../../services/vendor/routingCheckpoint.service");
const request = { category: "Plumbing", propertyId: "property", unitId: "unit" };
const candidate = { candidateKey: "preset__vendor", vendorId: "vendor", source: "preset", verificationStatus: "trusted",
  priceEstimate: { amountLow: 180, amountHigh: 210, currency: "CAD" } };
const args = { request, candidate, vendorTypeNeeded: "plumbing", eligibleCount: 1, lowestEligibleCost: 210 };
const snapshot = screening => ({ ...screening, requestSnapshot: { vendorTypeNeeded: "plumbing" }, candidateLedger: [candidate], recommendations: [candidate] });
const first = screenCandidate({ ...args, policy: { defaultQuota: 300, policyRevision: 1 } });
assert.equal(first.decision.approvalRequired, false);
assert.deepEqual(first.routingCheckpoints.map(row => row.state), ["passed", "passed"]);
const original = JSON.stringify(first);
const lowered = screenCandidate({ ...args, previousSnapshot: snapshot(first), policy: { defaultQuota: 100, policyRevision: 2 } });
assert.equal(lowered.decision.approvalRequired, false, "lower quota never reflags the passed estimate screen");
assert.equal(lowered.decision.quotaLimit, 300);
assert.equal(lowered.routingCheckpoints.length, 2);
assert.equal(JSON.stringify(first), original, "history is copied, not mutated");
assert.deepEqual(affectedCheckpointStages({ snapshot: snapshot(first), request, changedFields: ["defaultQuota"] }), []);
const revised = screenCandidate({ ...args, candidate: { ...candidate, priceEstimate: { ...candidate.priceEstimate, amountHigh: 400 } },
  previousSnapshot: snapshot(first), policy: { defaultQuota: 100, policyRevision: 2 } });
assert.equal(revised.decision.reasonCode, "estimate_over_quota", "changed estimate is a new price basis");
const nextVendor = screenCandidate({ ...args, candidate: { ...candidate, candidateKey: "preset__other", vendorId: "other" },
  previousSnapshot: snapshot(first), policy: { defaultQuota: 100, policyRevision: 2 } });
assert.equal(nextVendor.decision.reasonCode, "estimate_over_quota", "another vendor cannot borrow a passed screen");
const pending = screenCandidate({ ...args, policy: { defaultQuota: 100, policyRevision: 1 } });
assert.equal(pending.routingCheckpoints.length, 1, "first-time stage has not been reached");
assert.deepEqual(affectedCheckpointStages({ snapshot: snapshot(pending), request, changedFields: ["defaultQuota"] }), ["estimate"]);
const relaxed = screenCandidate({ ...args, previousSnapshot: snapshot(pending), policy: { defaultQuota: 300, policyRevision: 2 } });
assert.equal(relaxed.decision.approvalRequired, false);
assert.equal(pending.routingCheckpoints[0].state, "review_required", "old failed attempt remains evidence");
const unfamiliar = { ...candidate, verificationStatus: "verified" };
const firstTime = screenCandidate({ ...args, candidate: unfamiliar, policy: { defaultQuota: 300, policyRevision: 1 } });
assert.equal(firstTime.decision.reasonCode, "first_time_vendor");
const changedFlag = screenCandidate({ ...args, candidate: unfamiliar, previousSnapshot: snapshot(firstTime),
  policy: { defaultQuota: 100, requireApprovalForFirstTimeVendor: false, policyRevision: 2 } });
assert.equal(changedFlag.decision.reasonCode, "manager_contact_approval_required", "first-time setting does not invent contact permission");
const retoggle = screenCandidate({ ...args, candidate: unfamiliar, previousSnapshot: snapshot(changedFlag),
  policy: { defaultQuota: 100, requireApprovalForFirstTimeVendor: true, policyRevision: 3 } });
assert.equal(retoggle.decision.reasonCode, "manager_contact_approval_required", "passed first-time screen remains passed");
assert.equal(retoggle.decision.quotaLimit, 300);
const legacy = { ...snapshot(firstTime), routingCheckpoints: undefined, generatedAt: "2026-10-27T12:00:00Z" };
const legacyNext = screenCandidate({ ...args, candidate: unfamiliar, previousSnapshot: legacy,
  policy: { defaultQuota: 100, policyRevision: 2 } });
assert.equal(legacyNext.decision.reasonCode, "first_time_vendor");
assert.equal(legacyNext.routingCheckpoints[0].policyRevision, null, "historical policy revision is unknown, not fabricated");
assert.equal(legacyNext.routingCheckpoints[0].evidence, "legacy_decision");
const unknown = { ...legacy, decision: { actionType: "recommend_vendors", reasonCode: "unknown_old_state" } };
assert.deepEqual(affectedCheckpointStages({ snapshot: unknown, request, changedFields: ["defaultQuota"] }), [], "global save leaves unknown legacy plan intact");
assert.equal(screenCandidate({ ...args, policy: {} }).decision.reasonCode, "quota_not_set");
console.log("Routing checkpoints: passed-stage retention, pending policy changes, candidate/price separation and truthful legacy evidence PASS");
