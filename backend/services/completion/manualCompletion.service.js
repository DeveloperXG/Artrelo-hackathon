// The landlord's manual "Mark complete" — the one route to a finished job that
// does not run through closeJobCompletion.
//
// closeJobCompletion settles a job the tenant (or the 48h clock) vouched for.
// This settles one the LANDLORD vouched for, usually because the vendor flow
// stalled: no completion submitted, a dispute that went nowhere, an overage the
// landlord would rather just pay. Before this existed, the manual path flipped
// the request to completed and stopped, leaving behind three things a finished
// job must not have:
//
//   - the appointment still "scheduled", which is an UPLOADABLE status in
//     requireJobToken — the vendor's link could still submit a completion that
//     auto-confirms and pays through closeJobCompletion after the fact;
//   - the escrow hold, so `held` drifted away from committedCost (reconcile
//     check 3) and the landlord's money stayed locked against a closed job;
//   - the masked SMS channel, a live line into the tenant's request thread.
//
// PAY OR VOID. The landlord's stated finalCost is the only figure this path
// pays. With one, the hold is released and that amount goes to the vendor —
// the landlord is the approver, so the overage gate is satisfied by
// construction. Without one, the hold is VOIDED back to the landlord. The
// alternatives were the vendor's self-reported cost (unconfirmed — confirming
// it is exactly what the override skips) or the booking ceiling (a cap, not a
// price). A void is reversible — the landlord can still pay — and a transfer
// is not, so the doubtful case takes the reversible move. It also keeps the
// ledger agreeing with reported spend: money moves iff finalCost is recorded.

const Appointment = require("../../models/Appointment");
const JobCompletion = require("../../models/JobCompletion");
const LedgerEntry = require("../../models/LedgerEntry");
const { revokeJobToken } = require("../vendor/jobToken.service");
const { closeProxySessionsForRequest } = require("../comms/proxySession.service");
const { releaseHold, voidHold, settlePayout } = require("../ledger/ledger.service");
const { applyServiceFee } = require("../ledger/serviceFee.service");
const { toCents, fromCents } = require("../ledger/money");
const { isDirectAppointment } = require("../ledger/paymentMode");
const { recordDirectPaymentDue } = require("../ledger/directPayment.service");

// A booking that will not happen. Its hold, if one was ever left, is voided.
const ABANDONED_STATUSES = ["cancelled", "failed"];
const TERMINAL_STATUSES = ["completed", ...ABANDONED_STATUSES];

/**
 * Return or pay out one appointment's hold. Never moves money twice, and each
 * guard below exists because idempotency keys alone do not cover it.
 */
async function settleHold({ request, appointment, payoutCents }) {
  // closeJobCompletion claims its completion (step 2) well before it moves money
  // (step 9). A closed completion means that release is already in flight, and
  // voiding here as well would credit the same hold back twice.
  const completion = await JobCompletion.findOne({ appointmentId: appointment._id })
    .select("_id status identityId")
    .lean();
  if (completion?.status === "closed") return { action: "none", reason: "closed_by_vendor_flow" };

  const hold = await LedgerEntry.findOne({ idempotencyKey: `hold:${appointment._id}` }).lean();
  if (!hold) return { action: "none", reason: "no_hold" };

  // Release is keyed on the completion and void on the appointment, so the two
  // keys cannot collide with each other. The journal is what says whether this
  // hold has already gone back.
  const prior = await LedgerEntry.findOne({
    appointmentId: appointment._id,
    type: { $in: ["hold_release", "hold_void"] },
  })
    .select("type")
    .lean();
  if (prior?.type === "hold_void") return { action: "none", reason: "already_voided" };

  if (payoutCents > 0) {
    // Keyed on the completion whenever one exists — the SAME keys
    // closeJobCompletion would use, so the two paths converge on one payout
    // rather than racing to two. A retry of this function lands on them too.
    const settlementId = completion ? String(completion._id) : `manual:${appointment._id}`;
    const result = await releaseHold({
      landlordId: request.landlordId,
      appointmentId: appointment._id,
      completionId: completion?._id || null,
      settlementId,
      requestId: request._id,
      identityId: hold.identityId || completion?.identityId || null,
      heldCents: hold.amountCents,
      payoutCents,
      scope: hold.scope || {},
      memo: `Marked complete by landlord at $${fromCents(payoutCents)}`,
    });

    if (completion) {
      await JobCompletion.updateOne(
        { _id: completion._id },
        {
          $set: {
            "ledger.holdId": hold._id,
            "ledger.releaseEntryId": result.payout?.entry?._id || result.deferred?.entry?._id || null,
            "ledger.payoutStatus": result.shortfall ? "shortfall" : "pending",
          },
        }
      );
    }
    // Only for an entry this call created — a double-click must not make a
    // second provider call, even one Stripe's idempotency key would absorb.
    if (result.payout?.entry?._id && !result.payout.alreadyApplied) {
      await settlePayout({ entryId: result.payout.entry._id }).catch((err) =>
        console.error("[settleManualCompletion] payout settle failed", err.message)
      );
    }

    // The service fee, after the payout, exactly as closeJobCompletion does it --
    // and on the same settlementId, so the two paths converge on one fee the
    // way they converge on one payout. Only on the PAY branch: a voided hold is
    // a job nobody was paid for, and there is nothing to take a fee on.
    let serviceFee = null;
    try {
      serviceFee = await applyServiceFee({
        landlordId: request.landlordId,
        settlementId,
        payoutCents,
        completionId: completion?._id || null,
        requestId: request._id,
        appointmentId: appointment._id,
        scope: hold.scope || {},
      });
    } catch (err) {
      console.error("[settleManualCompletion] service fee failed", err.message);
    }
    return { action: "paid", shortfall: result.shortfall, uncoveredCents: result.uncoveredCents, serviceFee };
  }

  if (prior?.type === "hold_release") return { action: "none", reason: "already_released" };
  await voidHold({
    landlordId: request.landlordId,
    appointmentId: appointment._id,
    amountCents: hold.amountCents,
    requestId: request._id,
    memo: "Marked complete by landlord without a final cost",
  });
  return { action: "voided" };
}

