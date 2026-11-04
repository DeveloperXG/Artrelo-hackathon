// The single close path for a job.
//
// Every route to "this job is finished and the vendor may be paid" ends here:
// the tenant confirming, the 48h auto-confirm sweeper, a landlord resolving a
// review, and an overage approval resuming a held-back close. One function so
// there is exactly one place that writes finalCost, one place that flips the
// appointment to completed, and (in slice C) one place that moves money.
//
// The one exception is the landlord's manual "Mark complete" when there is no
// confirmed completion to delegate to: that path settles through
// manualCompletion.service.js, which shares this file's idempotency keys
// whenever a completion exists, so the two cannot both pay.
//
// ORDER MATTERS in closeJobCompletion — see the numbered comments.

const MaintenanceRequest = require("../../models/MaintenanceRequest");
const Appointment = require("../../models/Appointment");
const JobCompletion = require("../../models/JobCompletion");
const ApprovalRequest = require("../../models/ApprovalRequest");
const Vendor = require("../../models/Vendor");
const VendorIdentity = require("../../models/VendorIdentity");
const LandlordPolicy = require("../../models/LandlordPolicy");
const { notifyUser } = require("../notification/notify.service");
const { logAgentAction } = require("../audit/agentAction.service");
const { resolveQuotaLimit } = require("../vendor/routingDecision.service");
const { revokeJobToken } = require("../vendor/jobToken.service");
const { closeProxySession } = require("../comms/proxySession.service");
const LedgerEntry = require("../../models/LedgerEntry");
const VendorOutreach = require("../../models/VendorOutreach");
const Property = require("../../models/Property");
const Landlord = require("../../models/Landlord");
const env = require("../../config/env");
const { sendEmail } = require("../notification/email.service");
const { buildVendorJobCompleteEmail } = require("../notification/templates/vendorLifecycleEmail");
const { resolveRequestCity, formatCityLabel } = require("../vendor/vendorScoring.service");
const { releaseHold, settlePayout } = require("../ledger/ledger.service");
const { toCents, fromCents } = require("../ledger/money");
const { warnIfLowBalance } = require("../ledger/lowBalance.service");
const { applyServiceFee } = require("../ledger/serviceFee.service");
const { isDirectAppointment } = require("../ledger/paymentMode");
const { recordDirectPaymentDue } = require("../ledger/directPayment.service");
const { authorizedPayable, projectClosedCompletion } = require("./completionRecovery.service");

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

// After a manager vouches for weak evidence, the tenant gets the same window
// they would have had if the evidence had passed by itself.
const AUTO_CONFIRM_AFTER_REVIEW_MS = 48 * 60 * 60 * 1000;

// A rounding cent must not page a landlord at 2am. Whichever is larger, so
// small jobs get a flat allowance and large ones a proportional one.
const OVERAGE_TOLERANCE_PCT = 0.02;
const OVERAGE_TOLERANCE_MIN = 10;

// The gap between "the job closed" and "the money moved". A tenant who
// auto-confirmed by silence can still dispute inside this window, and a dispute
// there voids a transfer that never existed — which is the only way to make
// auto-confirm genuinely reversible once Stripe is wired in.
const TRAILING_DISPUTE_MS = 24 * 60 * 60 * 1000;

const roundUpTo25 = (amount) => Math.ceil(Number(amount || 0) / 25) * 25;

function overageAllowance(ceiling) {
  return Math.max(OVERAGE_TOLERANCE_MIN, Number(ceiling || 0) * OVERAGE_TOLERANCE_PCT);
}

/**
 * Does this cost need a manager's sign-off?
 *
 * THE one definition of the threshold. The vendor portal asks the same question
 * at submit time so the vendor learns immediately instead of 48 hours later, and
 * the close gate asks it again as a backstop. Two hand-rolled comparisons would
 * drift, and the direction they'd drift in is "submit says fine, close says no"
 * — which is precisely the confusing failure this is meant to remove.
 *
 * Pure. No ceiling means nothing to measure against, which is not an overage.
 */
