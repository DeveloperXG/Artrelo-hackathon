const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Outreach = require("../../../models/VendorOutreach");
const Request = require("../../../models/MaintenanceRequest");
const Policy = require("../../../models/LandlordPolicy");
const Checkpoint = require("../../../models/PolicyCheckpoint");
const { createQuoteSnapshot } = require("../../../services/quotes/itemization.service");
const svc = require("../../../services/quotes/quoteCheckpoint.service");
const snapshot = createQuoteSnapshot({ pricingMode: "fixed", currency: "CAD", items: [
  { description: "Repair", category: "labour", amountMinor: 21000 },
], totals: { lowMinor: 21000, highMinor: 21000 } }, { revision: 1 });
let outreach, request, policy, records, fences;
const query = value => ({ session() { return this; }, lean: async () => structuredClone(value) });
function matches(row, filter) { return Object.entries(filter).every(([key, value]) => row[key] === value); }
mongoose.connection.transaction = async work => work({ syntheticSession: true });
Outreach.findOne = filter => query(outreach.landlordId === filter.landlordId && outreach._id === filter._id && outreach.status === "accepted" && !outreach.appointmentId ? outreach : null);
Request.findOne = filter => query(request._id === filter._id && request.landlordId === filter.landlordId ? request : null);
Request.updateOne = async (_filter, patch, options) => { assert(options.session); assert.equal(patch.$inc.policyCheckpointFence, 1); return { matchedCount: 1 }; };
Policy.findOneAndUpdate = async (_filter, patch, options) => {
  assert(options.session); assert.equal(patch.$inc.checkpointFence, 1); fences++;
  return structuredClone(policy);
};
Checkpoint.findOne = filter => query(records.find(row => matches(row, filter)) || null);
Checkpoint.create = async ([row], options) => { assert(options.session); const saved = { ...structuredClone(row), _id: `checkpoint-${records.length + 1}` }; records.push(saved); return [saved]; };
Outreach.updateOne = async (_filter, patch, options) => { assert(options.session); Object.assign(outreach, structuredClone(patch.$set)); return { matchedCount: 1 }; };
function reset() {
  outreach = { _id: "outreach", landlordId: "owner", requestId: "request", status: "accepted", appointmentId: null,
    quoteContractVersion: 2, currentQuoteRevision: 1, quoteRevisions: [structuredClone(snapshot)],
    response: { quoteHigh: 210, submittedAt: new Date("2026-10-28T08:00:00Z") } };
  request = { _id: "request", landlordId: "owner", status: "queued", category: "Plumbing" };
  policy = { defaultQuota: 300, policyRevision: 1 }; records = []; fences = 0;
}
const args = { outreachId: "outreach", landlordId: "owner" };
async function main() {
  reset();
  const first = await svc.claimQuoteCheckpoint(args);
  assert.equal(first.record.state, "passed"); assert.equal(first.record.policyRevision, 1);
  assert.equal(first.record.quoteHighMinor, 21000); assert(first.record.passedAt);
  assert.equal(fences, 1);
  policy.defaultQuota = 100; policy.policyRevision = 2;
  const retry = await svc.claimQuoteCheckpoint(args);
  assert.equal(retry.reused, true); assert.equal(retry.quotaCheck.overQuota, false);
  assert.equal(retry.record.policyRevision, 1, "later lower quota never reflags a passed quote");
  assert.equal(records.length, 1); assert.equal(fences, 1, "passed quote does not cross the policy checkpoint again");
  outreach.currentQuoteRevision = 2;
  outreach.quoteRevisions.push({ ...structuredClone(snapshot), revision: 2 });
  const revised = await svc.claimQuoteCheckpoint(args);
  assert.equal(revised.record.state, "review_required"); assert.equal(revised.record.policyRevision, 2);
  assert.equal(records.length, 2, "new quote revision crosses a new checkpoint");
  policy.defaultQuota = 250; policy.policyRevision = 3;
  const unpassed = await svc.claimQuoteCheckpoint(args);
  assert.equal(unpassed.record.state, "passed"); assert.equal(unpassed.record.policyRevision, 3);
  assert.equal(records[1].state, "review_required", "previous attempt remains historical evidence");
  await assert.rejects(svc.claimQuoteCheckpoint({ ...args, landlordId: "other" }), /changed/);
  assert.equal(svc.quotaSource({ defaultQuota: 500, unitQuotas: { unit: 200 } }, { unitId: "unit", quotaOverride: 400 }), "request");
  assert.equal(svc.quotaSource({ defaultQuota: 500, unitQuotas: { unit: 200 } }, { unitId: "unit" }), "unit");

  const old = { response: { quoteHigh: 210 }, quotaCheck: { limit: 300, quoteHigh: 210, overQuota: false,
    evaluatedAt: new Date("2026-10-27T12:00:00Z") } };
  assert.equal(svc.passedLegacyCheck(old).limit, 300, "legacy passage uses actual saved evidence, no invented revision");
  assert.equal(svc.passedLegacyCheck({ ...old, authorizedCeilingAt: new Date("2026-10-28T12:00:00Z") }), null);
  assert.equal(svc.passedLegacyCheck({ response: { quoteHigh: 210 } }), null, "absence is not proof of passage");
  assert.equal(svc.passedLegacyCheck({ ...old, quotaCheck: { ...old.quotaCheck, limit: null } }), null);
  reset();
  outreach.quoteReview = { state: "cleared", quoteHash: snapshot.hash };
  outreach.approvedQuoteSnapshot = structuredClone(snapshot);
  assert.equal(svc.itemizedBookingMatches(outreach, structuredClone(outreach)), true);
  const newer = structuredClone(outreach); newer.currentQuoteRevision = 2;
  newer.quoteRevisions.push({ ...structuredClone(snapshot), revision: 2 });
  assert.equal(svc.itemizedBookingMatches(newer, outreach), false, "transaction rejects a quote-revision race");
  const changedAuthority = structuredClone(outreach); changedAuthority.authorizedCeiling = 150;
  assert.equal(svc.itemizedBookingMatches(changedAuthority, outreach), false);
  const pending = structuredClone(outreach); pending.quoteReview.state = "pending";
  assert.equal(svc.itemizedBookingMatches(pending, outreach), false);
  console.log("Quote checkpoints: transactional claim boundary, immutable passed latch, new-revision/current-policy and truthful legacy evidence PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