/**
 * The direct-pay counterpart of settleHold. closeJobCompletion may record the
 * same job; recordDirectPaymentDue keeps whichever amount landed first.
 */
async function settleDirect({ appointment, payoutCents }) {
  if (payoutCents <= 0) return { action: "none", reason: "direct_no_cost" };
  const result = await recordDirectPaymentDue({ appointmentId: appointment._id, amountCents: payoutCents });
  return result.recorded ? { action: "direct_due" } : { action: "none", reason: result.reason };
}

/**
 * Settle every booking on a request the landlord has just marked complete.
 *
 * The newest booking that was not abandoned is the job; the cost (if any) is
 * paid against it. Any other live booking is cancelled, because a completed
 * request has nothing left to book. Every unsettled hold on the request goes
 * back, so a terminal request holds nothing — which is what reconcile check 3
 * asserts.
 *
 * Safe to call twice: appointment moves are compare-and-set on the status
 * read, and money goes through the journal checks above plus the ledger's own
 * keys. A retry after a crash finishes the job rather than repeating it.
 *
 * Money failures are logged, not thrown. The work is done and the request is
 * already correct; reconcileLedger surfaces any gap, as for closeJobCompletion.
 */
async function settleManualCompletion({ request, finalCost = null }) {
  const payoutCents = finalCost === null || finalCost === undefined ? 0 : toCents(finalCost);

  const appointments = await Appointment.find({ requestId: request._id })
    .sort({ createdAt: -1 })
    .select("_id status paymentMode serviceBilling completedAt")
    .lean();
  const worked = appointments.find((a) => !ABANDONED_STATUSES.includes(a.status)) || null;

  const outcomes = [];
  for (const appointment of appointments) {
    const isWorked = worked && String(appointment._id) === String(worked._id);

    if (!TERMINAL_STATUSES.includes(appointment.status)) {
      const nextStatus = isWorked ? "completed" : "cancelled";
      const claimed = await Appointment.findOneAndUpdate(
        { _id: appointment._id, status: appointment.status },
        { $set: { status: nextStatus, ...(nextStatus === "completed" ? { completedAt: new Date() } : {}) } },
        { new: true }
      );
      // Moved under us — most likely closeJobCompletion finishing it. That path
      // owns its money now.
      if (!claimed) {
        outcomes.push({ appointmentId: String(appointment._id), action: "none", reason: "status_moved" });
        continue;
      }
      // A cancelled sibling with an open completion could otherwise still be
      // confirmed and released after its hold was voided below.
      if (!isWorked) {
        await JobCompletion.updateOne(
          { appointmentId: appointment._id, closedAt: null, status: { $nin: ["closed", "void"] } },
          { $set: { status: "void", closeReason: "landlord_override", closedAt: new Date() } }
        );
      }
      await revokeJobToken({ appointmentId: appointment._id }).catch(() => {});
    }

    let outcome;
    try {
      // A direct job never had a hold. The landlord pays the vendor themselves,
      // so the stated cost is recorded as owed rather than paid out; with no
      // cost there is nothing to record, the same as a voided hold.
      outcome = isDirectAppointment(appointment)
        ? await settleDirect({ appointment, payoutCents: isWorked ? payoutCents : 0 })
        : await settleHold({
            request,
            appointment,
            payoutCents: isWorked ? payoutCents : 0,
          });
    } catch (err) {
      console.error("[settleManualCompletion] ledger settle failed", err.message);
      outcome = { action: "none", reason: "ledger_error" };
    }
    if (isWorked && (require("../../config/env").service_billing_enabled || appointment.serviceBilling?.managed)) {
      await require("../billing/feeAssessment.service").assessFee({ appointmentId: appointment._id,
        requestId: request._id, payoutCents, at: appointment.completedAt || request.completedAt || new Date() })
        .catch(error => console.error("[billing] manual completion fee assessment needs recovery", error.code || "assessment_failed"));
    }
    outcomes.push({ appointmentId: String(appointment._id), ...outcome });
  }

  // Plural and request-keyed, like cancelRequest: this is a cleanup of whatever
  // is open, not an assumption that there is exactly one.
  await closeProxySessionsForRequest({ requestId: request._id, reason: "job_closed" }).catch((err) =>
    console.error("[settleManualCompletion] relay close failed", err.message)
  );

  return {
    workedAppointmentId: worked ? String(worked._id) : null,
    outcomes,
    shortfall: outcomes.some((o) => o.shortfall),
  };
}

module.exports = { settleManualCompletion };