function isOverCeiling({ actualCost, ceiling }) {
  const limit = Number(ceiling || 0);
  if (!limit) return false;
  return Number(actualCost || 0) - limit > overageAllowance(limit);
}

/**
 * Resolve the ceiling this job's actual cost is measured against.
 * Snapshotted value first — the outreach that carried the quote may have been
 * superseded — then the request estimate, then the standing quota.
 */
async function resolveApprovedCeiling({ completion, request, policy }) {
  if (completion.approvedCeiling !== null && completion.approvedCeiling !== undefined) {
    return Number(completion.approvedCeiling);
  }
  if (request?.estimatedCost) return Number(request.estimatedCost);
  return resolveQuotaLimit(policy || {}, request || {});
}

/**
 * Sibling of ensureQuotaApprovalForVendorQuote, NOT a modification of it: that
 * function's payload is vendor-quote shaped (selectedWindow, basis
 * "vendor_quote") and its dedup query keys on payload.outreachId. This one keys
 * on payload.completionId.
 *
 * It reuses type "quota_increase" rather than adding an enum value — which is
 * exactly why decideApprovalRequest needs a dedicated branch for it. See the
 * comment there.
 */
async function ensureCompletionOverageApproval({
  request,
  completion,
  ceiling,
  actualCost,
  overageReason = null,
}) {
  const existing = await ApprovalRequest.findOne({
    requestId: request._id,
    landlordId: request.landlordId,
    type: "quota_increase",
    status: "pending",
    "payload.source": "completion_overage",
    "payload.completionId": completion._id.toString(),
  });

  const approval =
    existing ||
    new ApprovalRequest({
      requestId: request._id,
      landlordId: request.landlordId,
      type: "quota_increase",
    });

  approval.type = "quota_increase";
  approval.status = "pending";
  approval.decidedAt = undefined;
  approval.expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  approval.amountRequested = actualCost;
  // The vendor's own explanation, captured at submit while they still had the
  // job in front of them. Without it this decision is a bare number and a delta.
  const reason = String(overageReason || "").trim();
  approval.reason =
    `The job was completed at $${actualCost}, above the approved $${ceiling}. ` +
    (reason
      ? `Vendor's reason: "${reason}" Approve to release payment at the higher amount.`
      : `Approve to release payment at the higher amount.`);
  approval.payload = {
    // The discriminator decideApprovalRequest branches on so it does NOT
    // regenerate the recommendation snapshot for a job that is already done.
    source: "completion_overage",
    ...(completion.quoteContractVersion === 2 && completion.report?.finalStatement ? {
      quoteRevision: completion.report.finalStatement.revision, quoteHash: completion.report.finalStatement.hash,
    } : {}),
    completionId: completion._id.toString(),
    requestId: request._id.toString(),
    appointmentId: completion.appointmentId?.toString() || null,
    quota: {
      limit: ceiling,
      quotedAmount: actualCost,
      suggestedQuota: roundUpTo25(actualCost),
      basis: "completion_overage",
    },
    overageReason: reason || null,
  };

  await approval.save();
  return approval;
}

/**
 * Raise the manager's review of a completion whose evidence did not pass.
 *
 * THIS IS THE OTHER HALF OF THE EVIDENCE GATE. Parking a completion in
 * in_review is only safe if something then asks a human about it — otherwise
 * the job stalls forever with the money held, which is exactly what happened
 * on the first real end-to-end run: a vendor submitted without a photo, the
 * check correctly demoted it, and there was nowhere for that to surface.
 *
 * Uses the existing ApprovalRequest surface rather than a parallel queue, so it
 * lands on the decisions page the manager already watches. Dedup keys on
 * payload.completionId, the same shape as the vendor-quote and overage
 * builders.
 */
