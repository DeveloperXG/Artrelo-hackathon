// When a booking falls through: the vendor doesn't show, or the tenant never
// confirms the time. Neither had any handling -- a no-show had no way to be
// reported or re-routed, and an unconfirmed appointment sat at
// awaiting_tenant forever with money held against it.
//
// One path for both, failAppointment, because the cleanup is identical and
// every piece of it is an invariant another part of the system relies on:
//
//   1. claim the appointment (scheduled/awaiting_tenant -> failed), so two
//      callers can't both run the rest
//   2. void the escrow hold -- idempotent on hold_void:<appointmentId>
//   3. revoke the job link and CLOSE THE PROXY SESSION: an open session is a
//      live line into the tenant's thread for a vendor who is no longer coming
//      (a terminal path without a close is the bug the relay handoff warns of)
//   4. put the request back into routing and let advanceOutreach retire this
//      vendor and pick the next by policy (auto-send, ask, or pause)
//
// A tenant's no-show REPORT does not run this. The vendor may be running late,
// and money is involved, so the manager confirms it (re-route) or dismisses it.

const Appointment = require("../../models/Appointment");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const VendorOutreach = require("../../models/VendorOutreach");
const LedgerEntry = require("../../models/LedgerEntry");
const JobCompletion = require("../../models/JobCompletion");
const Property = require("../../models/Property");
const Landlord = require("../../models/Landlord");
const env = require("../../config/env");
const { voidHold } = require("../ledger/ledger.service");
const { revokeJobToken } = require("../vendor/jobToken.service");
const { closeProxySession } = require("../comms/proxySession.service");
const { notifyUser } = require("../notification/notify.service");
const { logAgentAction } = require("../audit/agentAction.service");
const { sendEmail } = require("../notification/email.service");
const { buildVendorBookingCancelledEmail } = require("../notification/templates/vendorLifecycleEmail");
const { resolveRequestCity, formatCityLabel } = require("../vendor/vendorScoring.service");

const HOUR_MS = 60 * 60 * 1000;
// A tenant may report a no-show this long after the booked arrival.
const NO_SHOW_GRACE_MS = 2 * HOUR_MS;
// How long a tenant has to confirm the vendor's arrival time, and the reminder.
const TENANT_CONFIRM_MS = 48 * HOUR_MS;
const TENANT_REMINDER_MS = 24 * HOUR_MS;
// The confirmation must land this long before the vendor is due, so the
// manager still has time to step in if the tenant stays quiet.
const CONFIRM_BEFORE_ARRIVAL_MS = HOUR_MS;
// Shorter than this to confirm in and a reminder would only repeat the ask.
const MIN_REMINDABLE_MS = HOUR_MS;
// An arrival this far in the past is gone, not merely running late.
const ARRIVAL_PASSED_GRACE_MS = 15 * 60 * 1000;

const FAILABLE_STATUSES = ["awaiting_tenant", "proposed", "scheduled"];

const managerLabelFor = (landlord) =>
  landlord?.companyName || [landlord?.firstName, landlord?.lastName].filter(Boolean).join(" ") || "The property manager";

/**
 * The deadline for a tenant to confirm. Appointments created before the field
 * existed fall back to createdAt + 48h.
 */
function tenantConfirmDeadline(appointment) {
  if (appointment?.tenantConfirmBy) return new Date(appointment.tenantConfirmBy);
  const created = appointment?.createdAt ? new Date(appointment.createdAt).getTime() : Date.now();
  return new Date(created + TENANT_CONFIRM_MS);
}

/**
 * The tenant's confirmation deadline and reminder for a new appointment.
 *
 * It used to be a flat createdAt + 48h, with the reminder at 24h. But the
 * vendor's arrival is often sooner than that -- tomorrow morning, or within
 * the hour for urgent work -- so a tenant could confirm, or be reminded about,
 * a visit that had already happened. Now the deadline is the EARLIER of 48h and
 * an hour before arrival (never earlier than now; up to the arrival itself
 * when the visit is that close), and the reminder is halfway there.
 *
 * Arrival already passed (a counter-offer or quota approval that resolved
 * late): the deadline is now, so the sweep hands it straight to the manager.
 */
