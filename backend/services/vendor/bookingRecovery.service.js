const crypto = require("crypto");
const Preparation = require("../../models/BookingPreparation");
const Request = require("../../models/MaintenanceRequest");
const { closePreparation } = require("./bookingCoordination.service");
const { ensureBookingCredentials } = require("./bookingPreparation.service");
const notices = require("./coordinationNotices.service");
const INTERVAL_MS = 60_000;
const LEASE_MS = 120_000;
const RETRY_MS = [60_000, 300_000];

async function processPreparation(id, now = new Date()) {
  const token = crypto.randomUUID();
  const row = await Preparation.findOneAndUpdate({ _id: id, active: true,
    $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }, { $set: {
    leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS) } }, { new: true });
  if (!row) return false;
  try {
    const request = await Request.findById(row.requestId).select("status").lean();
    if (!request || ["cancelled", "rejected", "completed"].includes(request.status)) {
      if (request) await closePreparation({ preparationId: row._id, revision: row.revision,
        reason: request.status === "completed" ? "job_completed" : "request_closed", allowClosed: true });
      else await Preparation.updateOne({ _id: row._id, leaseToken: token },
        { $set: { active: false, phase: "closed", reasonCode: "request_deleted" } });
    } else if (row.phase !== "scheduled" && row.deadlineAt <= now) {
      const funding = row.phase === "awaiting_funds" || row.reasonCode?.startsWith("billing_");
      const silence = row.phase === "awaiting_tenant";
      await closePreparation({ preparationId: row._id, revision: row.revision,
        phase: funding || silence ? "paused" : "expired",
        reason: funding ? "funding_expired" : silence ? "tenant_unconfirmed" : "coordination_expired",
        reroute: !funding && !silence });
    } else if (["preparing", "awaiting_funds"].includes(row.phase)) {
      await require("./vendorAcceptance.service").finalizeVendorAcceptance({ outreachId: row.outreachId });
    } else if (["awaiting_tenant", "scheduled"].includes(row.phase)) {
      await ensureBookingCredentials(row);
    }
    await Preparation.updateOne({ _id: id, leaseToken: token }, { $set: {
      attempts: 0, lastErrorCode: null, nextAttemptAt: new Date(now.getTime() + INTERVAL_MS), leaseUntil: null, leaseToken: null } });
    return true;
  } catch (error) {
    if (["booking_changed", "request_closed"].includes(error.code)) return false;
    const fresh = await Preparation.findOne({ _id: id, leaseToken: token, active: true });
    if (!fresh) return false;
    const attempts = Math.min(3, fresh.attempts + 1);
    await Preparation.updateOne({ _id: id, leaseToken: token, revision: fresh.revision }, { $set: {
      attempts, lastErrorCode: "booking_preparation_failed", nextAttemptAt: new Date(now.getTime() + (RETRY_MS[attempts - 1] || 300_000)),
      leaseUntil: null, leaseToken: null } });
    if (attempts >= 3 && !fresh.appointmentId) await closePreparation({ preparationId: id, revision: fresh.revision,
      phase: "paused", reason: "booking_preparation_failed" }).catch(() => {});
    console.error("[bookingRecovery] preparation failed", error.code || "preparation_error");
    try { require("@sentry/node").captureException(new Error("Booking preparation failed"), {
      tags: { operation: "booking_preparation", code: "booking_preparation_failed" },
      extra: { requestId: String(row.requestId) },
    }); } catch (_) { /* Monitoring cannot prevent recovery. */ }
    return false;
  }
}
async function sweepPreparations({ landlordId = null, now = new Date() } = {}) {
  const due = await Preparation.find({ active: true, nextAttemptAt: { $lte: now },
    ...(landlordId ? { landlordId } : {}), $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] })
    .sort({ nextAttemptAt: 1, deadlineAt: 1 }).limit(20).select("_id").lean();
  for (const row of due) await processPreparation(row._id, now);
  await notices.sweepNotices();
  await require('./bookingReschedule.service').sweep(now);
  return due.length;
}
function startBookingRecovery(intervalMs = INTERVAL_MS) {
  const run = () => sweepPreparations().catch(error => console.error("[bookingRecovery] sweep failed", error.code || "sweep_error"));
  run();
  const timer = setInterval(run, intervalMs); timer.unref?.(); return timer;
}
module.exports = { processPreparation, sweepPreparations, startBookingRecovery, INTERVAL_MS, LEASE_MS };
