const mongoose = require("mongoose");
const { QuoteSnapshotSchema } = require("./schemas/quoteItemization.schema");
const Schema = mongoose.Schema;

// One document per (request, candidate, attempt). This is the SOURCE OF TRUTH
// for outreach state.
//
// The mirrored `outreach` object on MaintenanceRequest.vendorRecommendationSnapshot
// is only a derived read-cache: that snapshot is Schema.Types.Mixed with a
// read-modify-write update idiom and no concurrency control, so two writers can
// silently clobber each other. Every state transition here is an atomic
// conditional findOneAndUpdate; only the winner projects onto the snapshot, and
// the snapshot is re-projected from these rows on read.

const OUTREACH_STATUSES = [
  // Approved while the vendor was closed (by their own hours). Nothing has been
  // sent; the sweeper delivers it at scheduledFor. Not open: no link resolves.
  "scheduled",
  "queued",
  "sent",
  "delivery_failed",
  "viewed",
  "accepted",
  "declined",
  "expired",
  "superseded",
  "revoked",
];

const OUTREACH_TIERS = ["emergency", "urgent", "normal", "low"];

// Terminal for the OFFER round: the vendor can no longer accept or decline the
// original job request, and the timeout sweeper must not touch the row.
//
// `accepted` is the exception worth knowing about. It ends the offer round, but
// the row may still be live: a counter-offer round runs at `accepted` with its
// own token, its own deadline, and its own sweep. "Terminal" here means the
// offer is settled, NOT that the row is finished.
const TERMINAL_OUTREACH_STATUSES = [
  "accepted",
  "declined",
  "expired",
  "superseded",
  "revoked",
];

// States in which a vendor may still submit a response.
const OPEN_OUTREACH_STATUSES = ["sent", "viewed"];

// The counter-offer sub-machine. Runs while the top-level status is `accepted`,
// which is why `accepted` above is terminal for the OFFER round but not for the
// row as a whole — see the counterOffer field comment.
const COUNTER_OFFER_STATUSES = [
  "none",
  "pending",
  "confirmed",
  "declined",
  "expired",
  "withdrawn",
];

const OfferedWindowSchema = new Schema(
  {
    slotId: { type: String, required: true },
    start: { type: Date },
    end: { type: Date },
    label: { type: String },
    timeZone: { type: String },
    // "asap" is a pseudo-slot used for emergency tier — it has no fixed start.
    kind: { type: String, enum: ["asap", "window", "flexible"], default: "window" },
  },
  { _id: false }
);

const SelectedWindowSchema = new Schema(
  {
    slotId: { type: String },
    start: { type: Date },
    end: { type: Date },
    label: { type: String },
    timeZone: { type: String },
    kind: { type: String },
  },
  { _id: false }
);

