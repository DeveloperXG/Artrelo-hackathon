// Two timers over JobCompletion, structurally identical to
// vendorOutreachSweeper: a pure filter, an atomic conditional claim, and a
// per-row try/catch so one bad document cannot stall the tick.
//
//   1. auto-confirm      — the tenant went quiet on evidence that CLEARED the
//                          checks (or that a manager already reviewed); treat
//                          silence as acceptance
//   2. evidence escalation — the tenant went quiet on evidence that did NOT
//                          clear; ask the manager instead of paying out
//   3. payout release     — the trailing dispute window has passed; close for real
//
// Passes 1 and 2 are exact complements, so no completion can be claimed by both.
//
// WHY TWO. "Auto-confirm releases payment" and "auto-confirm is reversible"
// cannot both be true of one deadline: once a Stripe transfer lands in a
// vendor's Connect account, clawing it back is hard. So auto-confirm flips the
// state and payoutReleaseAt (set a trailing window later) is what actually
// closes and pays. A dispute inside that window voids a transfer that never
// existed. A manual tenant confirmation sets payoutReleaseAt = now, because the
// tenant has already spoken and there is nothing to reverse.

const JobCompletion = require("../../models/JobCompletion");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const Appointment = require("../../models/Appointment");
const Vendor = require("../../models/Vendor");
const { notifyUser } = require("../notification/notify.service");
const { logAgentAction } = require("../audit/agentAction.service");
const { sweepTenantConfirmations } = require("./appointmentFailure.service");
const { sweepCompletionRecovery } = require("./completionRecovery.service");
const { reconcileCompletionPaymentViews } = require("./completionPaymentView.service");
const {
  closeJobCompletion,
  ensureCompletionReviewApproval,
  TRAILING_DISPUTE_MS,
} = require("./jobCompletion.service");

// Five minutes, not the outreach sweeper's sixty seconds: that cadence is
// forced by a 15-minute emergency SLA, and a 48-hour deadline needs nothing
// tighter.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// A tenant answering as the tick fires should win; the claim below settles it
// either way, but the grace keeps the race from being routine.
const GRACE_MS = 60 * 1000;

const TERMINAL_REQUEST_STATUSES = ["completed", "rejected", "cancelled"];

/* ------------------------------------------------------------------ *
 * Pure filters — exported so they can be unit-tested without a database,
 * exactly like expiredOutreachFilter.
 * ------------------------------------------------------------------ */

// SILENCE ONLY BUYS EVIDENCE THAT CLEARED THE CHECKS.
//
// Weak evidence used to be parked in in_review at submit, which made it
// structurally unreachable from here. Every completion now goes to the tenant
// instead — they were in the room and are the better judge — so the guard moved
// from the front of the flow to this filter. The property it protects is the
// same one closeJobCompletion states about overages: a tenant saying nothing
// must never be read as a tenant saying yes to something nobody verified.
//
// evidenceReviewedAt is the second arm. A manager who has already looked at
// weak evidence and approved it has supplied the missing human, so the
// completion becomes auto-confirmable — otherwise the escalation below would
// fire again every time the tenant stayed quiet, forever.
const dueForAutoConfirmFilter = (now = new Date()) => ({
  status: "awaiting_tenant",
  autoConfirmAt: { $ne: null, $lte: new Date(now.getTime() - GRACE_MS) },
  $or: [{ evidenceVerdict: "pass" }, { evidenceReviewedAt: { $ne: null } }],
});

// The disjoint half: weak evidence the tenant never answered.
//
// Exactly the complement of the $or above — a completion satisfies one filter
// or the other and never both, which is what keeps "escalate" and
// "auto-confirm" from racing over the same row. Same disjointness the outreach
// sweeper gets from sent/viewed vs counterOffer.status.
const dueForEvidenceEscalationFilter = (now = new Date()) => ({
  status: "awaiting_tenant",
  autoConfirmAt: { $ne: null, $lte: new Date(now.getTime() - GRACE_MS) },
  evidenceVerdict: { $ne: "pass" },
  evidenceReviewedAt: null,
});

const dueForPayoutReleaseFilter = (now = new Date()) => ({
  status: "confirmed",
  closedAt: null,
  payoutReleaseAt: { $ne: null, $lte: new Date(now.getTime() - GRACE_MS) },
});

/** Guard shared by both passes: never act on a request that already ended. */
async function requestIsStillOpen(requestId) {
  const request = await MaintenanceRequest.findById(requestId).select("status").lean();
  if (!request) return false;
  return !TERMINAL_REQUEST_STATUSES.includes(request.status);
}

