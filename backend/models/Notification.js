const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    eventKey: { type: String, default: undefined, select: false },
    type: {
      type: String,
      required: true,
      enum: [
        "appointment_booked",
        "appointment_confirmed",
        "appointment_cancelled",
        "appointment_reminder",
        "booking_coordination",
        "payment_processed",
        "payment_failed",
        "payment_refunded",
        "payment_overdue",
        "lease_expiring",
        "lease_renewed",
        "lease_terminated",
        "rent_due",
        "maintenance_scheduled",
        "maintenance_completed",
        "maintenance_cancelled",
        // Rejection and appeal (services/request/appeal.service.js).
        "request_rejected",
        "request_appeal_submitted",
        "request_reopened",
        // Carries no metadata.workOrderId on purpose: the request it is about
        // has been deleted, and the delete cascade removes notifications by
        // that field.
        "request_rejected_final",
        // This enum is CLOSED and notifyUser swallows the ValidationError
        // (notify.service.js), so an unlisted type is a silent no-op rather
        // than an error. Anything notifyUser is called with must be here.
        "maintenance_verification_requested",
        "maintenance_verification_disputed",
        "maintenance_auto_confirmed",
        "vendor_hub_invite",
        // Inbound SMS from a vendor, relayed into the request thread.
        "vendor_message_received",
        // A message in a request thread from the other party. Coalesced: one
        // unread row per request that counts up (notifyUser `coalesce`).
        "tenant_message_received",
        "landlord_message_received",
        // Saving a routing policy re-evaluated the landlord's open requests.
        "policy_requests_reevaluated",
        "vendor_payout_sent",
        // A payout that is paid for but waiting on Stripe to clear the card
        // money it draws on. Sends itself; the landlord has nothing to do.
        "vendor_payout_clearing",
        // An ApprovalRequest was raised: something waits on the manager's
        // decision, usually against a 24h expiry (models/ApprovalRequest hook).
        "decision_needed",
        // Every vendor allowed for a request was contacted and none took it;
        // routing is paused until the manager chooses one.
        "vendor_outreach_exhausted",
        // A direct-pay job closed: the landlord pays the vendor themselves and
        // marks it paid on the Payments page.
        "vendor_payment_due",
        // The landlord is retiring the tenant's unit and asked them to move out.
        "tenant_move_out_requested",
        // A booked vendor didn't arrive (reported by the tenant or the manager).
        "vendor_no_show_reported",
        // The tenant hasn't confirmed a vendor's arrival time by the deadline.
        "appointment_unconfirmed",
        "work_order_created",
        "intake_details_needed",
        "judge_run_update",
        // A landlord's free beta is about to end (services/beta/).
        "beta_reminder",
        "account_created",
        "password_changed",
        "login_alert",
        "system_maintenance",
      ],
    },
    title: { type: String, required: true, maxlength: 200 },
    message: { type: String, required: true, maxlength: 1000 },
    metadata: {
      appointmentId: String,
      paymentId: String,
      leaseId: String,
      workOrderId: String,
      amount: Number,
      dueDate: Date,
      scheduledDate: Date,
      action: String,
      actionUrl: String,
      sandbox: Boolean,
      simulated: Boolean,
      // How many events a coalesced row stands for (message notifications).
      count: Number,
      // The requests a batch notification is about (policy re-evaluation).
      requestIds: [String],
      priority: {
        type: String,
        enum: ["low", "normal", "high", "urgent", "emergency", "medium"],
        default: "normal",
      },
    },
    read: { type: Boolean, default: false },
    readAt: { type: Date },
    isSystemGenerated: { type: Boolean, default: true },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, read: 1 });
notificationSchema.index({ eventKey: 1 }, { unique: true,
  partialFilterExpression: { eventKey: { $type: "string" } } });

const Notification = mongoose.model("Notification", notificationSchema);

module.exports = { Notification };
