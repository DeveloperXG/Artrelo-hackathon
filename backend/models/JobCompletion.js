// Proof that a vendor showed up and did the work, and that the tenant is happy.
//
// One document per Appointment. Deliberately NOT stored on VendorOutreach or on
// MaintenanceRequest:
//
//  - VendorOutreach is scoped to (request, candidate, attempt), is retired on
//    supersede, and does not exist AT ALL for manually-assigned vendors
//    (manualAssignVendorRecommendation, createAppointment). Completion has to
//    cover those too.
//  - MaintenanceRequest carries vendorRecommendationSnapshot, a Mixed field
//    mutated read-modify-write via .save() with no concurrency control. This
//    slice introduces an UNAUTHENTICATED writer (the magic-link vendor); it must
//    not share a document with the routing snapshot.
//
// request.finalCost / completedAt / completionNotes and Appointment.status
// remain the PROJECTION, written at close. This document is the source of
// truth — the same relationship VendorOutreach already has with the snapshot
// ledger, so this is not a new pattern.
//
// After-photos live here rather than in incidentRecord.evidence.assets on
// purpose: buildEvidencePhotos reads that array into buildPublicBrief, which
// ships PRE-ACCEPT, so completed-work photos would leak into the next vendor's
// brief mislabelled as the problem.

const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const { QuoteSnapshotSchema } = require("./schemas/quoteItemization.schema");

const COMPLETION_STATUSES = [
  "draft", // vendor is uploading; nothing submitted yet
  "awaiting_tenant", // submitted, evidence passed, tenant has the ball
  "in_review", // evidence failed a check — a human decides before any payout
  "confirmed", // tenant said yes, or the 48h timer fired
  "closed", // projected onto the request; money released
  "disputed", // tenant said no, or review rejected it
  "void", // superseded by a landlord's manual completion
];

const CLOSE_REASONS = [
  "tenant_confirmed",
  "auto_confirmed",
  "landlord_override",
  "review_approved",
  "disputed_resolved",
  // The booking fell through before any work: a no-show, or a tenant who
  // never confirmed the time (services/completion/appointmentFailure).
  "booking_failed",
];

const EVIDENCE_VERDICTS = ["pass", "review", "fail"];

// Shaped like EvidenceAssetSchema in MaintenanceRequest.js so the Cloudinary
// upload path is identical, plus the three fields that make a photo evidence
// rather than decoration.
const CompletionAssetSchema = new Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String },
    type: { type: String, enum: ["image", "video"], default: "image" },
    label: { type: String, default: null },
    format: { type: String },
    bytes: { type: Number },
    width: { type: Number },
    height: { type: Number },

    stage: { type: String, enum: ["before", "after"], default: "after" },
    // Read SERVER-SIDE from the image itself. A DateTimeOriginal far from
    // receivedAt is the recycled-photo signal.
    exifTakenAt: { type: Date, default: null },
    // Server clock at upload. Authoritative, unlike anything the client sends.
    receivedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// Presence evidence.
//
// HONEST LABELLING MATTERS HERE. The server cannot derive GPS — browser
// geolocation is client-supplied and trivially spoofed, and IP geolocation is
// city-level and wrong behind mobile carriers. What IS server-side is the
// timestamp and the distance COMPUTATION against the unit's address. So the
// coordinates carry source: "client_reported" and this whole block feeds the
// review queue; it never proves presence on its own.
const GeoStampSchema = new Schema(
  {
    source: { type: String, enum: ["client_reported", "denied", "unavailable"], default: "unavailable" },
    at: { type: Date },
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 },
    accuracyMeters: { type: Number, min: 0 },
    distanceMeters: { type: Number, min: 0, default: null },
    verdict: { type: String, enum: EVIDENCE_VERDICTS, default: "review" },
  },
  { _id: false }
);

