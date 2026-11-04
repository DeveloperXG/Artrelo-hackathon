// Response-timeout sweeper and next-vendor fallback.
//
// Mirrors services/request/rejectedRequestCleanup.service.js — a plain
// setInterval started from server.js. There is no queue library in this repo and
// this does not warrant introducing one.
//
// Interval must stay <= 1 minute: the emergency SLA is 15 minutes and urgent is
// 20, so a coarser tick would blow through both.

const MaintenanceRequest = require("../../models/MaintenanceRequest");
const LandlordPolicy = require("../../models/LandlordPolicy");
const ApprovalRequest = require("../../models/ApprovalRequest");
const VendorOutreach = require("../../models/VendorOutreach");
const Vendor = require("../../models/Vendor");
const { logAgentAction } = require("../audit/agentAction.service");
const { notifyUser } = require("../notification/notify.service");
const { resolveMaxVendors } = require("./routingSetup.service");
const { evaluateAutopilot } = require("./autopilotPolicy.service");
const { screenCandidate } = require("./routingCheckpoint.service");
const { buildRequestContext, routableVendorFilter } = require("./vendorRecommendation.service");
const { evaluateHardConstraints } = require("./vendorScoring.service");
const { resolveOutreachTier } = require("./vendorOutreachPolicy.service");
const {
  cloneSnapshot,
  findLedgerEntry,
  getActiveCandidate,
  requeueCandidatesForNextRound,
  rebuildSnapshotSections,
} = require("./vendorSnapshot.service");
const {
  expiredCounterOfferFilter,
  expireCounterOffer,
} = require("./vendorCounterOffer.service");

const SWEEP_INTERVAL_MS = 60 * 1000;
// Matches the submit grace in vendorPortal.controller.js so a response that
// began just before the deadline is not swept out from under the vendor.
const GRACE_MS = 60 * 1000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
async function saveRouting(request) {
  await request.save();
  const { publish } = require("../realtime/liveEvents.service");
  const recipients = [request.landlordId, request.tenantId?._id || request.tenantId];
  publish(recipients, `request:${request._id}`); publish(recipients, "requests");
}

// Pure — exported so it can be unit-tested without Mongo, the same way
// expiredRejectedRequestFilter is.
const expiredOutreachFilter = (now = new Date()) => ({
  status: { $in: ["sent", "viewed"] },
  responseDeadlineAt: { $lte: new Date(now.getTime() - GRACE_MS) },
});

const DECLINE_REASON_LABELS = {
  timeout: "No response within the agreed window",
  declined: "Vendor declined",
  manager_dismissed: "Quote turned down",
  counter_offer_declined: "Vendor declined the authorized amount",
  counter_offer_timeout: "No answer to the authorized amount",
  // After a booking fell through (services/completion/appointmentFailure).
  no_show: "Vendor didn't show up",
  tenant_unconfirmed: "Tenant didn't confirm the arrival time",
  // The manager moved on after the email never reached the vendor.
  delivery_failed: "Email couldn't be delivered",
};

// Reasons whose detail text lives on counterOffer, not response. A counter-offer
// decline records response.outcome === "accepted" (they DID accept the job), so
// reading response.declineReason there yields null and the manager loses the why.
const COUNTER_OFFER_REASONS = new Set(["counter_offer_declined", "counter_offer_timeout"]);

// Retires the current candidate so getActiveCandidate frees up and the next
// activateCandidateState can succeed. Deliberately reuses `excluded` rather than
// adding a new ledger state — nothing downstream needs to distinguish them.
function retireCandidate(snapshot, candidateKey, reason, detail) {
  const entry = findLedgerEntry(snapshot, candidateKey);
  if (!entry) return null;

  const label = DECLINE_REASON_LABELS[reason] || "Outreach closed";
  entry.state = "excluded";
  entry.displayGroup = "excluded";
  entry.humanReadableReasons = [
    ...(entry.humanReadableReasons || []),
    detail ? `${label}: ${detail}` : label,
  ];
  entry.holdReason = null;
  return entry;
}

// Everyone still queued who could be contacted next: not yet sent to, and with
// a usable email.
function contactableCandidates(snapshot) {
  const ledger = Array.isArray(snapshot?.candidateLedger) ? snapshot.candidateLedger : [];
  return ledger.filter(
    (entry) =>
      ["held", "recommended", "pending"].includes(entry.state) &&
      (entry.outreach?.status || "not_sent") === "not_sent" &&
      entry.contact?.hasEmail === true
  );
}

