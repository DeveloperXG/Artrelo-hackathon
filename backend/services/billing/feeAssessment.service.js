const Assessment = require("../../models/FeeAssessment");
const Appointment = require("../../models/Appointment");
const Request = require("../../models/MaintenanceRequest");
const Completion = require("../../models/JobCompletion");
const Entry = require("../../models/LedgerEntry");
const { feeDecision } = require("./billingPolicy");
async function assessFee({ appointmentId, requestId, completionId = null, payoutCents, at }) {
  if (!appointmentId || !Number.isSafeInteger(payoutCents) || payoutCents < 0) throw new Error("A job and integer payable amount are required");
  const sourceKey = `job:${appointmentId}`;
  const prior = await Assessment.findOne({ sourceKey }); if (prior) return prior;
  const appointment = await Appointment.findById(appointmentId).lean();
  if (!appointment || appointment.status !== "completed") return null;
  // Historical wallet assessments are authoritative. Never invoice them again.
  if (await Entry.exists({ appointmentId, type: "fee", shortfall: { $ne: true } })) return null;
  const decision = feeDecision(appointment.serviceBilling, payoutCents);
  const closedAt = appointment.completedAt || at || appointment.updatedAt;
  try { return await Assessment.create({ sourceKey, source: "job", landlordId: appointment.landlordId,
    appointmentId, requestId: requestId || appointment.requestId, completionId, payableCents: payoutCents, closedAt, ...decision }); }
  catch (error) { if (error.code !== 11000) throw error; return Assessment.findOne({ sourceKey }); }
}
async function recoverAssessments({ limit = 50 } = {}) {
  const rows = await Appointment.aggregate([
    { $match: { status: "completed", "serviceBilling.managed": true, completedAt: { $lt: new Date(Date.now() - 60_000) } } },
    { $lookup: { from: Assessment.collection.name, localField: "_id", foreignField: "appointmentId", as: "assessments" } },
    { $match: { "assessments.0": { $exists: false } } }, { $sort: { completedAt: 1 } }, { $limit: limit },
  ]);
  for (const row of rows) {
    const request = await Request.findById(row.requestId).select("finalCost status").lean();
    const completion = await Completion.findOne({ appointmentId: row._id, status: "closed" }).select("_id closedAt").lean();
    if (request?.status !== "completed") continue;
    const cents = row.directPayment?.amountCents ?? Math.round(Number(request?.finalCost || 0) * 100);
    await assessFee({ appointmentId: row._id, requestId: row.requestId, completionId: completion?._id,
      payoutCents: cents, at: completion?.closedAt || row.completedAt || row.updatedAt });
  }
  return { checked: rows.length };
}
module.exports = { assessFee, recoverAssessments };