const JobCompletionSchema = new Schema(
  {
    // The idempotency claim. One completion per appointment, enforced by the
    // database rather than by a read-then-write in application code.
    appointmentId: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      required: true,
    },

    requestId: { type: Schema.Types.ObjectId, ref: "MaintenanceRequest", required: true, index: true },
    landlordId: { type: Schema.Types.ObjectId, ref: "Landlord", required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", index: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", default: null },
    identityId: { type: Schema.Types.ObjectId, ref: "VendorIdentity", default: null, index: true },
    outreachId: { type: Schema.Types.ObjectId, ref: "VendorOutreach", default: null },

    source: { type: String, enum: ["vendor_portal", "landlord_manual"], default: "vendor_portal" },
    status: { type: String, enum: COMPLETION_STATUSES, default: "draft", index: true },

    quoteContractVersion: { type: Number, enum: [2], default: undefined },
    approvedQuoteSnapshot: { type: QuoteSnapshotSchema, default: undefined },
    invoiceReview: {
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
    report: {
      finalStatement: { type: QuoteSnapshotSchema, default: undefined },
      invoiceReference: { type: String, maxlength: 120, default: undefined },
      workPerformed: { type: String, maxlength: 2000 },
      partsUsed: { type: String, maxlength: 1000 },
      followUpNeeded: { type: Boolean, default: false },
      followUpNotes: { type: String, maxlength: 1000 },
      actualCost: { type: Number, min: 0, max: 1000000, default: null },
      currency: { type: String, default: "CAD" },
      // Required at submit ONLY when actualCost trips isOverCeiling. Captured
      // there rather than asked for later because the manager otherwise rules on
      // a bare number, and by the time they look the vendor has moved on.
      // Landlord-facing: it is the justification, so it rides on the approval.
      overageReason: { type: String, maxlength: 1000, default: null },
      // What the vendor says. Distrusted relative to receivedAt.
      completedAt: { type: Date },
      // Server clock at submit. Authoritative.
      receivedAt: { type: Date },
      submittedAt: { type: Date },
      submitterIpHash: { type: String, default: null },
      submitterUaHash: { type: String, default: null },
    },

    photos: { type: [CompletionAssetSchema], default: [] },
    checkIn: { type: GeoStampSchema, default: null },
    checkOut: { type: GeoStampSchema, default: null },

    // Deterministic, reproducible, and computed by a pure function so the
    // thresholds stay tunable and a verdict can be re-derived in a dispute
    // months later.
    evidenceVerdict: { type: String, enum: EVIDENCE_VERDICTS, default: "review" },
    // When a human was actually asked about weak evidence.
    //
    // evidenceVerdict must NOT be rewritten to "pass" after a review: a dispute
    // months later depends on what the checks said AT SUBMIT. So "someone
    // looked" is tracked separately, and it is what lets auto-confirm resume —
    // without it a tenant going quiet a second time re-escalates forever.
    evidenceReviewedAt: { type: Date, default: null },
    evidenceReasons: { type: [String], default: [] },

    // Snapshotted at creation, never read live: the outreach that carried the
    // quote can be superseded out from under a finished job.
    //
    // Resolved via resolveBookedAmount, so on a job booked through a confirmed
    // counter-offer this is the NEGOTIATED figure, not the vendor's original
    // quoteHigh — otherwise the overage gate would never fire on exactly the
    // jobs a manager talked down.
    //
    // PRIVACY: landlord-only. Listed in LANDLORD_ONLY_KEYS and omitted from
    // buildVendorCompletionView. Since it can now carry the manager's
    // authorization rather than the vendor's own number, exposing it to the
    // vendor would leak the manager's reservation price.
    approvedCeiling: { type: Number, default: null },
    overage: {
      isOver: { type: Boolean, default: false },
      amount: { type: Number, default: 0 },
      approvalRequestId: { type: Schema.Types.ObjectId, ref: "ApprovalRequest", default: null },
      decision: { type: String, enum: ["pending", "approved", "rejected"], default: null },
      // What the manager actually authorized, which is NOT always what the
      // vendor invoiced — they may approve a lower figure. This caps the
      // payout at close. Kept separate from approvedCeiling on purpose:
      // approvedCeiling is the basis of the escrow HOLD and must keep
      // describing what was reserved at booking, or releaseHold would try to
      // release money that was never held.
      approvedAmount: { type: Number, default: null },
      resolvedAt: { type: Date, default: null },
    },

    tenantConfirmation: {
      outcome: { type: String, enum: ["confirmed", "disputed"], default: null },
      rating: { type: Number, min: 1, max: 5, default: null },
      comment: { type: String, maxlength: 500 },
      respondedAt: { type: Date },
      autoConfirmed: { type: Boolean, default: false },
    },

    // TWO timers, because "auto-confirm releases payment" and "auto-confirm is
    // reversible" cannot both be true of a single deadline. autoConfirmAt closes
    // the job; payoutReleaseAt moves the money a trailing window later, so a
    // dispute inside that window voids a transfer that never existed. A manual
    // tenant confirmation sets payoutReleaseAt = now — they already spoke.
    autoConfirmAt: { type: Date, default: null },
    payoutReleaseAt: { type: Date, default: null },

    closedAt: { type: Date, default: null },
    closeReason: { type: String, enum: CLOSE_REASONS, default: null },
    // New closes only. Freeze the authorized value before projecting related
    // records. Recovery repairs documents; it never replays financial actions.
    closeRecovery: {
      version: Number,
      payableCents: { type: Number, min: 0 },
      actorUserId: { type: Schema.Types.ObjectId },
      projectionPending: Boolean,
      settlementRecordedAt: Date,
      reviewedAt: Date,
      attentionClaimedAt: Date,
      leaseUntil: Date,
      attempts: { type: Number, default: 0 },
    },

    // Declared here, written in slice C. Keeping the shape in place means the
    // close path already has somewhere to record what it did.
    ledger: {
      holdId: { type: Schema.Types.ObjectId, ref: "LedgerEntry", default: null },
      releaseEntryId: { type: Schema.Types.ObjectId, ref: "LedgerEntry", default: null },
      payoutStatus: { type: String, default: null },
      payoutCheckedAt: Date,
      // Artrelo's service fee on this job, written once at the close by
      // serviceFee.service. The DURABLE DECISION: a fee waived during the beta
      // has no ledger entry (an entry needs a positive amount), so this is the
      // only record that it was waived -- and a replay honours it rather than
      // re-deciding against a beta that may have ended since.
      //
      // PRIVACY: landlord-only, like the rest of `ledger` (LANDLORD_ONLY_KEYS).
      // What Artrelo charges the landlord is not the vendor's or tenant's business.
      serviceFee: {
        type: new Schema(
          {
            listCents: { type: Number, min: 0, required: true },
            // Billed for this job. Always the full fee unless it was waived.
            chargedCents: { type: Number, min: 0, required: true },
            // Of chargedCents, the part the wallet could not cover at the close
            // and the landlord now owes (LandlordLedger.feesOwed).
            owedCents: { type: Number, min: 0, default: 0 },
            waivedReason: { type: String, enum: ["beta", null], default: null },
            basis: {
              flatCents: { type: Number, min: 0, default: 0 },
              percent: { type: Number, min: 0, default: 0 },
            },
            rateSource: { type: String, enum: ["list", "founding", "founding_locked"], default: "list" },
            entryId: { type: Schema.Types.ObjectId, ref: "LedgerEntry", default: null },
            decidedAt: { type: Date, required: true },
          },
          { _id: false }
        ),
        default: null,
      },
    },
  },
  { timestamps: true }
);

JobCompletionSchema.index({ appointmentId: 1 }, { unique: true });
// The two sweeper queries.
JobCompletionSchema.index({ status: 1, autoConfirmAt: 1 });
JobCompletionSchema.index({ status: 1, payoutReleaseAt: 1 });
// The vendor hub's history query (slice D).
JobCompletionSchema.index({ identityId: 1, closedAt: -1 });
JobCompletionSchema.index({ landlordId: 1, status: 1 });
JobCompletionSchema.index({ "closeRecovery.version": 1, "closeRecovery.reviewedAt": 1, closedAt: 1 });
JobCompletionSchema.index({ status: 1, "ledger.payoutCheckedAt": 1, _id: 1 });

module.exports = mongoose.model("JobCompletion", JobCompletionSchema);
module.exports.COMPLETION_STATUSES = COMPLETION_STATUSES;
module.exports.CLOSE_REASONS = CLOSE_REASONS;
module.exports.EVIDENCE_VERDICTS = EVIDENCE_VERDICTS;
