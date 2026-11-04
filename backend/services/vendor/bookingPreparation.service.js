const mongoose = require("mongoose");
const BookingPreparation = require("../../models/BookingPreparation");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const VendorOutreach = require("../../models/VendorOutreach");
const Appointment = require("../../models/Appointment");
const Vendor = require("../../models/Vendor");
const LedgerEntry = require("../../models/LedgerEntry");
const calendar = require("./vendorCalendar.service");
const { bookingFunds } = require("../ledger/bookingFunds");
const ledgerService = require("../ledger/ledger.service");
const { loadLandlordPaymentMode } = require("../ledger/paymentMode");
const { toCents } = require("../ledger/money");
const { publish } = require("../realtime/liveEvents.service");
const { cloneSnapshot, findLedgerEntry, rebuildSnapshotSections } = require("./vendorSnapshot.service");
const notices = require("./coordinationNotices.service");

const HOUR_MS = 3600_000;
const CLOSED = ["completed", "rejected", "cancelled"];
function stopped(code = "booking_changed") {
  const error = new Error("This booking changed. Refresh before trying again.");
  error.code = code; error.status = 409; return error;
}
function nudge(row) {
  publish(row.landlordId, `request:${row.requestId}`);
  publish(row.tenantId, `request:${row.requestId}`);
  publish(row.landlordId, "requests"); publish(row.tenantId, "requests");
  publish(row.landlordId, "wallet");
}
async function ensurePreparation({ outreach, request }) {
  const existing = await BookingPreparation.findOne({ outreachId: outreach._id });
  if (existing) return existing;
  const identityId = await calendar.canonicalId(outreach.identityId);
  try {
    const row = await BookingPreparation.create({ requestId: request._id, outreachId: outreach._id,
      landlordId: request.landlordId, tenantId: request.tenantId?._id || request.tenantId,
      vendorId: outreach.vendorId, identityId, paymentMode: await loadLandlordPaymentMode(request.landlordId),
      phase: "preparing", deadlineAt: new Date(Date.now() + 24 * HOUR_MS),
      arrivalAt: outreach.response?.scheduledArrivalAt || null,
      durationMinutes: outreach.response?.durationMinutes || null });
    await notices.queueNotices(row);
    notices.nudge();
    await MaintenanceRequest.updateOne({ _id: request._id }, { $set: { bookingVersion: 2 } });
    return row;
  } catch (error) {
    if (error.code !== 11000) throw error;
    const winner = await BookingPreparation.findOne({ outreachId: outreach._id });
    if (!winner) throw stopped("another_vendor_in_preparation");
    return winner;
  }
}
async function setPhase(row, phase, fields = {}) {
  const update = { phase, ...fields };
  if (Object.keys(update).every(key => String(row[key] ?? "") === String(update[key] ?? ""))) return row;
  const saved = await BookingPreparation.findOneAndUpdate({ _id: row._id, revision: row.revision, active: true },
    { $set: update, $inc: { revision: 1 } }, { new: true });
  if (!saved) throw stopped();
  await notices.queueNotices(saved);
  notices.nudge();
  nudge(saved);
  return saved;
}
function landlordView(row) {
  if (!row) return null;
  return { phase: row.phase, revision: row.revision, deadlineAt: row.deadlineAt, rounds: row.rounds,
    amount: row.amountCents === null ? null : row.amountCents / 100,
    shortfall: row.shortfallCents / 100, reasonCode: row.reasonCode,
    proposedBy: row.proposedBy, proposals: row.proposals?.map(({ start, end }) => ({ start, end })) || [],
    arrivalAt: row.arrivalAt, durationMinutes: row.durationMinutes };
}
// The tenant never learns the funding blocker, agreed amount, or ledger state.
function tenantView(row) {
  if (!row) return null;
  return { phase: ["awaiting_funds", "awaiting_approval"].includes(row.phase) ? "preparing" : row.phase,
    revision: row.revision, deadlineAt: row.deadlineAt, rounds: row.rounds,
    proposedBy: row.proposedBy, proposals: row.proposals?.map(({ start, end }) => ({ start, end })) || [],
    arrivalAt: row.arrivalAt, durationMinutes: row.durationMinutes };
}
async function prepareAcceptedBooking({ outreach, request, bookedAmount, appointmentFields }) {
  let preparation = await ensurePreparation({ outreach, request });
  if (!preparation.active || preparation.deadlineAt <= new Date()) return { preparation, closed: true };
  if (preparation.appointmentId) return { preparation, appointment: await Appointment.findById(preparation.appointmentId), alreadyFinalized: true };
  if (require("../../config/env").booking_confirmations_paused) {
    preparation = await setPhase(preparation, "preparing", { reasonCode: "bookings_paused" });
    return { preparation, paused: true, appointment: null };
  }
  const amountCents = bookedAmount === null || bookedAmount === undefined ? null : toCents(bookedAmount);
  const ledger = preparation.paymentMode === "platform" ? await ledgerService.ensureLedger(request.landlordId) : null;
  const externalCredits = preparation.paymentMode === "platform" &&
    !!await LedgerEntry.exists({ landlordId: request.landlordId, type: "deposit", fundingSource: "external" });
  if (preparation.paymentMode === "platform") {
    const gate = bookingFunds({ amountCents, ledger, externalCredits });
    if (!gate.allowed) {
      preparation = await setPhase(preparation, "awaiting_funds", { amountCents,
        shortfallCents: gate.shortfallCents, reasonCode: gate.reasonCode });
      return { preparation, awaitingFunds: true, appointment: null };
    }
  }
  const arrival = preparation.arrivalAt || appointmentFields.confirmedStart;
  const duration = preparation.durationMinutes || outreach.response?.durationMinutes;
  if (!arrival || new Date(arrival) <= new Date() || !Number.isInteger(duration) || duration < 15 || duration > 720) {
    preparation = await setPhase(preparation, "awaiting_vendor", { reasonCode: "new_time_required", amountCents });
    return { preparation, awaitingTime: true, appointment: null };
  }
  const identityId = await calendar.canonicalId(preparation.identityId);
  await calendar.ensureCalendar(identityId);
  // A recovery attempt is not a new coordination state. Keep the last visible
  // phase until the transaction commits or a different blocker is established;
  // bouncing through preparing would notify everyone again on the same failure.
  let result;
  try {
    result = await mongoose.connection.transaction(async session => {
      const current = await BookingPreparation.findOne({ _id: preparation._id, active: true }).session(session);
      if (!current || current.revision !== preparation.revision || current.deadlineAt <= new Date()) throw stopped();
      if (current.appointmentId) return { preparation: current,
        appointment: await Appointment.findById(current.appointmentId).session(session), alreadyFinalized: true };
      const freshOutreach = await VendorOutreach.findOne({ _id: outreach._id, status: "accepted", appointmentId: null }).session(session);
      if (!freshOutreach || !require("../quotes/quoteCheckpoint.service").itemizedBookingMatches(freshOutreach, outreach)) throw stopped("quote_review_changed");
      const freshRequest = await MaintenanceRequest.findById(request._id).select("+bookingActionToken +bookingActionUntil").session(session);
      const vendor = await Vendor.findOne({ _id: outreach.vendorId, landlordId: request.landlordId,
        active: true, verificationStatus: { $ne: "blocked" } }).session(session);
      if (!freshOutreach || !freshRequest || CLOSED.includes(freshRequest.status) || !vendor ||
        freshRequest.bookingActionUntil > new Date() ||
        (freshRequest.selectedVendorId && String(freshRequest.selectedVendorId) !== String(outreach.vendorId))) throw stopped();
      const otherBooking = await Appointment.exists({ requestId: request._id,
        status: { $in: ["awaiting_tenant", "scheduled", "work_verifying", "in_review", "disputed"] } }).session(session);
      if (otherBooking) throw stopped("request_already_booked");
      const appointmentId = new mongoose.Types.ObjectId();
      const start = new Date(arrival), end = new Date(start.getTime() + duration * 60_000);
      await calendar.reserveVisit({ identityId, appointmentId, preparationId: current._id, start, end, session });
      if (current.paymentMode === "platform") await ledgerService.reserveBookingFunds({
        landlordId: freshRequest.landlordId, amountCents, appointmentId, requestId: request._id,
        identityId, scope: { propertyId: freshRequest.propertyId || null, unitId: freshRequest.unitId || null,
          category: freshRequest.category || null }, session });
      const { planTenantConfirmation } = require("../completion/appointmentFailure.service");
      const serviceBilling = await require("../billing/billingAccount.service").bookingSnapshot({ landlordId: freshRequest.landlordId, request: freshRequest, session });
      const [appointment] = await Appointment.create([{ ...appointmentFields, serviceBilling, _id: appointmentId,
        identityId, preparationId: current._id, bookingVersion: 2, paymentMode: current.paymentMode,
        confirmedStart: start, confirmedEnd: end, ...planTenantConfirmation({ arrival: start }) }], { session });
      freshOutreach.appointmentId = appointment._id;
      await freshOutreach.save({ session });
      const snapshot = cloneSnapshot(freshRequest.vendorRecommendationSnapshot);
      const candidate = snapshot ? findLedgerEntry(snapshot, outreach.candidateKey) : null;
      if (candidate) {
        candidate.state = "selected"; candidate.displayGroup = "active";
        freshRequest.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
      }
      freshRequest.selectedVendorId = outreach.vendorId;
      freshRequest.appointmentStatus = "awaiting_tenant";
      freshRequest.estimatedCost = bookedAmount;
      freshRequest.routingStatus = "routed";
      // Counter-offer authorization remains specific to the vendor who confirmed.
      if (outreach.counterOffer?.status === "confirmed" || outreach.negotiatedProposal?.start) freshRequest.quotaOverride = bookedAmount;
      freshRequest.timeline.push({ status: "assigned", actorRole: "vendor", actorId: outreach.vendorId,
        note: `Vendor accepted: ${outreach.vendorNameSnapshot}; awaiting tenant confirmation` });
      await freshRequest.save({ session });
      Object.assign(current, { appointmentId, identityId, phase: "awaiting_tenant", amountCents,
        shortfallCents: 0, reasonCode: null, arrivalAt: start, durationMinutes: duration,
        deadlineAt: appointment.tenantConfirmBy, revision: current.revision + 1 });
      await current.save({ session });
      await notices.queueNotices(current, session);
      return { preparation: current, appointment, outreach: freshOutreach, bookedAmount };
    });
  } catch (error) {
    if (error.code?.startsWith("billing_")) {
      preparation = await setPhase(preparation, "preparing", { reasonCode: error.code, amountCents });
      return { preparation, awaitingBilling: true, appointment: null };
    }
    if (["time_unavailable", "calendar_needs_review"].includes(error.code)) {
      preparation = await setPhase(preparation, "awaiting_vendor", { reasonCode: error.code, amountCents });
      return { preparation, awaitingTime: true, appointment: null };
    }
    if (["insufficient_funds", "funding_review_required", "funding_obligations_outstanding"].includes(error.code)) {
      preparation = await setPhase(preparation, "awaiting_funds", { reasonCode: error.code,
        amountCents, shortfallCents: error.shortfallCents || 0 });
      return { preparation, awaitingFunds: true, appointment: null };
    }
    throw error;
  }
  nudge(result.preparation);
  notices.nudge();
  return result;
}
async function ensureBookingCredentials(preparation) {
  if (!preparation.appointmentId || !["awaiting_tenant", "scheduled"].includes(preparation.phase)) return;
  const { mintJobToken } = require("./jobToken.service");
  const outreach = await VendorOutreach.findById(preparation.outreachId);
  if (!outreach || !preparation.active) return;
  const appointment = await Appointment.findById(preparation.appointmentId).select("status").lean();
  if (!appointment || !["awaiting_tenant", "scheduled"].includes(appointment.status)) return;
  await mintJobToken({ outreachId: outreach._id, requestId: preparation.requestId,
    appointmentId: preparation.appointmentId, landlordId: preparation.landlordId,
    identityId: preparation.identityId, vendorId: preparation.vendorId, vendorNameSnapshot: outreach.vendorNameSnapshot });
  const env = require("../../config/env");
  if (env.relay_sms_enabled) {
    const { openProxySession } = require("../comms/proxySession.service");
    await openProxySession({ requestId: preparation.requestId, appointmentId: preparation.appointmentId,
      tenantId: preparation.tenantId, identityId: preparation.identityId, vendorId: preparation.vendorId,
      landlordId: preparation.landlordId });
  }
  if (preparation.phase === "scheduled") {
    const { sendVendorBookingConfirmation } = require("./vendorAcceptance.service");
    await sendVendorBookingConfirmation({ appointmentId: preparation.appointmentId });
  }
}
module.exports = { HOUR_MS, ensurePreparation, setPhase, prepareAcceptedBooking, landlordView, tenantView, stopped, nudge };
module.exports.ensureBookingCredentials = ensureBookingCredentials;
module.exports.withBookingRevisions = async rows => {
  const ids = rows.filter(row => row.bookingVersion === 2 && row.preparationId).map(row => row.preparationId);
  if (!ids.length) return rows;
  const preparations = await BookingPreparation.find({ _id: { $in: ids } }).select("_id revision phase").lean();
  const byId = new Map(preparations.map(row => [String(row._id), row]));
  return rows.map(row => {
    const preparation = byId.get(String(row.preparationId || ""));
    return preparation ? { ...row, coordinationRevision: preparation.revision, coordinationPhase: preparation.phase } : row;
  });
};
