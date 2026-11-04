const mongoose = require("mongoose");
const { createHash, createHmac, randomBytes, randomUUID } = require("node:crypto");
const Clarification = require("../../models/QuoteClarification");
const Request = require("../../models/MaintenanceRequest");
const Policy = require("../../models/LandlordPolicy");
const Approval = require("../../models/ApprovalRequest");
const Outreach = require("../../models/VendorOutreach");
const Completion = require("../../models/JobCompletion");
const { createQuoteSnapshot } = require("./itemization.service");
const { logAgentAction } = require("../audit/agentAction.service");
const { publish } = require("../realtime/liveEvents.service");
const id = value => String(value?._id || value || "");
const digest = value => createHash("sha256").update(value).digest("hex");
const active = ["draft", "ready", "delivery_unknown"];
const failure = (code, statusCode = 409) => Object.assign(new Error("This clarification is unavailable or has changed."), { code, statusCode });
function binding(stage) { return stage === "quote" ? { Model: Outreach, field: "quoteReview" } : { Model: Completion, field: "invoiceReview" }; }
function snapshotOf(subject, stage) { return stage === "quote" ? subject.quoteRevisions?.find(row => row.revision === subject.currentQuoteRevision) : subject.report?.finalStatement; }
function subjectFilter(row, existingClarification = false) {
  return { _id: row.subjectId, landlordId: row.landlordId, requestId: row.requestId,
    ...(row.stage === "quote" ? { status: "accepted", appointmentId: null, currentQuoteRevision: row.quoteRevision,
      quoteRevisions: { $elemMatch: { revision: row.quoteRevision, hash: row.quoteHash } } } :
      { status: { $in: ["awaiting_tenant", "confirmed", "in_review"] }, "report.finalStatement.hash": row.quoteHash,
        "report.finalStatement.revision": row.quoteRevision,
        ...(existingClarification ? { "invoiceReview.contextHash": row.contextHash } : {}) }) };
}
function routineQuestions(result, snapshot) {
  if (result?.reviewRecommendation !== "clarify" || !result.questions?.length ||
    result.flags?.some(flag => !["unclear", "possible_duplicate"].includes(flag.code))) return [];
  const ids = new Set(snapshot.itemization.items.map(line => line.lineId));
  return result.questions.slice(0, 4).filter(question => ["unclear", "possible_duplicate"].includes(question.code) &&
    question.lineIds?.length && question.lineIds.every(lineId => ids.has(lineId))).map(question => ({
    id: randomUUID(), code: question.code, lineIds: [...new Set(question.lineIds)],
    text: question.code === "possible_duplicate" ? "Explain how these charges differ and what each covers." :
      "Describe the work or materials covered by these lines. Identify any change in scope.",
  }));
}
// Purpose-specific derivation permits durable delivery recovery without storing
// a raw bearer token. Nonce/hash are private; the existing server signing secret
// stays inside the application and is never projected or logged.
function deliveryToken(row) {
  const secret = require("../../config/env").jwt_secret;
  if (!secret || secret.length < 16 || !row.nonce) throw failure("clarification_signing_unavailable");
  return `qc_${id(row)}_${createHmac("sha256", secret).update(`quote-clarification:${id(row)}:${row.nonce}`).digest("base64url")}`;
}
async function openClarification({ basis, analysis, stage, permissionApprovalId = null }) {
  const questions = routineQuestions(analysis.result, basis.snapshot);
  if (!questions.length) return null;
  const result = await mongoose.connection.transaction(async session => {
    const existing = await Clarification.findOne({ subjectId: basis.subject._id, stage }).session(session).lean();
    if (existing) return { row: existing, created: false };
    const counter = await Request.updateOne({ _id: basis.request._id, landlordId: basis.subject.landlordId,
      status: { $nin: ["completed", "cancelled", "rejected"] }, archivedAt: null,
      $or: [{ quoteClarificationCount: { $lt: 2 } }, { quoteClarificationCount: { $exists: false } }] },
    { $inc: { quoteClarificationCount: 1, policyCheckpointFence: 1 } }, { session });
    if (!counter.matchedCount) throw failure("clarification_limit");
    const policy = await Policy.findOneAndUpdate({ landlordId: basis.subject.landlordId }, { $inc: { checkpointFence: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true, session, lean: true });
    if (permissionApprovalId) {
      const permission = await Approval.findOne({ _id: permissionApprovalId, landlordId: basis.subject.landlordId,
        requestId: basis.request._id, status: "approved", type: "cost_review", "payload.purpose": "clarification_permission",
        "payload.subjectId": id(basis.subject), "payload.contextHash": basis.contextHash,
        "payload.quoteHash": basis.snapshot.hash, "payload.quoteRevision": basis.snapshot.revision }).session(session).lean();
      if (!permission) throw failure("clarification_permission_changed");
    } else if (policy.allowQuoteClarification !== true) throw failure("clarification_permission_required");
    const row = { _id: new mongoose.Types.ObjectId(), landlordId: basis.subject.landlordId, requestId: basis.request._id,
      subjectId: basis.subject._id, stage, quoteRevision: basis.snapshot.revision, quoteHash: basis.snapshot.hash,
      contextHash: basis.contextHash, policyRevision: policy.policyRevision || 0, permissionApprovalId,
      nonce: randomBytes(24).toString("hex"), questions, expiresAt: new Date(Date.now() + 24 * 3600_000) };
    row.tokenHash = digest(deliveryToken(row));
    const { Model, field } = binding(stage);
    const claimed = await Model.updateOne({ ...subjectFilter(row), [`${field}.state`]: { $nin: ["cleared", "rejected", "waiting_clarification"] } },
      { $set: { [field]: { state: "waiting_clarification", quoteHash: row.quoteHash, contextHash: row.contextHash,
        analysisId: analysis._id, clarificationId: row._id } } }, { session });
    if (!claimed.matchedCount) throw failure("clarification_subject_changed");
    const [saved] = await Clarification.create([row], { session });
    return { row: saved.toObject(), created: true };
  });
  if (result.created) {
    await deliverClarification(result.row._id).catch(() => undefined);
    await logAgentAction({ landlordId: result.row.landlordId, requestId: result.row.requestId, actor: "system",
      actionType: "quote_clarification_prepared", summary: "A bounded vendor clarification was prepared; delivery status is recorded separately.",
      output: { stage, revision: result.row.quoteRevision } });
    publish(result.row.landlordId, `request:${result.row.requestId}`); publish(result.row.landlordId, "requests");
  }
  return result.row;
}
async function deliverClarification(clarificationId, deliver) {
  const env = require("../../config/env");
  if (!deliver && !env.outreach_email_enabled) return { delivery: "disabled" };
  const row = await Clarification.findOneAndUpdate({ _id: clarificationId, state: "draft", delivery: "disabled", expiresAt: { $gt: new Date() } },
    { $set: { delivery: "delivering", deliveryStartedAt: new Date() } }, { new: true }).select("+nonce +tokenHash").lean();
  if (!row) return { alreadyClaimed: true };
  let result, attempted = false;
  try {
    const token = deliveryToken(row);
    if (digest(token) !== row.tokenHash) throw failure("clarification_signing_changed");
    await lookup(token); // Recheck active request, subject and exact revision before I/O.
    const policy = await Policy.findOne({ landlordId: row.landlordId }).lean();
    if (!row.permissionApprovalId && policy?.allowQuoteClarification !== true) {
      await Clarification.updateOne({ _id: row._id, delivery: "delivering" }, { $set: { delivery: "disabled" } });
      return { delivery: "disabled" };
    }
    const url = `${String(env.app_public_url || "").replace(/\/$/, "")}/vendor-response/${token}?mode=quote-clarification`;
    if (deliver) { attempted = true; result = await deliver({ token, url, questions: row.questions }); }
    else {
      const outreach = await deliveryRecipient(row);
      if (!outreach?.toEmail) result = { delivered: false };
      else { attempted = true; result = await require("../notification/email.service").sendEmail({ to: outreach.toEmail,
        subject: "Clarify your itemized maintenance charges", text: `Review the line-specific questions and reply: ${url}`,
        categories: ["quote_clarification"] }); }
    }
  } catch (_) { result = { uncertain: attempted }; }
  const delivery = result?.delivered ? "sent" : result?.stub ? "development_preview" : result?.uncertain ? "unknown" : "failed";
  const finished = await Clarification.updateOne({ _id: row._id, delivery: "delivering", state: "draft" }, { $set: { delivery,
    state: delivery === "failed" ? "failed" : delivery === "unknown" ? "delivery_unknown" : "ready" } });
  // A fast reply may commit while the transport is returning. Record delivery
  // metadata without resurrecting an answered or expired capability.
  if (!finished.matchedCount) await Clarification.updateOne({ _id: row._id, delivery: "delivering" }, { $set: { delivery } });
  return { delivery };
}
async function deliveryRecipient(row) {
  const completion = row.stage === "invoice" ? await Completion.findOne({ _id: row.subjectId,
    landlordId: row.landlordId, requestId: row.requestId }).select("appointmentId").lean() : null;
  return row.stage === "quote" ? Outreach.findOne({ _id: row.subjectId, landlordId: row.landlordId,
    requestId: row.requestId }).select("toEmail").lean() : completion?.appointmentId ?
    Outreach.findOne({ requestId: row.requestId, landlordId: row.landlordId, appointmentId: completion.appointmentId }).select("toEmail").lean() : null;
}
async function lookup(token, session) {
  if (typeof token !== "string" || !/^qc_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/.test(token)) throw failure("invalid_link", 404);
  let query = Clarification.findOne({ tokenHash: digest(token) }); if (session) query = query.session(session);
  const row = await query.lean();
  if (!row || !active.includes(row.state)) throw failure("invalid_link", 404);
  if (new Date(row.expiresAt) <= new Date()) throw failure("clarification_expired", 410);
  const { Model, field } = binding(row.stage);
  let subjectQuery = Model.findOne({ ...subjectFilter(row, true), [`${field}.state`]: "waiting_clarification", [`${field}.clarificationId`]: row._id });
  let requestQuery = Request.findOne({ _id: row.requestId, landlordId: row.landlordId, archivedAt: null, status: { $nin: ["completed", "cancelled", "rejected"] } });
  if (session) { subjectQuery = subjectQuery.session(session); requestQuery = requestQuery.session(session); }
  const subject = await subjectQuery.lean(), request = await requestQuery.lean();
  if (!subject || !request) throw failure("invalid_link", 404);
  return { row, subject, Model, field };
}
async function getClarification(token) {
  const { row, subject } = await lookup(token);
  return { stage: row.stage, quoteRevision: row.quoteRevision, quoteHash: row.quoteHash, expiresAt: row.expiresAt,
    questions: row.questions, quote: snapshotOf(subject, row.stage), allowRevision: row.stage === "quote" &&
      !subject.approvedQuoteSnapshot && !subject.authorizedCeiling && !["pending", "confirmed"].includes(subject.counterOffer?.status) };
}
function validateAnswers(body, row) {
  if (!body || Object.keys(body).some(key => !["answers", "expectedQuoteRevision", "expectedQuoteHash", "itemization"].includes(key)) ||
    body.expectedQuoteRevision !== row.quoteRevision || body.expectedQuoteHash !== row.quoteHash || !Array.isArray(body.answers) ||
    body.answers.length !== row.questions.length || Array.from({ length: body.answers.length }, (_, index) => index).some(index => !Object.hasOwn(body.answers, index)) ||
    new Set(body.answers.map(answer => answer?.questionId)).size !== row.questions.length ||
    body.answers.some(answer => !answer || Object.keys(answer).some(key => !["questionId", "answer"].includes(key)) ||
      !row.questions.some(question => question.id === answer.questionId) || typeof answer.answer !== "string" || !answer.answer.trim() || answer.answer.length > 800)) {
    throw failure("invalid_clarification_reply", 400);
  }
  return body.answers.map(answer => ({ questionId: answer.questionId, answer: answer.answer.trim() }));
}
async function submitClarification(token, body) {
  const result = await mongoose.connection.transaction(async session => {
    const { row, subject, Model, field } = await lookup(token, session);
    const answers = validateAnswers(body, row);
    let revised;
    if (Object.hasOwn(body, "itemization")) {
      if (row.stage !== "quote" || subject.approvedQuoteSnapshot || subject.authorizedCeiling ||
        ["pending", "confirmed"].includes(subject.counterOffer?.status) || row.quoteRevision >= 5) throw failure("quote_revision_locked");
      revised = createQuoteSnapshot(body.itemization, { revision: row.quoteRevision + 1,
        allowedLineIds: snapshotOf(subject, row.stage).itemization.items.map(line => line.lineId) });
    }
    const fenced = await Request.updateOne({ _id: row.requestId, landlordId: row.landlordId, archivedAt: null,
      status: { $nin: ["completed", "cancelled", "rejected"] } }, { $inc: { policyCheckpointFence: 1 } }, { session });
    if (!fenced.matchedCount) throw failure("clarification_subject_changed");
    const claimed = await Clarification.updateOne({ _id: row._id, state: { $in: active }, expiresAt: { $gt: new Date() } },
      { $set: { state: "answered", answers, answeredAt: new Date(), resultingRevision: revised?.revision || row.quoteRevision } }, { session });
    if (!claimed.matchedCount) throw failure("clarification_already_answered");
    const patch = { $set: { [field]: { state: "pending", quoteHash: revised?.hash || row.quoteHash, clarificationId: row._id } } };
    if (revised) {
      patch.$set.currentQuoteRevision = revised.revision; patch.$push = { quoteRevisions: revised };
      patch.$unset = { quoteCheckpointId: 1, quotaCheck: 1, approvalRequestId: 1 };
    }
    const saved = await Model.updateOne({ ...subjectFilter(row, true), [`${field}.clarificationId`]: row._id, [`${field}.state`]: "waiting_clarification" }, patch, { session });
    if (!saved.matchedCount) throw failure("clarification_subject_changed");
    await Approval.updateMany({ landlordId: row.landlordId, requestId: row.requestId, type: "cost_review", status: "pending",
      "payload.subjectId": id(row.subjectId) }, { $set: { status: "expired", decidedAt: new Date() } }, { session });
    return { row, revision: revised?.revision || row.quoteRevision };
  });
  const { row } = result;
  if (row.stage === "quote") {
    try {
      const current = await Outreach.findById(row.subjectId);
      if (current) await require("../vendor/vendorOutreach.service").applyOutreachToSnapshot({ requestId: row.requestId,
        candidateKey: current.candidateKey, patch: require("../vendor/vendorOutreach.service").buildOutreachLedgerPatch(current) });
    } catch (_) { /* Durable submission remains pending review; read-path repair can refresh the cache. */ }
  }
  // Submission is durable before asynchronous review/recovery. A retry cannot
  // mutate the original single-use response or consume a second round.
  try {
    if (row.stage === "quote") await require("./quoteCheckpoint.service").claimQuoteCheckpoint({ outreachId: row.subjectId, landlordId: row.landlordId });
    await require("./review.service").queueRuntimeReview({ subjectId: row.subjectId, stage: row.stage, landlordId: row.landlordId });
  } catch (_) { /* Pending state is recovered by the existing quote review sweep. */ }
  await logAgentAction({ landlordId: row.landlordId, requestId: row.requestId, actor: "vendor", actionType: "quote_clarification_answered",
    summary: "The vendor answered the bounded clarification; the current itemized costs returned to review.", output: { stage: row.stage, revision: result.revision } });
  publish(row.landlordId, `request:${row.requestId}`); publish(row.landlordId, "requests");
  return { revision: result.revision, state: "pending_review" };
}
async function recoverClarifications(now = new Date()) {
  const rows = await Clarification.find({ state: { $in: [...active, "failed"] }, $or: [{ expiresAt: { $lte: now } }, { delivery: "failed" },
    { delivery: "delivering", deliveryStartedAt: { $lte: new Date(now - 60_000) } }] }).limit(20).lean();
  for (const row of rows) {
    if (row.delivery === "delivering" && row.expiresAt > now) {
      await Clarification.updateOne({ _id: row._id, delivery: "delivering", state: { $in: active } }, { $set: { delivery: "unknown", state: "delivery_unknown" } });
      continue; // Unknown delivery is never blindly replayed.
    }
    await Clarification.updateOne({ _id: row._id, state: { $in: [...active, "failed"] } }, { $set: { state: "expired" } });
    const { Model, field } = binding(row.stage);
    await Model.updateOne({ ...subjectFilter(row, true), [`${field}.clarificationId`]: row._id, [`${field}.state`]: "waiting_clarification" },
      { $set: { [field]: { state: "pending", quoteHash: row.quoteHash } } });
  }
}
module.exports = { routineQuestions, openClarification, deliverClarification, deliveryRecipient, deliveryToken, getClarification, submitClarification, recoverClarifications, validateAnswers };
