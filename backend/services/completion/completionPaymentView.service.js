// Metadata-only repair of the old completion payout cache. The journal owns
// payment status; this never marks a ledger entry paid or calls a provider.
const JobCompletion = require("../../models/JobCompletion");
const LedgerEntry = require("../../models/LedgerEntry");
function payoutViewStatus(entries) {
  if (!entries.length) return null;
  if (entries.every(row => row.providerStatus === "paid")) return "paid";
  if (entries.length === 1) return entries[0].providerStatus || null;
  for (const status of ["failed", "awaiting_funds", "awaiting_clearance", "pending_onboarding", "pending"]) {
    if (entries.some(row => row.providerStatus === status)) return status;
  }
  return entries.some(row => row.providerStatus === "paid") ? "partially_paid" : "pending";
}
async function reconcileCompletionPaymentViews(now = new Date()) {
  const rows = await JobCompletion.find({ status: "closed", closedAt: { $ne: null }, "ledger.releaseEntryId": { $ne: null } })
    .sort({ "ledger.payoutCheckedAt": 1, _id: 1 }).limit(50).select("_id landlordId ledger").lean();
  let updated = 0;
  for (const completion of rows) {
    try {
      const entries = await LedgerEntry.find({ landlordId: completion.landlordId, completionId: completion._id, type: "payout" })
        .select("providerStatus").lean();
      const status = payoutViewStatus(entries);
      const result = await JobCompletion.updateOne({ _id: completion._id,
        "ledger.payoutCheckedAt": completion.ledger.payoutCheckedAt || null,
        "ledger.payoutStatus": completion.ledger.payoutStatus || null },
      { $set: { "ledger.payoutCheckedAt": now, ...(status ? { "ledger.payoutStatus": status } : {}) } });
      if (status && status !== completion.ledger.payoutStatus && result.matchedCount) updated++;
    } catch (error) { console.error("[completionPaymentView] cache refresh failed", String(completion._id), error.message); }
  }
  return updated;
}
module.exports = { payoutViewStatus, reconcileCompletionPaymentViews };
