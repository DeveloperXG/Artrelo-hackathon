const { randomUUID } = require("node:crypto");
const Outreach = require("../../models/VendorOutreach");
const Completion = require("../../models/JobCompletion");
const Request = require("../../models/MaintenanceRequest");
const Approval = require("../../models/ApprovalRequest");
const Analysis = require("../../models/QuoteAnalysis");
const { buildAnalysisContext, inspectAnalysis, developmentAnalysis } = require("./analysisContract.service");
const { dollarToMinor } = require("./itemization.service");
const { logAgentAction } = require("../audit/agentAction.service");
const { publish } = require("../realtime/liveEvents.service");
const id = value => String(value?._id || value || "");
const error = code => Object.assign(new Error("This cost review changed. Refresh the current decision."), { code, statusCode: 409 });
function binding(stage) {
  if (stage === "quote") return { Model: Outreach, review: "quoteReview" };
  if (stage === "invoice") return { Model: Completion, review: "invoiceReview" };
  throw error("invalid_review_stage");
}
function snapshotOf(subject, stage) {
  return stage === "invoice" ? subject.report?.finalStatement :
    subject.quoteRevisions?.find(row => row.revision === subject.currentQuoteRevision);
}

async function loadBasis({ subjectId, stage, landlordId, session = null }) {
  const scoped = query => session ? query.session(session) : query;
  const { Model, review } = binding(stage);
  const subject = await scoped(Model.findOne({ _id: subjectId, landlordId })).lean();
  if (!subject || subject.quoteContractVersion !== 2) throw error("review_subject_missing");
  const request = await scoped(Request.findOne({ _id: subject.requestId, landlordId })).lean();
  if (!request || request.archivedAt || ["completed", "rejected", "cancelled"].includes(request.status)) throw error("review_request_closed");
  const snapshot = snapshotOf(subject, stage);
  if (!snapshot) throw error("review_quote_missing");
  let history = [];
  if (request.propertyId) {
    const prior = await scoped(Request.find({ landlordId, propertyId: request.propertyId, category: request.category,
      status: "completed", _id: { $ne: request._id } }).select("_id").sort({ completedAt: -1, _id: -1 }).limit(3)).lean();
    if (prior.length) history = await scoped(Completion.find({ landlordId, requestId: { $in: prior.map(row => row._id) },
      status: "closed", closedAt: { $ne: null } }).select("_id report.workPerformed closeRecovery.payableCents")
      .sort({ closedAt: -1, _id: -1 }).limit(3)).lean();
  }
  let agreedMinor = null;
  if (stage === "invoice" && subject.approvedCeiling != null) {
    try { agreedMinor = dollarToMinor(subject.approvedCeiling, "agreed"); } catch (_) { /* Unknown legacy basis is not invented. */ }
  }
  const basis = buildAnalysisContext({ request, snapshot, stage, agreedMinor,
    originalSnapshot: stage === "invoice" ? subject.approvedQuoteSnapshot : null, history,
    ...(subject[review]?.clarificationId ? { clarification: await scoped(require("../../models/QuoteClarification").findOne({
      _id: subject[review].clarificationId, landlordId, subjectId, state: "answered" })).lean() } : {}) });
  return { ...basis, subject, request, snapshot, Model, review };
}

function currentFilter(basis, stage) {
  return { _id: basis.subject._id, landlordId: basis.subject.landlordId,
    ...(stage === "quote" ? { status: "accepted", appointmentId: null,
      currentQuoteRevision: basis.snapshot.revision, quoteRevisions: { $elemMatch: { revision: basis.snapshot.revision, hash: basis.snapshot.hash } } } :
      { status: { $in: ["awaiting_tenant", "confirmed", "in_review"] }, "report.finalStatement.hash": basis.snapshot.hash }),
  };
}