async function ensureCompletionReviewApproval({ request, completion, vendorName }) {
  const existing = await ApprovalRequest.findOne({
    requestId: request._id,
    landlordId: request.landlordId,
    type: "completion_review",
    status: "pending",
    "payload.completionId": completion._id.toString(),
  });

  const approval =
    existing ||
    new ApprovalRequest({
      requestId: request._id,
      landlordId: request.landlordId,
      type: "completion_review",
    });

  const cost = completion.report?.actualCost ?? 0;
  // Prefer what the manager authorized over what was reserved at booking. When
  // the review is raised AFTER an overage decision (the normal order now), the
  // booking-time ceiling is stale and quoting it made the card read
  // "$480 of $300 approved" for a job already approved at $400.
  const ceilingForDisplay =
    completion.overage?.decision === "approved" && completion.overage?.approvedAmount != null
      ? completion.overage.approvedAmount
      : (completion.approvedCeiling ?? null);
  const photoCount = (completion.photos || []).length;

  approval.type = "completion_review";
  approval.status = "pending";
  approval.decidedAt = undefined;
  approval.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  approval.amountRequested = cost;
  approval.reason =
    `${vendorName || "The vendor"} submitted a completion for $${cost} that needs a look ` +
    `before the tenant is asked to confirm.`;
  approval.payload = {
    source: "completion_review",
    completionId: completion._id.toString(),
    appointmentId: completion.appointmentId?.toString() || null,
    requestId: request._id.toString(),
    vendorName: vendorName || null,
    // Everything the manager needs to judge it without opening another page.
    completion: {
      workPerformed: completion.report?.workPerformed || "",
      partsUsed: completion.report?.partsUsed || "",
      followUpNeeded: Boolean(completion.report?.followUpNeeded),
      followUpNotes: completion.report?.followUpNotes || "",
      actualCost: cost,
      currency: completion.report?.currency || "CAD",
      approvedCeiling: ceilingForDisplay,
      submittedAt: completion.report?.submittedAt || null,
      photoCount,
      photos: (completion.photos || []).map((photo) => ({
        url: photo.url,
        label: photo.label || null,
      })),
      evidenceVerdict: completion.evidenceVerdict,
      evidenceReasons: completion.evidenceReasons || [],
    },
  };

  await approval.save();
  return approval;
}

/**
 * The manager ruled on a parked completion.
 *
 * Approving does NOT pay the vendor directly — it hands the job back to the
 * tenant, who is still the real signal. The manager is vouching that the
 * evidence gap is acceptable, not that the work is done.
 */
async function resolveCompletionReview({ completionId, decision, actorUserId = null }) {
  const approved = decision === "approved";
  const now = new Date();

  const completion = await JobCompletion.findOneAndUpdate(
    // evidenceReviewedAt records that a human has now looked, which is what
    // makes the completion auto-confirmable again. The verdict itself is left
    // alone on purpose — a dispute depends on what the checks said at submit,
    // not on what was decided afterwards.
    { _id: completionId, status: "in_review" },
    {
      $set: {
        // Stamped on BOTH outcomes: the fact being recorded is that a human
        // looked, not what they concluded.
        evidenceReviewedAt: now,
        ...(approved
          ? {
              status: "awaiting_tenant",
              // The tenant gets the same window they would have had if the
              // evidence had passed on its own — and this time silence CAN
              // auto-confirm it, because evidenceReviewedAt is now set.
              autoConfirmAt: new Date(now.getTime() + AUTO_CONFIRM_AFTER_REVIEW_MS),
            }
          : { status: "disputed" }),
      },
    },
    { new: true }
  );
  if (!completion) return null;

  const appointmentStatus = approved ? "work_verifying" : "disputed";
  await Appointment.updateOne(
    { _id: completion.appointmentId },
    { $set: { status: appointmentStatus } }
  );
  await MaintenanceRequest.updateOne(
    { _id: completion.requestId },
    { $set: { appointmentStatus, routingStatus: approved ? "routed" : "approval_needed" } }
  );

  if (approved) {
    await notifyUser({
      userId: completion.tenantId,
      type: "maintenance_verification_requested",
      title: "Was your repair completed?",
      message: "Your property manager reviewed the work. Please confirm it's sorted.",
      metadata: { workOrderId: completion.requestId.toString() },
    });
  } else {
    await bumpVendorCompletionStats({ completion, outcome: "disputed" });
  }

  await logAgentAction({
    requestId: completion.requestId,
    landlordId: completion.landlordId,
    actor: "landlord",
    actionType: approved ? "completion_review_approved" : "completion_review_rejected",
    summary: approved
      ? "Manager accepted the completion evidence; tenant asked to confirm"
      : "Manager rejected the completion evidence",
    input: { completionId: String(completionId), actorUserId },
    output: { status: completion.status },
  });

  return completion;
}

