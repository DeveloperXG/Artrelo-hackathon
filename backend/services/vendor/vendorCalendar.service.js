const crypto = require("crypto");
const mongoose = require("mongoose");
const VendorCalendar = require("../../models/VendorCalendar");
const VendorReservation = require("../../models/VendorReservation");
const Appointment = require("../../models/Appointment");
const Vendor = require("../../models/Vendor");
const VendorIdentity = require("../../models/VendorIdentity");
const { resolveIdentity } = require("./vendorIdentity.service");
const { BUFFER_MS, LIVE_APPOINTMENT_STATUSES, interval } = require("./calendarPolicy");

function conflict(code = "time_unavailable") {
  const error = new Error(code === "calendar_needs_review" ?
    "This vendor has a visit without a confirmed time. Resolve it before booking another visit." :
    "That time is no longer available. Choose another time.");
  error.status = 409; error.code = code; return error;
}
async function canonicalId(identityId) {
  const identity = await resolveIdentity(identityId);
  if (!identity) throw conflict("calendar_needs_review");
  return identity._id;
}
async function ensureCalendar(identityId) {
  try { await VendorCalendar.updateOne({ identityId }, { $setOnInsert: { identityId, revision: 0 } }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
}
async function lockCalendar(identityId, session) {
  await VendorCalendar.updateOne({ identityId }, { $inc: { revision: 1 } }, { session });
  const identity = await VendorIdentity.findById(identityId, null, { session }).lean();
  if (!identity || identity.mergedInto) throw conflict("calendar_needs_review");
}
async function identityFamily(identityId, session) {
  const ids = [identityId];
  let frontier = [identityId];
  for (let depth = 0; frontier.length && depth < 6; depth += 1) {
    const children = await VendorIdentity.find({ mergedInto: { $in: frontier } }).select("_id")
      .session(session || null).lean();
    frontier = children.map(row => row._id).filter(id => !ids.some(known => String(known) === String(id)));
    ids.push(...frontier);
  }
  return ids;
}
// Legacy appointments also occupy time. Read through the canonical identity,
// rather than silently treating an un-migrated contractor as free.
async function legacyVisits(identityId, session) {
  const ids = await identityFamily(identityId, session);
  const vendors = await Vendor.find({ identityId: { $in: ids } }).select("_id").session(session || null).lean();
  const offeredVendorIds = await require("../../models/VendorOutreach").distinct("vendorId", { identityId: { $in: ids } }).session(session || null);
  return Appointment.find({ $or: [{ vendorId: { $in: [...vendors.map(row => row._id), ...offeredVendorIds.filter(Boolean)] } },
    { identityId: { $in: ids } }],
    status: { $in: LIVE_APPOINTMENT_STATUSES } }).select("_id confirmedStart confirmedEnd")
    .session(session || null).lean();
}
async function occupied(identityId, { session = null, excludingAppointmentId = null } = {}) {
  const exclude = String(excludingAppointmentId || "");
  // Mongo sessions cannot run parallel operations inside a transaction.
  const ids = await identityFamily(identityId, session);
  const reservations = await VendorReservation.find({ identityId: { $in: ids }, active: true }).session(session).lean();
  const legacy = await legacyVisits(identityId, session);
  const rows = reservations.filter(row => !exclude || String(row.appointmentId || "") !== exclude);
  for (const visit of legacy) {
    if (String(visit._id) === exclude || rows.some(row => String(row.appointmentId || "") === String(visit._id))) continue;
    if (!visit.confirmedStart || !visit.confirmedEnd) throw conflict("calendar_needs_review");
    rows.push({ start: visit.confirmedStart, end: visit.confirmedEnd, appointmentId: visit._id });
  }
  return rows;
}
async function assertAvailable(identityId, start, end, { session, excludingAppointmentId = null } = {}) {
  const proposed = interval(start, end);
  const rows = await occupied(identityId, { session, excludingAppointmentId });
  const { overlaps } = require("./calendarPolicy");
  if (rows.some(row => overlaps(proposed, row))) throw conflict();
  return proposed;
}
async function reserveVisit({ identityId, appointmentId, preparationId, start, end, session }) {
  await lockCalendar(identityId, session);
  const times = await assertAvailable(identityId, start, end, { session, excludingAppointmentId: appointmentId });
  return VendorReservation.findOneAndUpdate({ appointmentId }, { $set: {
    identityId, preparationId, ...times, kind: "appointment", active: true, releasedAt: null,
  }, $setOnInsert: { ref: crypto.randomUUID() } }, { upsert: true, new: true, session });
}
async function releaseVisit(appointmentId, { session = null } = {}) {
  const row = await VendorReservation.findOne({ appointmentId, active: true }).session(session);
  if (!row) return;
  await lockCalendar(row.identityId, session);
  await VendorReservation.updateOne({ _id: row._id, active: true },
    { $set: { active: false, releasedAt: new Date() } }, { session });
}
async function withCalendar(identityId, work) {
  const canonical = await canonicalId(identityId);
  await ensureCalendar(canonical);
  return mongoose.connection.transaction(async session => {
    await lockCalendar(canonical, session);
    return work(canonical, session);
  });
}
async function addBusyTime(identityId, input) {
  const times = interval(input.start, input.end);
  if (times.start <= new Date() || times.end - times.start > 60 * 24 * 3600_000) {
    const error = new Error("Choose a future busy period of no more than 60 days.");
    error.code = "invalid_interval"; error.status = 400; throw error;
  }
  return withCalendar(identityId, async (canonical, session) => {
    await assertAvailable(canonical, times.start, times.end, { session });
    const [row] = await VendorReservation.create([{ identityId: canonical, ref: crypto.randomUUID(),
      kind: "busy", ...times, note: String(input.note || "").trim().slice(0, 200) }], { session });
    return { ref: row.ref, start: row.start, end: row.end, note: row.note };
  });
}
async function listBusyTimes(identityId) {
  const id = await canonicalId(identityId);
  const ids = await identityFamily(id);
  const rows = await VendorReservation.find({ identityId: { $in: ids }, kind: "busy", active: true,
    end: { $gt: new Date() } }).sort({ start: 1 }).limit(500).lean();
  return rows.map(row => ({ ref: row.ref, start: row.start, end: row.end, note: row.note }));
}
async function removeBusyTime(identityId, ref) {
  return withCalendar(identityId, async (canonical, session) => {
    const ids = await identityFamily(canonical, session);
    const row = await VendorReservation.findOneAndUpdate({ identityId: { $in: ids }, ref,
      kind: "busy", active: true }, { $set: { active: false, releasedAt: new Date() } }, { session, new: true });
    return { removed: Boolean(row) };
  });
}
module.exports = { BUFFER_MS, canonicalId, ensureCalendar, lockCalendar, occupied, assertAvailable,
  reserveVisit, releaseVisit, withCalendar, addBusyTime, listBusyTimes, removeBusyTime, conflict };