// Next-best queued candidate. applyHoldStateToRemainingCandidates already
// parked everyone else in `held` when the first vendor was approved, so the
// queue exists for free — just take the highest score with a usable email.
function pickNextCandidate(snapshot) {
  return (
    contactableCandidates(snapshot).sort(
      (left, right) => Number(right.score || 0) - Number(left.score || 0)
    )[0] || null
  );
}

// How a closed round reads in "X ____. Approve contacting Y next?"
const ROUND_OUTCOME_PHRASES = {
  timeout: "did not respond in time",
  no_show: "didn't show up",
  tenant_unconfirmed: "wasn't confirmed by the tenant in time",
  delivery_failed: "couldn't be emailed",
};

const NO_RESPONSE_REASONS = new Set(["timeout", "counter_offer_timeout"]);

async function bumpVendorFailureStats(outreach, reason) {
  if (!outreach.vendorId) return;
  // Neither is the vendor's failure: the tenant didn't confirm, or our email
  // never reached them. Don't count either against their record.
  if (["tenant_unconfirmed", "delivery_failed", "coordination_failed", "coordination_expired"].includes(reason)) return;
  if (reason === "no_show") {
    await Vendor.updateOne(
      { _id: outreach.vendorId },
      { $inc: { "responseStats.noShowCount": 1, failedJobs: 1 } }
    );
    return;
  }
  // Silence is silence, whichever round it happened in.
  const field = NO_RESPONSE_REASONS.has(reason)
    ? "responseStats.noResponseCount"
    : "responseStats.declinedRequests";
  await Vendor.updateOne(
    { _id: outreach.vendorId },
    { $inc: { "responseStats.totalRequests": 1, [field]: 1 } }
  );
}

/**
 * Retires a closed outreach and moves the request to the next queued vendor,
 * or pauses for manager attention when policy or the attempt cap says so.
 */
