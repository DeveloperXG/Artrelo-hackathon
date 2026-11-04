const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { validateInput, reopenDescriptor } = require("../../../services/quotes/reopenReview.service");
const oid = () => new mongoose.Types.ObjectId().toString();
const landlordId = oid(), requestId = oid(), subjectId = oid(), approvalId = oid();
const quoteHash = "a".repeat(64), contextHash = "b".repeat(64);
const body = { expectedReviewRevision: 0, expectedQuoteRevision: 1, expectedQuoteHash: quoteHash,
  expectedContextHash: contextHash, declinedApprovalId: approvalId, idempotencyKey: "p0_explicit_attempt_0001" };
const args = { requestId, subjectId, stage: "invoice", body };
assert.doesNotThrow(() => validateInput(args));
for (const key of Object.keys(body)) {
  const missing = { ...body }; delete missing[key];
  assert.throws(() => validateInput({ ...args, body: missing }), e => e.code === "invalid_reopen_input" && e.statusCode === 400);
}
for (const patch of [{ approvedAmount: 200 }, { status: "approved" }, { expectedReviewRevision: -1 },
  { expectedReviewRevision: "0" }, { expectedReviewRevision: Number.MAX_SAFE_INTEGER }, { expectedQuoteRevision: 1.5 },
  { expectedQuoteRevision: 6 }, { expectedQuoteHash: "stale" }, { expectedContextHash: "B".repeat(64) },
  { declinedApprovalId: "foreign" }, { idempotencyKey: "short" }, { idempotencyKey: "key with spaces and text" }]) {
  assert.throws(() => validateInput({ ...args, body: { ...body, ...patch } }), e => e.code === "invalid_reopen_input");
}
assert.throws(() => validateInput({ ...args, stage: "other" }), e => e.code === "invalid_reopen_input");
const request = { _id: requestId, status: "approved" };
const subject = { _id: subjectId, landlordId, requestId, quoteContractVersion: 2, status: "confirmed",
  report: { finalStatement: { revision: 1, hash: quoteHash } },
  invoiceReview: { state: "rejected", approvalId, quoteHash, contextHash } };
const approval = { _id: approvalId, landlordId, requestId, type: "cost_review", status: "rejected",
  payload: { source: "iris_cost_review", purpose: "scope_review", subjectId, stage: "invoice", quoteRevision: 1, quoteHash, contextHash } };
const input = () => structuredClone({ subject, stage: "invoice", request, approval });
const { idempotencyKey, ...expected } = body;
assert.deepEqual(reopenDescriptor(input()), expected, "legacy absent revision means0, with exact prior Decision binding");
for (const mutate of [
  x => { x.request.status = "completed"; }, x => { x.request.archivedAt = new Date(); },
  x => { x.subject.status = "closed"; }, x => { x.subject.quoteContractVersion = undefined; },
  x => { x.subject.invoiceReview.state = "cleared"; }, x => { x.subject.invoiceReview.contextHash = "unknown"; },
  x => { x.subject.invoiceReview.revision = -1; }, x => { x.subject.invoiceReview.quoteHash = "c".repeat(64); },
  x => { x.approval.status = "pending"; }, x => { x.approval.type = "quota_increase"; },
  x => { x.approval.landlordId = oid(); }, x => { x.approval.requestId = oid(); },
  x => { x.approval.payload.subjectId = oid(); }, x => { x.approval.payload.stage = "quote"; },
  x => { x.approval.payload.purpose = "clarification_permission"; }, x => { x.approval.payload.source = "other"; },
  x => { x.approval.payload.quoteRevision = 2; }, x => { x.approval.payload.quoteHash = "c".repeat(64); },
  x => { x.approval.payload.contextHash = "c".repeat(64); }, x => { x.approval = null; },
]) { const changed = input(); mutate(changed); assert.equal(reopenDescriptor(changed), null); }
const quote = input(); quote.stage = "quote"; quote.subject.status = "accepted";
quote.subject.currentQuoteRevision = 1; quote.subject.quoteRevisions = [quote.subject.report.finalStatement];
quote.subject.quoteReview = quote.subject.invoiceReview; quote.approval.payload.stage = "quote";
assert.deepEqual(reopenDescriptor(quote), expected);
quote.subject.appointmentId = oid(); assert.equal(reopenDescriptor(quote), null, "a booked historical quote cannot be reopened");
const generation = input(); generation.subject.invoiceReview.revision = 2;
assert.equal(reopenDescriptor(generation).expectedReviewRevision, 2);
const unavailable = input(); unavailable.approval.payload.purpose = "analysis_unavailable";
assert(reopenDescriptor(unavailable));
console.log("P0 reopen contract: strict no-amount input, exact generation/hash/ownership/history descriptor, legacy0 and unavailable-analysis scope boundaries PASS");
