// The landlord's balance — a DERIVED CACHE, never the source of truth.
//
// The truth is the LedgerEntry journal. This document exists so a dashboard can
// read a balance without aggregating every entry ever written, and
// scripts/reconcileLedger.js rebuilds it from the journal and asserts equality.
// If the two ever disagree, the journal wins.
//
// ONE balance per landlord, deliberately. Property and unit allocations are
// soft budget tags on each entry, not separate wallets: hard partitioning would
// strand money in Unit 3B while 5A has a burst pipe, and would need a transfer
// UI, transfer audit, and reconciliation per wallet before any of it was useful.

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const centsField = { type: Number, default: 0, min: 0 };

const LandlordLedgerSchema = new Schema(
  {
    landlordId: { type: Schema.Types.ObjectId, ref: "Landlord", required: true },
    currency: { type: String, default: "CAD" },

    // Spendable right now.
    available: centsField,
    // Escrowed against booked jobs. Equal to getStats' committedCost over the
    // appointment-backed subset — which is what reconcileLedger checks.
    held: centsField,
    // Owed after a payout the balance could not cover. Kept as its own positive
    // counter rather than letting `available` go negative: a negative available
    // silently breaks every { available: { $gte: x } } guard downstream, whereas
    // arrears makes "you owe $X" a first-class, legible fact.
    arrears: centsField,
    // Artrelo service fees the wallet could not cover when a job closed. Its
    // own counter, never folded into arrears: arrears is read as exactly two
    // things (a vendor waiting on funds, an under-funded booking), and fee debt
    // in there would be cancelled by the next hold release. Paid down by the
    // next top-up, after any vendor waiting on funds.
    feesOwed: centsField,
    // Owed after a bank top-up was reversed (a dispute) once some of it had
    // been spent, plus any bank fee the wallet could not cover. Its own
    // counter for the same reason as feesOwed. Paid down by the next CARD or
    // BANK top-up (cash that is really at Stripe), after any vendor waiting on
    // funds and before unpaid service fees.
    bankOwed: centsField,

    lifetimeDeposited: centsField,
    lifetimeReleased: centsField,

    // LandlordPolicy.lowFundsThreshold finally gets a consumer. Stored here in
    // cents so the comparison needs no conversion at read time.
    lowBalanceThresholdCents: { type: Number, default: 10000, min: 0 },
    lowBalanceNotifiedAt: { type: Date, default: null },

    version: { type: Number, default: 0 },
    lastEntryAt: { type: Date, default: null },
    // Operator reconciliation of legacy external credits, which never funded
    // Stripe. New deposits cannot set this or claim those old credits are cash.
    platformFundingReviewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

LandlordLedgerSchema.index({ landlordId: 1 }, { unique: true });

module.exports = mongoose.model("LandlordLedger", LandlordLedgerSchema);
