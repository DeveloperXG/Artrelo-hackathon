const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ApprovalRequestSchema = new Schema(
  {
    landlordId: {
      type: Schema.Types.ObjectId,
      ref: "Landlord",
      required: true,
      index: true,
    },
    requestId: {
      type: Schema.Types.ObjectId,
      ref: "MaintenanceRequest",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "external_vendor_search",
        "quota_increase",
        "first_time_vendor",
        "vendor_contact_approval",
        "high_severity",
        "tenant_caused_cost",
        // A completion whose evidence did not pass. Its own type rather than a
        // payload discriminator on quota_increase, because it is genuinely a
        // different question: not "may I spend more" but "did this work happen".
        "completion_review",
        "cost_review",
        "other",
      ],
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "expired"],
      default: "pending",
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
    amountRequested: { type: Number, min: 0 },
    reason: { type: String, trim: true },
    payload: { type: Schema.Types.Mixed },
    decidedAt: { type: Date },
    // Internal identity for this exact decision attempt, never a user token and
    // never returned by normal queries. Rollback must not overwrite a newer claim.
    decisionClaimToken: { type: String, select: false },
  },
  { timestamps: true }
);
ApprovalRequestSchema.index({ landlordId: 1, requestId: 1, status: 1, expiresAt: 1, createdAt: -1 });
ApprovalRequestSchema.post("save", function invalidateApproval(doc) {
  if (doc.$locals.deferPolicyEffects) return;
  const { publish } = require("../services/realtime/liveEvents.service");
  publish(doc.landlordId, "requests");
  publish(doc.landlordId, `request:${doc.requestId}`);
});

// TELL THE MANAGER. Every approval waits on a person and most expire in 24h,
// but nothing used to say one had been raised: it surfaced only as a badge on a
// page they had to think to open. Six places create approvals, so this is a
// model hook rather than six calls -- a seventh cannot forget it. notifyUser
// emails it (decision_needed is in its EMAILED_TYPES) and never throws.
//
// isNew is gone by post-save, so it is carried across in $locals.
const DECISION_TITLES = {
  external_vendor_search: "Approve a search beyond your vendors?",
  quota_increase: "A quote is over your limit",
  first_time_vendor: "Approve a vendor you haven't used before?",
  vendor_contact_approval: "Approve contacting a vendor?",
  high_severity: "A serious job needs your approval",
  tenant_caused_cost: "Decide who pays for this job",
  completion_review: "A finished job needs your review",
  cost_review: "Itemized costs need your review",
  other: "A decision is waiting for you",
};

ApprovalRequestSchema.pre("save", function markNew() {
  this.$locals.wasNew = this.isNew;
});

async function notifyManager(doc) {
  if (doc.status !== "pending") return;
  // Required late: notify.service loads the Landlord and Tenant models, and a
  // model file should not pull services in at load time.
  // eslint-disable-next-line global-require
  const { notifyUser } = require("../services/notification/notify.service");
  await notifyUser({
    userId: doc.landlordId,
    type: "decision_needed",
    title: DECISION_TITLES[doc.type] || DECISION_TITLES.other,
    message: doc.reason || "Open Decisions to approve or decline it.",
    metadata: { workOrderId: String(doc.requestId), approvalRequestId: String(doc._id), approvalType: doc.type,
      ...(doc.payload?.priority === "emergency" ? { priority: "emergency" } : {}) },
  });
}
ApprovalRequestSchema.post("save", async function notifyAfterSave(doc) {
  if (!doc.$locals.wasNew || doc.$locals.deferPolicyEffects) return;
  await notifyManager(doc);
});
// Policy refresh commits the request and its question in one transaction;
// notification/realtime effects must run only after the transaction commits.
ApprovalRequestSchema.statics.notifyCreatedAfterCommit = async function(approvalId) {
  const doc = await this.findOne({ _id: approvalId, status: "pending" });
  if (doc) await notifyManager(doc);
};

ApprovalRequestSchema.index({ landlordId: 1, requestId: 1, "payload.reviewKey": 1 }, {
  unique: true, name: "one_pending_cost_review",
  partialFilterExpression: { type: "cost_review", status: "pending" },
});
module.exports = mongoose.model("ApprovalRequest", ApprovalRequestSchema);