async function bumpVendorCompletionStats({ completion, outcome }) {
  const rating = completion.tenantConfirmation?.rating || null;
  const success = outcome === "success";

  if (completion.vendorId) {
    const inc = success ? { successfulJobs: 1 } : { failedJobs: 1 };
    const update = { $inc: inc, $set: { lastUsedAt: new Date() } };

    // Running mean, same formula as bumpVendorAcceptanceStats.
    if (rating) {
      const vendor = await Vendor.findById(completion.vendorId).select("rating ratingCount").lean();
      const count = Number(vendor?.ratingCount || 0);
      const mean = Number(vendor?.rating || 0);
      update.$set.rating = Math.round(((mean * count + rating) / (count + 1)) * 10) / 10;
      update.$inc.ratingCount = 1;
    }
    await Vendor.updateOne({ _id: completion.vendorId }, update).catch(() => {});
  }

  // The global identity is what a trusted-vendor score will later read, so it
  // accumulates from day one rather than starting at zero when that ships.
  if (completion.identityId) {
    await VendorIdentity.updateOne(
      { _id: completion.identityId },
      {
        $inc: {
          [success ? "aggregate.completedJobs" : "aggregate.disputedJobs"]: 1,
          ...(rating ? { "aggregate.ratingSum": rating, "aggregate.ratingCount": 1 } : {}),
        },
      }
    ).catch(() => {});
  }
}

/**
 * Close a confirmed completion: project it onto the request, retire the
 * vendor's credential, bank the trust data, and (slice C) release the money.
 *
 * Safe to call twice — the closedAt claim makes it idempotent.
 * Returns { closed: false, reason } when it deliberately declines to close.
 */