async function ensureApproval(basis, row, stage, purpose = row.status === "unavailable" ? "analysis_unavailable" : "scope_review") {
  const revision = basis.subject[basis.review]?.revision || 0;
  const reviewKey = `${stage}:${id(basis.subject)}:${basis.snapshot.hash}:${basis.contextHash}:${purpose}${revision ? `:reopen:${revision}` : ""}`;
  const scope = { landlordId: basis.subject.landlordId, requestId: basis.request._id, type: "cost_review", "payload.reviewKey": reviewKey };
  await Approval.updateMany({ ...scope, status: "pending", expiresAt: { $lte: new Date() } },
    { $set: { status: "expired", decidedAt: new Date() } });
  let approval;
  try {
    approval = await Approval.findOneAndUpdate({ ...scope, status: "pending" }, { $setOnInsert: {
      landlordId: basis.subject.landlordId, requestId: basis.request._id, type: "cost_review", status: "pending",
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      reason: purpose === "clarification_permission" ? "Allow one routine, line-specific follow-up to this vendor? This permits a question only; it does not approve costs." : row.status === "unavailable" ? "Analysis is unavailable. Review the itemized costs and scope before proceeding." :
        stage === "quote" ? "Review the itemized vendor quote and its scope before booking." : "Review the final itemized charges before financial close.",
      payload: { source: "iris_cost_review", purpose, reviewKey, stage,
        subjectId: id(basis.subject), quoteRevision: basis.snapshot.revision,
        quoteHash: basis.snapshot.hash, contextHash: basis.contextHash, analysisId: id(row) },
    } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
    approval = await Approval.findOne({ ...scope, status: "pending" });
  }
  if (!approval) throw error("review_claim_changed");
  const saved = await basis.Model.updateOne({ ...currentFilter(basis, stage),
    $or: [ { [`${basis.review}.state`]: { $nin: ["cleared", "rejected"] } },
      { [`${basis.review}.quoteHash`]: { $ne: basis.snapshot.hash } },
      { [`${basis.review}.contextHash`]: { $ne: basis.contextHash } } ] }, { $set: {
    [basis.review]: { state: "needs_review", revision, quoteHash: basis.snapshot.hash,
      contextHash: basis.contextHash, analysisId: row._id, approvalId: approval._id,
      clarificationId: basis.subject[basis.review]?.clarificationId },
  } });
  if (!saved.matchedCount) {
    await Approval.updateOne({ _id: approval._id, status: "pending" }, { $set: { status: "expired", decidedAt: new Date() } });
    return null;
  }
  publish(basis.request.landlordId, "requests"); publish(basis.request.landlordId, `request:${basis.request._id}`);
  await require("../notification/notify.service").notifyUser({ userId: basis.subject.landlordId,
    type: "decision_needed", title: purpose === "clarification_permission" ? "Allow a routine vendor follow-up?" : "Review the itemized costs",
    message: approval.reason, eventKey: `cost_review:${id(approval)}`,
    metadata: { workOrderId: id(basis.request), approvalRequestId: id(approval), approvalType: "cost_review" } });
  return approval;
}

async function routeResult(basis, row, stage) {
  if (basis.subject[basis.review]?.state === "waiting_clarification") return { waitingClarification: true };
  const clarificationService = require("./clarification.service");
  if (row.status === "ready" && clarificationService.routineQuestions(row.result, basis.snapshot).length) {
    const existing = await require("../../models/QuoteClarification").findOne({ subjectId: basis.subject._id, stage }).lean();
    if (!existing) {
      if (await require("../../models/QuoteClarification").countDocuments({ requestId: basis.request._id, landlordId: basis.subject.landlordId }) >= 2) {
        return { approval: await ensureApproval(basis, row, stage, "scope_review") };
      }
      const policy = await require("../../models/LandlordPolicy").findOne({ landlordId: basis.subject.landlordId }).lean();
      if (policy?.allowQuoteClarification) {
        try { return { clarification: await clarificationService.openClarification({ basis, analysis: row, stage }) }; }
        catch (error) { if (error.code !== "clarification_permission_required") return { approval: await ensureApproval(basis, row, stage, "scope_review") }; }
      }
      return { approval: await ensureApproval(basis, row, stage, "clarification_permission") };
    }
    if (["draft", "ready", "delivery_unknown"].includes(existing.state) && existing.expiresAt > new Date()) return { waitingClarification: true };
  }
  // Readiness is not spend authority. Unknown scope/history, unavailable or
  // flagged analyses always retain human review. The existing monetary,
  // calendar, request and funds gates are still authoritative after readiness.
  const clean = row.status === "ready" && row.result?.reviewRecommendation === "no_additional_flags" &&
    !row.result.flags.length && !row.result.questions.length && basis.context.approvedScopeKnown && basis.context.historyKnown;
  if (clean && basis.subject[basis.review]?.state === "pending") {
    const saved = await basis.Model.updateOne({ ...currentFilter(basis, stage), [`${basis.review}.state`]: "pending" },
      { $set: { [basis.review]: { state: "cleared", quoteHash: basis.snapshot.hash, contextHash: basis.contextHash,
        analysisId: row._id, clearedAt: new Date(), resumePending: true, clarificationId: basis.subject[basis.review]?.clarificationId } } });
    if (saved.matchedCount) return { ready: true };
  }
  return { approval: await ensureApproval(basis, row, stage) };
}

/**
 * No provider SDK/default network path. Live E2E must inject the separately
 * budget-guarded Standard Spark runner; runtime defaults to unavailable/human.
 */
async function runReview({ subjectId, stage, landlordId, complete = null, source = "disabled", guardedLiveProof = null }) {
  const guarded = guardedLiveProof !== null && require('../judgeSandbox/offlineGuard.service').isGuardedLiveProof(guardedLiveProof);
  if (guardedLiveProof !== null && !guarded) throw new TypeError('Explicit guarded review proof required');
  const timeoutMs = guarded ? require('../../contracts/judgeSandboxFreshRecording.v1.json').guardedTimeoutMs : 10000;
  const basis = await loadBasis({ subjectId, stage, landlordId });
  if (basis.subject[basis.review]?.state === "waiting_clarification") return { waitingClarification: true };
  if (["cleared", "rejected"].includes(basis.subject[basis.review]?.state) &&
      basis.subject[basis.review]?.quoteHash === basis.snapshot.hash &&
      basis.subject[basis.review]?.contextHash === basis.contextHash) return { alreadyReviewed: true };
  const key = { landlordId, subjectId, stage, quoteHash: basis.snapshot.hash, contextHash: basis.contextHash };
  let row;
  try { row = await Analysis.findOneAndUpdate(key, { $setOnInsert: { ...key, requestId: basis.request._id,
    quoteRevision: basis.snapshot.revision, status: "pending" } }, { upsert: true, new: true, setDefaultsOnInsert: true }); }
  catch (err) { if (err.code !== 11000) throw err; row = await Analysis.findOne(key); }
  const leaseToken = randomUUID();
  const claimed = await Analysis.findOneAndUpdate({ _id: row._id, status: "pending" },
    { $set: { status: "running", leaseToken, leaseUntil: new Date(Date.now() + 30_000) } }, { new: true });
  if (!claimed) {
    if (["ready", "unavailable"].includes(row.status)) return { analysis: row, ...await routeResult(basis, row, stage) };
    return { analysis: row, pending: true };
  }
  let result = null, errorCode = "analysis_disabled", validationReason = null, timer, provider, model;
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const started = Date.now();
  try {
    if (Buffer.byteLength(JSON.stringify(basis.context), "utf8") > 24_576) throw error("context_too_large");
    if (typeof complete === "function") {
      const output = await Promise.race([complete(basis.context), new Promise((_, reject) => {
        timer = setTimeout(() => reject(error("analysis_timeout")), timeoutMs);
      })]);
      const telemetry = output?.telemetry;
      for (const attempt of telemetry?.attempts || []) for (const [key, target] of
        [["prompt_tokens", "promptTokens"], ["completion_tokens", "completionTokens"], ["total_tokens", "totalTokens"]]) {
        if (Number.isSafeInteger(attempt.usage?.[key]) && attempt.usage[key] >= 0) usage[target] += attempt.usage[key];
      }
      if (source === "meta" && (telemetry?.provider !== "meta" || telemetry?.model !== "muse-spark-1.3")) throw error("invalid_provider_provenance");
      if (source === "meta") { provider = "meta"; model = "muse-spark-1.3"; }
      if (output && Object.hasOwn(output, 'parsed') && output.parsed === null) validationReason = 'provider_output_unavailable';
      else {
        const inspected = inspectAnalysis(output?.parsed || output, basis);
        result = inspected.analysis;validationReason = inspected.reason;
      }
      errorCode = result ? null : "invalid_analysis";
    }
  } catch (err) { errorCode = ["analysis_timeout", "context_too_large"].includes(err.code) ? err.code : "analysis_unavailable"; }
  finally { clearTimeout(timer); }
  let fresh;
  try { fresh = await loadBasis({ subjectId, stage, landlordId }); } catch (_) { /* Closed/changed subjects cannot acquire effects. */ }
  const stale = !fresh || fresh.snapshot.hash !== basis.snapshot.hash || fresh.contextHash !== basis.contextHash;
  const status = stale ? "stale" : result ? "ready" : "unavailable";
  // An unavailable advisory is not credited as a model-authored analysis.
  // Billable attempts/usage remain in the separate authoritative cost ledger.
  const recordedSource = source === "meta" && !result ? "disabled" : ["disabled", "development_stub", "meta"].includes(source) ? source : "disabled";
  await Analysis.updateOne({ _id: row._id, status: "running", leaseToken }, { $set: {
    status, source: recordedSource,
    result: stale ? null : result, errorCode: stale ? "context_changed" : errorCode,
    validationReason: stale ? null : validationReason, durationMs: Date.now() - started,
    usage, ...(provider && result ? { provider, model } : {}),
  }, $unset: { leaseToken: 1, leaseUntil: 1, ...(!result && source === 'meta' ? { provider: 1, model: 1 } : {}) } });
  if (stale) return { stale: true };
  row = await Analysis.findById(row._id);
  const routed = await routeResult(basis, row, stage);
  const approval = routed.approval;
  await logAgentAction({ landlordId, requestId: basis.request._id, actor: "system",
    actionType: "quote_analysis_recorded", summary: routed.ready ? "Analysis readiness recorded; independent backend authorization gates remain." : routed.clarification || routed.waitingClarification ? "Routine clarification is pending; costs remain unapproved." : result ?
      source === "development_stub" ? "Development simulation recorded; landlord cost review required." : "Quote analysis recorded; landlord cost review required." :
      "Quote analysis unavailable; landlord cost review required.",
    output: { stage, status, source: recordedSource, revision: basis.snapshot.revision, approvalRequestId: id(approval) || null } });
  publish(landlordId, "requests"); publish(landlordId, `request:${basis.request._id}`);
  return { analysis: row, ...routed };
}

let guardedReview = null;
function registerGuardedReview(proof, review) {
  if (!require('../judgeSandbox/offlineGuard.service').isGuardedLiveProof(proof) || typeof review !== 'function' || guardedReview) throw new TypeError('Explicit isolated quote registration required');
  guardedReview = review;
}
async function queueRuntimeReview(args) {
  if (guardedReview) return guardedReview(args);
  const env = require("../../config/env");
  const stub = env.quote_analysis_mode === "stub" && ["dev", "test", "development"].includes(env.node_env);
  return runReview({ ...args, complete: stub ? async () => developmentAnalysis() : null,
    source: stub ? "development_stub" : "disabled" });
}

async function validateDecision({ approval, body, landlordId }) {
  if (approval.payload?.source !== "iris_cost_review" || !["scope_review", "analysis_unavailable", "clarification_permission"].includes(approval.payload?.purpose) ||
      Object.hasOwn(body, "approvedAmount")) throw error("invalid_cost_review_decision");
  const { subjectId, stage, quoteHash, contextHash, quoteRevision } = approval.payload;
  if (body.expectedQuoteRevision !== quoteRevision || body.expectedQuoteHash !== quoteHash) throw error("stale_cost_review");
  const basis = await loadBasis({ subjectId, stage, landlordId });
  if (basis.snapshot.hash !== quoteHash || basis.contextHash !== contextHash ||
      id(basis.subject[basis.review]?.approvalId) !== id(approval)) throw error("stale_cost_review");
  return basis;
}

async function applyDecision({ approval, body, landlordId, status }) {
  if (!["approved", "rejected"].includes(status)) throw error("invalid_cost_review_decision");
  const basis = await validateDecision({ approval, body, landlordId });
  if (approval.payload.purpose === "clarification_permission") {
    const analysis = await Analysis.findOne({ _id: approval.payload.analysisId, landlordId, subjectId: basis.subject._id,
      quoteHash: basis.snapshot.hash, contextHash: basis.contextHash, status: "ready" });
    if (!analysis) throw error("stale_cost_review");
    if (status === "approved") {
      await require("./clarification.service").openClarification({ basis, analysis, stage: approval.payload.stage, permissionApprovalId: approval._id });
    } else {
      await basis.Model.updateOne({ ...currentFilter(basis, approval.payload.stage), [`${basis.review}.approvalId`]: approval._id },
        { $set: { [basis.review]: { state: "pending", quoteHash: basis.snapshot.hash } } });
      // Declining permission asks the human to review scope; it never cancels a
      // request or silently clears the still-unresolved cost review.
      await ensureApproval(basis, analysis, approval.payload.stage, "scope_review");
    }
    return basis;
  }
  const changed = await basis.Model.updateOne({ ...currentFilter(basis, approval.payload.stage),
    [`${basis.review}.approvalId`]: approval._id, [`${basis.review}.contextHash`]: basis.contextHash,
    [`${basis.review}.state`]: "needs_review" }, { $set: {
    [`${basis.review}.state`]: status === "approved" ? "cleared" : "rejected",
    [`${basis.review}.clearedAt`]: status === "approved" ? new Date() : null,
  } });
  if (!changed.matchedCount) throw error("stale_cost_review");
  if (status === "approved") {
    try {
      if (approval.payload.stage === "quote") await require("../vendor/vendorAcceptance.service").finalizeVendorAcceptance({ outreachId: basis.subject._id, actorUserId: landlordId });
      else if (basis.subject.status === "confirmed") await require("../completion/jobCompletion.service").closeJobCompletion({ completionId: basis.subject._id, actorUserId: landlordId });
    } catch (_) {
      // Review is durably decided. Never roll it back after an effect may have
      // happened; existing idempotent booking/close recovery owns the retry.
      await basis.Model.updateOne({ _id: basis.subject._id, landlordId }, { $set: { [`${basis.review}.resumePending`]: true } });
    }
  } else await Request.updateOne({ _id: basis.request._id, landlordId }, { $set: { routingStatus: "paused" } });
  return basis;
}

module.exports = { loadBasis, runReview, queueRuntimeReview, registerGuardedReview, validateDecision, applyDecision };
