const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const LandlordPolicySchema = new Schema(
  {
    landlordId: {
      type: Schema.Types.ObjectId,
      ref: "Landlord",
      required: true,
      unique: true,
      index: true,
    },
    policyRevision: { type: Number, default: 0, min: 0 },
    policyChangeReceiptRef: { type: String, default: null },
    auditRef: { type: String, default: null },
    allowQuoteClarification: { type: Boolean, default: false },
    checkpointFence: { type: Number, default: 0, select: false },
    // Unset until the landlord chooses one. A spending limit is the landlord's
    // decision, not ours: a silent $300 default let vendors be contacted on a
    // budget nobody had agreed to. While null, nothing is contacted without the
    // landlord approving that job (reasonCode "quota_not_set").
    defaultQuota: { type: Number, default: null, min: 0 },
    categoryQuotas: { type: Map, of: Number, default: {} },
    propertyQuotas: { type: Map, of: Number, default: {} },
    unitQuotas: { type: Map, of: Number, default: {} },
    requireApprovalForExternalSearch: { type: Boolean, default: true },
    requireApprovalOverQuota: { type: Boolean, default: true },
    requireApprovalForFirstTimeVendor: { type: Boolean, default: true },
    allowAutopilotForLowSeverity: { type: Boolean, default: true },
    allowAutopilotForMediumSeverity: { type: Boolean, default: false },
    digestFrequency: {
      type: String,
      enum: ["instant", "hourly", "daily"],
      default: "daily",
    },
    emergencyNotificationChannels: {
      type: [String],
      enum: ["email", "sms", "push"],
      default: ["email", "push"],
    },
    lowFundsThreshold: { type: Number, default: 100, min: 0 },

    // Vendor outreach fallback. When a vendor declines or lets the response SLA
    // lapse, auto-advance contacts the next-best queued candidate without asking;
    // otherwise a fresh vendor_contact_approval is raised for the manager.
    autoAdvanceOnVendorDecline: { type: Boolean, default: true },
    // A ceiling, not a promise of three real vendors. An unset spending quota
    // still requires approval; an explicitly saved zero disables contact.
    maxOutreachAttempts: { type: Number, default: 3, min: 0, max: 5 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LandlordPolicy", LandlordPolicySchema);
