const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const AppointmentSchema = new Schema(
  {
    requestId: {
      type: Schema.Types.ObjectId,
      ref: "MaintenanceRequest",
      required: true,
      index: true,
    },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true, index: true },
    vendorNameSnapshot: { type: String, trim: true },
    identityId: { type: Schema.Types.ObjectId, ref: "VendorIdentity", default: null, index: true },
    bookingVersion: { type: Number },
    preparationId: { type: Schema.Types.ObjectId, ref: "BookingPreparation", default: null },
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    landlordId: {
      type: Schema.Types.ObjectId,
      ref: "Landlord",
      required: true,
      index: true,
    },
    proposedWindows: [{ type: String }],
    confirmedStart: { type: Date },
    confirmedEnd: { type: Date },
    // Linearizes a real vendor work-update attempt with a reschedule commit.
    // This is not verification of physical presence or a completed repair.
    workMutationStartedAt: { type: Date, default: null, select: false },
    // KEEP IN LOCKSTEP with MaintenanceRequest.appointmentStatus, which carries
    // an identical list plus "none". confirmTenantAppointment and
    // updateAppointment mirror one field into the other, so a value added here
    // and not there throws a ValidationError on the first mirror.
    //
    // work_verifying -> vendor submitted completion evidence, tenant hasn't answered
    // in_review      -> evidence failed a check; a human decides before any payout
    // disputed       -> tenant said the work isn't done, or review rejected it
    status: {
      type: String,
      enum: [
        "proposed",
        "awaiting_vendor",
        "awaiting_tenant",
        "scheduled",
        "work_verifying",
        "in_review",
        "disputed",
        "cancelled",
        "completed",
        "failed",
      ],
      default: "proposed",
      index: true,
    },
    accessNotes: { type: String },
    vendorConfirmation: {
      accepted: { type: Boolean, default: false },
      respondedAt: { type: Date },
      note: { type: String },
    },
    // When the vendor was told the job is booked. Written by a conditional
    // claim in sendVendorBookingConfirmation, so the two paths into
    // `scheduled` — the tenant confirming and a landlord editing the
    // appointment directly — cannot both email the vendor.
    vendorBookingNotifiedAt: { type: Date, default: null },
    // The job link goes out with the booking confirmation (sendVendorJobLink).
    // SentAt is the done-flag; ClaimedAt is a short lease so a send that
    // failed -- or a process that died mid-send -- is retried by the sweep
    // instead of being lost, which would strand the job (the link is how the
    // vendor checks in and submits completion).
    vendorJobLinkSentAt: { type: Date, default: null },
    vendorJobLinkClaimedAt: { type: Date, default: null },
    // The link-free "starting in about an hour" nudge (sweepVendorArrivalReminders).
    vendorArrivalReminderSentAt: { type: Date, default: null },
    tenantConfirmation: {
      accepted: { type: Boolean, default: false },
      respondedAt: { type: Date },
      note: { type: String },
      // "landlord" when the manager confirmed on the tenant's behalf.
      confirmedBy: { type: String, enum: ["tenant", "landlord", null], default: null },
    },

    // How long the tenant has to confirm the vendor's arrival time. Without a
    // deadline an unanswered appointment sat at awaiting_tenant forever. A
    // reminder goes out at the halfway mark; at the deadline the manager is
    // asked to confirm on the tenant's behalf or find another vendor.
    tenantConfirmBy: { type: Date, default: null, index: true },
    tenantReminderSentAt: { type: Date, default: null },
    // Halfway to tenantConfirmBy (planTenantConfirmation), not a flat 24h:
    // a visit due tomorrow morning needs its reminder tonight.
    tenantRemindAt: { type: Date, default: null },
    tenantOverdueNotifiedAt: { type: Date, default: null },

    // The tenant (or manager) saying the vendor never arrived. A report alone
    // re-routes nothing -- a vendor can be running late, and money is held --
    // so the manager confirms (re-route) or dismisses it.
    noShowReport: {
      status: { type: String, enum: ["reported", "confirmed", "dismissed", null], default: null },
      reportedAt: { type: Date, default: null },
      reportedBy: { type: String, enum: ["tenant", "landlord", null], default: null },
      note: { type: String, default: null },
      resolvedAt: { type: Date, default: null },
    },

    // Why a `failed` appointment failed. Its request goes back to routing.
    failureReason: { type: String, enum: ["no_show", "tenant_unconfirmed", null], default: null },
    failedAt: { type: Date, default: null },

    // The landlord's paymentMode, COPIED at vendor acceptance. The job settles
    // on the rail it was booked on even if the landlord switches later: a
    // platform job has a wallet hold behind it, a direct one does not.
    //
    // No default, on purpose. An appointment written before this field existed
    // was booked on the platform rail (it has a hold), so absence means
    // "platform" -- read it through services/ledger/paymentMode.js.
    paymentMode: { type: String, enum: ["direct", "platform"] },
    completedAt: Date,
    // Frozen when booked. A beta/legacy job cannot become chargeable just
    // because it closes after the beta ends or the landlord changes mode.
    serviceBilling: {
      managed: Boolean, chargeable: Boolean, agreementVersion: String,
      rate: { flatCents: Number, percent: Number }, rateSource: String,
      waivedReason: String, bookedAt: Date,
    },

    // Direct jobs only: what the landlord owes the vendor and whether they have
    // said it is paid. Set to "due" when the job closes. The ledger never sees
    // any of this -- the money never passes through Artrelo.
    directPayment: {
      status: { type: String, enum: ["due", "paid"] },
      amountCents: { type: Number, min: 0 },
      dueSince: { type: Date },
      paidAt: { type: Date },
      // Free text from the landlord, e.g. an e-transfer confirmation number.
      reference: { type: String, trim: true, maxlength: 120 },
      markedBy: { type: Schema.Types.ObjectId, ref: "Landlord" },
    },
  },
  { timestamps: true }
);

// The job-link retry and arrival-reminder sweeps: scheduled, by link state and arrival.
AppointmentSchema.index({ status: 1, vendorJobLinkSentAt: 1, confirmedStart: 1 });
// The Payments page and the sidebar badge: a landlord's direct payments by state.
AppointmentSchema.index({ landlordId: 1, "directPayment.status": 1 });

module.exports = mongoose.model("Appointment", AppointmentSchema);
