const mongoose = require("mongoose");
const { createHash } = require("node:crypto");
const Approval = require("../../models/ApprovalRequest");
const Request = require("../../models/MaintenanceRequest");
const Receipt = require("../../models/ScopeReviewReopen");
const Audit = require("../../models/AgentActionLog");
const reviewService = require("./review.service");
const { publish } = require("../realtime/liveEvents.service");
const id = value => String(value?._id || value || "");
const hash = value => createHash("sha256").update(value).digest("hex");
const oid = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const hex = value => typeof value === "string" && /^[a-f\d]{64}$/.test(value);
const fail = (code, statusCode = 409) => Object.assign(new Error({
  invalid_reopen_input: "Check the scope-review reopening request.",
  review_not_found: "This scope review is not available.",
  stale_cost_review: "The scope review changed. Refresh the current record before trying again.",
  review_request_closed: "This request is closed. Its scope review cannot be reopened.",
  review_not_reopenable: "This scope review cannot be reopened in its current state.",
  idempotency_conflict: "This action identifier was already used for a different reopening request.",
  review_reopen_unavailable: "The reopening outcome could not be verified. Refresh the current review before trying again.",
}[code] || "The scope review could not be reopened."), { code, statusCode });
const MESSAGE = "Scope review reopened. Confirm scope review in Decisions. Reopening does not authorize spending or payment.";
const purposes = ["scope_review", "analysis_unavailable"];

function validateInput({ requestId, subjectId, stage, body }) {
  const keys = ["expectedReviewRevision", "expectedQuoteRevision", "expectedQuoteHash", "expectedContextHash", "declinedApprovalId", "idempotencyKey"];
  if (!oid(requestId) || !oid(subjectId) || !["quote", "invoice"].includes(stage) || !body || Array.isArray(body) ||
      Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key)) ||
      !Number.isSafeInteger(body.expectedReviewRevision) || body.expectedReviewRevision < 0 || body.expectedReviewRevision >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(body.expectedQuoteRevision) || body.expectedQuoteRevision < 1 || body.expectedQuoteRevision > 5 ||
      !hex(body.expectedQuoteHash) || !hex(body.expectedContextHash) || !oid(body.declinedApprovalId) ||
      typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.idempotencyKey)) throw fail("invalid_reopen_input", 400);
}

function reopenDescriptor({ subject, stage, approval, request }) {
  const review = stage === "invoice" ? subject.invoiceReview : subject.quoteReview;
  const snapshot = stage === "invoice" ? subject.report?.finalStatement :
    subject.quoteRevisions?.find(row => row.revision === subject.currentQuoteRevision);
  const active = stage === "invoice" ? ["awaiting_tenant", "confirmed", "in_review"].includes(subject.status) :
    subject.status === "accepted" && !subject.appointmentId;
  const revision = review?.revision ?? 0;
  if (!request || request.archivedAt || ["completed", "rejected", "cancelled"].includes(request.status) ||
      !active || id(subject.requestId) !== id(request) || subject.quoteContractVersion !== 2 || review?.state !== "rejected" ||
      !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER ||
      !snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || snapshot.revision > 5 ||
      !hex(snapshot.hash) || !hex(review.contextHash) || review.quoteHash !== snapshot.hash ||
      !approval || approval.status !== "rejected" || approval.type !== "cost_review" ||
      approval.payload?.source !== "iris_cost_review" || !purposes.includes(approval.payload.purpose) ||
      id(approval._id) !== id(review.approvalId) || id(approval.landlordId) !== id(subject.landlordId) ||
      id(approval.requestId) !== id(request) || id(approval.payload.subjectId) !== id(subject) || approval.payload.stage !== stage ||
      approval.payload.quoteRevision !== snapshot.revision || approval.payload.quoteHash !== snapshot.hash ||
      approval.payload.contextHash !== review.contextHash) return null;
  return { expectedReviewRevision: revision, expectedQuoteRevision: snapshot.revision, expectedQuoteHash: snapshot.hash,
    expectedContextHash: review.contextHash, declinedApprovalId: id(approval) };
}

function presentReceipt(row, replayed) {
  return { stage: row.stage, subjectId: id(row.subjectId), approvalId: id(row.approvalId),
    reviewRevision: row.reviewRevision, state: "needs_review", replayed, message: MESSAGE };
}

