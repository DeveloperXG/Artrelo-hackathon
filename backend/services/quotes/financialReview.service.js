const { dollarToMinor } = require("./itemization.service");
function validateFinalChargeDecision({ completion, approval, body }) {
  if (completion.quoteContractVersion !== 2) return;
  const snapshot = completion.report?.finalStatement;
  if (!snapshot || approval.payload?.quoteRevision !== snapshot.revision || approval.payload?.quoteHash !== snapshot.hash ||
    body.expectedQuoteRevision !== snapshot.revision || body.expectedQuoteHash !== snapshot.hash) {
    throw Object.assign(new Error("Review the current final itemized charges."), { statusCode: 409, code: "quote_revision_conflict" });
  }
  if (body.status === "approved") {
    const value = Object.hasOwn(body, "approvedAmount") ? body.approvedAmount : approval.amountRequested;
    try { if (dollarToMinor(value, "approvedAmount") <= 0) throw new Error("positive amount required"); }
    catch (_) { throw Object.assign(new Error("Authorize a positive amount with at most two decimal places."), { statusCode: 400, code: "invalid_approved_amount" }); }
  }
}
module.exports = { validateFinalChargeDecision };