function planTenantConfirmation({ now = new Date(), arrival = null } = {}) {
  const start = now.getTime();
  let deadline = start + TENANT_CONFIRM_MS;
  if (arrival) {
    const due = new Date(arrival).getTime();
    deadline = Math.min(deadline, due - CONFIRM_BEFORE_ARRIVAL_MS);
    // Inside the last hour: the tenant can still confirm up to the arrival.
    if (deadline <= start) deadline = Math.max(start, due);
  }
  const window = deadline - start;
  return {
    tenantConfirmBy: new Date(deadline),
    tenantRemindAt: window >= MIN_REMINDABLE_MS ? new Date(start + window / 2) : null,
    // No room for a reminder: mark it done so the sweep never sends one.
    tenantReminderSentAt: window >= MIN_REMINDABLE_MS ? null : now,
  };
}

/** Whether the booked arrival is already over (past a short grace). */
function isArrivalPassed(appointment, now = new Date()) {
  if (!appointment?.confirmedStart) return false;
  return new Date(appointment.confirmedStart).getTime() < now.getTime() - ARRIVAL_PASSED_GRACE_MS;
}

/** When a tenant may report a no-show, or null if there's no booked arrival. */
function noShowReportableAt(appointment) {
  if (!appointment?.confirmedStart) return null;
  return new Date(new Date(appointment.confirmedStart).getTime() + NO_SHOW_GRACE_MS);
}

/**
 * Fail a booking and send the request back to routing. Safe to call twice:
 * the status claim means only the first caller does the work.
 */
async function failAppointment({ appointmentId, reason, actorRole = "landlord", actorId = null, now = new Date() }) {
  if (!["no_show", "tenant_unconfirmed"].includes(reason)) throw new Error(`Unknown failure reason: ${reason}`);

  const appointment = await Appointment.findOneAndUpdate(
    { _id: appointmentId, status: { $in: FAILABLE_STATUSES } },
    {
      $set: {
        status: "failed",
        failureReason: reason,
        failedAt: now,
        ...(reason === "no_show" ? { "noShowReport.status": "confirmed", "noShowReport.resolvedAt": now } : {}),
      },
    },
    { new: true }
  );
  if (!appointment) return { failed: false, reason: "not_failable" };

  const request = await MaintenanceRequest.findById(appointment.requestId);
  const outreach = await VendorOutreach.findOne({ appointmentId: appointment._id });

  // 2. Escrow back to the landlord. Idempotent on the void key.
  try {
    const hold = await LedgerEntry.findOne({ appointmentId: appointment._id, type: "hold" }).lean();
    if (hold && request) {
      await voidHold({
        landlordId: request.landlordId,
        appointmentId: appointment._id,
        amountCents: hold.amountCents,
        requestId: request._id,
        memo: reason === "no_show" ? "Vendor didn't show up" : "Tenant didn't confirm the time",
      });
    }
  } catch (err) {
    console.error("[failAppointment] hold void failed", err.message);
  }

  // 3. Credentials. Both are scoped to this appointment.
  await revokeJobToken({ appointmentId: appointment._id }).catch(() => {});
  await closeProxySession({ appointmentId: appointment._id, reason: "job_cancelled" }).catch(() => {});

  // An unsubmitted draft completion would otherwise sit open forever.
  await JobCompletion.updateOne(
    { appointmentId: appointment._id, closedAt: null, status: { $nin: ["closed", "void"] } },
    { $set: { status: "void", closeReason: "booking_failed", closedAt: now } }
  ).catch(() => {});

  if (request) {
    // Back to a routable state: approved, no vendor, the booking failed.
    request.status = "approved";
    request.appointmentStatus = "failed";
    request.selectedVendorId = null;
    request.timeline.push({
      status: "approved",
      note:
        reason === "no_show"
          ? `${outreach?.vendorNameSnapshot || "The vendor"} didn't show up — finding another vendor`
          : "The arrival time wasn't confirmed — finding another vendor",
      actorRole,
      actorId: actorId || undefined,
    });
    await request.save();

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: actorRole,
      actionType: reason === "no_show" ? "appointment_no_show" : "appointment_unconfirmed_rerouted",
      summary:
        reason === "no_show"
          ? `${outreach?.vendorNameSnapshot || "Vendor"} didn't show up; booking cancelled and the job re-routed`
          : "Tenant didn't confirm the arrival time; booking cancelled and the job re-routed",
      input: { appointmentId: String(appointment._id), reason },
      output: { status: appointment.status },
    });

    await notifyUser({
      userId: request.tenantId,
      type: "appointment_cancelled",
      title: "We're finding another vendor",
      message:
        reason === "no_show"
          ? `Sorry the vendor didn't arrive for "${request.issueTitle}". We're finding someone else and will be in touch.`
          : `The visit for "${request.issueTitle}" wasn't confirmed, so we're arranging another vendor.`,
      metadata: { workOrderId: String(request._id) },
    });
  }

  // Tell the vendor not to go -- and, for a tenant who never confirmed, that
  // it isn't held against them. Non-fatal.
  if (outreach?.toEmail && request) {
    try {
      const [property, landlord] = await Promise.all([
        request.propertyId ? Property.findById(request.propertyId).select("address city").lean() : null,
        Landlord.findById(request.landlordId).select("firstName lastName companyName").lean(),
      ]);
      const email = buildVendorBookingCancelledEmail({
        vendorName: outreach.vendorNameSnapshot,
        category: request.category,
        city: formatCityLabel(resolveRequestCity({ property })) || null,
        reason,
        managerLabel: managerLabelFor(landlord),
      });
      await sendEmail({ to: outreach.toEmail, ...email, categories: ["vendor_booking_cancelled"] });
    } catch (err) {
      console.error("[failAppointment] vendor email failed", err.message);
    }
  }

  // 4. Next vendor, by policy. Lazy: the sweeper module requires the outreach
  // service, which would cycle at load.
  if (outreach && request) {
    try {
      // eslint-disable-next-line global-require
      const { advanceOutreach } = require("../vendor/vendorOutreachSweeper.service");
      await advanceOutreach({ outreach, reason });
    } catch (err) {
      console.error("[failAppointment] re-route failed", err.message);
    }
  }

  return { failed: true, appointment };
}

