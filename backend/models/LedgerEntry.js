// The immutable money journal. Append-only: entries are never updated in place
// except to record what a payment provider later did with one.
//
// DOUBLE-ENTRY, with namespaced string accounts:
//
//   landlord:<id>:available    spendable balance
//   landlord:<id>:held         escrowed against a booked job
//   landlord:<id>:arrears      owed to the platform after a shortfall
//   vendor:<id>:payable        earned, not yet transferred
//   external:funding           the outside world (a card, a bank transfer)
//   platform:fee               our cut, when there is one
//   landlord:<id>:bank_owed    owed after a bank top-up was reversed, or a bank
//                              fee the wallet could not cover
//   platform:bank_fees         failure/dispute fees recovered from landlords
//
// Every entry's lines MUST sum to zero. That is the invariant scripts/
// reconcileLedger.js checks, and it is what makes the LandlordLedger balance a
// derived cache rather than the truth.
//
// The account STRINGS are what make §6's upgrade path a migration rather than a
// rebuild: hard per-property partitioning later is just a longer name
// (landlord:<id>:property:<pid>:available) with no change to the entry shape or
// to the posting logic.
//
// One correction worth stating, because it changes what else you must build:
// double-entry buys auditability and that upgrade path. It does NOT buy
// transactional consistency. That comes from `idempotencyKey` below plus the
// guarded $inc in ledger.service.js. Double-entry alone will still double-pay
// on a retry.

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ENTRY_TYPES = [
  "deposit", // landlord funded the wallet
  "hold", // available -> held, at vendor acceptance
  "hold_release", // held -> available, at close (before the payout)
  "hold_void", // held -> available, job cancelled
  "payout", // available -> vendor payable, at close
  "payout_reversal", // a transfer that failed or was clawed back
  "arrears_settlement", // new money paying down arrears before it is spendable
  "fee", // Artrelo's service fee on a settled job: available (+ fees_owed) -> platform:fee
  "fee_settlement", // a top-up paying unpaid service fees down
  "fee_billing_transfer", // unpaid fee liability moved to invoice receivable; no cash collected
  "deposit_reversal", // a disputed bank top-up taken back: external:funding <- available (+ bank_owed)
  "deposit_restoration", // Stripe returned disputed card principal: funding -> available / bank_owed
  "bank_fee", // a failed or disputed debit's fee: platform:bank_fees <- available (+ bank_owed)
  "bank_settlement", // a top-up paying bank_owed down
  "refund",
  "adjustment", // manual correction; always carries a memo
];

const PROVIDER_STATUSES = [
  "none", // no external movement (holds, voids)
  "pending", // written, awaiting a provider
  "pending_manual", // the offline rail: a human must mark it paid
  "pending_onboarding", // vendor has no usable Connect account yet
  // The landlord's wallet did not cover this part of the job. Nothing is sent
  // until a deposit funds it in full (fundedCents === amountCents) — sending it
  // anyway would pay one landlord's vendor out of another landlord's money,
  // because the Stripe platform balance is shared.
  "awaiting_funds",
  // Funded in the ledger, but Stripe has not cleared the money yet. A card
  // top-up lands in the platform balance as PENDING and only becomes
  // transferable days later (`available_on`); a transfer attempted before then
  // is refused with balance_insufficient. Nothing is wrong and nobody has to
  // act: it sends itself once Stripe's available balance covers it
  // (ledger.service.releaseClearedPayouts, on the balance.available webhook and
  // an hourly sweep).
  "awaiting_clearance",
  "paid",
  "failed",
];

const LedgerLineSchema = new Schema(
  {
    account: { type: String, required: true, trim: true },
    direction: { type: String, enum: ["debit", "credit"], required: true },
    // Always POSITIVE. The direction carries the sign, so a line can never be
    // ambiguous about which way money moved.
    amountCents: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "amountCents must be an integer number of cents",
      },
    },
  },
  { _id: false }
);

