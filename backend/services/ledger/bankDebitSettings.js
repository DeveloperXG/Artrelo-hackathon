// Settings for bank top-ups (Canadian pre-authorized debit, Stripe acss_debit).
//
// Read through here, never raw from env: every value is parsed with a safe
// default, so a typo in a deploy setting degrades to the documented default
// rather than to 0 (no minimum, no cap, free failures).
//
// WHY A BANK TOP-UP IS DIFFERENT FROM A CARD. A card answers in seconds. A
// debit is "processing" for about four business days, can fail after that, and
// -- the part that shapes everything else -- can be DISPUTED by the account
// holder afterwards and cannot be contested: 10 business days for a business
// account, 90 days for a personal one. So a new landlord is capped and kept to
// one debit in flight until a few have cleared, and a failure or a dispute
// costs the landlord the fee Stripe charges Artrelo for it, disclosed up front.

const env = require("../../config/env");

const DEFAULTS = Object.freeze({
  minCents: 10000, // $100: below this the fixed costs dominate and a card is better
  newCapCents: 200000, // $2,000 per debit until trusted
  trustedAfter: 3, // cleared bank top-ups before the cap and the one-at-a-time rule lift
  failureFeeCents: 500, // charged when a debit is attempted and the bank refuses it
  disputeFeeCents: 500, // fallback when Stripe's dispute carries no fee figure
  verificationFeeCents: 100, // REPORT-ONLY estimate of the first-mandate verification cost
  transactionType: "business",
});

function intOr(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

/** The live settings. A function, not a constant, so tests can change env. */
function bankDebitSettings(source = env) {
  const type = String(source.bank_mandate_transaction_type || "").trim().toLowerCase();
  return {
    enabled: Boolean(source.bank_debit_enabled),
    minCents: intOr(source.bank_topup_min_cents, DEFAULTS.minCents, { min: 100 }),
    newCapCents: intOr(source.bank_topup_new_cap_cents, DEFAULTS.newCapCents, { min: 100 }),
    trustedAfter: intOr(source.bank_trusted_after, DEFAULTS.trustedAfter, { max: 100 }),
    failureFeeCents: intOr(source.bank_failure_fee_cents, DEFAULTS.failureFeeCents, { max: 10000 }),
    disputeFeeCents: intOr(source.bank_dispute_fee_cents, DEFAULTS.disputeFeeCents, { max: 10000 }),
    verificationFeeCents: intOr(source.bank_verification_fee_cents, DEFAULTS.verificationFeeCents, { max: 10000 }),
    // Stripe accepts exactly these two; anything else would fail every debit.
    transactionType: type === "personal" || type === "business" ? type : DEFAULTS.transactionType,
  };
}

module.exports = { bankDebitSettings, BANK_DEBIT_DEFAULTS: DEFAULTS };
