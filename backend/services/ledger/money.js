// The single boundary between dollars and cents.
//
// Every existing money value in this codebase is a float dollar amount —
// estimatedCost, finalCost, quoteHigh, counterOffer.amount. Floats are fine for
// displaying a quote and fatal for a ledger: 0.1 + 0.2 leaves a drift that the
// reconcile script would then flag forever, on a balance that is arithmetically
// correct.
//
// So the ledger stores INTEGER CENTS and nothing else, and conversion happens
// here and nowhere else. request.finalCost stays dollars, so there is no data
// migration and no change to getStats.

/** 240.5 -> 24050. Throws rather than silently truncating a bad input. */
function toCents(dollars) {
  const value = Number(dollars);
  if (!Number.isFinite(value)) {
    throw new TypeError(`toCents received a non-numeric amount: ${dollars}`);
  }
  // Math.round, not Math.trunc: 24049.999999999996 is what 240.50 * 100 can
  // actually produce, and truncating it loses a cent on a correct input.
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`toCents produced an unsafe integer: ${cents}`);
  }
  return cents;
}

/** 24050 -> 240.5. For display and for writing back to the dollar fields. */
function fromCents(cents) {
  const value = Number(cents);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`fromCents received a non-integer amount: ${cents}`);
  }
  return value / 100;
}

/** "$240.50". Display only — never parse this back. */
function formatCents(cents, currency = "CAD") {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency }).format(fromCents(cents));
}

/** Guard for anything about to be written to a LedgerEntry. */
function assertCents(cents, label = "amount") {
  if (!Number.isSafeInteger(cents)) {
    throw new TypeError(`${label} must be an integer number of cents, got: ${cents}`);
  }
  return cents;
}

module.exports = { toCents, fromCents, formatCents, assertCents };
