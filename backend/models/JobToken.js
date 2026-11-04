// The vendor's credential for one job, promoted out of VendorOutreach.tokenHash.
//
// Why it moved: VendorOutreach is scoped to (request, candidate, attempt) and is
// retired the moment that outreach row goes terminal — superseded, expired,
// revoked. That is correct for an OFFER. It is wrong for a live job: a vendor
// who accepted and is standing in the unit must not lose their link because the
// routing pipeline retired the outreach row behind them.
//
// So there are two scopes over the same primitive:
//
//   scope: "offer" -> pre-acceptance. Retired on decline/expire/supersede.
//   scope: "job"   -> minted AT acceptance. Carries accept -> in_progress ->
//                     complete, and is revoked only when the job closes.
//
// The raw token is never persisted and never logged; only sha256(token) is
// stored, exactly as vendorOutreach.service has always done.

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const JOB_TOKEN_SCOPES = ["offer", "job", "scheduling"];

// Crockford base32: no I, L, O, or U. Ambiguous glyphs are the whole problem
// with a code a vendor reads off a phone screen and types into another device.
const JOB_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const JOB_CODE_LENGTH = 8;

const JobTokenSchema = new Schema(
  {
    // sha256 of the raw token. Unset (not nulled) on revoke so the partial
    // unique index stops covering the row and the link stops resolving.
    tokenHash: { type: String, default: undefined },

    // RESERVED, NOT YET A WORKING FALLBACK. Generated and unique-indexed, but
    // no endpoint redeems it — an earlier comment here claimed it resolved to
    // an emailed link, which was never built. Recovery today is the vendor hub
    // (POST /vendor-hub/jobs/:ref/link), which re-issues a link after the
    // vendor proves control of their email.
    //
    // If it is ever wired up it must NOT authenticate directly: 8 base32 chars
    // is ~40 bits, far too little to hand somebody a job on. It would resolve
    // to an emailed link, like the hub does.
    jobCode: { type: String, default: undefined, uppercase: true, trim: true },

    scope: { type: String, enum: JOB_TOKEN_SCOPES, required: true, index: true },

    outreachId: { type: Schema.Types.ObjectId, ref: "VendorOutreach", index: true },
    requestId: { type: Schema.Types.ObjectId, ref: "MaintenanceRequest", required: true, index: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", default: null, index: true },
    preparationId: { type: Schema.Types.ObjectId, ref: "BookingPreparation", default: null },
    landlordId: { type: Schema.Types.ObjectId, ref: "Landlord", index: true },
    identityId: { type: Schema.Types.ObjectId, ref: "VendorIdentity", default: null, index: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", default: null },
    vendorNameSnapshot: { type: String, trim: true },

    expiresAt: { type: Date },
    usedCount: { type: Number, default: 0, min: 0 },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// partialFilterExpression rather than sparse: a sparse unique index still
// treats an explicit null as a value, so two revoked tokens that both stored
// `tokenHash: null` would collide. Revocation $unsets the field instead.
JobTokenSchema.index(
  { tokenHash: 1 },
  { unique: true, partialFilterExpression: { tokenHash: { $type: "string" } } }
);
JobTokenSchema.index(
  { jobCode: 1 },
  { unique: true, partialFilterExpression: { jobCode: { $type: "string" } } }
);

// One live job token per appointment. This is the claim that keeps
// finalizeVendorAcceptance idempotent when it re-enters after a quota approval.
JobTokenSchema.index(
  { appointmentId: 1, scope: 1 },
  { unique: true, partialFilterExpression: { appointmentId: { $type: "objectId" }, scope: "job" } }
);

JobTokenSchema.index({ preparationId: 1, scope: 1 }, { unique: true,
  partialFilterExpression: { preparationId: { $type: "objectId" }, scope: "scheduling" } });
module.exports = mongoose.model("JobToken", JobTokenSchema);
module.exports.JOB_TOKEN_SCOPES = JOB_TOKEN_SCOPES;
module.exports.JOB_CODE_ALPHABET = JOB_CODE_ALPHABET;
module.exports.JOB_CODE_LENGTH = JOB_CODE_LENGTH;