async function advanceOutreach({ outreach, reason = "timeout" }) {
  const request = await MaintenanceRequest.findById(outreach.requestId);
  if (!request) return null;
  if (["completed", "rejected", "cancelled"].includes(request.status)) return null;
  if (outreach.bookingVersion === 2) {
    const row = await require("../../models/BookingPreparation").findOne({ outreachId: outreach._id, active: true });
    if (row) await require("./bookingCoordination.service").closePreparation({ preparationId: row._id,
      revision: row.revision, reason, allowClosed: true });
    await VendorOutreach.updateOne({ _id: outreach._id, status: "accepted" },
      { $set: { status: "superseded" }, $unset: { tokenHash: 1 } });
  }

  const policy = (await LandlordPolicy.findOne({ landlordId: request.landlordId }).lean()) || {};
  // Not `Number(x) || 3`: that read a deliberate 0 as 3. A cap lowered to 0
  // mid-loop now pauses the request at the next round, as the policy says.
  const maxVendors = resolveMaxVendors(policy);
  const autoAdvance = policy.autoAdvanceOnVendorDecline !== false;

  await bumpVendorFailureStats(outreach, reason);

  const detail = COUNTER_OFFER_REASONS.has(reason)
    ? outreach.counterOffer?.declineReason || null
    : reason === "declined"
      ? outreach.response?.declineReason || null
      : null;

  const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
  if (!snapshot) return null;
  retireCandidate(snapshot, outreach.candidateKey, reason, detail);
  // The vendor just retired is no longer this request's selected vendor. Left
  // set, Generate refused forever with "a selected vendor candidate exists"
  // while the panel showed nobody -- the request could not move. Every branch
  // below saves the request, so this lands with whichever runs.
  if (request.selectedVendorId && String(request.selectedVendorId) === String(outreach.vendorId)) {
    request.selectedVendorId = null;
  }
  // Re-deal the rest of the queue so round N+1 looks exactly like a fresh
  // generation — top three in Recommended, the remainder in Eligible backup,
  // nobody stranded in `held` where activateCandidateState would refuse them.
  requeueCandidatesForNextRound(snapshot);

  // The policy behind this is shown to the manager as "Max vendors contacted
  // per request", so it has to count VENDORS. countDocuments counted outreach
  // ROWS, and a resend to a vendor who let the SLA lapse writes a second row
  // for the same candidateKey — quietly spending a slot of the budget on a
  // vendor already counted. Per-vendor resends stay capped by MAX_ATTEMPTS in
  // vendorOutreach.service.js, which is the separate and correct question.
  const vendorsContacted = (
    await VendorOutreach.distinct("candidateKey", { requestId: request._id })
  ).length;

  // The closed round, published on the snapshot so the manager UI can say what
  // just happened and what it is asking for next. Derived state on a derived
  // cache — every field here is rebuildable from the VendorOutreach rows and
  // the ledger, so it never becomes a source of truth.
  // The policy cap is a ceiling, not a promise: with 2 eligible vendors and a
  // cap of 3, the third never exists. Published so the panel can say
  // "vendor 2 of 2" instead of implying someone is still in line.
  const effectiveMaxVendors = Math.min(
    maxVendors,
    vendorsContacted + contactableCandidates(snapshot).length
  );

  const recordRound = (resolution, nextCandidate = null) => {
    snapshot.lastRound = {
      candidateKey: outreach.candidateKey,
      vendorName: outreach.vendorNameSnapshot,
      reason,
      reasonLabel: DECLINE_REASON_LABELS[reason] || "Outreach closed",
      detail,
      at: new Date().toISOString(),
      vendorsContacted,
      maxVendors,
      effectiveMaxVendors,
      resolution,
      nextCandidateKey: nextCandidate?.candidateKey || null,
      nextVendorName: nextCandidate?.name || null,
    };
  };

  await logAgentAction({
    requestId: request._id,
    landlordId: request.landlordId,
    actor: "system",
    actionType: reason === "timeout" ? "vendor_outreach_expired" : "vendor_outreach_closed",
    summary: `Outreach to ${outreach.vendorNameSnapshot} closed (${DECLINE_REASON_LABELS[reason] || reason})`,
    input: { outreachId: outreach._id.toString(), candidateKey: outreach.candidateKey, reason },
    output: { attempt: outreach.attempt },
  });

  // A 15-minute life-safety SLA should reach a human, not the next name on a
  // list. Emergency never auto-advances.
  if (outreach.tier === "emergency" || resolveOutreachTier(request) === "emergency") {
    recordRound("escalated");
    snapshot.approvalRequest = null;
    request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
    request.routingStatus = "approval_needed";
    await saveRouting(request);

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "system",
      actionType: "vendor_outreach_escalated",
      summary: `Emergency outreach to ${outreach.vendorNameSnapshot} closed without a booking — escalated for manager attention`,
      input: { outreachId: outreach._id.toString(), reason },
      output: { tier: outreach.tier },
    });
    // "Escalated" meant an audit row and nothing else: no one was told. This is
    // an emergency with no vendor booked, so it is emailed as one.
    await notifyUser({
      userId: request.landlordId,
      type: "vendor_outreach_exhausted",
      title: `No vendor booked for an emergency: ${request.issueTitle || "a request"}`,
      message: `${outreach.vendorNameSnapshot} ${ROUND_OUTCOME_PHRASES[reason] || "didn't take the job"}. Choose another vendor or call one directly.`,
      metadata: { workOrderId: String(request._id), priority: "emergency" },
    });
    return { escalated: true };
  }

  const next = pickNextCandidate(snapshot);

  if (!next || vendorsContacted >= maxVendors) {
    recordRound("exhausted", next);
    snapshot.approvalRequest = null;
    request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
    request.routingStatus = "paused";
    await saveRouting(request);

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "system",
      actionType: "vendor_outreach_exhausted",
      summary: next
        ? `Contacted the maximum of ${maxVendors} vendor(s) for this request — paused for manual assignment`
        : "No further eligible vendors with an email address — request paused for manual assignment",
      input: { outreachId: outreach._id.toString(), vendorsContacted, maxVendors },
      output: { hasNextCandidate: Boolean(next) },
    });
    await notifyUser({
      userId: request.landlordId,
      type: "vendor_outreach_exhausted",
      title: `No vendor took "${request.issueTitle || "a request"}"`,
      message: next
        ? `Artrelo contacted ${maxVendors} vendor${maxVendors === 1 ? "" : "s"}, the most you allow, and none took the job. Choose who to contact next.`
        : "Every vendor who can take this job has been contacted. Add a vendor, or choose one by hand.",
      metadata: { workOrderId: String(request._id) },
    });
    return { exhausted: true };
  }

  // The first vendor's permission is not permission for every replacement.
  // Read the roster again: trust, contact details and eligibility may have changed.
  const liveVendor = autoAdvance && next.vendorId
    ? await Vendor.findOne({ ...routableVendorFilter(request.landlordId), _id: next.vendorId }).lean() : null;
  const screening = screenCandidate({ request, policy, previousSnapshot: snapshot,
    candidate: { ...(liveVendor || next), candidateKey: next.candidateKey }, priceEstimate: next.priceEstimate,
    vendorTypeNeeded: request.vendorTypeNeeded || snapshot.requestSnapshot?.vendorTypeNeeded,
    eligibleCount: contactableCandidates(snapshot).length, lowestEligibleCost: Number(next.priceEstimate?.amountHigh || 0) });
  snapshot.routingCheckpoints = screening.routingCheckpoints;
  const nextDecision = screening.decision;
  const gate = evaluateAutopilot({ request, policy, candidate: next, decision: nextDecision, phase: "advance" });
  const eligible = liveVendor && evaluateHardConstraints(buildRequestContext(request,
    { address: snapshot.requestSnapshot?.propertyAddress }, request.unitId, policy), liveVendor).eligible;
  let billingAllowed = true;
  try { await require("../billing/billingAccount.service").bookingSnapshot({ landlordId: request.landlordId, request }); }
  catch (error) {
    if (!error.code?.startsWith("billing_")) throw error;
    billingAllowed = false; gate.managerSummary = error.message;
  }
  const canAutoSend = billingAllowed && autoAdvance && gate.allowed && eligible && Boolean(liveVendor.email);

  if (!canAutoSend) {
    // Ask before contacting the next vendor. vendor_contact_approval already
    // exists in the ApprovalRequest enum — no new type is warranted.
    //
    // Created BEFORE the save so the snapshot below can carry its id. The UI
    // reads the outstanding decision off snapshot.approvalRequest, and leaving
    // the first round's already-resolved approval sitting there is what made
    // the routing panel report an approval that had long since been granted.
    const approval = await ApprovalRequest.create({
      requestId: request._id,
      landlordId: request.landlordId,
      type: "vendor_contact_approval",
      status: "pending",
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      amountRequested: Number(next.priceEstimate?.amountHigh) > 0 ? Number(next.priceEstimate.amountHigh) : undefined,
      reason: `${outreach.vendorNameSnapshot} ${ROUND_OUTCOME_PHRASES[reason] || "declined"}. Approve contacting ${next.name} next? ${!eligible || !liveVendor?.email ? "Vendor availability or contact details need review." : gate.allowed ? "" : gate.managerSummary}`.trim(),
      payload: {
        source: "outreach_fallback",
        vendorName: next.name,
        candidateKey: next.candidateKey,
        requestId: request._id.toString(),
        previousOutreachId: outreach._id.toString(),
        draftMessage: next.draftMessage,
      },
    });

    snapshot.approvalRequest = {
      approvalRequestId: approval._id.toString(),
      type: approval.type,
      status: approval.status,
      candidateKey: next.candidateKey,
    };
    recordRound("awaiting_approval", next);

    request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
    request.routingStatus = "approval_needed";
    await saveRouting(request);

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "ai_agent",
      actionType: "vendor_outreach_reapproval_requested",
      summary: `Approval requested to contact ${next.name} after ${outreach.vendorNameSnapshot} ${reason}`,
      input: { candidateKey: next.candidateKey },
      output: { previousOutreachId: outreach._id.toString() },
    });

    return { awaitingApproval: true, nextCandidateKey: next.candidateKey };
  }

  // Auto-advance: promote the next candidate and send immediately.
  const nextEntry = findLedgerEntry(snapshot, next.candidateKey);
  nextEntry.state = "approved_for_contact";
  nextEntry.displayGroup = "active";
  nextEntry.holdReason = null;
  nextEntry.contactApproval = {
    status: "approved",
    approvedAt: new Date().toISOString(),
    approvedBy: null,
  };
  nextEntry.contact = { email: liveVendor.email, phone: liveVendor.phone || null, hasEmail: true };

  recordRound("auto_advanced", next);
  snapshot.approvalRequest = null;

  request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
  request.routingStatus = "routed";
  await saveRouting(request);

  // Required late to avoid a require cycle (vendorOutreach.service -> ... -> here).
  // eslint-disable-next-line global-require
  const { sendVendorOutreach } = require("./vendorOutreach.service");

  const fresh = await MaintenanceRequest.findById(request._id)
    .populate("propertyId", "name address")
    .populate("unitId", "unitNumber")
    .populate("tenantId", "firstName lastName email");
  if (!fresh || !["queued", "approved"].includes(fresh.status) || fresh.archivedAt || fresh.vendorId || fresh.selectedVendorId) return { superseded: true };

  try {
    await sendVendorOutreach({
      request: fresh,
      candidate: nextEntry,
      initiation: 'policy_auto_advance',
      draftMessage: nextEntry.draftMessage,
      attempt: 1,
    });
  } catch (err) {
    // A collision on { requestId, candidateKey, attempt } means another sweeper
    // instance already advanced this request — harmless, and exactly what the
    // unique index is there for.
    console.error("[advanceOutreach] send failed", err.message);
  }

  await logAgentAction({
    requestId: request._id,
    landlordId: request.landlordId,
    actor: "system",
    actionType: "vendor_outreach_advanced",
    summary: `Auto-advanced from ${outreach.vendorNameSnapshot} to ${next.name} after ${reason}`,
    input: { previousOutreachId: outreach._id.toString(), reason },
    output: { nextCandidateKey: next.candidateKey, nextVendor: next.name },
  });

  return { advanced: true, nextCandidateKey: next.candidateKey };
}

