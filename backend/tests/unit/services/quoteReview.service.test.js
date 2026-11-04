const assert = require("node:assert/strict");
const { createQuoteSnapshot } = require("../../../services/quotes/itemization.service");
const Outreach = require("../../../models/VendorOutreach");
const Completion = require("../../../models/JobCompletion");
const Request = require("../../../models/MaintenanceRequest");
const Approval = require("../../../models/ApprovalRequest");
const Analysis = require("../../../models/QuoteAnalysis");
require("../../../services/audit/agentAction.service").logAgentAction = async () => {};
require("../../../services/realtime/liveEvents.service").publish = () => {};
require("../../../services/notification/notify.service").notifyUser = async () => {};
let resumes = 0;
require.cache[require.resolve("../../../services/vendor/vendorAcceptance.service")] = { exports: {
  finalizeVendorAcceptance: async () => { resumes++; },
} };
const svc = require("../../../services/quotes/review.service");
const snapshot = createQuoteSnapshot({ pricingMode: "fixed", currency: "CAD", items: [
  { description: "Repair", category: "labour", amountMinor: 21000 },
], totals: { lowMinor: 21000, highMinor: 21000 } }, { revision: 1 });
let subject, request, analyses, approvals;
function reset() {
  subject = { _id: "subject", landlordId: "owner", requestId: "request", status: "accepted", appointmentId: null,
    quoteContractVersion: 2, currentQuoteRevision: 1, quoteRevisions: [structuredClone(snapshot)],
    quoteReview: { state: "pending", quoteHash: snapshot.hash } };
  request = { _id: "request", landlordId: "owner", status: "queued", issueTitle: "Sink", ai: { summary: "Dripping trap" } };
  analyses = []; approvals = []; resumes = 0;
}
const get = (doc, path) => path.split(".").reduce((value, key) => value?.[key], doc);
function matches(doc, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some(part => matches(doc, part));
    const actual = get(doc, key);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if (value.$in) return value.$in.includes(actual);
      if (value.$nin) return !value.$nin.includes(actual);
      if (Object.hasOwn(value, "$ne")) return actual !== value.$ne;
      if (value.$lte) return actual <= value.$lte;
      if (value.$elemMatch) return actual?.some(row => matches(row, value.$elemMatch));
    }
    return actual === value;
  });
}
function update(doc, patch) {
  for (const [path, value] of Object.entries(patch.$set || {})) {
    const parts = path.split("."); let parent = doc;
    for (const key of parts.slice(0, -1)) parent = parent[key] ||= {};
    parent[parts.at(-1)] = structuredClone(value);
  }
  for (const path of Object.keys(patch.$unset || {})) delete doc[path];
}
Outreach.findOne = filter => ({ lean: async () => matches(subject, filter) ? structuredClone(subject) : null });
Outreach.updateOne = async (filter, patch) => { if (!matches(subject, filter)) return { matchedCount: 0 }; update(subject, patch); return { matchedCount: 1 }; };
Request.findOne = filter => ({ lean: async () => matches(request, filter) ? structuredClone(request) : null });
Request.updateOne = async (filter, patch) => { if (!matches(request, filter)) return { matchedCount: 0 }; update(request, patch); return { matchedCount: 1 }; };
function collection(Model, rows) {
  Model.findOneAndUpdate = async (filter, patch, opts = {}) => {
    let doc = rows().find(row => matches(row, filter));
    if (!doc && opts.upsert) { doc = { _id: `record-${rows().length + 1}`, ...structuredClone(patch.$setOnInsert) }; rows().push(doc); }
    if (!doc) return null;
    update(doc, patch); return structuredClone(doc);
  };
  Model.findOne = async filter => structuredClone(rows().find(row => matches(row, filter)) || null);
  Model.findById = async key => structuredClone(rows().find(row => row._id === key) || null);
  Model.updateOne = async (filter, patch) => { const doc = rows().find(row => matches(row, filter)); if (!doc) return { matchedCount: 0 }; update(doc, patch); return { matchedCount: 1 }; };
  Model.updateMany = async (filter, patch) => { for (const doc of rows().filter(row => matches(row, filter))) update(doc, patch); return {}; };
}
collection(Analysis, () => analyses); collection(Approval, () => approvals);
const args = { subjectId: "subject", stage: "quote", landlordId: "owner" };
const body = () => ({ expectedQuoteRevision: 1, expectedQuoteHash: snapshot.hash });
const clean = () => ({ schemaVersion: 1, summary: "Submitted breakdown recorded.", flags: [], questions: [], reviewRecommendation: "no_additional_flags" });

