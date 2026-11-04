const mongoose = require("mongoose");
const Request = require("../models/MaintenanceRequest");
const Outreach = require("../models/VendorOutreach");
const Completion = require("../models/JobCompletion");
const Analysis = require("../models/QuoteAnalysis");
const Approval = require("../models/ApprovalRequest");
const { reopenDescriptor } = require("../services/quotes/reopenReview.service");
const id = value => String(value?._id || value || "");
function presentAnalysis(row, now = new Date()) {
  if (!row) return null;
  const expired = row.status === "running" && (!row.leaseUntil || new Date(row.leaseUntil) <= now);
  return { status: expired ? "unavailable" : row.status, source: row.source,
    simulated: row.source === "development_stub", result: row.status === "ready" ? row.result : null,
    errorCode: expired ? "analysis_interrupted" : row.errorCode || null,
    provider: row.provider || null, model: row.model || null, durationMs: row.durationMs ?? null };
}
exports.getReviews = async (req, res) => {
  if (!["landlord", "property_manager", "admin"].includes(req.user?.role)) return res.status(403).json({ success: false, message: "Access denied" });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Request not found" });
  try {
    const request = await Request.findOne({ _id: req.params.id, landlordId: req.user.id }).select("_id status archivedAt").lean();
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    const scope = { requestId: request._id, landlordId: req.user.id };
    const [quotes, invoices, analyses, clarifications, declined] = await Promise.all([
      Outreach.find({ ...scope, quoteContractVersion: 2 }).select("_id landlordId requestId quoteContractVersion appointmentId vendorId vendorNameSnapshot status currentQuoteRevision quoteRevisions approvedQuoteSnapshot quoteReview").sort({ createdAt: 1 }).lean(),
      Completion.find({ ...scope, quoteContractVersion: 2 }).select("_id landlordId requestId quoteContractVersion vendorId status approvedCeiling approvedQuoteSnapshot report invoiceReview overage closeRecovery.payableCents").sort({ createdAt: 1 }).lean(),
      Analysis.find(scope).select("subjectId quoteHash contextHash status source result provider model durationMs errorCode leaseUntil").lean(),
      require("../models/QuoteClarification").find(scope).select("subjectId stage state delivery questions answers expiresAt quoteRevision quoteHash").lean(),
      Approval.find({ ...scope, type: "cost_review", status: "rejected" }).select("_id landlordId requestId type status payload").lean(),
    ]);
    const clarificationFor = subject => {
      const row = clarifications.find(row => id(row.subjectId) === id(subject));
      return row ? { state: row.state, delivery: row.delivery, questions: row.questions, answers: row.answers,
        expiresAt: row.expiresAt, quoteRevision: row.quoteRevision, quoteHash: row.quoteHash } : null;
    };
    const analysisFor = (subject, review) => presentAnalysis(analyses.find(row => id(row.subjectId) === id(subject) &&
      row.quoteHash === review?.quoteHash && row.contextHash === review?.contextHash));
    const reviewFor = (subject, stage) => {
      const review = stage === "invoice" ? subject.invoiceReview : subject.quoteReview;
      return { state: review?.state || "pending", approvalId: id(review?.approvalId) || null,
        resumePending: Boolean(review?.resumePending), revision: review?.revision ?? 0,
        reopen: reopenDescriptor({ subject, stage, request, approval: declined.find(row => id(row) === id(review?.approvalId)) }) };
    };
    return res.json({ success: true, data: { quotes: quotes.map(row => ({ id: id(row), vendorId: id(row.vendorId) || null, vendorName: row.vendorNameSnapshot,
      status: row.status, revision: row.currentQuoteRevision,
      original: row.quoteRevisions?.[0] || null,
      current: row.quoteRevisions?.find(snapshot => snapshot.revision === row.currentQuoteRevision) || null,
      approved: row.approvedQuoteSnapshot || null,
      review: reviewFor(row, "quote"), analysis: analysisFor(row, row.quoteReview), clarification: clarificationFor(row) })),
    invoices: invoices.map(row => ({ id: id(row), vendorId: id(row.vendorId) || null, status: row.status, finalStatement: row.report?.finalStatement || null,
      invoiceReference: row.report?.invoiceReference || null, originalQuote: row.approvedQuoteSnapshot || null,
      agreedAmount: row.approvedCeiling ?? null, invoicedAmount: row.report?.actualCost ?? null,
      approvedPayable: row.status === "closed" ? row.closeRecovery?.payableCents != null ? row.closeRecovery.payableCents / 100 : null :
        row.overage?.decision === "approved" ? row.overage.approvedAmount ?? null : null,
      review: reviewFor(row, "invoice"), analysis: analysisFor(row, row.invoiceReview), clarification: clarificationFor(row) })) } });
  } catch (_) { return res.status(500).json({ success: false, message: "Cost reviews could not be loaded." }); }
};
exports.presentAnalysis = presentAnalysis;

exports.reopenReview = async (req, res) => {
  if (!["landlord", "property_manager", "admin"].includes(req.user?.role)) return res.status(403).json({ success: false, message: "Access denied" });
  try {
    const data = await require("../services/quotes/reopenReview.service").reopenReview({ landlordId: req.user.id,
      requestId: req.params.id, subjectId: req.params.subjectId, stage: req.params.stage, body: req.body });
    return res.json({ success: true, data });
  } catch (error) {
    const known = ["invalid_reopen_input", "review_not_found", "stale_cost_review", "review_request_closed", "review_not_reopenable", "idempotency_conflict", "review_reopen_unavailable"];
    return res.status(known.includes(error.code) ? error.statusCode : 503).json({ success: false,
      code: known.includes(error.code) ? error.code : "review_reopen_unavailable",
      message: known.includes(error.code) ? error.message : "The reopening outcome could not be verified. Refresh the current review before trying again." });
  }
};