async function sweepVendorOutreach(now = new Date()) {
  const due = await VendorOutreach.find(expiredOutreachFilter(now)).select("_id").lean();
  if (!due.length) return 0;

  let processed = 0;
  for (const row of due) {
    // Atomic claim. The vendor's submit handler contends on the same conditional
    // update, so exactly one of {response lands, sweep expires} wins.
    const claimed = await VendorOutreach.findOneAndUpdate(
      { _id: row._id, status: { $in: ["sent", "viewed"] } },
      { $set: { status: "expired" }, $unset: { tokenHash: 1 } },
      { new: true }
    );
    if (!claimed) continue; // a response landed in the same tick

    try {
      await advanceOutreach({ outreach: claimed, reason: "timeout" });
      processed += 1;
    } catch (err) {
      console.error("[vendorOutreachSweeper] advance failed", err.message);
    }
  }

  if (processed) {
    console.log(`[vendorOutreachSweeper] expired ${processed} outreach attempt(s)`);
  }
  return processed;
}

/**
 * Second pass: counter-offers the vendor never answered.
 *
 * A disjoint claim from the pass above. That one matches status sent/viewed;
 * these rows sit at `accepted` with counterOffer.status "pending", so the two
 * can never contend for the same row — and a bug in one cannot expire the other.
 */