async function closeJobCompletion({ completionId, reason = "tenant_confirmed", actorUserId = null }) {
  const completion = await JobCompletion.findById(completionId);
  if (!completion) return { closed: false, reason: "not_found" };
  if (completion.closedAt) return { closed: false, reason: "already_closed", completion };
  if (completion.status !== "confirmed") {
    return { closed: false, reason: `not_confirmed:${completion.status}`, completion };
  }
  if (completion.quoteContractVersion === 2 &&
      (!completion.report?.finalStatement || completion.invoiceReview?.state !== "cleared" ||
        completion.invoiceReview.quoteHash !== completion.report.finalStatement.hash)) {
    return { closed: false, reason: "cost_review_pending", completion };
  }

  const request = await MaintenanceRequest.findById(completion.requestId);
  if (!request) return { closed: false, reason: "request_missing" };

  const auto = Boolean(completion.tenantConfirmation?.autoConfirmed);
  const actualCost = Number(completion.report?.actualCost || 0);

  /* -- 1. Overage gate FIRST. No finalCost, no money, no close. ------------ */
  const policy = await LandlordPolicy.findOne({ landlordId: request.landlordId }).lean();
  const ceiling = await resolveApprovedCeiling({ completion, request, policy });
  const overBy = actualCost - Number(ceiling || 0);
  const alreadyApproved = completion.overage?.decision === "approved";

  // Backstop. submitCompletion normally raised this already, in which case
  // ensureCompletionOverageApproval finds the pending row and reuses it — the
  // dedup on payload.completionId is what makes calling from both places safe.
  if (isOverCeiling({ actualCost, ceiling }) && !alreadyApproved) {
    const approval = await ensureCompletionOverageApproval({
      request,
      completion,
      ceiling,
      actualCost,
      overageReason: completion.report?.overageReason || null,
    });

    await JobCompletion.updateOne(
      { _id: completion._id },
      {
        $set: {
          "overage.isOver": true,
          "overage.amount": Math.round(overBy * 100) / 100,
          "overage.approvalRequestId": approval._id,
          "overage.decision": "pending",
        },
      }
    );

    request.routingStatus = "approval_needed";
    await request.save();

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "system",
      actionType: "completion_over_ceiling",
      summary: `Job completed at $${actualCost}, above the approved $${ceiling} — manager approval requested`,
      input: { completionId: completion._id.toString(), auto },
      output: { approvalRequestId: approval._id.toString(), overBy },
    });

    // Deliberately NOT closed. Silence from a tenant must never buy an
    // overage — that is the one guardrail unconditional auto-confirm keeps.
    return { closed: false, reason: "overage_pending", completion, approval };
  }

  /* -- 2. The close claim. Only one caller may win. ------------------------ */
  const now = new Date();
  const payable = authorizedPayable(completion);
  const claimed = await JobCompletion.findOneAndUpdate(
    { _id: completion._id, closedAt: null, status: "confirmed", updatedAt: completion.updatedAt },
    { $set: { closedAt: now, closeReason: reason, status: "closed",
      closeRecovery: { version: 1, payableCents: toCents(payable), projectionPending: true,
        ...(actorUserId ? { actorUserId } : {}) } } },
    { new: true }
  );
  if (!claimed) return { closed: false, reason: "lost_close_race", completion };

  /* -- 3–4. Idempotent projections, recoverable after a process failure. --- */
  await projectClosedCompletion({ completion: claimed, request, actorUserId });

  /* -- 5. Retire the vendor's credentials. Bounds a leaked link to the job. - */
  await revokeJobToken({ appointmentId: claimed.appointmentId }).catch(() => {});

  // The masked channel is a credential too — an open ProxySession is a live
  // line into a tenant's request thread, and a job that is finished should not
  // still have one. Closing it also RELEASES THE NUMBER: the routing invariant
  // pins (proxyNumber, vendorPhone) only while a session is open, so a pool
  // that is never closed down dies after one job per vendor per number.
  //
  // Nothing is reversed here beyond a status flip, which is the payoff for
  // never having written a masked number onto the Tenant record in the first
  // place.
  await closeProxySession({ appointmentId: claimed.appointmentId, reason: "job_closed" }).catch(
    () => {}
  );

  /* -- 6. Trust data. Cheap now so the scoring feature later is a read model
   *       over real history rather than zeros. ----------------------------- */
  await bumpVendorCompletionStats({ completion: claimed, outcome: "success" });

  /* -- 7. Audit. ---------------------------------------------------------- */
  await logAgentAction({
    requestId: request._id,
    landlordId: request.landlordId,
    actor: auto ? "system" : "tenant",
    actionType: "job_completion_closed",
    summary: auto
      ? `Job auto-confirmed after the tenant review window and closed at $${payable}`
      : `Tenant confirmed the work; job closed at $${payable}`,
    input: { completionId: claimed._id.toString(), reason },
    metadata: { occurredAt: claimed.closedAt, occurrenceSource: "completion.closedAt",
      cause: { kind: "approval", id: claimed.invoiceReview?.approvalId || null } },
    output: {
      finalCost: payable,
      rating: claimed.tenantConfirmation?.rating || null,
      evidenceVerdict: claimed.evidenceVerdict,
    },
  });

  /* -- 8. Notify. --------------------------------------------------------- */
  await notifyUser({
    userId: request.tenantId,
    type: "maintenance_completed",
    title: "Your request is complete",
    message: `"${request.issueTitle}" has been marked complete.`,
    metadata: { workOrderId: request._id.toString() },
  });
  if (auto) {
    await notifyUser({
      userId: request.landlordId,
      type: "maintenance_auto_confirmed",
      title: "Job auto-confirmed",
      message: `"${request.issueTitle}" closed at $${payable} after the tenant review window.`,
      metadata: { workOrderId: request._id.toString(), amount: payable },
    });
  }

  /* -- 9. Money. THE ONLY PLACE IT MOVES. --------------------------------- */
  //
  // Runs last, after the close claim, so it can only ever execute for the one
  // caller that won — and its own idempotency keys are derived from
  // completionId, so even a replay of this whole function pays once.
  //
  // Non-fatal: the work is done and the record is already correct. A ledger
  // outage must not un-complete a job; reconcileLedger surfaces the gap.
  let ledgerResult = null;
  let settlementRecorded = false;
  // The rail was fixed when the vendor accepted (Appointment.paymentMode).
  const booked = await Appointment.findById(claimed.appointmentId).select("paymentMode serviceBilling").lean();
  const direct = isDirectAppointment(booked);
  if (direct) {
    // The landlord pays the vendor themselves: there is no hold to release,
    // nothing to transfer, and no service fee to take from a wallet that is
    // not in use. What is owed is recorded on the appointment instead.
    try {
      await recordDirectPaymentDue({ appointmentId: claimed.appointmentId, amountCents: toCents(payable), at: now });
      settlementRecorded = true;
    } catch (err) { console.error("[closeJobCompletion] direct payment record failed", err.message); }
  } else {
    try {
      // heldCents stays on the BOOKING ceiling — that is what was actually
      // reserved, and releasing more than was held would invent money. The
      // difference between the two comes back to the wallet as unspent.
      const heldCents = toCents(ceiling || actualCost);
      const payoutCents = toCents(payable);
      ledgerResult = await releaseHold({
        landlordId: request.landlordId,
        appointmentId: claimed.appointmentId,
        completionId: claimed._id,
        requestId: request._id,
        identityId: claimed.identityId || null,
        heldCents,
        payoutCents,
        scope: {
          propertyId: request.propertyId || null,
          unitId: request.unitId || null,
          category: request.category || null,
        },
        memo: `Job completed at $${payable}`,
      });

      await JobCompletion.updateOne(
        { _id: claimed._id },
        {
          $set: {
            "ledger.holdId": ledgerResult.release?.entry?._id || null,
            // When nothing was covered there is no sent payout, only the deferred one.
            "ledger.releaseEntryId": ledgerResult.payout?.entry?._id || ledgerResult.deferred?.entry?._id || null,
            "ledger.payoutStatus": ledgerResult.shortfall ? "shortfall" : "pending",
          },
        }
      );

      // Attempt the external transfer. Separate from the journal write on
      // purpose: the ledger is authoritative about what is OWED, and the provider
      // only reports what happened to the transfer. A failure here changes
      // providerStatus and nothing else.
      if (ledgerResult.payout?.entry?._id) {
        await settlePayout({ entryId: ledgerResult.payout.entry._id }).catch((err) =>
          console.error("[closeJobCompletion] payout settle failed", err.message)
        );
      }

      if (ledgerResult.shortfall) {
        // A bill, not a decision — so it is a notification, not an
        // ApprovalRequest. The vendor is owed either way.
        const owed = fromCents(ledgerResult.uncoveredCents || 0);
        await notifyUser({
          userId: request.landlordId,
          type: "payment_overdue",
          title: "Your balance didn't cover this payout",
          message: ledgerResult.deferred
            ? `"${request.issueTitle}" completed at $${payable}. $${owed} of it is waiting on your balance — add funds by card and it goes to the vendor automatically.`
            : `"${request.issueTitle}" completed at $${payable}, more than your available balance. Top up to settle it.`,
          metadata: { workOrderId: request._id.toString(), amount: payable, owed },
        });
        await logAgentAction({
          requestId: request._id,
          landlordId: request.landlordId,
          actor: "system",
          actionType: "ledger_shortfall",
          summary: `Payout of $${payable} exceeded the available balance and was recorded as arrears`,
          input: { completionId: claimed._id.toString() },
          output: { payoutCents, shortfall: true },
        });
      }

      // Artrelo's service fee. LAST, after the payout and its settle: the vendor
      // has first claim on the wallet, and a fee problem must never be the reason
      // a vendor was not paid -- hence its own try/catch inside this one. Quoted
      // as of the close (claimed.closedAt) so a replay decides the same way.
      settlementRecorded = true;
      try {
        await applyServiceFee({
          landlordId: request.landlordId,
          settlementId: String(claimed._id),
          payoutCents,
          completionId: claimed._id,
          requestId: request._id,
          appointmentId: claimed.appointmentId,
          scope: {
            propertyId: request.propertyId || null,
            unitId: request.unitId || null,
            category: request.category || null,
          },
          at: claimed.closedAt || now,
        });
      } catch (err) {
        settlementRecorded = false;
        console.error("[closeJobCompletion] service fee failed", err.message);
      }

      await warnIfLowBalance({ landlordId: request.landlordId });
    } catch (err) {
      settlementRecorded = false;
      console.error("[closeJobCompletion] ledger release failed", err.message);
    }
  }

  // Shared billing is independent of the vendor payment rail and its outcome.
  // In particular a direct vendor payment still marked due cannot defer this fee.
  if (require("../../config/env").service_billing_enabled || booked?.serviceBilling?.managed) {
    await require("../billing/feeAssessment.service").assessFee({ appointmentId: claimed.appointmentId,
      requestId: request._id, completionId: claimed._id, payoutCents: toCents(payable), at: claimed.closedAt || now })
      .catch(error => { settlementRecorded = false;
        console.error("[billing] completion fee assessment needs recovery", error.code || "assessment_failed"); });
  }
  if (settlementRecorded) await JobCompletion.updateOne({ _id: claimed._id },
    { $set: { "closeRecovery.settlementRecordedAt": new Date(), "closeRecovery.reviewedAt": new Date() } });

  /* -- 10. Tell the vendor. After the money step so the email can say what
   *        happened to it. Non-fatal: the job is closed either way. ---------- */
  await sendVendorJobCompleteEmail({ completion: claimed, request, amount: payable, ledgerResult, direct }).catch((err) =>
    console.error("[closeJobCompletion] vendor complete email failed", err.message)
  );

  return { closed: true, completion: claimed, request, ledger: ledgerResult };
}