async function reopenReview({ landlordId, requestId, subjectId, stage, body }) {
  validateInput({ requestId, subjectId, stage, body });
  // Ownership is checked even on a receipt replay. A receipt is not current state.
  const owned = await Request.findOne({ _id: requestId, landlordId }).select("_id").lean();
  if (!owned) throw fail("review_not_found", 404);
  const { idempotencyKey, ...expected } = body;
  const keyScope = { landlordId, keyHash: hash(idempotencyKey) };
  const fingerprint = hash(JSON.stringify([requestId, subjectId, stage, body.expectedReviewRevision,
    body.expectedQuoteRevision, body.expectedQuoteHash, body.expectedContextHash, body.declinedApprovalId]));
  const replay = row => {
    if (row.fingerprint !== fingerprint) throw fail("idempotency_conflict");
    return presentReceipt(row, true);
  };
  const prior = await Receipt.findOne(keyScope).lean();
  if (prior) return replay(prior);
  let result;
  try {
    result = await mongoose.connection.transaction(async session => {
      const existing = await Receipt.findOne(keyScope).session(session).lean();
      if (existing) return replay(existing);
      let basis;
      try { basis = await reviewService.loadBasis({ subjectId, stage, landlordId, session }); }
      catch (error) {
        if (error.code === "review_subject_missing") throw fail("review_not_found", 404);
        if (error.code === "review_request_closed") throw fail("review_request_closed");
        if (error.statusCode === 409) throw fail("stale_cost_review");
        throw error;
      }
      if (id(basis.request) !== id(requestId)) throw fail("review_not_found", 404);
      const old = await Approval.findOne({ _id: body.declinedApprovalId, landlordId, requestId, type: "cost_review" }).session(session).lean();
      const descriptor = reopenDescriptor({ subject: basis.subject, stage, approval: old, request: basis.request });
      if (!descriptor) throw fail("review_not_reopenable");
      if (Object.entries(descriptor).some(([key, value]) => expected[key] !== value) || basis.contextHash !== body.expectedContextHash) throw fail("stale_cost_review");
      // Serialize with request closure/cancellation and any concurrent request edit.
      const fence = await Request.updateOne({ _id: requestId, landlordId, archivedAt: null,
        status: { $nin: ["completed", "rejected", "cancelled"] } }, { $inc: { policyCheckpointFence: 1 } }, { session });
      if (!fence.matchedCount) throw fail("review_request_closed");
      const revision = body.expectedReviewRevision + 1;
      const approvalId = new mongoose.Types.ObjectId();
      const reviewKey = `${stage}:${subjectId}:${basis.snapshot.hash}:${basis.contextHash}:${old.payload.purpose}:reopen:${revision}`;
      const changed = await basis.Model.updateOne({ _id: subjectId, landlordId, requestId,
        ...(stage === "invoice" ? { status: { $in: ["awaiting_tenant", "confirmed", "in_review"] }, "report.finalStatement.hash": basis.snapshot.hash,
          "report.finalStatement.revision": basis.snapshot.revision } : { status: "accepted", appointmentId: null,
          currentQuoteRevision: basis.snapshot.revision, quoteRevisions: { $elemMatch: { revision: basis.snapshot.revision, hash: basis.snapshot.hash } } }),
        [`${basis.review}.state`]: "rejected", [`${basis.review}.approvalId`]: old._id,
        [`${basis.review}.quoteHash`]: basis.snapshot.hash, [`${basis.review}.contextHash`]: basis.contextHash,
        ...(body.expectedReviewRevision === 0 ? { $or: [{ [`${basis.review}.revision`]: 0 }, { [`${basis.review}.revision`]: { $exists: false } }] } :
          { [`${basis.review}.revision`]: body.expectedReviewRevision }),
      }, { $set: { [`${basis.review}.state`]: "needs_review", [`${basis.review}.revision`]: revision,
        [`${basis.review}.approvalId`]: approvalId, [`${basis.review}.resumePending`]: false, [`${basis.review}.clearedAt`]: null } }, { session });
      if (!changed.matchedCount) throw fail("stale_cost_review");
      const approval = new Approval({ _id: approvalId, landlordId, requestId, type: "cost_review", status: "pending",
        expiresAt: new Date(Date.now() + 24 * 3600_000), reason: stage === "invoice" ?
          "Scope review reopened. Review the final itemized charges before financial close. This does not authorize spending or payment." :
          "Scope review reopened. Review the itemized quote and scope before booking. This does not authorize spending or payment.",
        payload: { source: "iris_cost_review", purpose: old.payload.purpose, stage, subjectId, reviewKey, reviewRevision: revision,
          quoteRevision: basis.snapshot.revision, quoteHash: basis.snapshot.hash, contextHash: basis.contextHash,
          analysisId: old.payload.analysisId, reopenedFromApprovalId: id(old) } });
      // Existing save hooks otherwise notify before commit. Reopen adds no delivery.
      approval.$locals.deferPolicyEffects = true;
      await approval.save({ session });
      const [audit] = await Audit.create([{ landlordId, requestId, actor: "landlord", actionType: "cost_review_reopened",
        summary: "The landlord reopened the declined scope review. A fresh human Decision is required; no spending or payment was authorized.",
        input: { stage, subjectId, declinedApprovalId: id(old), quoteRevision: basis.snapshot.revision, quoteHash: basis.snapshot.hash,
          contextHash: basis.contextHash, expectedReviewRevision: body.expectedReviewRevision },
        output: { approvalRequestId: id(approvalId), reviewRevision: revision, state: "needs_review" },
        metadata: { occurredAt: approval.createdAt, occurrenceSource: "approval.createdAt",
          cause: { kind: "approval", id: old._id } } }], { session });
      const [receipt] = await Receipt.create([{ ...keyScope, fingerprint, requestId, subjectId, stage,
        declinedApprovalId: old._id, approvalId, reviewRevision: revision, quoteRevision: basis.snapshot.revision,
        quoteHash: basis.snapshot.hash, contextHash: basis.contextHash, auditId: audit._id }], { session });
      return presentReceipt(receipt, false);
    });
  } catch (error) {
    // Includes duplicate keys and an uncertain commit acknowledgment: read durable
    // receipt, never issue another write attempt or roll back a possibly committed action.
    const committed = await Receipt.findOne(keyScope).lean().catch(() => null);
    if (committed) return replay(committed);
    if (["review_not_found", "stale_cost_review", "review_request_closed", "review_not_reopenable", "idempotency_conflict"].includes(error.code)) throw error;
    throw fail("review_reopen_unavailable", 503);
  }
  // These are nudges only. The atomic receipt/audit remains authoritative if a
  // process exits here; current GET/replay can recover without another reopening.
  publish(landlordId, "requests"); publish(landlordId, `request:${requestId}`);
  return result;
}

module.exports = { reopenReview, reopenDescriptor, validateInput, MESSAGE };