async function sweepCounterOffers(now = new Date()) {
  const due = await VendorOutreach.find(expiredCounterOfferFilter(now)).select("_id").lean();
  if (!due.length) return 0;

  let processed = 0;
  for (const row of due) {
    // The vendor's confirm/decline handler contends on the same
    // `counterOffer.status: "pending"` condition, so exactly one wins.
    const claimed = await expireCounterOffer(row._id);
    if (!claimed) continue; // an answer landed in the same tick

    try {
      await advanceOutreach({ outreach: claimed, reason: "counter_offer_timeout" });
      processed += 1;
    } catch (err) {
      console.error("[vendorOutreachSweeper] counter-offer advance failed", err.message);
    }
  }

  if (processed) {
    console.log(`[vendorOutreachSweeper] expired ${processed} counter-offer(s)`);
  }
  return processed;
}

/**
 * Third pass: deliver outreach that was scheduled for the vendor's opening.
 *
 * Approve contact on a Standard/Low job while the vendor is closed creates the
 * row as `scheduled` (see sendVendorOutreach). Its time has come when
 * scheduledFor passes; the claim flips scheduled -> queued atomically so two
 * sweeper instances can't both send.
 *
 * Re-checked before sending, because days can pass: a request cancelled or
 * rejected in the meantime, or a candidate no longer the active one, is
 * revoked instead of emailed.
 */