/**
 * "Job complete", with what happened to the payment and the first link to the
 * vendor's jobs page -- where past work and payouts now mean something. This
 * is also where the hub is introduced (it used to be at acceptance, linking a
 * vendor to a list holding one job they couldn't open yet).
 */
async function sendVendorJobCompleteEmail({ completion, request, amount, ledgerResult, direct = false }) {
  if (require('../judgeSandbox/offlineGuard.service').inAppOnly()) return { sent: false, reason: 'offline_in_app_only' };
  const outreach = await VendorOutreach.findOne({ appointmentId: completion.appointmentId })
    .select("toEmail vendorNameSnapshot identityId")
    .lean();
  if (!outreach?.toEmail) return { sent: false, reason: "no_vendor_email" };

  // A shortfall is still owed and still "being processed" from the vendor's
  // side -- the arrears are the landlord's problem, not theirs.
  // A direct job has no payout entry: the landlord pays them, and the email says so.
  let payoutStatus = direct ? "pending_manual" : "pending";
  let clearsOn = null;
  const payoutEntryId = ledgerResult?.payout?.entry?._id;
  if (payoutEntryId) {
    const entry = await LedgerEntry.findById(payoutEntryId).select("providerStatus clearsOn").lean();
    if (entry?.providerStatus && entry.providerStatus !== "none") payoutStatus = entry.providerStatus;
    clearsOn = entry?.clearsOn || null;
  }
  // The part the landlord's balance didn't cover. The vendor is told it is
  // coming, not that it was sent.
  const awaitingAmount = ledgerResult?.deferred?.entry ? fromCents(ledgerResult.deferred.entry.amountCents) : 0;

  const [property, landlord] = await Promise.all([
    request.propertyId ? Property.findById(request.propertyId?._id || request.propertyId).select("address city").lean() : null,
    Landlord.findById(request.landlordId).select("firstName lastName companyName").lean(),
  ]);
  const hubUrl = `${String(env.app_public_url || "http://localhost:3000").replace(/\/+$/, "")}/vendor-hub`;
  const email = buildVendorJobCompleteEmail({
    vendorName: outreach.vendorNameSnapshot,
    category: request.category,
    city: formatCityLabel(resolveRequestCity({ property })) || null,
    amount,
    payoutStatus,
    clearsOn,
    awaitingAmount,
    hubUrl,
    managerLabel:
      landlord?.companyName ||
      [landlord?.firstName, landlord?.lastName].filter(Boolean).join(" ") ||
      "The property manager",
  });
  await sendEmail({ to: outreach.toEmail, ...email, categories: ["vendor_job_complete"] });

  // Kept meaningful: this is now the email that introduces the hub.
  if (outreach.identityId) {
    await VendorIdentity.updateOne(
      { _id: outreach.identityId, hubIntroSentAt: null },
      { $set: { hubIntroSentAt: new Date() } }
    ).catch(() => {});
  }
  return { sent: true, payoutStatus };
}