async function sweepAutoConfirm(now = new Date()) {
  const due = await JobCompletion.find(dueForAutoConfirmFilter(now)).select("_id requestId").lean();
  if (!due.length) return 0;

  let processed = 0;
  for (const row of due) {
    if (!(await requestIsStillOpen(row.requestId))) continue;

    // Atomic claim. verifyTenantJobCompletion contends on this exact predicate,
    // so exactly one of {tenant answers, sweeper auto-confirms} can win.
    const claimed = await JobCompletion.findOneAndUpdate(
      { _id: row._id, status: "awaiting_tenant" },
      {
        $set: {
          status: "confirmed",
          "tenantConfirmation.outcome": "confirmed",
          "tenantConfirmation.autoConfirmed": true,
          "tenantConfirmation.respondedAt": now,
          payoutReleaseAt: new Date(now.getTime() + TRAILING_DISPUTE_MS),
        },
      },
      { new: true }
    );
    if (!claimed) continue; // the tenant answered in the same tick

    try {
      await logAgentAction({
        requestId: claimed.requestId,
        landlordId: claimed.landlordId,
        actor: "system",
        actionType: "completion_auto_confirmed",
        summary: "Tenant review window elapsed — completion auto-confirmed",
        input: { completionId: claimed._id.toString(), autoConfirmAt: claimed.autoConfirmAt },
        output: { payoutReleaseAt: claimed.payoutReleaseAt },
      });
      // The tenant is told, and told they can still object. An auto-confirm the
      // tenant only discovers afterwards is how you lose their trust.
      await notifyUser({
        userId: claimed.tenantId,
        type: "maintenance_auto_confirmed",
        title: "We've marked your request complete",
        message:
          "You didn't get a chance to review the work, so we've marked it complete. " +
          "If something's still wrong, let us know today and we'll reopen it.",
        metadata: { workOrderId: claimed.requestId.toString() },
      });
      processed += 1;
    } catch (err) {
      console.error("[completionSweeper] auto-confirm follow-up failed", err.message);
    }
  }

  if (processed) console.log(`[completionSweeper] auto-confirmed ${processed} completion(s)`);
  return processed;
}

/**
 * The tenant went quiet on a completion whose evidence was thin.
 *
 * This is the ONLY path that now puts a completion in front of the manager, and
 * it is a much smaller set than the old submit-time gate: it needs weak evidence
 * AND an unanswered tenant. A tenant who looks and confirms closes the job
 * without the manager ever seeing it, however few photos the vendor uploaded.
 */
async function sweepEvidenceEscalation(now = new Date()) {
  const due = await JobCompletion.find(dueForEvidenceEscalationFilter(now))
    .select("_id requestId")
    .lean();
  if (!due.length) return 0;

  let processed = 0;
  for (const row of due) {
    if (!(await requestIsStillOpen(row.requestId))) continue;

    // Atomic claim on the same predicate the tenant's own answer contends on,
    // so exactly one of {tenant answers, we escalate} can win.
    const claimed = await JobCompletion.findOneAndUpdate(
      { _id: row._id, status: "awaiting_tenant", evidenceReviewedAt: null },
      { $set: { status: "in_review" } },
      { new: true }
    );
    if (!claimed) continue; // the tenant answered in the same tick

    try {
      const request = await MaintenanceRequest.findById(claimed.requestId);
      if (!request) continue;

      const vendor = claimed.vendorId
        ? await Vendor.findById(claimed.vendorId).select("name").lean()
        : null;

      await ensureCompletionReviewApproval({
        request,
        completion: claimed,
        vendorName: vendor?.name || null,
      });

      // Kept in lockstep with the completion, per the note on Appointment.status.
      await Appointment.updateOne(
        { _id: claimed.appointmentId },
        { $set: { status: "in_review" } }
      );
      request.appointmentStatus = "in_review";
      request.routingStatus = "approval_needed";
      await request.save();

      await logAgentAction({
        requestId: claimed.requestId,
        landlordId: claimed.landlordId,
        actor: "system",
        actionType: "completion_review_escalated",
        summary:
          "Tenant review window elapsed on a completion that did not pass the evidence checks — raised for manager review",
        input: {
          completionId: claimed._id.toString(),
          evidenceVerdict: claimed.evidenceVerdict,
          evidenceReasons: claimed.evidenceReasons || [],
        },
        output: { autoConfirmAt: claimed.autoConfirmAt },
      });

      // The manager is told by the approval itself (decision_needed, raised by
      // the ApprovalRequest hook and emailed), not by a second notice here.

      processed += 1;
    } catch (err) {
      console.error("[completionSweeper] evidence escalation failed", err.message);
    }
  }

  if (processed) console.log(`[completionSweeper] escalated ${processed} completion(s)`);
  return processed;
}

async function sweepPayoutRelease(now = new Date()) {
  const due = await JobCompletion.find(dueForPayoutReleaseFilter(now)).select("_id requestId").lean();
  if (!due.length) return 0;

  let processed = 0;
  for (const row of due) {
    if (!(await requestIsStillOpen(row.requestId))) continue;
    try {
      // closeJobCompletion owns its own claim, so a concurrent tick is safe and
      // an overage simply declines to close rather than throwing.
      const result = await closeJobCompletion({
        completionId: row._id,
        reason: "auto_confirmed",
      });
      if (result?.closed) processed += 1;
    } catch (err) {
      console.error("[completionSweeper] close failed", err.message);
    }
  }

  if (processed) console.log(`[completionSweeper] closed ${processed} completion(s)`);
  return processed;
}

async function sweepCompletions(now = new Date()) {
  const confirmed = await sweepAutoConfirm(now);
  const escalated = await sweepEvidenceEscalation(now);
  const closed = await sweepPayoutRelease(now);
  // Bookings the tenant hasn't confirmed: reminder at 24h, manager at 48h.
  const tenantConfirmations = await sweepTenantConfirmations(now);
  const recovered = await sweepCompletionRecovery(now);
  const paymentViews = await reconcileCompletionPaymentViews(now);
  return { confirmed, escalated, closed, tenantConfirmations, recovered, paymentViews };
}

function startCompletionSweeper(intervalMs = SWEEP_INTERVAL_MS) {
  const run = () => {
    sweepCompletions().catch((err) => {
      console.error("[completionSweeper] run failed", err);
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = {
  SWEEP_INTERVAL_MS,
  GRACE_MS,
  dueForAutoConfirmFilter,
  dueForEvidenceEscalationFilter,
  dueForPayoutReleaseFilter,
  sweepAutoConfirm,
  sweepEvidenceEscalation,
  sweepPayoutRelease,
  sweepCompletions,
  startCompletionSweeper,
};
