// The persistent, GLOBAL vendor. One document per real-world contractor.
//
// This is deliberately NOT the `Vendor` model. `Vendor` is landlord-scoped
// (`Vendor.landlordId`, and every read path filters on it), so the same plumber
// working for two landlords is two Vendor documents. That is correct for what
// Vendor actually is — a landlord's roster entry: their pricing, their
// preference flags, their blacklists, their capacity limit.
//
// But three things must survive across landlords:
//   - the Stripe Connect account (a vendor onboards to payouts ONCE, not once
//     per landlord who hires them),
//   - the vendor hub session (one login shows every job they hold),
//   - completed-job history used for trust scoring later.
//
// Those live here. `Vendor.identityId` points at this document.
//
// Keying: phone is preferred but NOT required, because outreach is email-only
// (VendorOutreach.channel is "email") and an identity is created at first SEND,
// when we frequently have an email and no phone at all. So the key is
// `e164(phone) ?? lower(email)` and both normalized values are stored.

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const CONNECT_STATUSES = ["none", "pending", "restricted", "enabled"];

const ProviderRefSchema = new Schema(
  {
    providerName: { type: String, trim: true },
    providerVendorId: { type: String, trim: true },
  },
  { _id: false }
);

const VendorIdentitySchema = new Schema(
  {
    // e164(phone) ?? lower(email). Never mutated in place once set — a vendor
    // whose phone is discovered later keeps its email key and gains phoneE164;
    // genuine duplicates are resolved by the explicit mergeIdentities().
    identityKey: { type: String, required: true, trim: true },

    phoneE164: { type: String, trim: true, default: undefined },
    emailNormalized: { type: String, trim: true, lowercase: true, default: undefined },

    displayName: { type: String, trim: true },
    businessWebsite: { type: String, trim: true, default: null },
    providerRefs: { type: [ProviderRefSchema], default: [] },

    // Payouts. Stored here and nowhere else, so onboarding is once-per-vendor
    // rather than once-per-landlord.
    stripeConnectAccountId: { type: String, trim: true, default: null },
    connectStatus: { type: String, enum: CONNECT_STATUSES, default: "none" },
    connectOnboardedAt: { type: Date, default: null },

    // Guards the one-time hub introduction email.
    hubIntroSentAt: { type: Date, default: null },

    // Populated by closeJobCompletion. The read model a trusted-vendor score
    // will later be derived from, so it starts collecting on day one.
    aggregate: {
      completedJobs: { type: Number, default: 0, min: 0 },
      disputedJobs: { type: Number, default: 0, min: 0 },
      ratingSum: { type: Number, default: 0, min: 0 },
      ratingCount: { type: Number, default: 0, min: 0 },
    },

    // Set by mergeIdentities on the losing document. Readers must follow it.
    mergedInto: { type: Schema.Types.ObjectId, ref: "VendorIdentity", default: null },
  },
  { timestamps: true }
);

VendorIdentitySchema.index({ identityKey: 1 }, { unique: true });

// partialFilterExpression, NOT sparse. A sparse unique index still treats an
// explicit `null` as a value, so two identities that both stored `phoneE164:
// null` would collide. Requiring $type: "string" excludes both missing and null.
VendorIdentitySchema.index(
  { phoneE164: 1 },
  { unique: true, partialFilterExpression: { phoneE164: { $type: "string" } } }
);
VendorIdentitySchema.index(
  { emailNormalized: 1 },
  { unique: true, partialFilterExpression: { emailNormalized: { $type: "string" } } }
);

VendorIdentitySchema.index({ mergedInto: 1 });

module.exports = mongoose.model("VendorIdentity", VendorIdentitySchema);
module.exports.CONNECT_STATUSES = CONNECT_STATUSES;
