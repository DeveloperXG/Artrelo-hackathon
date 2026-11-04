// Funding permission is separate from settlement timing. Stripe-successful
// credits may be reserved while pending; a processing debit is not a credit.
function bookingFunds({ amountCents, ledger, externalCredits = false }) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    return { allowed: false, reasonCode: "quote_required", shortfallCents: 0 };
  }
  const available = Math.max(0, ledger?.available || 0);
  if (externalCredits && !ledger?.platformFundingReviewedAt) {
    return { allowed: false, reasonCode: "funding_review_required", shortfallCents: Math.max(0, amountCents - available) };
  }
  if (ledger?.bankOwed > 0 || ledger?.arrears > 0) {
    return { allowed: false, reasonCode: "funding_obligations_outstanding", shortfallCents: Math.max(0, amountCents - available) };
  }
  return { allowed: available >= amountCents, reasonCode: available >= amountCents ? "funded" : "insufficient_funds",
    shortfallCents: Math.max(0, amountCents - available) };
}
module.exports = { bookingFunds };