/**
 * The tenant says the vendor never came. Only once the booked arrival is two
 * hours past, and not if the vendor checked in -- then it's a dispute about the
 * work, not a no-show.
 */
async function reportNoShow({ appointmentId, tenantId, note = "", now = new Date() }) {
  const appointment = await Appointment.findOne({ _id: appointmentId, tenantId });
  if (!appointment) return { error: { status: 404, message: "Appointment not found" } };
  if (appointment.status !== "scheduled") {
    return { error: { status: 409, code: "not_reportable", message: "Only a booked visit can be reported as a no-show." } };
  }
  const reportableAt = noShowReportableAt(appointment);
  if (!reportableAt || now < reportableAt) {
    return {
      error: {
        status: 409,
        code: "too_early",
        message: "You can report this two hours after the booked arrival time, in case the vendor is running late.",
        reportableAt,
      },
    };
  }
  const completion = await JobCompletion.findOne({ appointmentId: appointment._id }).select("checkIn").lean();
  // Any check-in means they arrived -- including one where they declined to
  // share their location (source "denied" still stamps `at`).
  if (completion?.checkIn?.at) {
    return {
      error: {
        status: 409,
        code: "vendor_checked_in",
        message: "The vendor checked in for this visit. If the work isn't done, report it when you're asked to confirm the job.",
      },
    };
  }
  if (appointment.noShowReport?.status === "reported") return { appointment, already: true };

  appointment.noShowReport = {
    status: "reported",
    reportedAt: now,
    reportedBy: "tenant",
    note: String(note || "").trim().slice(0, 500) || null,
    resolvedAt: null,
  };
  await appointment.save();

  const request = await MaintenanceRequest.findById(appointment.requestId).select("landlordId issueTitle");
  if (request) {
    await notifyUser({
      userId: request.landlordId,
      type: "vendor_no_show_reported",
      title: "Tenant reports the vendor didn't arrive",
      message: `The tenant says nobody arrived for "${request.issueTitle}". Re-route it to another vendor, or dismiss if they came.`,
      metadata: { workOrderId: String(request._id), priority: "high" },
    });
    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "tenant",
      actionType: "vendor_no_show_reported",
      summary: "Tenant reported that the vendor didn't arrive",
      input: { appointmentId: String(appointment._id), note: appointment.noShowReport.note },
    });
  }
  return { appointment };
}