const LedgerEntrySchema = new Schema(
  {
    landlordId: { type: Schema.Types.ObjectId, ref: "Landlord", required: true, index: true },

    // THE anti-double-pay guard. Derived from domain identity
    // (hold:<appointmentId>, payout:<completionId>), so a retry produces the
    // same key, the second insert throws E11000, and the service returns the
    // existing entry instead of moving money twice.
    idempotencyKey: { type: String, required: true, trim: true },

    type: { type: String, enum: ENTRY_TYPES, required: true, index: true },
    lines: {
      type: [LedgerLineSchema],
      required: true,
      validate: {
        validator: (lines) => Array.isArray(lines) && lines.length >= 2,
        message: "an entry needs at least two lines",
      },
    },
    // Convenience mirror of the entry's magnitude, for reporting. Never summed
    // to derive a balance — that is what `lines` is for.
    amountCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "CAD" },

    // Soft allocation tags. ONE balance per landlord; per-property and per-unit
    // reporting is a query-time rollup over these, not a separate wallet. That
    // avoids money stranded in Unit 3B while 5A has a burst pipe.
    scope: {
      propertyId: { type: Schema.Types.ObjectId, ref: "Property", default: null },
      unitId: { type: Schema.Types.ObjectId, ref: "Unit", default: null },
      category: { type: String, default: null },
    },

    requestId: { type: Schema.Types.ObjectId, ref: "MaintenanceRequest", default: null, index: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", default: null },
    completionId: { type: Schema.Types.ObjectId, ref: "JobCompletion", default: null },
    identityId: { type: Schema.Types.ObjectId, ref: "VendorIdentity", default: null, index: true },
    // The hold this entry releases, so a release can always be traced back.
    holdEntryId: { type: Schema.Types.ObjectId, ref: "LedgerEntry", default: null },

    provider: { type: String, default: "internal" },
    providerRef: { type: String, default: null },
    providerStatus: { type: String, enum: PROVIDER_STATUSES, default: "none" },
    providerError: { type: String, default: null },

    // WHERE THE MONEY ACTUALLY IS. Only meaningful on deposits, and the
    // distinction is not cosmetic:
    //
    //   "stripe"   — a settled PaymentIntent. The funds are in the Stripe
    //                platform balance, so a Connect transfer can draw on them.
    //   "external" — a landlord says they wired/e-transferred money. The ledger
    //                is credited but STRIPE HAS NOTHING TO SEND, so a payout
    //                backed only by these will fail for insufficient funds.
    //
    // Without this the two are indistinguishable in the journal, and a wallet
    // reading $1,000 available can be entirely unspendable.
    fundingSource: {
      type: String,
      enum: ["stripe", "external", "none"],
      default: "none",
    },

    // The balance could not cover this. The entry is still written — the work
    // was done and the vendor is owed — and the difference lands in arrears.
    shortfall: { type: Boolean, default: false },

    // Only on an awaiting_funds payout: how much of it later deposits have paid
    // for. Each step is its own arrears_settlement entry; this is the running
    // total that decides when the transfer is finally allowed to go.
    fundedCents: { type: Number, default: 0, min: 0 },

    // Only on an awaiting_clearance payout: when Stripe's pending balance is
    // expected to cover it, from the pending balance transactions' available_on.
    // An estimate the landlord and vendor are shown; null when Stripe's pending
    // money does not add up to it, and never used to decide anything.
    clearsOn: { type: Date, default: null },

    // Only on card deposits, read off the charge's balance transaction once the
    // PaymentIntent settles. Informational — the cache never moves on them.
    //   processingFeeCents  what the landlord paid on top of the wallet credit
    //   stripeFeeCents      what Stripe actually kept
    //   availableOn         when the funds clear for Connect transfers
    card: {
      processingFeeCents: { type: Number, default: null },
      stripeFeeCents: { type: Number, default: null },
      netCents: { type: Number, default: null },
      availableOn: { type: Date, default: null },
    },

    // Only on BANK deposits (acss_debit), the same reading as `card`. There is
    // no processing fee on top: Artrelo absorbs Stripe's bank fee, and this is
    // where it is recorded for the revenue report.
    bank: {
      stripeFeeCents: { type: Number, default: null },
      netCents: { type: Number, default: null },
      availableOn: { type: Date, default: null },
    },

    // Written AFTER the cache update, so an entry with balanceAfter: null marks
    // a crash between the two writes for reconcileLedger to replay.
    balanceAfter: {
      available: { type: Number, default: null },
      held: { type: Number, default: null },
    },

    actor: { type: String, default: "system" },
    memo: { type: String, default: null },
  },
  { timestamps: true }
);

LedgerEntrySchema.index({ idempotencyKey: 1 }, { unique: true });
// The per-property / per-unit rollups.
LedgerEntrySchema.index({ landlordId: 1, "scope.propertyId": 1, createdAt: -1 });
LedgerEntrySchema.index({ landlordId: 1, type: 1, createdAt: -1 });
// Finding payouts still waiting on a human or on Stripe.
LedgerEntrySchema.index({ providerStatus: 1, type: 1 });

/** The invariant. Exported so the reconcile script and the tests share it. */
function linesBalance(lines = []) {
  const sum = lines.reduce(
    (total, line) => total + (line.direction === "debit" ? line.amountCents : -line.amountCents),
    0
  );
  return sum === 0;
}

LedgerEntrySchema.pre("validate", function preValidate(next) {
  if (!linesBalance(this.lines)) {
    return next(new Error("ledger entry lines do not balance to zero"));
  }
  next();
});

module.exports = mongoose.model("LedgerEntry", LedgerEntrySchema);
module.exports.ENTRY_TYPES = ENTRY_TYPES;
module.exports.PROVIDER_STATUSES = PROVIDER_STATUSES;
module.exports.linesBalance = linesBalance;