async function main() {
  reset();
  let calls = 0, release;
  const first = svc.runReview({ ...args, source: "development_stub", complete: async () => {
    calls++; await new Promise(resolve => { release = resolve; }); return clean();
  } });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const duplicate = await svc.runReview(args);
  assert.equal(duplicate.pending, true); assert.equal(calls, 1);
  release(); const completed = await first;
  assert.equal(completed.analysis.source, "development_stub");
  assert.equal(analyses.length, 1); assert.equal(approvals.length, 1);
  assert.equal(approvals[0].type, "cost_review");
  assert.equal(subject.quoteReview.state, "needs_review", "a clean simulation never approves spend or clears human review");
  await svc.runReview(args);
  assert.equal(approvals.length, 1, "same context reuses one pending decision");
  const approval = structuredClone(approvals[0]);
  await assert.rejects(svc.validateDecision({ approval, body: { ...body(), approvedAmount: 1000 }, landlordId: "owner" }), /changed/);
  await assert.rejects(svc.validateDecision({ approval, body: { ...body(), expectedQuoteHash: "stale" }, landlordId: "owner" }), /changed/);
  await assert.rejects(svc.validateDecision({ approval, body: body(), landlordId: "other-owner" }), /changed/);
  await svc.applyDecision({ approval, body: body(), landlordId: "owner", status: "approved" });
  assert.equal(subject.quoteReview.state, "cleared"); assert.equal(resumes, 1);
  assert.equal(request.quotaOverride, undefined, "cost review does not raise a quota");
  await assert.rejects(svc.applyDecision({ approval, body: body(), landlordId: "owner", status: "approved" }), /changed/);
  assert.equal(resumes, 1);

  reset();
  const invalid = await svc.runReview({ ...args, complete: async () => ({ ...clean(), approve: true }) });
  assert.equal(invalid.analysis.status, "unavailable"); assert.equal(subject.quoteReview.state, "needs_review");
  assert.equal(resumes, 0); assert.equal(approvals.length, 1);

  reset();
  const invalidMeta = await svc.runReview({ ...args, source: 'meta', complete: async () => ({ parsed: { ...clean(), approve: true },
    telemetry: { provider: 'meta', model: 'muse-spark-1.3', attempts: [{ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }] } }) });
  assert.equal(invalidMeta.analysis.status, 'unavailable');assert.equal(invalidMeta.analysis.source, 'disabled');
  assert.equal(invalidMeta.analysis.provider, undefined);assert.equal(invalidMeta.analysis.usage.totalTokens, 120);
  assert.equal(subject.quoteReview.state, 'needs_review');assert.equal(resumes, 0);

  reset();
  const stale = await svc.runReview({ ...args, complete: async () => { request.ai.summary = "Different scope"; return clean(); } });
  assert.equal(stale.stale, true); assert.equal(analyses[0].status, "stale"); assert.equal(approvals.length, 0);
  assert.equal(subject.quoteReview.state, "pending");

  reset();
  await svc.runReview(args);
  assert.equal(analyses[0].status, "unavailable", "no injected provider means no network path and human fallback");
  const rejected = structuredClone(approvals[0]);
  await svc.applyDecision({ approval: rejected, body: body(), landlordId: "owner", status: "rejected" });
  assert.equal(request.routingStatus, "paused"); assert.equal(subject.quoteReview.state, "rejected");
  await svc.runReview(args);
  assert.equal(approvals.length, 1, "analysis cannot overwrite a human rejection");
  assert.equal(resumes, 0);
  console.log("Quote review: lease/dedupe, invalid/stale fallback, scoped exact-context human review and no spend authority PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
