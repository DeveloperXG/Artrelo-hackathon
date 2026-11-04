// One bank top-up, from the click to its outcome.
//
// The LEDGER still holds only money that ARRIVED: a deposit entry is posted on
// payment_intent.succeeded and nowhere else. This record is the in-flight
// state the ledger deliberately cannot hold:
//
//   * the wallet's "processing, expected by ..." line;
//   * the risk rules: one debit in flight and a per-debit cap until a landlord
//     has `trustedAfter` cleared, undisputed bank top-ups;
//   * finding the top-up a later dispute is about.
//
// `clientToken` is the browser's id for ONE attempt (a UUID minted when the
// landlord presses the button). Unique per landlord, and also part of Stripe's
// idempotency key, so a double-click -- or a retry after a dropped response --
// converges on one debit rather than two. With a saved bank account the server
// CONFIRMS the debit itself, so without this a double-click takes money twice.

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const TOP_UP_STATUSES = [
  "created", // intent minted; for a new bank, the landlord has not finished the form
  "processing", // the bank was asked; Stripe answers in about four business days
  "succeeded", // credited to the wallet (the ledger deposit exists)
  "failed", // the bank refused it, or verification failed; nothing was credited
  "disputed", // the account holder disputed it after it succeeded; reversed
  "canceled",
];

const WalletTopUpSchema = new Schema(
  {
    landlordId: { type: Schema.Types.ObjectId, ref: "Landlord", required: true, index: true },
    clientToken: { type: String, required: true, trim: true },
    method: { type: String, enum: ["bank"], default: "bank" },
    // Set once Stripe answers. Unique where present.
    paymentIntentId: { type: String, default: null },
    // What the wallet receives. A bank debit has no gross-up: Artrelo absorbs
    // Stripe's fee (1% + $0.40, capped at $5), so this is also what is debited.
    walletCents: { type: Number, required: true, min: 0 },
    // A saved account confirmed server-side, versus a new one entered in the form.
    savedBank: { type: Boolean, default: false },
    transactionType: { type: String, enum: ["personal", "business"] },
    status: { type: String, enum: TOP_UP_STATUSES, default: "created", index: true },
    processingAt: { type: Date, default: null },
    // Stripe's expected debit date, else processing + 5 business days. Shown to
    // the landlord, never used to decide anything.
    expectedAt: { type: Date, default: null },
    succeededAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    failureCode: { type: String, default: null },
    failureMessage: { type: String, default: null },
    disputeId: { type: String, default: null },
    disputedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

WalletTopUpSchema.index({ landlordId: 1, clientToken: 1 }, { unique: true });
WalletTopUpSchema.index(
  { paymentIntentId: 1 },
  { unique: true, partialFilterExpression: { paymentIntentId: { $type: "string" } } }
);
WalletTopUpSchema.index({ landlordId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("WalletTopUp", WalletTopUpSchema);
module.exports.TOP_UP_STATUSES = TOP_UP_STATUSES;
