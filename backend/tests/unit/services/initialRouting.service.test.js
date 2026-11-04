const assert = require("assert");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const LandlordPolicy = require("../../../models/LandlordPolicy");
const Vendor = require("../../../models/Vendor");
const VendorOutreach = require("../../../models/VendorOutreach");
const ApprovalRequest = require("../../../models/ApprovalRequest");
const { routingDigest } = require("../../../services/ai/triageReceipt.service");
require('../../../models/FirstContactDecision').findOne = () => ({ sort() { return this; }, lean: async () => null });
const { guardAutopilotDecision } = require("../../../services/vendor/autopilotPolicy.service");
let row, policy, outreach, searches, sends, approvals, notices, searchFailure, duringSearch;
let auditEvents = [];
const clone = (v) => structuredClone(v);
const at = (o, path) => path.split(".").reduce((a, k) => a?.[k], o);
const equal = (a, b) => a instanceof Date || b instanceof Date ? Number(a) === Number(b) : a === b;
function matches(doc, filter) {
  return Object.entries(filter).every(([key, val]) => {
    if (key === "$or") return val.some((f) => matches(doc, f));
    const actual = at(doc, key);
    if (val === null) return actual == null;
    if (val && typeof val === "object" && !(val instanceof Date)) {
      return Object.entries(val).every(([op, limit]) => op === "$in" ? limit.includes(actual) : op === "$lte" ? actual <= limit : op === "$gt" ? actual > limit : false);
    }
    return equal(actual, val);
  });
}
function put(doc, key, value) {
  const parts = key.split("."); const last = parts.pop();
  let target = doc; for (const part of parts) target = target[part] ||= {};
  target[last] = clone(value);
}
function update(doc, changes) {
  for (const [k, v] of Object.entries(changes.$set || {})) put(doc, k, v);
  for (const [k, v] of Object.entries(changes.$inc || {})) put(doc, k, (at(doc, k) || 0) + v);
  doc.updatedAt = new Date();
}
MaintenanceRequest.findOneAndUpdate = async (filter, changes) => {
  if (!matches(row, filter)) return null;
  update(row, changes); return clone(row);
};
MaintenanceRequest.updateOne = async (filter, changes, options) => {
  if (!matches(row, filter)) return { matchedCount: 0 };
  const before = row.updatedAt;
  update(row, changes); if (options?.timestamps === false) row.updatedAt = before;
  return { matchedCount: 1 };
};
const query = () => ({ populate() { return this; }, then(resolve) { return Promise.resolve(clone(row)).then(resolve); } });
MaintenanceRequest.findById = query;
LandlordPolicy.findOne = () => ({ lean: async () => clone(policy) });
const vendor = { _id: "507f191e810c19729de860ef", name: "Real vendor", email: "vendor@artrelo.test", source: "preset", status: "active", verificationStatus: "trusted", specialties: ["Plumbing"], city: "Regina" };
let preservedVisits = [];
require("../../../models/Appointment").updateOne = async (filter, change) => { preservedVisits.push({ filter, change }); return { matchedCount: 1 }; };
VendorOutreach.find = () => ({ select() { return this; }, lean: async () => [{ appointmentId: "old-visit", vendorNameSnapshot: "Original vendor name" }] });
Vendor.findOne = () => ({ lean: async () => clone(vendor) });
require("../../../models/Appointment").exists = async () => false;
VendorOutreach.findOne = () => ({ sort: async () => outreach && clone(outreach) });
VendorOutreach.updateOne = async (filter, changes) => { if (outreach && matches(outreach, filter)) update(outreach, changes); };
let cleanupCalls = [];
VendorOutreach.deleteMany = async filter => { cleanupCalls.push(filter); outreach = null; return { deletedCount: 1 }; };
ApprovalRequest.updateMany = async () => ({});
ApprovalRequest.findOne = async () => approvals[0] || null;
ApprovalRequest.prototype.save = async function () { if (!approvals.includes(this)) approvals.push(this); return this; };
require("../../../services/notification/notify.service").notifyUser = async (n) => notices.push(n);
require("../../../services/audit/agentAction.service").logAgentAction = async (event) => { auditEvents.push(event); };
require("../../../models/AgentActionLog").create = async () => ({});
const candidate = { candidateKey: "preset__real", vendorId: vendor._id, name: vendor.name, source: "preset", verificationStatus: "trusted",
  state: "recommended", displayGroup: "recommended", contact: { hasEmail: true, email: vendor.email }, draftMessage: "A repair is needed", priceEstimate: null };