/** The manager says the vendor did come (or the report was a mistake). */
async function dismissNoShow({ appointmentId, landlordId, now = new Date() }) {
  const appointment = await Appointment.findOneAndUpdate(
    { _id: appointmentId, landlordId, "noShowReport.status": "reported" },
    { $set: { "noShowReport.status": "dismissed", "noShowReport.resolvedAt": now } },
    { new: true }
  );
  if (!appointment) return { error: { status: 409, message: "There's no open no-show report on this visit." } };
  await logAgentAction({
    requestId: appointment.requestId,
    landlordId,
    actor: "landlord",
    actionType: "vendor_no_show_dismissed",
    summary: "Manager dismissed the no-show report",
    input: { appointmentId: String(appointment._id) },
  });
  return { appointment };
}

/**
 * Tenant silence on the arrival time. A reminder at 24h (once), and at the 48h
 * deadline the manager is told -- the decision itself is derived from the
 * appointment's state on the Decisions page, so this only notifies.
 */
async function sweepTenantConfirmations(now = new Date()) {
  let reminded = 0;
  let escalated = 0;

  const remindable = await Appointment.find({
    status: "awaiting_tenant",
    tenantReminderSentAt: null,
    $or: [
      { tenantRemindAt: { $lte: now } },
      // Appointments created before tenantRemindAt existed.
      { tenantRemindAt: null, createdAt: { $lte: new Date(now.getTime() - TENANT_REMINDER_MS) } },
    ],
  })
    .select("_id requestId tenantId")
    .lean();
  for (const row of remindable) {
    const claimed = await Appointment.findOneAndUpdate(
      { _id: row._id, status: "awaiting_tenant", tenantReminderSentAt: null },
      { $set: { tenantReminderSentAt: now } }
    );
    if (!claimed) continue;
    await notifyUser({
      userId: row.tenantId,
      type: "appointment_reminder",
      title: "Please confirm the vendor's arrival time",
      message: "A vendor is booked for your request and is waiting for you to confirm the time.",
      metadata: { workOrderId: String(row.requestId), priority: "high" },
    });
    reminded += 1;
  }

  const overdue = await Appointment.find({
    status: "awaiting_tenant",
    tenantOverdueNotifiedAt: null,
    $or: [
      { tenantConfirmBy: { $lte: now } },
      { tenantConfirmBy: null, createdAt: { $lte: new Date(now.getTime() - TENANT_CONFIRM_MS) } },
    ],
  })
    .select("_id requestId landlordId confirmedStart")
    .lean();
  for (const row of overdue) {
    const claimed = await Appointment.findOneAndUpdate(
      { _id: row._id, status: "awaiting_tenant", tenantOverdueNotifiedAt: null },
      { $set: { tenantOverdueNotifiedAt: now } }
    );
    if (!claimed) continue;
    // The time itself is gone: confirming it would book a visit in the past,
    // so the only useful move is another vendor (or a new time with them).
    const passed = isArrivalPassed(row, now);
    await notifyUser({
      userId: row.landlordId,
      type: "appointment_unconfirmed",
      title: passed ? "A vendor's arrival time passed unconfirmed" : "Tenant hasn't confirmed a visit",
      message: passed
        ? "The arrival time went by before the visit was confirmed. Find another vendor from Decisions Needed."
        : "Confirm the time on their behalf, or find another vendor, from Decisions Needed.",
      metadata: { workOrderId: String(row.requestId), priority: "high" },
    });
    escalated += 1;
  }

  return { reminded, escalated };
}

module.exports = {
  NO_SHOW_GRACE_MS,
  TENANT_CONFIRM_MS,
  planTenantConfirmation,
  isArrivalPassed,
  TENANT_REMINDER_MS,
  tenantConfirmDeadline,
  noShowReportableAt,
  failAppointment,
  reportNoShow,
  dismissNoShow,
  sweepTenantConfirmations,
};
