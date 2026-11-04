// Policy updates preserve passed screens, vendor order and edited drafts.
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const recommendations = require("../../../services/vendor/vendorRecommendation.service");
const routingSetup = require("../../../services/vendor/routingSetup.service");
const Request = require("../../../models/MaintenanceRequest");
const Policy = require("../../../models/LandlordPolicy");
const Approval = require("../../../models/ApprovalRequest");
const AgentLog = require("../../../models/AgentActionLog");
const Appointment = require("../../../models/Appointment");
const { Notification } = require("../../../models/Notification");
const { screenCandidate } = require("../../../services/vendor/routingCheckpoint.service");
const { rebuildSnapshotSections } = require("../../../services/vendor/vendorSnapshot.service");
let rows, policy, transactions, writes, notifications, setupReady, searches, fences, approvalSaves;
const session = { synthetic: true };
mongoose.connection.transaction = async work => { transactions++; return work(session); };
const query = doc => ({ populate() { return this; }, session(given) { assert.equal(given, session); return this; },
  then(resolve, reject) { return Promise.resolve(doc).then(resolve, reject); } });
Request.find = () => ({ select: () => ({ lean: async () => Object.keys(rows).map(_id => ({ _id })) }) });
Request.findOne = filter => query(rows[String(filter._id)] || null);
Policy.findOneAndUpdate = async (_filter, update, options) => {
  assert.equal(update.$inc.checkpointFence, 1); assert.equal(options.session, session); fences++; return { ...policy };
};
Approval.findOne = () => query(null);
Approval.prototype.save = async function(options) { assert.equal(options.session, session); approvalSaves++; return this; };
Approval.updateMany = async (_filter, _update, options) => { assert.equal(options.session, session); return {}; };
AgentLog.create = async entry => entry;
Appointment.exists = async () => null;
Notification.create = async entry => { notifications.push(entry); return entry; };
recommendations.generateVendorRecommendations = async () => { searches++; throw new Error("Policy saves must not search"); };
routingSetup.assertRoutingSetupReady = async () => { if (!setupReady) throw new Error("Setup incomplete"); };
const ctrl = require("../../../controllers/request.controller");
const candidate = { candidateKey: "preset__vendor", vendorId: "vendor", name: "Synthetic Vendor", source: "preset",
  verificationStatus: "trusted", state: "recommended", displayGroup: "recommended", priceEstimate: { amountHigh: 210 },
  draftMessage: "Owner-edited gate instructions", draftEditedAt: "2026-10-27T12:00:00Z" };
function makeRow(_id, oldPolicy, extra = {}) {
  const request = { _id, landlordId: "landlord-1", category: "Plumbing", status: "queued", appointmentStatus: "none", ...extra };
  const screening = screenCandidate({ request, candidate, policy: oldPolicy, vendorTypeNeeded: "plumbing", eligibleCount: 1, lowestEligibleCost: 210 });
  request.vendorRecommendationSnapshot = rebuildSnapshotSections({ ...screening, version: "same-plan", generatedAt: "2026-10-27T12:00:00Z",
    requestSnapshot: { vendorTypeNeeded: "plumbing" }, candidateLedger: [structuredClone(candidate)] });
  request.save = async options => { assert.equal(options.session, session); writes++; return request; };
  return request;
}
function reset() {
  policy = { defaultQuota: 500, policyRevision: 2, maxOutreachAttempts: 3 };
  transactions = writes = searches = fences = approvalSaves = 0; notifications = []; setupReady = true;
  rows = { pending: makeRow("pending", { defaultQuota: 100, policyRevision: 1 }),
    passed: makeRow("passed", { defaultQuota: 300, policyRevision: 1 }),
    busy: makeRow("busy", { defaultQuota: 100, policyRevision: 1 }),
    unknown: makeRow("unknown", { defaultQuota: 100, policyRevision: 1 }) };
  rows.busy.vendorRecommendationSnapshot.candidateLedger[0].state = "approved_for_contact";
  rows.unknown.vendorRecommendationSnapshot.routingCheckpoints = undefined;
  rows.unknown.vendorRecommendationSnapshot.decision.reasonCode = "unknown_old_state";
}
async function main() {
  reset();
  const beforePassed = JSON.stringify(rows.passed.vendorRecommendationSnapshot);
  const beforeUnknown = JSON.stringify(rows.unknown.vendorRecommendationSnapshot);
  const result = await ctrl.reevaluateRequestsForPolicy("landlord-1", { changedFields: ["defaultQuota"] });
  assert.deepEqual(result, { changed: 1, kept: 3, setupIncomplete: false, failed: 0 });
  assert.equal(searches, 0); assert.equal(writes, 1); assert.equal(fences, 1);
  const saved = rows.pending.vendorRecommendationSnapshot;
  assert.equal(saved.version, "same-plan"); assert.equal(saved.candidateLedger[0].draftMessage, candidate.draftMessage);
  assert.equal(saved.decision.reasonCode, "trusted_preset_match");
  assert.equal(rows.pending.routingStatus, "routed");
  assert.equal(JSON.stringify(rows.passed.vendorRecommendationSnapshot), beforePassed);
  assert.equal(JSON.stringify(rows.unknown.vendorRecommendationSnapshot), beforeUnknown);
  assert.equal(notifications.length, 1); assert.deepEqual(notifications[0].metadata.requestIds, ["pending"]);
  assert.match(notifications[0].message, /passed checkpoints or current vendor plan/);
  reset();
  rows = { pending: makeRow("pending", { defaultQuota: 300, policyRevision: 1 }) };
  rows.pending.vendorRecommendationSnapshot.routingCheckpoints = undefined;
  rows.pending.vendorRecommendationSnapshot.candidateLedger[0].verificationStatus = "verified";
  rows.pending.vendorRecommendationSnapshot.decision = { actionType: "request_first_time_vendor_approval", reasonCode: "first_time_vendor",
    candidateKey: candidate.candidateKey, quotaLimit: 300, approvalRequired: true };
  policy.defaultQuota = 100; policy.requireApprovalForFirstTimeVendor = false;
  await ctrl.reevaluateRequestsForPolicy("landlord-1", { changedFields: ["requireApprovalForFirstTimeVendor"] });
  assert.equal(rows.pending.vendorRecommendationSnapshot.decision.reasonCode, "manager_contact_approval_required");
  assert.equal(rows.pending.vendorRecommendationSnapshot.decision.quotaLimit, 300);
  assert.equal(approvalSaves, 1, "existing Decisions carries the new exact step question");
  reset();
  const first = ctrl.reevaluateRequestsForPolicy("landlord-1", { changedFields: ["defaultQuota"] });
  const second = ctrl.reevaluateRequestsForPolicy("landlord-1", { changedFields: ["requireApprovalForFirstTimeVendor"] });
  assert.equal(first, second); await first;
  assert.equal(notifications.length, 1); assert.equal(searches, 0);
  reset(); setupReady = false;
  const blocked = await ctrl.reevaluateRequestsForPolicy("landlord-1");
  assert.equal(blocked.setupIncomplete, true); assert.equal(transactions, 0); assert.equal(writes, 0);
  console.log("Selective policy refresh: same plan/drafts, pending stages only, transaction session, field coalescing and unknown history PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