/**
 * Called from decideApprovalRequest when a landlord rules on an overage.
 * Approval resumes the close that step 1 held back; rejection sends the job to
 * disputed so the landlord can settle offline at an agreed figure.
 */
async function resolveCompletionOverage({
  completionId,
  decision,
  approvedAmount = null,
  actorUserId = null,
}) {
  const approved = decision === "approved";

  // The authorized figure has to be recorded HERE, on the completion. Writing
  // it only to request.quotaOverride — which is all decideApprovalRequest used
  // to do — is a dead end: resolveApprovedCeiling returns
  // completion.approvedCeiling first and never falls through to the quota, so
  // a modified approval changed nothing the invoice or the payout could see.
  const authorized = Number(approvedAmount);
  const hasAuthorized = Number.isFinite(authorized) && authorized > 0;

  const completion = await JobCompletion.findOneAndUpdate(
    { _id: completionId },
    {
      $set: {
        "overage.decision": approved ? "approved" : "rejected",
        "overage.resolvedAt": new Date(),
        ...(approved && hasAuthorized ? { "overage.approvedAmount": authorized } : {}),
        ...(approved ? {} : { status: "disputed" }),
      },
    },
    { new: true }
  );
  if (!completion) return null;

  if (!approved) {
    await Appointment.updateOne(
      { _id: completion.appointmentId },
      { $set: { status: "disputed" } }
    );
    await MaintenanceRequest.updateOne(
      { _id: completion.requestId },
      { $set: { appointmentStatus: "disputed" } }
    );
    await bumpVendorCompletionStats({ completion, outcome: "disputed" });
    return { closed: false, completion };
  }

  // Money settled. ONLY NOW is it worth asking about the evidence.
  //
  // submitCompletion used to raise both approvals at once, which put two
  // decisions on the manager in no defined order — and froze the pre-approval
  // ceiling into the review's payload, which is why the review card kept
  // quoting the old figure after the amount had been changed. Raising it here
  // means the review is built against a settled number.
  if (completion.status === "in_review") {
    const request = await MaintenanceRequest.findById(completion.requestId);
    if (request) {
      const vendor = completion.vendorId
        ? await Vendor.findById(completion.vendorId).select("name").lean()
        : null;
      await ensureCompletionReviewApproval({
        request,
        completion,
        vendorName: vendor?.name || null,
      });
      request.routingStatus = "approval_needed";
      await request.save();
    }
    return { closed: false, reason: "awaiting_evidence_review", completion };
  }

  return closeJobCompletion({
    completionId,
    reason: "review_approved",
    actorUserId,
  });
}

module.exports = {
  closeJobCompletion,
  sendVendorJobCompleteEmail,
  ensureCompletionReviewApproval,
  resolveCompletionReview,
  resolveCompletionOverage,
  ensureCompletionOverageApproval,
  // Shared with the vendor portal so submit and close ask the same question.
  isOverCeiling,
  bumpVendorCompletionStats,
  resolveApprovedCeiling,
  overageAllowance,
  TRAILING_DISPUTE_MS,
  OVERAGE_TOLERANCE_PCT,
  OVERAGE_TOLERANCE_MIN,
};
