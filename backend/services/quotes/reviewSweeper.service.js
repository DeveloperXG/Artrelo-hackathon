const Outreach = require("../../models/VendorOutreach");
const Completion = require("../../models/JobCompletion");
const Analysis = require("../../models/QuoteAnalysis");
const { queueRuntimeReview } = require("./review.service");
let timer, running = false;
async function sweepQuoteReviews(now = new Date()) {
  if (running) return;
  running = true;
  try {
    await require("./clarification.service").recoverClarifications(now);
    // Interrupted provider outcomes are uncertain, never automatically replayed.
    await Analysis.updateMany({ status: "running", leaseUntil: { $lte: now } },
      { $set: { status: "unavailable", result: null, errorCode: "analysis_interrupted" }, $unset: { leaseToken: 1, leaseUntil: 1 } });
    for (const [Model, stage, review] of [[Outreach, "quote", "quoteReview"], [Completion, "invoice", "invoiceReview"]]) {
      const rows = await Model.find({ quoteContractVersion: 2,
        ...(stage === "quote" ? { status: "accepted", appointmentId: null } :
          { status: { $in: ["awaiting_tenant", "confirmed", "in_review"] }, "report.submittedAt": { $ne: null } }),
        $or: [{ [`${review}.state`]: { $in: ["pending", "needs_review"] } }, { [`${review}.resumePending`]: true }],
      }).select(`_id landlordId status ${review}`).sort({ updatedAt: 1, _id: 1 }).limit(20).lean();
      for (const row of rows) {
        try {
          if (row[review]?.state === "cleared" && row[review]?.resumePending) {
            if (stage === "quote") await require("../vendor/vendorAcceptance.service").finalizeVendorAcceptance({ outreachId: row._id });
            else if (row.status === "confirmed") await require("../completion/jobCompletion.service").closeJobCompletion({ completionId: row._id });
            await Model.updateOne({ _id: row._id, [`${review}.state`]: "cleared" }, { $set: { [`${review}.resumePending`]: false } });
          } else await queueRuntimeReview({ subjectId: row._id, stage, landlordId: row.landlordId });
        } catch (_) { console.error("[quoteReview] recovery remains pending"); }
      }
    }
  } finally { running = false; }
}
function startQuoteReviewSweeper() {
  if (timer) return;
  timer = setInterval(() => sweepQuoteReviews().catch(() => console.error("[quoteReview] recovery unavailable")), 60_000);
  timer.unref?.();
}
module.exports = { sweepQuoteReviews, startQuoteReviewSweeper };