const VendorOutreachSchema = new Schema(
  {
    requestId: {
      type: Schema.Types.ObjectId,
      ref: "MaintenanceRequest",
      required: true,
      index: true,
    },
    landlordId: { type: Schema.Types.ObjectId, ref: "Landlord", required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant" },
    // Null for provider-sourced candidates that have no landlord-owned Vendor row.
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", default: null },
    // The global contractor behind this outreach. Survives across landlords and
    // is what payouts and the vendor hub key on. Null when the candidate had no
    // usable phone or email at send time.
    identityId: { type: Schema.Types.ObjectId, ref: "VendorIdentity", default: null, index: true },

    candidateKey: { type: String, required: true, index: true },
    providerName: { type: String, trim: true },
    providerVendorId: { type: String, trim: true },
    vendorNameSnapshot: { type: String, trim: true },

    // Real PII. Never returned by an API — the snapshot carries a masked copy.
    toEmail: { type: String, required: true, trim: true, lowercase: true },
    channel: { type: String, enum: ["email"], default: "email" },
    attempt: { type: Number, default: 1, min: 1 },
    // Absent on historical offers. New offers use the funded booking and
    // shared calendar path; rollback must not silently downgrade those jobs.
    bookingVersion: { type: Number },
    bookingActionToken: { type: String, select: false },
    negotiatedProposal: { amountCents: Number, start: Date, durationMinutes: Number, note: String },

    // sha256 of the raw magic-link token. The raw token is never persisted and
    // never logged. Unset on terminal states so the link stops resolving.
    //
    // NEVER `$set: { tokenHash: null }`. The unique index below is sparse, not
    // partial, so it still indexes explicit nulls — two rows both persisting a
    // null would collide with E11000. Retirement must use `$unset`, and rotation
    // (the counter-offer round) must `$set` a real hash. See JobToken.js, which
    // hit this and switched to a partialFilterExpression.
    tokenHash: { type: String, default: null },
    tokenLast4: { type: String, default: null },

    status: { type: String, enum: OUTREACH_STATUSES, default: "queued", index: true },
    // Server-issued isolated simulation receipt, never a real email claim.
    simulatedDelivery: { type: Boolean, default: false },
    tier: { type: String, enum: OUTREACH_TIERS, required: true },
    offeredWindows: { type: [OfferedWindowSchema], default: [] },
    // Bumped by every refresh of offeredWindows (offeredWindows.service), so two
    // concurrent refreshes can't both write and leave the vendor's page holding
    // slot ids the other replaced.
    windowsVersion: { type: Number, default: 0 },

    // The landlord-approved draft, verbatim.
    messageBody: { type: String },

    // When a `scheduled` row goes out: the vendor's next opening at the time
    // contact was approved. Kept after delivery as a record of the wait.
    scheduledFor: { type: Date, default: null },
    sentAt: { type: Date },
    initiation: { type: String, enum: ['policy_auto_start', 'policy_auto_advance', 'landlord', 'unknown'], default: 'unknown' },
    firstContactDecisionId: { type: Schema.Types.ObjectId, ref: 'FirstContactDecision', default: null, select: false },
    deliveryUnconfirmed: { type: Boolean, default: false },
    firstViewedAt: { type: Date },
    lastViewedAt: { type: Date },
    viewCount: { type: Number, default: 0, min: 0 },
    submitAttempts: { type: Number, default: 0, min: 0 },

    respondedAt: { type: Date },
    responseDeadlineAt: { type: Date, index: true },
    expiresAt: { type: Date },
    revealedAt: { type: Date },

    deliveryProvider: { type: String },
    deliveryMessageId: { type: String },
    deliveryError: { type: String },

    quoteContractVersion: { type: Number, enum: [2], default: undefined },
    currentQuoteRevision: { type: Number, min: 1, max: 5, default: undefined },
    quoteRevisions: { type: [QuoteSnapshotSchema], default: undefined },
    approvedQuoteSnapshot: { type: QuoteSnapshotSchema, default: undefined },
    quoteCheckpointId: { type: Schema.Types.ObjectId, ref: "PolicyCheckpoint", default: undefined },
    quoteReview: {
      revision: { type: Number, min: 0, validate: Number.isSafeInteger },
      state: { type: String, enum: ["pending", "needs_review", "waiting_clarification", "cleared", "rejected"] },
      clarificationId: { type: Schema.Types.ObjectId, ref: "QuoteClarification" },
      quoteHash: String,
      contextHash: String,
      analysisId: { type: Schema.Types.ObjectId, ref: "QuoteAnalysis" },
      resumePending: Boolean,
      approvalId: { type: Schema.Types.ObjectId, ref: "ApprovalRequest" },
      clearedAt: Date,
    },
    response: {
      outcome: { type: String, enum: ["accepted", "declined"] },
      quoteLow: { type: Number, min: 0 },
      quoteHigh: { type: Number, min: 0 },
      quoteCurrency: { type: String, default: "CAD" },
      quoteNotes: { type: String },
      declineReason: { type: String },
      selectedSlotId: { type: String },
      selectedWindow: { type: SelectedWindowSchema, default: null },
      // The window is what the vendor CAN do; these are when they actually
      // commit to arriving and for how long. They drive Appointment
      // confirmedStart/confirmedEnd, which is what the tenant confirms.
      scheduledArrivalAt: { type: Date },
      durationMinutes: { type: Number, min: 15, max: 480 },
      alternateNote: { type: String },
      submittedAt: { type: Date },
      // Hashed rather than stored raw — enough to spot abuse, not a tracking record.
      submitterIpHash: { type: String },
      submitterUaHash: { type: String },
    },

    quotaCheck: {
      limit: { type: Number },
      quoteHigh: { type: Number },
      overQuota: { type: Boolean },
      evaluatedAt: { type: Date },
    },

    // What the manager authorized for THIS vendor's quote.
    //
    // Deliberately NOT request.quotaOverride: that is a standing per-request limit
    // that would also silently authorize the NEXT vendor if this one falls through.
    // Promoted to quotaOverride only at booking.
    //
    // PRIVACY: landlord-only. This is the manager's reservation price — a vendor
    // who learns it anchors every future quote upward. It must never appear in
    // buildResponsePayload or any vendor-facing view. The one sanctioned
    // disclosure is counterOffer.amount, which the vendor is explicitly asked
    // to accept. See services/completion/completionViews.service.js for the
    // sibling rule on approvedCeiling.
    authorizedCeiling: { type: Number, default: null, min: 0 },
    authorizedCeilingAt: { type: Date, default: null },
    authorizedBy: { type: Schema.Types.ObjectId, ref: "Landlord", default: null },

    // The negotiation round that opens when a manager authorizes an amount
    // between the vendor's quoteLow and quoteHigh. The row stays `accepted` at
    // the top level for the whole pending round (see the status comment above),
    // so this sub-status is the real state machine.
    counterOffer: {
      status: {
        type: String,
        enum: COUNTER_OFFER_STATUSES,
        default: "none",
      },
      round: { type: Number, default: 0, min: 0 },
      // Frozen copy of authorizedCeiling. Must not be derived: a later
      // completion overage approval moves request.quotaOverride, and a derived
      // amount would retroactively change what the vendor agreed to.
      amount: { type: Number, min: 0 },
      currency: { type: String, default: "CAD" },
      // What the range was when this round opened, so the floor invariant stays
      // checkable from one object.
      quotedLow: { type: Number, min: 0 },
      quotedHigh: { type: Number, min: 0 },
      note: { type: String },
      sentAt: { type: Date },
      deadlineAt: { type: Date },
      respondedAt: { type: Date },
      declineReason: { type: String },
      deliveryError: { type: String, default: null },
      submitterIpHash: { type: String },
      submitterUaHash: { type: String },
    },

    appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", default: null },
    approvalRequestId: { type: Schema.Types.ObjectId, ref: "ApprovalRequest", default: null },
    supersededBy: { type: Schema.Types.ObjectId, ref: "VendorOutreach", default: null },
  },
  { timestamps: true }
);

// Sparse so many rows may hold a null tokenHash once their token is retired.
VendorOutreachSchema.index({ tokenHash: 1 }, { unique: true, sparse: true });
// The double-click lock: concurrent approve-contact calls collide here (E11000)
// rather than both sending an email.
VendorOutreachSchema.index({ requestId: 1, candidateKey: 1, attempt: 1 }, { unique: true });
VendorOutreachSchema.index({ requestId: 1 }, { unique: true, name: "one_live_v2_offer",
  partialFilterExpression: { bookingVersion: 2, status: { $in: ["scheduled", "queued", "sent", "viewed", "accepted"] } } });
// Drives the timeout sweeper.
VendorOutreachSchema.index({ status: 1, responseDeadlineAt: 1 });
// The release sweep: scheduled rows whose time has come.
VendorOutreachSchema.index({ status: 1, scheduledFor: 1 });
// Drives the counter-offer timeout sweep. Deliberately a separate claim from the
// one above: the offer sweep matches status sent/viewed, this one matches rows
// sitting at `accepted`, so the two can never contend for the same row.
VendorOutreachSchema.index({ "counterOffer.status": 1, "counterOffer.deadlineAt": 1 });
VendorOutreachSchema.index({ requestId: 1, createdAt: -1 });

// Deliberately NO TTL index on expiresAt — the outreach record is part of the
// audit trail and must outlive the token it carried.

module.exports = mongoose.model("VendorOutreach", VendorOutreachSchema);
module.exports.OUTREACH_STATUSES = OUTREACH_STATUSES;
module.exports.OUTREACH_TIERS = OUTREACH_TIERS;
module.exports.TERMINAL_OUTREACH_STATUSES = TERMINAL_OUTREACH_STATUSES;
module.exports.OPEN_OUTREACH_STATUSES = OPEN_OUTREACH_STATUSES;
module.exports.COUNTER_OFFER_STATUSES = COUNTER_OFFER_STATUSES;
