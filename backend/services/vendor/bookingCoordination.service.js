const mongoose = require("mongoose");
const Preparation = require("../../models/BookingPreparation");
const Appointment = require("../../models/Appointment");
const Request = require("../../models/MaintenanceRequest");
const Outreach = require("../../models/VendorOutreach");
const Completion = require("../../models/JobCompletion");
const Approval = require("../../models/ApprovalRequest");
const calendar = require("./vendorCalendar.service");
const notices = require("./coordinationNotices.service");
const { interval } = require("./calendarPolicy");
const { revokeSchedulingLink } = require("./schedulingToken.service");
const { releaseBookingFunds } = require("../ledger/ledger.service");
const { revokeJobToken } = require("./jobToken.service");
const { closeProxySession } = require("../comms/proxySession.service");
const { nudge, stopped, ensureBookingCredentials } = require("./bookingPreparation.service");
const { planTenantConfirmation } = require("../completion/appointmentFailure.service");
const HOUR = 3600_000;

function proposalsOf(windows, now = new Date()) {
  if (!Array.isArray(windows) || !windows.length || windows.length > 3) {
    const error = new Error("Provide between one and three alternative windows."); error.code = "invalid_windows"; error.status = 400; throw error;
  }
  return windows.map(window => {
    const times = interval(window.start, window.end);
    if (times.start <= now || times.end - times.start < 15 * 60_000 || times.end - now > 60 * 24 * HOUR) {
      const error = new Error("Choose future windows of at least 15 minutes within the next 60 days.");
      error.code = "invalid_windows"; error.status = 400; throw error;
    }
    return times;
  });
}
async function edit(preparationId, revision, work, { allowClosed = false, allowConfirmedChange = false } = {}) {
  if (!Number.isInteger(revision)) {
    const error = new Error("Refresh the proposal before responding."); error.status = 409; error.code = "revision_required"; throw error;
  }
  const initial = await Preparation.findOne({ _id: preparationId, active: true });
  if (!initial) throw stopped();
  const identityId = await calendar.canonicalId(initial.identityId);
  await calendar.ensureCalendar(identityId);
  const saved = await mongoose.connection.transaction(async session => {
    const row = await Preparation.findOne({ _id: preparationId, active: true, revision }).session(session);
    if (!row) throw stopped();
    await calendar.lockCalendar(identityId, session);
    const request = await Request.findById(row.requestId).session(session);
    if (!request || (!allowClosed && ["completed", "cancelled", "rejected"].includes(request.status))) throw stopped("request_closed");
    const appointment = row.appointmentId ? await Appointment.findById(row.appointmentId).select('+workMutationStartedAt').session(session) : null;
    if (appointment && !allowClosed) {
      const completion = await Completion.exists({ appointmentId: appointment._id, checkIn: { $ne: null } }).session(session);
      if (completion || appointment.workMutationStartedAt || !["proposed", "awaiting_tenant", "scheduled"].includes(appointment.status)) throw stopped("work_already_started");
      if (!allowConfirmedChange && appointment.status === "scheduled") throw stopped("confirmed_visit_requires_reschedule");
    }
    await work({ row, request, appointment, identityId, session });
    row.revision += 1;
    await row.save({ session });
    await request.save({ session });
    await notices.queueNotices(row, session);
    return row;
  });
  nudge(saved); notices.nudge();
  return saved;
}
async function proposeAlternatives({ preparationId, revision, windows, actor = "tenant" }) {
  const proposals = proposalsOf(windows);
  const initial = await Preparation.findById(preparationId);
  if (initial?.phase !== "scheduled" && initial?.rounds >= 2) return closePreparation({ preparationId, revision, reason: "coordination_failed", reroute: true });
  return edit(preparationId, revision, async ({ row, request, appointment, session }) => {
    if (!["awaiting_tenant", "awaiting_vendor", "scheduled"].includes(row.phase)) throw stopped("proposal_not_ready");
    if (!appointment || !["awaiting_tenant", "scheduled"].includes(row.phase)) throw stopped();
    // A newly confirmed booking may later need a new pre-visit cycle. Pending
    // exchanges never refresh their own deadline and cannot loop indefinitely.
    if (row.phase === "scheduled" || row.rounds === 0) { row.rounds = 0; row.deadlineAt = new Date(Date.now() + 48 * HOUR); }
    if (row.deadlineAt <= new Date()) throw stopped("coordination_expired");
    await calendar.releaseVisit(appointment._id, { session });
    row.proposals = proposals; row.proposedBy = actor; row.rounds += 1;
    row.phase = "awaiting_vendor"; row.reasonCode = "alternative_time_requested";
    row.arrivalAt = null;
    appointment.status = "proposed";
    appointment.tenantConfirmation = { accepted: false, respondedAt: new Date(), confirmedBy: actor === "landlord" ? "landlord" : "tenant" };
    appointment.vendorBookingNotifiedAt = null; appointment.vendorJobLinkSentAt = null;
    appointment.confirmedStart = undefined; appointment.confirmedEnd = undefined;
    await appointment.save({ session });
    request.appointmentStatus = "proposed";
    request.timeline.push({ status: "assigned", actorRole: actor, note: "Alternative visit times requested; the previous visit is not confirmed" });
  });
}
async function proposeVendorTime({ preparationId, revision, start, durationMinutes }) {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 720 || durationMinutes % 15) {
    const error = new Error("Choose a duration from 15 minutes to 12 hours in 15-minute steps.");
    error.status = 400; error.code = "invalid_duration"; throw error;
  }
  const startAt = new Date(start), endAt = new Date(startAt.getTime() + durationMinutes * 60_000);
  interval(startAt, endAt);
  if (startAt <= new Date() || startAt > new Date(Date.now() + 60 * 24 * HOUR)) throw stopped("invalid_arrival");
  const row = await edit(preparationId, revision, async ({ row, request, appointment, identityId, session }) => {
    if (!["awaiting_vendor", "awaiting_tenant", "scheduled"].includes(row.phase)) throw stopped();
    if (row.phase === "scheduled") { row.rounds = 0; row.deadlineAt = new Date(Date.now() + 48 * HOUR); }
    if (row.deadlineAt <= new Date()) throw stopped("coordination_expired");
    await calendar.assertAvailable(identityId, startAt, endAt, { session, excludingAppointmentId: appointment?._id });
    row.arrivalAt = startAt; row.durationMinutes = durationMinutes; row.proposedBy = "vendor";
    row.reasonCode = null;
    if (!appointment) {
      // The quote and payment permission still go through finalizeAcceptance.
      // Updating a time never approves a new quote or creates a booking.
      await Outreach.updateOne({ _id: row.outreachId, status: "accepted", appointmentId: null },
        { $set: { "response.scheduledArrivalAt": startAt, "response.durationMinutes": durationMinutes } }, { session });
      row.phase = "awaiting_vendor";
      return;
    }
    await calendar.reserveVisit({ identityId, appointmentId: appointment._id, preparationId: row._id,
      start: startAt, end: endAt, session });
    appointment.confirmedStart = startAt; appointment.confirmedEnd = endAt;
    appointment.status = "awaiting_tenant";
    Object.assign(appointment, planTenantConfirmation({ arrival: startAt }));
    appointment.tenantConfirmation = { accepted: false };
    appointment.vendorBookingNotifiedAt = null; appointment.vendorJobLinkSentAt = null;
    await appointment.save({ session });
    row.phase = "awaiting_tenant";
    row.deadlineAt = new Date(Math.min(row.deadlineAt.getTime(), appointment.tenantConfirmBy.getTime()));
    request.appointmentStatus = "awaiting_tenant";
    request.timeline.push({ status: "assigned", actorRole: "vendor", note: "Vendor proposed a new arrival time; awaiting tenant confirmation" });
  });
  if (!row.appointmentId) await require("./vendorAcceptance.service").finalizeVendorAcceptance({ outreachId: row.outreachId });
  return Preparation.findById(row._id);
}
async function declineTime({ preparationId, revision, actor = "tenant" }) {
  const initial = await Preparation.findById(preparationId);
  if (initial?.rounds >= 2 && initial?.phase !== "scheduled") return closePreparation({ preparationId, revision,
    reason: "coordination_failed", reroute: true });
  return edit(preparationId, revision, async ({ row, request, appointment, session }) => {
    if (!appointment || !["awaiting_tenant", "scheduled"].includes(row.phase)) throw stopped();
    if (row.phase === "scheduled" || row.rounds === 0) { row.rounds = 0; row.deadlineAt = new Date(Date.now() + 48 * HOUR); }
    await calendar.releaseVisit(appointment._id, { session });
    row.rounds += 1; row.proposals = []; row.arrivalAt = null;
    row.phase = "awaiting_vendor"; row.reasonCode = "alternative_time_requested"; row.proposedBy = actor;
    appointment.status = "proposed"; appointment.confirmedStart = undefined; appointment.confirmedEnd = undefined;
    appointment.tenantConfirmation = { accepted: false, respondedAt: new Date(), confirmedBy: actor };
    appointment.vendorBookingNotifiedAt = null; appointment.vendorJobLinkSentAt = null;
    await appointment.save({ session });
    request.appointmentStatus = "proposed";
    request.timeline.push({ status: "assigned", actorRole: actor, note: "The proposed time was declined; arranging alternatives with the vendor" });
  });
}
async function confirmTime({ preparationId, revision, actor = "tenant", actorId = null }) {
  const row = await edit(preparationId, revision, async ({ row, request, appointment, identityId, session }) => {
    if (!appointment || row.phase !== "awaiting_tenant" || !row.arrivalAt || row.arrivalAt <= new Date() || row.deadlineAt <= new Date()) throw stopped("arrival_expired");
    if (row.paymentMode === "platform") {
      const ledger = await require("../../models/LandlordLedger").findOne({ landlordId: row.landlordId }).session(session);
      if (!ledger || ledger.bankOwed > 0 || ledger.arrears > 0) throw stopped("funding_obligations_outstanding");
      // Serialize confirmation with a reversal or another financial writer.
      await require("../../models/LandlordLedger").updateOne({ _id: ledger._id }, { $set: { updatedAt: new Date() } }, { session });
    }
    await calendar.reserveVisit({ identityId, appointmentId: appointment._id, preparationId: row._id,
      start: appointment.confirmedStart, end: appointment.confirmedEnd, session });
    appointment.tenantConfirmation = { accepted: true, respondedAt: new Date(), confirmedBy: actor, note: "" };
    appointment.status = "scheduled";
    await appointment.save({ session });
    row.phase = "scheduled"; row.reasonCode = null;
    request.appointmentStatus = "scheduled";
    request.timeline.push({ status: "assigned", actorRole: actor, actorId: actorId || undefined,
      note: actor === "tenant" ? "Tenant confirmed the visit" : "Manager confirmed access on the tenant's behalf" });
  });
  await ensureBookingCredentials(row);
  return row;
}
async function closePreparation({ preparationId, revision, phase = "closed", reason = "proposal_closed", reroute = false, allowClosed = false, onlyUnbooked = false }) {
  const initial = await Preparation.findOne({ _id: preparationId, active: true });
  if (!initial) return null;
  const row = await edit(preparationId, revision ?? initial.revision, async ({ row, request, appointment, session }) => {
    if (onlyUnbooked && appointment && !["cancelled", "failed", "completed"].includes(appointment.status)) throw stopped("cancel_booked_visit_first");
    if (appointment) await calendar.releaseVisit(appointment._id, { session });
    if (appointment && ["proposed", "awaiting_tenant", "scheduled"].includes(appointment.status)) {
      if (row.paymentMode === "platform") await releaseBookingFunds({ appointmentId: appointment._id, session });
      appointment.status = "cancelled"; await appointment.save({ session });
      request.appointmentStatus = "cancelled";
    }
    row.active = false; row.phase = phase; row.reasonCode = reason;
    await Approval.updateMany({ requestId: row.requestId, status: "pending", "payload.outreachId": String(row.outreachId) },
      { $set: { status: "expired", decidedAt: new Date() } }, { session });
    await revokeSchedulingLink(row._id, session);
    await Outreach.updateOne({ _id: row.outreachId }, { $set: { status: "declined", "response.declineReason": reason },
      $unset: { tokenHash: 1 } }, { session });
    if (String(request.selectedVendorId || "") === String(row.vendorId)) request.selectedVendorId = null;
    if (phase === "paused") request.routingStatus = "paused";
    request.timeline.push({ status: request.status, actorRole: "system", note: "Visit proposal closed; no visit is confirmed" });
  }, { allowClosed, allowConfirmedChange: true });
  if (row.appointmentId) {
    await revokeJobToken({ appointmentId: row.appointmentId }).catch(() => {});
    await closeProxySession({ appointmentId: row.appointmentId, reason: "job_cancelled" }).catch(() => {});
  }
  if (reroute) {
    const outreach = await Outreach.findById(row.outreachId);
    await require("./vendorOutreachSweeper.service").advanceOutreach({ outreach, reason });
  }
  return row;
}
module.exports = { proposalsOf, edit, proposeAlternatives, proposeVendorTime, confirmTime, declineTime, closePreparation };
module.exports.closeRequestPreparations = async request => {
  if (request.bookingVersion !== 2) return;
  const rows = await Preparation.find({ requestId: request._id, active: true });
  for (const row of rows) await closePreparation({ preparationId: row._id, revision: row.revision,
    reason: request.status === "completed" ? "job_completed" : "request_closed", allowClosed: true });
};