require("../../../services/vendor/vendorRecommendation.service").generateVendorRecommendations = async ({ request, policy: p }) => {
  searches++;
  if (duringSearch) await duringSearch();
  if (searchFailure) throw new Error("database unavailable");
  const decision = guardAutopilotDecision({ request, policy: p, candidate, decision: { candidateKey: candidate.candidateKey,
    actionType: "recommend_preset_vendor", approvalRequired: false, quotaLimit: 300 } });
  return { version: "v1", generatedAt: new Date().toISOString(), decision, candidateLedger: [clone(candidate)], recommendations: [clone(candidate)] };
};
require("../../../services/vendor/vendorOutreach.service").sendVendorOutreach = async ({ initialRoutingToken, initiation }) => {
  assert.strictEqual(initialRoutingToken, row.initialRouting.leaseToken);
  assert.strictEqual(initiation,'policy_auto_start','automatic contact records its origin');
  assert.deepStrictEqual(auditEvents.map(event=>event.actionType),['vendor_recommendations_generated'],
    'preparation never invents authorization; the actual send boundary owns the transactional permission receipt');
  await new Promise(resolve=>setTimeout(resolve,5));
  auditEvents.push({actionType:'vendor_outreach_sent'});
  sends++; outreach = { _id: "outreach", status: "sent" }; return { delivered: true, outreach };
};
const { processInitialRouting, takeOverInitialRouting } = require("../../../services/request/initialRouting.service");
function reset() {
  auditEvents = [];
  row = { _id: "507f191e810c19729de860eb", tenantId: "507f191e810c19729de860ec", landlordId: "507f191e810c19729de860ed",
    status: "queued", urgency: "low", archivedAt: null, issueTitle: "Tap", issueDescription: "Drips", category: "Plumbing", vendorTypeNeeded: "Plumbing",
    propertyId: { address: "Regina" }, timeline: [], ai: { severity: 1 },
    intakeFollowUp: {state:'reviewed',revision:1,remainingTopics:[]},
    routingReadiness: { state: "ready_to_route", blocking: false },
    initialRouting: { status: "pending", attempts: 0, nextAttemptAt: new Date(0) }, updatedAt: new Date() };
  row.routingAuthority = { digest: routingDigest(row) };
  policy = { defaultQuota: 300, maxOutreachAttempts: 3, allowAutopilotForLowSeverity: true };
  outreach = null; searches = 0; sends = 0; approvals = []; notices = []; searchFailure = false; duringSearch = null;
  cleanupCalls = [];
  preservedVisits = [];
}
async function main() {
  reset();
  await Promise.all([processInitialRouting(row._id), processInitialRouting(row._id)]);
  assert.strictEqual(searches, 1, "only one worker owns a claim");
  assert.strictEqual(sends, 1); assert.strictEqual(row.initialRouting.status, "done");
  assert.deepStrictEqual(auditEvents.map(event=>event.actionType),['vendor_recommendations_generated','vendor_outreach_sent'],
    'preparation precedes delayed delivery; permission is no longer invented by this preparation layer');
  assert.strictEqual(auditEvents[0].output.autoStarted,undefined,'preparation does not claim a send outcome');
  assert.strictEqual(row.timeline[0].actorRole, "system"); assert.strictEqual(approvals.length, 0);
  reset(); row.workflowAlertPending = true;
  duringSearch = async () => {
    const before = row.updatedAt;
    await require('../../../services/notification/newRequestAlert.service').alertLandlordOfNewRequest({ request: { ...clone(row), propertyId: null } });
    assert.strictEqual(row.workflowAlertPending, false);
    assert.strictEqual(row.updatedAt, before, 'notification bookkeeping preserves the routing snapshot timestamp');
  };
  await processInitialRouting(row._id);
  assert.strictEqual(sends, 1, 'concurrent in-app submission notice cannot strand the routing lease');
  assert.strictEqual(row.initialRouting.status, 'done');
  reset(); row.urgency='medium'; row.ai.severity=3; policy.allowAutopilotForMediumSeverity=true;
  row.routingAuthority.digest=routingDigest(row);
  await processInitialRouting(row._id);
  assert.strictEqual(sends,1,'enabled medium-severity automation starts contact');
  reset(); row.intakeFollowUp={state:'ready_for_review',revision:2,remainingTopics:['timeline']};
  await processInitialRouting(row._id);
  assert.strictEqual(sends,0,'unreviewed details block automatic low-severity contact');
  reset(); policy.allowAutopilotForLowSeverity = false;
  await processInitialRouting(row._id);
  assert.strictEqual(sends, 0); assert.strictEqual(approvals.length, 1); assert.strictEqual(row.routingStatus, "approval_needed");
  assert.strictEqual(approvals[0].payload.vendorName, vendor.name);
  reset(); row.urgency = "emergency"; row.routingAuthority.digest = routingDigest(row);
  await processInitialRouting(row._id);
  assert.strictEqual(sends, 0); assert.strictEqual(approvals[0].payload.priority, "emergency");
  reset(); searchFailure = true;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await processInitialRouting(row._id);
    assert.strictEqual(row.initialRouting.attempts, attempt);
    row.initialRouting.nextAttemptAt = new Date(0);
  }
  assert.strictEqual(row.initialRouting.status, "failed"); assert.strictEqual(notices.length, 1);
  assert.strictEqual(auditEvents.length,0,'failed preparation is never logged as completed generation');
  assert.strictEqual(row.routingStatus, "paused"); assert.ok(row.vendorRecommendationSnapshot);
  reset(); row.initialRouting = { status: "processing", leaseToken: "dead-process", leaseUntil: new Date(0), attempts: 1 };
  await processInitialRouting(row._id); assert.strictEqual(sends, 1, "expired leases recover after restart");
  reset(); outreach = { _id: "old", status: "queued" };
  await processInitialRouting(row._id); assert.strictEqual(sends, 0); assert.strictEqual(outreach.status, "delivery_failed");
  reset(); duringSearch = async () => { row.status = "cancelled"; row.updatedAt = new Date(Date.now() + 1); };
  await processInitialRouting(row._id); assert.strictEqual(sends, 0); assert.strictEqual(row.vendorRecommendationSnapshot, undefined);
  reset(); await takeOverInitialRouting(clone(row)); await processInitialRouting(row._id);
  assert.strictEqual(searches, 0, "manual takeover prevents recovery from starting outreach");
  reset(); row.initialRouting.status = "processing"; row.initialRouting.leaseUntil = new Date(Date.now() + 60_000);
  await assert.rejects(() => takeOverInitialRouting(clone(row)), (e) => e.code === "routing_in_progress");
  reset(); duringSearch = async () => { row.initialRouting.leaseToken = "new-owner"; };
  await processInitialRouting(row._id); assert.strictEqual(sends, 0); assert.strictEqual(row.vendorRecommendationSnapshot, undefined);
  reset(); const reopenedAt = new Date();
  row.initialRouting.cleanupBefore = reopenedAt; row.initialRouting.requiresContactReview = true;
  outreach = { _id: "first-round", status: "declined" };
  await assert.rejects(() => takeOverInitialRouting(clone(row)), error => error.code === "routing_in_progress");
  duringSearch = async () => assert.strictEqual(cleanupCalls.length, 1, "cleanup precedes search");
  await processInitialRouting(row._id);
  assert.strictEqual(searches, 1); assert.strictEqual(sends, 0, "reopening prepares search, never contacts on old consent");
  assert.strictEqual(row.initialRouting.cleanupBefore, null);
  assert.strictEqual(row.initialRouting.status, "done");
  assert.strictEqual(row.vendorRecommendationSnapshot.decision.reasonCode, "reopened_request_review_required");
  assert.deepStrictEqual(cleanupCalls[0].createdAt, { $lt: reopenedAt }, "new rounds cannot be deleted on recovery");
  assert.strictEqual(preservedVisits[0].change.$set.vendorNameSnapshot, "Original vendor name", "cleanup preserves historical visit identity");
  console.log("initialRouting lease/recovery tests passed");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