async function releaseScheduledOutreach(now = new Date()) {
  const due = await VendorOutreach.find({ status: "scheduled", scheduledFor: { $lte: now } })
    .select("_id")
    .lean();
  if (!due.length) return 0;

  // Required late to avoid a require cycle (vendorOutreach.service -> ... -> here).
  // eslint-disable-next-line global-require
  const { deliverOutreach, applyOutreachToSnapshot, buildOutreachLedgerPatch } = require("./vendorOutreach.service");

  let released = 0;
  for (const row of due) {
    const claimed = await VendorOutreach.findOneAndUpdate(
      { _id: row._id, status: "scheduled" },
      { $set: { status: "queued" } },
      { new: true }
    );
    if (!claimed) continue; // cancelled, or another instance took it

    try {
      const request = await MaintenanceRequest.findById(claimed.requestId)
        .populate("propertyId", "name address")
        .populate("unitId", "unitNumber")
        .populate("tenantId", "firstName lastName email");
      const entry = request ? findLedgerEntry(request.vendorRecommendationSnapshot, claimed.candidateKey) : null;
      const stillWanted =
        request &&
        !["completed", "rejected", "cancelled"].includes(request.status) &&
        entry?.state === "approved_for_contact";

      if (!stillWanted) {
        await VendorOutreach.updateOne(
          { _id: claimed._id },
          { $set: { status: "revoked" }, $unset: { tokenHash: 1 } }
        );
        if (request) {
          claimed.status = "revoked";
          await applyOutreachToSnapshot({
            requestId: request._id,
            candidateKey: claimed.candidateKey,
            patch: buildOutreachLedgerPatch(claimed),
          });
        }
        continue;
      }

      if (claimed.bookingVersion === 2) {
        // Approval may have been granted days ago. A removed/blocked roster
        // vendor or a deliberately disabled cap must not receive that old send.
        const policy = await LandlordPolicy.findOne({ landlordId: request.landlordId }).lean();
        const { loadPresetCandidates } = require("./vendorRecommendation.service");
        const candidate = (await loadPresetCandidates({ request })).find(item => String(item.vendorId) === String(claimed.vendorId));
        const eligible = candidate?.email && resolveMaxVendors(policy) > 0 &&
          evaluateHardConstraints(buildRequestContext(request, request.propertyId, null, policy), candidate).eligible;
        if (!eligible) {
          claimed.status = "delivery_failed";
          claimed.deliveryError = "Scheduled contact paused: review the vendor profile and vendor contact cap before retrying.";
          await claimed.save();
          await applyOutreachToSnapshot({ requestId: request._id, candidateKey: claimed.candidateKey,
            patch: buildOutreachLedgerPatch(claimed) });
          await notifyUser({ userId: request.landlordId, type: "vendor_outreach_exhausted",
            title: "Scheduled vendor contact needs review", message: claimed.deliveryError,
            metadata: { workOrderId: String(request._id) } });
          continue;
        }
        claimed.toEmail = candidate.email;
      }

      await deliverOutreach({ outreach: claimed, request, candidate: entry, now });
      released += 1;
    } catch (err) {
      if (err.code?.startsWith("billing_")) {
        claimed.status = "scheduled"; claimed.scheduledFor = new Date(now.getTime() + 300_000); claimed.deliveryError = err.message;
        await claimed.save();
        await applyOutreachToSnapshot({ requestId: claimed.requestId, candidateKey: claimed.candidateKey, patch: buildOutreachLedgerPatch(claimed) });
        continue;
      }
      console.error("[vendorOutreachSweeper] scheduled release failed", err.message);
    }
  }

  if (released) {
    console.log(`[vendorOutreachSweeper] delivered ${released} scheduled outreach(es)`);
  }
  return released;
}

function startVendorOutreachSweeper(intervalMs = SWEEP_INTERVAL_MS) {
  const run = () => {
    sweepVendorOutreach().catch((err) => {
      console.error("[vendorOutreachSweeper] run failed", err);
    });
    releaseScheduledOutreach().catch((err) => {
      console.error("[vendorOutreachSweeper] scheduled release failed", err);
    });
    sweepCounterOffers().catch((err) => {
      console.error("[vendorOutreachSweeper] counter-offer run failed", err);
    });
    // Job-link retries and the arrival reminder ride this 60s tick rather than
    // the completion sweeper's 5 min, so "about an hour before" means 59-60
    // minutes, not 55. Required lazily, because vendorAcceptance pulls in the
    // outreach services this file is loaded alongside.
    const acceptance = require("./vendorAcceptance.service");
    acceptance.sweepVendorJobLinks().catch((err) => {
      console.error("[vendorOutreachSweeper] job-link run failed", err);
    });
    acceptance.sweepVendorArrivalReminders().catch((err) => {
      console.error("[vendorOutreachSweeper] arrival-reminder run failed", err);
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
  expiredOutreachFilter,
  sweepCounterOffers,
  releaseScheduledOutreach,
  pickNextCandidate,
  retireCandidate,
  advanceOutreach,
  sweepVendorOutreach,
  startVendorOutreachSweeper,
};
