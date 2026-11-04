const JobCompletion = require("../../models/JobCompletion");
const Appointment = require("../../models/Appointment");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const { notifyUser } = require("../notification/notify.service");
const { logAgentAction } = require("../audit/agentAction.service");
const { revokeJobToken } = require("../vendor/jobToken.service");
const { closeProxySession } = require("../comms/proxySession.service");

function authorizedPayable(completion) {
  const actual = Number(completion.report?.actualCost || 0);
  const approved = Number(completion.overage?.approvedAmount);
  return completion.overage?.decision === "approved" && Number.isFinite(approved) && approved > 0
    ? Math.min(actual, approved) : actual;
}

// Idempotent document repair, deliberately with NO imports of payment, billing,
// provider, stats or email services. An uncertain settlement requires review;
// blindly replaying a half-written ledger split is not safe financial recovery.
async function projectClosedCompletion({ completion, request, actorUserId = null }) {
  if (!completion.closedAt || completion.status !== "closed") throw new Error("Completion is not closed");
  if (["cancelled", "rejected"].includes(request.status)) throw new Error("Request was superseded");
  const latestVisit = await Appointment.findOne({ requestId: completion.requestId, landlordId: completion.landlordId })
    .sort({ createdAt: -1, _id: -1 }).select("_id").lean();
  if (String(latestVisit?._id || "") !== String(completion.appointmentId)) throw new Error("A later visit superseded this completion");
  const payable = completion.closeRecovery?.payableCents != null
    ? completion.closeRecovery.payableCents / 100 : authorizedPayable(completion);
  const auto = Boolean(completion.tenantConfirmation?.autoConfirmed);
  const event = { status: "completed", at: completion.closedAt,
    note: auto ? "Auto-confirmed after tenant review window" : "Confirmed by tenant",
    actorRole: auto ? "system" : "tenant", ...((completion.closeRecovery?.actorUserId || actorUserId)
      ? { actorId: completion.closeRecovery?.actorUserId || actorUserId } : {}) };
  const appointment = await Appointment.updateOne({ _id: completion.appointmentId, landlordId: completion.landlordId,
    status: { $in: ["work_verifying", "in_review", "disputed", "completed"] } },
  { $set: { status: "completed", completedAt: completion.closedAt } });
  if (!appointment.matchedCount) throw new Error("Appointment was superseded or removed");
  const fields = { status: "completed", completedAt: completion.closedAt, finalCost: payable, appointmentStatus: "completed",
    ...(completion.report?.workPerformed ? { completionNotes: completion.report.workPerformed } : {}) };
  const result = await MaintenanceRequest.updateOne({ _id: request._id, landlordId: completion.landlordId,
    status: { $nin: ["cancelled", "rejected"] }, updatedAt: request.updatedAt },
  { $set: fields, $addToSet: { timeline: event } });
  if (!result.matchedCount) throw new Error("Request changed during completion projection");
  await JobCompletion.updateOne({ _id: completion._id, status: "closed" },
    { $set: { "closeRecovery.projectionPending": false } });
  Object.assign(request, fields);
  return { payable, request };
}

async function sweepCompletionRecovery(now = new Date()) {
  // Give an in-flight normal close ten minutes. No historical backfill or
  // reopening. A failed projection stays pending for the next bounded pass.
  const due = await JobCompletion.find({ status: "closed", "closeRecovery.version": 1,
    "closeRecovery.reviewedAt": null, closedAt: { $lte: new Date(now.getTime() - 10 * 60_000) } })
    .sort({ closedAt: 1 }).limit(25).lean();
  let repaired = 0;
  for (const row of due) {
    const claimed = await JobCompletion.findOneAndUpdate({ _id: row._id, status: "closed",
      "closeRecovery.reviewedAt": null,
      $or: [{ "closeRecovery.leaseUntil": null }, { "closeRecovery.leaseUntil": { $lte: now } }] },
    { $set: { "closeRecovery.leaseUntil": new Date(now.getTime() + 120_000) },
      $inc: { "closeRecovery.attempts": 1 } }, { new: true });
    if (!claimed) continue;
    const completion = claimed;
    try {
      if (completion.closeRecovery.projectionPending) {
        const request = await MaintenanceRequest.findOne({ _id: completion.requestId, landlordId: completion.landlordId }).lean();
        if (!request) throw new Error("Request was removed");
        await projectClosedCompletion({ completion, request });
        repaired++;
      }
      // Both are conditional credential retirements, safe to repeat. A crash
      // before the normal close's step 5 must not leave a live job link/channel.
      await revokeJobToken({ appointmentId: completion.appointmentId });
      await closeProxySession({ appointmentId: completion.appointmentId, reason: "job_closed" });
      if (!completion.closeRecovery.settlementRecordedAt) {
        // At most one attention notice even if a worker dies mid-delivery.
        const claimed = await JobCompletion.findOneAndUpdate({ _id: completion._id,
          "closeRecovery.attentionClaimedAt": null, "closeRecovery.settlementRecordedAt": null },
        { $set: { "closeRecovery.attentionClaimedAt": now } }, { new: true });
        if (claimed) {
          await logAgentAction({ requestId: completion.requestId, landlordId: completion.landlordId, actor: "system",
            actionType: "completion_settlement_review_required", summary: "Completion records recovered; verify the payment and billing records before retrying settlement",
            input: { completionId: String(completion._id) }, output: { paymentsReplayed: false } });
          await notifyUser({ userId: completion.landlordId, type: "system_maintenance", title: "Completed job payment needs review",
            message: "The completion was interrupted. Check the work record and payment records before retrying; recovery has not moved money.",
            metadata: { workOrderId: String(completion.requestId), actionUrl: `/dashboard/requests/${completion.requestId}?tab=work` } });
        }
      }
      await JobCompletion.updateOne({ _id: completion._id }, { $set: { "closeRecovery.reviewedAt": now } });
    } catch (error) {
      console.error("[completionRecovery] projection needs review", String(completion._id), error.message);
      if (claimed.closeRecovery.attempts >= 3) {
        const attention = await JobCompletion.findOneAndUpdate({ _id: completion._id, "closeRecovery.attentionClaimedAt": null },
          { $set: { "closeRecovery.attentionClaimedAt": now } }, { new: true });
        if (attention) await notifyUser({ userId: completion.landlordId, type: "system_maintenance",
          title: "Completion records need review", message: "An interrupted completion could not be reconciled automatically. Review this request; recovery has not moved money.",
          metadata: { workOrderId: String(completion.requestId), actionUrl: `/dashboard/requests/${completion.requestId}?tab=work` } });
        await JobCompletion.updateOne({ _id: completion._id }, { $set: { "closeRecovery.reviewedAt": now } });
      }
    }
  }
  return repaired;
}
module.exports = { authorizedPayable, projectClosedCompletion, sweepCompletionRecovery };
