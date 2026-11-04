// What happens after a vendor accepts a job.
//
// Under quota  -> create the Appointment, notify the tenant, done. The manager
//                 sees a completed step, not a task.
// Over quota   -> raise a quota_increase ApprovalRequest and hold. The
//                 Appointment is created when the manager approves it, which
//                 re-enters this module via decideApprovalRequest.
//
// finalizeVendorAcceptance is therefore called from two places and must be
// idempotent — see the appointmentId claim at the bottom.

const env = require("../../config/env");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const LandlordPolicy = require("../../models/LandlordPolicy");
const ApprovalRequest = require("../../models/ApprovalRequest");
const Appointment = require("../../models/Appointment");
const VendorOutreach = require("../../models/VendorOutreach");
const Vendor = require("../../models/Vendor");
const Unit = require("../../models/Unit");
const Landlord = require("../../models/Landlord");
const Property = require("../../models/Property");
const { notifyUser } = require("../notification/notify.service");
const { logAgentAction } = require("../audit/agentAction.service");
const { resolveQuotaLimit } = require("./routingDecision.service");
const { currentQuote } = require("../quotes/currentQuote.service");
const { claimQuoteCheckpoint, passedLegacyCheck } = require("../quotes/quoteCheckpoint.service");
const {
  applyQuotaLimitToSnapshot,
  cloneSnapshot,
  findLedgerEntry,
  rebuildSnapshotSections,
} = require("./vendorSnapshot.service");
const { resolveBookedAmount } = require("./vendorCounterOffer.service");
const { buildOutreachLedgerPatch, applyOutreachToSnapshot } = require("./vendorOutreach.service");
const { mintJobToken, rotateJobToken, buildJobUrl } = require("./jobToken.service");
const { openProxySession } = require("../comms/proxySession.service");
const { createHold } = require("../ledger/ledger.service");
const { loadLandlordPaymentMode, isDirectAppointment } = require("../ledger/paymentMode");
const { warnIfLowBalance } = require("../ledger/lowBalance.service");
const { planTenantConfirmation } = require("../completion/appointmentFailure.service");
const { toCents } = require("../ledger/money");
const { sendEmail } = require("../notification/email.service");
const {
  buildVendorAcceptedEmail,
  buildVendorArrivalReminderEmail,
} = require("../notification/templates/vendorLifecycleEmail");
const { buildVendorJobLinkEmail } = require("../notification/templates/vendorJobLinkEmail");
const { resolveRequestCity, formatCityLabel } = require("./vendorScoring.service");

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const roundUpTo25 = (amount) => Math.ceil(Number(amount || 0) / 25) * 25;

// "Thu, Jul 30 at 9:30 a.m. (about 2h on site)" — the precise commitment the
// tenant is being asked to confirm, not the broad window.
function formatArrivalLabel(arrival, durationMinutes, timeZone = env.outreach_timezone) {
  const when = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(arrival));

  const minutes = Number(durationMinutes) || 0;
  if (!minutes) return when;
  const duration = minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10}h` : `${minutes} min`;
  return `${when} (about ${duration} on site)`;
}

function evaluateQuoteAgainstQuota({ request, policy, outreach }) {
  const limit = resolveQuotaLimit(policy || {}, request || {});
  // Compare the HIGH end — the conservative read of a range quote.
  const quoteHigh = Number(currentQuote(outreach).high || 0);
  return {
    limit,
    quoteHigh,
    // No quota set: every quote needs the manager's say-so. Written out rather
    // than left to `quoteHigh > null`, which JavaScript reads as `> 0` and
    // which happens to agree only by accident.
    overQuota: limit === null ? true : quoteHigh > limit,
    evaluatedAt: new Date(),
  };
}

/** "$300", or the honest words when there is no limit. */
const describeLimit = (limit) => (limit === null || limit === undefined ? "no spending quota set" : `$${limit}`);

// Narrow, vendor-quote-specific approval. Deliberately NOT
// ensureApprovalRequestForSnapshot — that one derives its payload from
// snapshot.decision and would produce the wrong shape here.
async function ensureQuotaApprovalForVendorQuote({ request, outreach, quotaCheck }) {
  const existing = await ApprovalRequest.findOne({
    requestId: request._id,
    landlordId: request.landlordId,
    type: "quota_increase",
    status: "pending",
    "payload.source": "vendor_quote",
    "payload.outreachId": outreach._id.toString(),
  });

  const approval =
    existing ||
    new ApprovalRequest({
      requestId: request._id,
      landlordId: request.landlordId,
      type: "quota_increase",
    });

  const quote = currentQuote(outreach);
  const low = quote.low ?? 0;
  const high = quote.high ?? 0;

  approval.type = "quota_increase";
  approval.status = "pending";
  approval.decidedAt = undefined;
  approval.expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  approval.amountRequested = high;
  approval.reason =
    quotaCheck.limit === null
      ? `${outreach.vendorNameSnapshot} quoted $${low}–$${high}. You haven't set a spending quota, so every quote needs your approval.`
      : `${outreach.vendorNameSnapshot} quoted $${low}–$${high}; your limit for this request is $${quotaCheck.limit}.`;
  approval.payload = {
    // The discriminator decideApprovalRequest branches on so it does NOT
    // regenerate the recommendation snapshot and destroy outreach state.
    source: "vendor_quote",
    ...(quote.snapshot ? { quoteRevision: quote.revision, quoteHash: quote.hash } : {}),
    outreachId: outreach._id.toString(),
    candidateKey: outreach.candidateKey,
    requestId: request._id.toString(),
    vendorName: outreach.vendorNameSnapshot,
    quota: {
      limit: quotaCheck.limit,
      quotedAmount: high,
      quotedLow: low,
      suggestedQuota: roundUpTo25(high),
      basis: "vendor_quote",
    },
    selectedWindow: outreach.response?.selectedWindow || null,
    quoteNotes: outreach.response?.quoteNotes || null,
  };

  await approval.save();
  return approval;
}

// Promotes the candidate to `selected` in the snapshot ledger.
async function markCandidateSelected({ request, outreach }) {
  if (!request.vendorRecommendationSnapshot) return null;
  const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
  const entry = findLedgerEntry(snapshot, outreach.candidateKey);
  if (!entry) return null;

  entry.state = "selected";
  entry.displayGroup = "active";
  entry.manualSelection = {
    ...(entry.manualSelection || {}),
    status: "selected",
    selectedAt: new Date().toISOString(),
    selectedBy: null,
    selectionMethod: "vendor_accepted",
    overrideReason: null,
    overriddenConstraints: [],
  };
  entry.outreach = { ...(entry.outreach || {}), ...buildOutreachLedgerPatch(outreach) };

  request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
  return entry;
}

async function bumpVendorAcceptanceStats(outreach) {
  if (!outreach.vendorId) return;
  const responseMinutes =
    outreach.sentAt && outreach.respondedAt
      ? Math.max(0, Math.round((outreach.respondedAt - outreach.sentAt) / 60000))
      : null;

  const vendor = await Vendor.findById(outreach.vendorId).select("responseStats");
  if (!vendor) return;

  const stats = vendor.responseStats || {};
  const previousTotal = Number(stats.totalRequests || 0);
  const previousAvg = Number(stats.averageFirstResponseMinutes || 0);
  const nextAvg =
    responseMinutes === null
      ? previousAvg
      : Math.round((previousAvg * previousTotal + responseMinutes) / (previousTotal + 1));

  await Vendor.updateOne(
    { _id: outreach.vendorId },
    {
      $inc: { "responseStats.totalRequests": 1, "responseStats.acceptedRequests": 1 },
      $set: { "responseStats.averageFirstResponseMinutes": nextAvg, lastUsedAt: new Date() },
    }
  );
}

/**
 * The single place a vendor acceptance turns into a booked appointment.
 *
 * Three callers re-enter it: the vendor's accept on the portal, a manager
 * authorizing an over-quota quote, and a vendor confirming a counter-offer. It
 * takes no "already approved" flag — whether the job may book is derived from
 * the outreach itself every time, so no caller can assert its way past the gate.
 *
 * Safe to call repeatedly: the appointmentId claim below makes appointment
 * creation idempotent, and it is now load-bearing for all three paths.
 */
async function finalizeVendorAcceptance({ outreachId, actorUserId = null }) {
  const outreach = await VendorOutreach.findById(outreachId);
  if (!outreach || outreach.status !== "accepted") return null;
  if (outreach.appointmentId) {
    if (outreach.bookingVersion === 2) {
      const preparation = await require("../../models/BookingPreparation").findOne({ outreachId: outreach._id });
      if (preparation) await require("./bookingPreparation.service").ensureBookingCredentials(preparation);
      return { alreadyFinalized: true, outreach, preparation, appointment: await Appointment.findById(outreach.appointmentId) };
    }
    return { alreadyFinalized: true, outreach };
  }
  // New contracts wait for their exact revision's review barrier. Legacy offers
  // keep the existing path; a stale result must not authorize a revised quote.
  if (outreach.quoteContractVersion === 2) {
    const quote = outreach.quoteRevisions?.find(row => row.revision === outreach.currentQuoteRevision);
    if (!quote || outreach.quoteReview?.state !== "cleared" || outreach.quoteReview.quoteHash !== quote.hash) {
      return { outreach, awaitingCostReview: true, appointment: null };
    }
  }

  let request = await MaintenanceRequest.findById(outreach.requestId);
  if (!request) return null;
  // The offer round closes in minutes, but a counter-offer round runs for days,
  // so this function can now re-enter long after the request moved on. Booking an
  // appointment onto a cancelled request is not a hypothetical here.
  if (["completed", "rejected", "cancelled"].includes(request.status)) {
    return { outreach, closed: true, appointment: null };
  }
  if (outreach.bookingVersion === 2) {
    const { ensurePreparation } = require("./bookingPreparation.service");
    const preparation = await ensurePreparation({ outreach, request });
    if (!preparation.active) return { outreach, closed: true, appointment: null };
  }

  const policy = await LandlordPolicy.findOne({ landlordId: request.landlordId }).lean();
  const legacyPassed = passedLegacyCheck(outreach);
  const checkpoint = outreach.quoteContractVersion === 2
    ? await claimQuoteCheckpoint({ outreachId: outreach._id, landlordId: request.landlordId }) : null;
  if (checkpoint && (checkpoint.record.quoteRevision !== outreach.currentQuoteRevision ||
      checkpoint.record.quoteHash !== outreach.quoteReview?.quoteHash)) return { outreach, awaitingCostReview: true, appointment: null };
  const quotaCheck = checkpoint?.quotaCheck || legacyPassed || evaluateQuoteAgainstQuota({ request, policy, outreach });

  outreach.quotaCheck = quotaCheck;
  if (checkpoint) {
    const checked = await VendorOutreach.updateOne({ _id: outreach._id, status: "accepted", appointmentId: null,
      currentQuoteRevision: checkpoint.record.quoteRevision, "quoteReview.state": "cleared",
      "quoteReview.quoteHash": checkpoint.record.quoteHash },
    { $set: { quotaCheck, quoteCheckpointId: checkpoint.record._id } });
    if (!checked.matchedCount) return { outreach, awaitingCostReview: true, appointment: null };
  } else await outreach.save();

  await logAgentAction({
    requestId: request._id,
    landlordId: request.landlordId,
    actor: "system",
    actionType: "vendor_quote_recorded",
    summary: `${outreach.vendorNameSnapshot} quoted $${currentQuote(outreach).low}–$${currentQuote(outreach).high} (limit: ${describeLimit(quotaCheck.limit)})`,
    input: { outreachId: outreach._id.toString(), candidateKey: outreach.candidateKey },
    output: quotaCheck,
  });

  /* -- The booking gate. ----------------------------------------------------
   *
   * There is deliberately no `quotaApproved` bypass any more. It let a manager
   * authorize $200 against a $900 quote and still book at $900, because the flag
   * skipped this check entirely rather than comparing anything.
   *
   * The gate is now self-correcting: resolveQuotaLimit reads request.quotaOverride
   * first, and the override is promoted ONLY when someone has actually committed
   * to a number, so `overQuota` tells the truth on every re-entry.
   */
  const counterOfferStatus = outreach.counterOffer?.status || "none";

  // Waiting on the vendor to answer an authorized amount. Not a failure, and
  // emphatically not a booking — and no new approval, the manager already ruled.
  if (counterOfferStatus === "pending") {
    return { outreach, awaitingCounterOffer: true, appointment: null };
  }

  // The vendor said no, or said nothing, or the manager pulled it. advanceOutreach
  // has already moved on; this request is not theirs to book.
  if (["declined", "expired", "withdrawn"].includes(counterOfferStatus)) {
    return { outreach, closed: true, appointment: null };
  }

  const authorizedCeiling = Number(outreach.authorizedCeiling);
  const hasCeiling = (Number.isFinite(authorizedCeiling) && authorizedCeiling > 0) ||
    (outreach.negotiatedProposal?.start && quotaCheck.quoteHigh === outreach.negotiatedProposal.amountCents / 100);

  // Both arms below should be unreachable — the API refuses a below-floor
  // authorization and decideApprovalRequest owns the mid-range case by raising a
  // counter-offer. They exist because this is precisely where a silent
  // fallthrough books at a price nobody agreed to, so it must never be an `else`.
  if (counterOfferStatus === "none" && quotaCheck.overQuota && hasCeiling) {
    if (authorizedCeiling < quotaCheck.quoteHigh) {
      console.error(
        `[finalizeVendorAcceptance] refusing to book ${outreach._id}: authorized $${authorizedCeiling} is below the quoted $${quotaCheck.quoteHigh} and no counter-offer was confirmed`
      );
      return {
        outreach,
        needsCounterOffer: true,
        ceiling: authorizedCeiling,
        appointment: null,
      };
    }
  }

  // Over quota with nothing authorized yet: stop here and ask.
  if (quotaCheck.overQuota && !hasCeiling && counterOfferStatus === "none") {
    const approval = await ensureQuotaApprovalForVendorQuote({ request, outreach, quotaCheck });
    if (outreach.bookingVersion === 2) {
      const preparationService = require("./bookingPreparation.service");
      const preparation = await preparationService.ensurePreparation({ outreach, request });
      await preparationService.setPhase(preparation, "awaiting_approval", { reasonCode: "quote_approval_required" });
    }
    outreach.approvalRequestId = approval._id;
    await outreach.save();

    request.routingStatus = "approval_needed";
    await request.save();

    // MUST come after the save above. applyOutreachToSnapshot reloads the request
    // and saves it, so writing our stale in-memory copy afterwards would clobber
    // the ledger patch it just made.
    //
    // Without this the ledger never learns quotaCheck.overQuota, so the landlord's
    // request page falls through to the plain `accepted` case and paints a green
    // "Vendor accepted — booking" over a request that is actually parked waiting
    // on this approval. The under-quota path patches the ledger via
    // markCandidateSelected; this branch returns before reaching it.
    await applyOutreachToSnapshot({
      requestId: request._id,
      candidateKey: outreach.candidateKey,
      patch: buildOutreachLedgerPatch(outreach),
    });

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "system",
      actionType: "vendor_quote_over_quota",
      summary:
        quotaCheck.limit === null
          ? `Quote from ${outreach.vendorNameSnapshot} needs approval — no spending quota set`
          : `Quote from ${outreach.vendorNameSnapshot} exceeds the $${quotaCheck.limit} limit — manager approval requested`,
      input: { outreachId: outreach._id.toString() },
      output: { approvalRequestId: approval._id.toString(), suggestedQuota: roundUpTo25(quotaCheck.quoteHigh) },
    });

    return { outreach, approval, appointment: null, overQuota: true };
  }

  // --- Cleared to book. ---

  if (outreach.bookingVersion !== 2) await markCandidateSelected({ request, outreach });

  // A ceiling is a ceiling, not a price: authorizing $400 against a $180–$320
  // quote still books at $320. Only a CONFIRMED counter-offer books at the
  // authorized figure, because that is the number the vendor negotiated to.
  const bookedAmount = resolveBookedAmount(outreach);
  if (outreach.quoteContractVersion === 2 && (outreach.approvedQuoteSnapshot?.revision !== outreach.currentQuoteRevision ||
      outreach.approvedQuoteSnapshot?.hash !== outreach.quoteReview.quoteHash)) {
    const approvedQuoteSnapshot = outreach.quoteRevisions.find(row => row.revision === outreach.currentQuoteRevision);
    const frozen = await VendorOutreach.updateOne({ _id: outreach._id, status: "accepted", appointmentId: null,
      currentQuoteRevision: outreach.currentQuoteRevision, "quoteReview.state": "cleared",
      "quoteReview.quoteHash": approvedQuoteSnapshot.hash }, { $set: { approvedQuoteSnapshot } });
    if (!frozen.matchedCount) return { outreach, awaitingCostReview: true, appointment: null };
    outreach.approvedQuoteSnapshot = approvedQuoteSnapshot;
  }

  if (counterOfferStatus === "confirmed") {
    // Promote the authorization to the request only now, once the vendor has
    // actually committed. Raising quotaOverride at authorization time would also
    // have silently authorized whatever vendor came next if this one fell through.
    request.quotaOverride = bookedAmount;
    request.quotaSnapshot = { limit: bookedAmount, generatedAt: new Date().toISOString() };
    // Keep the snapshot's decision block agreeing with the override; we skip
    // regeneration here on purpose, so it has to be corrected in place.
    if (request.vendorRecommendationSnapshot) {
      request.vendorRecommendationSnapshot = applyQuotaLimitToSnapshot(
        request.vendorRecommendationSnapshot,
        bookedAmount
      );
    }
  }

  const unit = request.unitId ? await Unit.findById(request.unitId).select("unitNumber").lean() : null;
  const selectedWindow = outreach.response?.selectedWindow || null;

  // The vendor committed to a precise arrival time inside their chosen window,
  // so the appointment carries real instants rather than a label. `proposedWindows`
  // keeps the window text purely as human context.
  const arrival = outreach.response?.scheduledArrivalAt || null;
  const durationMinutes = Number(outreach.response?.durationMinutes) || 120;
  const confirmedEnd = arrival
    ? new Date(new Date(arrival).getTime() + durationMinutes * 60 * 1000)
    : null;

  // Which rail this job settles on, fixed now. A landlord switched to (or off)
  // platform payouts later does not move a job already booked.
  const paymentMode = await loadLandlordPaymentMode(request.landlordId);

  const appointmentFields = {
    requestId: request._id,
    vendorId: outreach.vendorId || undefined,
    vendorNameSnapshot: outreach.vendorNameSnapshot || undefined,
    tenantId: request.tenantId,
    landlordId: request.landlordId,
    proposedWindows: selectedWindow?.label ? [selectedWindow.label] : [],
    confirmedStart: arrival || undefined,
    confirmedEnd: confirmedEnd || undefined,
    // NOT "scheduled": per the MVP rules an appointment is only booked once
    // vendor time + tenant access + quota approval all line up. The tenant has
    // not confirmed access yet.
    status: "awaiting_tenant",
    // The tenant has until the earlier of 48h and an hour before arrival; then
    // the manager is asked to confirm for them or find another vendor
    // (completion/appointmentFailure). An arrival that already passed while a
    // counter-offer or quota approval was pending goes to the manager at once.
    ...planTenantConfirmation({ now: new Date(), arrival }),
    accessNotes: request.preferredTime || "",
    vendorConfirmation: {
      accepted: true,
      respondedAt: outreach.respondedAt,
      note: outreach.response?.quoteNotes || "",
    },
    paymentMode,
    serviceBilling: outreach.bookingVersion === 2 ? undefined : await require("../billing/billingAccount.service").bookingSnapshot({ landlordId: request.landlordId, request }),
  };
  let appointment;
  let claimed;
  if (outreach.bookingVersion === 2) {
    const { prepareAcceptedBooking } = require("./bookingPreparation.service");
    const prepared = await prepareAcceptedBooking({ outreach, request, bookedAmount, appointmentFields });
    if (!prepared.appointment || prepared.alreadyFinalized) return prepared;
    await require("./bookingPreparation.service").ensureBookingCredentials(prepared.preparation).catch(error =>
      console.error("[bookingPreparation] credential recovery needed", error.code || "credential_error"));
    return { ...prepared, overQuota: false };
  } else {
    appointment = await Appointment.create(appointmentFields);

  // Idempotency claim: only the first caller gets to own the appointment.
  claimed = await VendorOutreach.findOneAndUpdate(
    { _id: outreach._id, appointmentId: null },
    { $set: { appointmentId: appointment._id } },
    { new: true }
  );

  if (!claimed) {
    // Another call won the race — drop the duplicate we just made.
    await Appointment.deleteOne({ _id: appointment._id });
    return { alreadyFinalized: true, outreach };
  }
  }

  // The job-scoped credential. Minted here, in the region only the appointment
  // claim winner reaches, so re-entry after a quota approval cannot issue a
  // second live link for one job. Non-fatal: the vendor's acceptance is already
  // durably recorded, and a token failure must not undo a booked appointment.
  //
  // NO EMAIL IS SENT HERE. The appointment is `awaiting_tenant` at this point,
  // and jobToken.middleware admits only `scheduled`/`work_verifying` — so a
  // "you're booked" email sent now hands the vendor a link that 404s for the
  // entire window, on top of claiming something that is not true yet. The
  // vendor is told once the tenant confirms, by sendVendorBookingConfirmation.
  try {
    await mintJobToken({
      outreachId: outreach._id,
      requestId: request._id,
      appointmentId: appointment._id,
      landlordId: request.landlordId,
      identityId: outreach.identityId || null,
      vendorId: outreach.vendorId || null,
      vendorNameSnapshot: outreach.vendorNameSnapshot,
    });
  } catch (err) {
    console.error("[finalizeVendorAcceptance] job token mint failed", err.message);
  }

  // Open the masked SMS channel. Alongside the job-token mint on purpose: both
  // are the credentials a vendor needs to actually do the job, and both are
  // scoped to exactly this appointment.
  //
  // FAIL-SOFT, and non-fatal like everything else in this region. The vendor
  // has already committed an arrival time and the escrow hold is placed;
  // refusing to book because a number pool is full would let a Twilio
  // subscription tier decide whether a plumber gets hired. When it fails, the
  // relay projection keeps rendering the honest gap it renders today and the
  // property manager relays — which is exactly the status quo, not a
  // regression.
  //
  // Idempotent under the quota-approval re-entry this whole function has to
  // survive: openProxySession claims on a unique partial index over open rows
  // keyed by appointmentId, so a second pass returns the first session rather
  // than burning a second number on the same job.
  //
  // Skipped outright while the relay is switched off (RELAY_SMS_ENABLED):
  // openProxySession would only return sms_disabled, and logging that on every
  // acceptance is noise for a feature that is deliberately dormant.
  try {
    if (env.relay_sms_enabled) {
      const relay = await openProxySession({
        requestId: request._id,
        appointmentId: appointment._id,
        tenantId: request.tenantId,
        identityId: outreach.identityId || null,
        vendorId: outreach.vendorId || null,
        landlordId: request.landlordId,
        outreachId: outreach._id,
        vendorNameSnapshot: outreach.vendorNameSnapshot,
      });
      if (!relay.opened && relay.reason && relay.reason !== "already_open") {
        // Named rather than generic: no_vendor_phone is a data gap on one
        // vendor, and pool_exhausted means buy more numbers. Two different
        // jobs for two different people.
        console.log(
          `[finalizeVendorAcceptance] no relay channel for appointment ${appointment._id}: ${relay.reason}`
        );
      }
    }
  } catch (err) {
    console.error("[finalizeVendorAcceptance] relay session failed", err.message);
  }

  // Tell the vendor where things stand: accepted, waiting on the tenant, and
  // nothing for them to do yet. NO link -- the job page doesn't open until the
  // tenant confirms, and that's when sendVendorBookingConfirmation brings it.
  //
  // This replaces the hub introduction that used to go out here on a first
  // acceptance: a "see all your jobs" link to a list holding one job the vendor
  // couldn't open yet. The hub is introduced when a job completes instead
  // (jobCompletion.sendVendorJobCompleteEmail), where past jobs and payouts
  // mean something.
  //
  // In the region only the appointment-claim winner reaches, so a re-entry
  // after a quota approval can't send it twice. Non-fatal like the rest.
  try {
    if (outreach.toEmail) {
      const [property, landlord] = await Promise.all([
        request.propertyId ? Property.findById(request.propertyId?._id || request.propertyId).select("address city").lean() : null,
        Landlord.findById(request.landlordId).select("firstName lastName companyName").lean(),
      ]);
      const email = buildVendorAcceptedEmail({
        vendorName: outreach.vendorNameSnapshot,
        category: request.category,
        city: formatCityLabel(resolveRequestCity({ property })) || null,
        scheduledArrivalAt: arrival,
        timeZone: env.outreach_timezone,
        managerLabel:
          landlord?.companyName ||
          [landlord?.firstName, landlord?.lastName].filter(Boolean).join(" ") ||
          "The property manager",
      });
      await sendEmail({ to: outreach.toEmail, ...email, categories: ["vendor_accepted"] });
    }
  } catch (err) {
    console.error("[finalizeVendorAcceptance] accepted email failed", err.message);
  }

  if (outreach.bookingVersion !== 2) {
  request.selectedVendorId = outreach.vendorId || request.selectedVendorId;
  request.appointmentStatus = "awaiting_tenant";
  // The negotiated figure when there was one, the vendor's ceiling otherwise.
  // ensureDraftCompletion snapshots the same number, so the final invoice is
  // measured against what was actually agreed.
  request.estimatedCost = bookedAmount || request.estimatedCost;
  request.routingStatus = "routed";
  request.timeline.push({
    status: "assigned",
    note:
      counterOfferStatus === "confirmed"
        ? `Vendor accepted at the authorized $${bookedAmount}: ${outreach.vendorNameSnapshot}`
        : `Vendor accepted: ${outreach.vendorNameSnapshot}`,
    actorRole: "vendor",
    actorId: outreach.vendorId || undefined,
  });
  await request.save();
  }

  // Escrow the booked amount. Placed here, inside the region only the
  // appointment-claim WINNER reaches, so re-entry after a quota approval cannot
  // double-hold — and the over-quota path returns long before this, so a hold
  // and an appointment share one creation point for free.
  //
  // Deliberately non-fatal and deliberately non-blocking: the vendor has
  // already accepted, and cancelling on them because the wallet is light would
  // be both rude and pointless. createHold records a shortfall instead, which
  // is the whole reason to hold at acceptance rather than at release — it buys
  // days of warning before the money is actually needed.
  //
  // Not for a direct job: the landlord pays the vendor themselves, so there is
  // nothing to escrow and a "top up your balance" warning would be false.
  try {
    if (outreach.bookingVersion !== 2 && bookedAmount && !isDirectAppointment(appointment)) {
      const hold = await createHold({
        landlordId: request.landlordId,
        amountCents: toCents(bookedAmount),
        appointmentId: appointment._id,
        requestId: request._id,
        identityId: outreach.identityId || null,
        scope: { propertyId: request.propertyId || null, unitId: request.unitId || null, category: request.category || null },
        memo: `Held for ${outreach.vendorNameSnapshot}`,
      });
      if (hold.guardFailed) {
        await notifyUser({
          userId: request.landlordId,
          type: "payment_overdue",
          title: "Top up your maintenance balance",
          message: `$${bookedAmount} was booked for "${request.issueTitle}" but your balance couldn't cover it. Add funds before the job completes.`,
          metadata: { workOrderId: request._id.toString(), amount: bookedAmount },
        });
      } else {
        // The hold is when the balance actually drops. Warning here, rather
        // than only after the payout, is days of notice instead of none. A
        // shortfall above already has its own, more specific notice.
        await warnIfLowBalance({ landlordId: request.landlordId }).catch((err) =>
          console.error("[finalizeVendorAcceptance] low-balance check failed", err.message)
        );
      }
    }
  } catch (err) {
    console.error("[finalizeVendorAcceptance] hold failed", err.message);
  }

  await bumpVendorAcceptanceStats(outreach);

  // Tenant update. Vendor name + window only — the tenant must not see the
  // landlord's cost.
  try {
    await notifyUser({
      userId: request.tenantId,
      type: "maintenance_scheduled",
      title: "A vendor accepted your maintenance request",
      message: arrival
        ? `${outreach.vendorNameSnapshot} plans to arrive ${formatArrivalLabel(arrival, durationMinutes)}. Please confirm this works for you.`
        : `${outreach.vendorNameSnapshot} accepted your request. We'll confirm a time shortly.`,
      metadata: {
        workOrderId: request._id.toString(),
        appointmentId: appointment._id.toString(),
        priority: request.urgency,
      },
    });
  } catch (err) {
    console.error("[finalizeVendorAcceptance] tenant notify failed", err.message);
  }

  await logAgentAction({
    requestId: request._id,
    landlordId: request.landlordId,
    actor: "system",
    actionType: "vendor_appointment_created",
    summary: `Appointment created with ${outreach.vendorNameSnapshot}${
      selectedWindow?.label ? ` for ${selectedWindow.label}` : ""
    } — awaiting tenant confirmation`,
    input: {
      outreachId: outreach._id.toString(),
      counterOfferStatus,
      authorizedCeiling: hasCeiling ? authorizedCeiling : null,
    },
    output: {
      appointmentId: appointment._id.toString(),
      status: "awaiting_tenant",
      estimatedCost: request.estimatedCost,
      bookedAmount,
    },
  });

  return { outreach: claimed, appointment, overQuota: false, bookedAmount };
}

// The arrival reminder goes out this long before the vendor is due.
const ARRIVAL_REMINDER_LEAD_MS = 60 * 60 * 1000;
// How long a claimed job-link send may run before a later sweep may retry it.
const JOB_LINK_LEASE_MS = 5 * 60 * 1000;

function durationMinutesOf(appointment) {
  if (!appointment.confirmedStart || !appointment.confirmedEnd) return null;
  return Math.round(
    (new Date(appointment.confirmedEnd).getTime() - new Date(appointment.confirmedStart).getTime()) / 60000
  );
}

// The facts the booking emails share. Narrow lookups purely for the header
// and footer; a miss degrades the copy rather than the send.
async function loadBookingEmailContext(appointment) {
  const request = await MaintenanceRequest.findById(appointment.requestId)
    .select("issueTitle category propertyId")
    .lean();
  const [landlord, property] = await Promise.all([
    Landlord.findById(appointment.landlordId).select("firstName lastName companyName").lean(),
    request?.propertyId ? Property.findById(request.propertyId).select("address city").lean() : null,
  ]);
  const managerName = [landlord?.firstName, landlord?.lastName].filter(Boolean).join(" ");
  return {
    issueTitle: request?.issueTitle,
    category: request?.category || "Maintenance",
    city: formatCityLabel(resolveRequestCity({ property })) || "your service area",
    managerName,
    managerCompany: landlord?.companyName,
    managerLabel: landlord?.companyName || managerName || "The property manager",
    durationMinutes: durationMinutesOf(appointment),
  };
}

// Stub mode (no Resend key) "succeeds" without delivering; only a real
// provider rejection or transport fault is a failure worth retrying.
const emailFailed = (result) => !result || (!result.stub && !result.delivered);

/**
 * Tell the vendor the job is booked -- with the job link -- the moment the
 * tenant (or the manager for them) confirms the time.
 *
 * Deliberately NOT at acceptance: the appointment is then `awaiting_tenant`,
 * which jobToken.middleware refuses, so a link sent then would be dead.
 *
 * The link goes out NOW rather than shortly before the visit. Holding it back
 * was tried and reverted: it put the one email the vendor cannot work without
 * at the most time-critical moment (a late or spam-filtered send left them on
 * site unable to check in), arrived after a vendor with a long drive had left,
 * and protected nothing -- they saw the address when they accepted. The
 * day-of nudge is sweepVendorArrivalReminders, which carries no link.
 *
 * Idempotent via a conditional claim on `vendorBookingNotifiedAt`; the link
 * itself is at-least-once (sendVendorJobLink).
 *
 * Non-fatal by contract: the caller has already committed the confirmation,
 * and a mail outage must not roll that back.
 */
async function sendVendorBookingConfirmation({ appointmentId, now = new Date() }) {
  const appointment = await Appointment.findOneAndUpdate(
    { _id: appointmentId, status: "scheduled", vendorBookingNotifiedAt: null },
    { $set: { vendorBookingNotifiedAt: now } },
    { new: true }
  );
  if (!appointment) return { sent: false, reason: "already_notified_or_not_scheduled" };
  return sendVendorJobLink({ appointmentId: appointment._id, now });
}

/**
 * Email the vendor the "You're booked" message with their job link.
 *
 * At-least-once: without this link the vendor cannot check in or submit
 * completion, so losing it strands the job. A send claims a short lease
 * (vendorJobLinkClaimedAt), and only a DELIVERED send sets
 * vendorJobLinkSentAt. A provider failure releases the lease at once; a
 * process that dies mid-send leaves it to expire. Either way
 * sweepVendorJobLinks tries again. The cost is a rare duplicate email,
 * harmless because each send rotates the token and the newest link is live.
 *
 * Failures that no retry can fix (no vendor email, no job token) are marked
 * done so the sweep stops picking them up.
 */
async function sendVendorJobLink({ appointmentId, now = new Date() }) {
  const appointment = await Appointment.findOneAndUpdate(
    {
      _id: appointmentId,
      status: "scheduled",
      vendorJobLinkSentAt: null,
      $or: [
        { vendorJobLinkClaimedAt: null },
        { vendorJobLinkClaimedAt: { $lte: new Date(now.getTime() - JOB_LINK_LEASE_MS) } },
      ],
    },
    { $set: { vendorJobLinkClaimedAt: now } },
    { new: true }
  );
  if (!appointment) return { sent: false, reason: "already_sent_or_in_flight" };

  // Guarded on our own lease, so a send whose lease expired and was taken
  // over cannot overwrite the newer attempt's outcome.
  const settle = (fields) =>
    Appointment.updateOne({ _id: appointment._id, vendorJobLinkClaimedAt: now }, { $set: fields });
  const giveUp = (reason) =>
    settle({ vendorJobLinkSentAt: now, vendorJobLinkClaimedAt: null }).then(() => ({ sent: false, reason }));

  try {
    const outreach = await VendorOutreach.findOne({ appointmentId: appointment._id });
    if (!outreach?.toEmail) return giveUp("no_vendor_email");

    const { rawToken, jobToken } = await rotateJobToken({ appointmentId: appointment._id });
    if (!rawToken) return giveUp("no_job_token");

    const context = await loadBookingEmailContext(appointment);
    const jobUrl = buildJobUrl(rawToken);
    const email = buildVendorJobLinkEmail({
      vendorName: outreach.vendorNameSnapshot,
      jobUrl,
      jobCode: jobToken?.jobCode,
      issueTitle: context.issueTitle,
      category: context.category,
      city: context.city,
      scheduledArrivalAt: appointment.confirmedStart || null,
      durationMinutes: context.durationMinutes,
      timeZone: env.outreach_timezone,
      managerName: context.managerName,
      managerCompany: context.managerCompany,
      paymentMode: appointment.paymentMode,
    });

    // Stub mode logs the URL instead of sending, which is what keeps the flow
    // exercisable locally -- same as the outreach email.
    const result = await sendEmail({
      to: outreach.toEmail,
      subject: email.subject,
      text: email.text,
      html: email.html,
      categories: ["vendor_job_link"],
      previewUrl: jobUrl,
    });
    if (!env.resend_api_key && !require('../judgeSandbox/offlineGuard.service').inAppOnly()) console.log("[vendorJobLink] job link captured by email stub");

    if (emailFailed(result)) {
      await settle({ vendorJobLinkClaimedAt: null });
      return { sent: false, reason: "send_failed" };
    }
    await settle({ vendorJobLinkSentAt: now, vendorJobLinkClaimedAt: null });
    return { sent: true, jobUrl };
  } catch (err) {
    await settle({ vendorJobLinkClaimedAt: null }).catch(() => {});
    throw err;
  }
}

/**
 * Retry the job link for any scheduled appointment that doesn't have one yet:
 * a confirmation whose send failed, a process that died mid-send, or a booking
 * that reached `scheduled` some other way. Runs on the outreach sweeper's 60s
 * tick. Status-keyed, so a cancelled or failed booking never gets one.
 */
async function sweepVendorJobLinks({ now = new Date(), limit = 50 } = {}) {
  const due = await Appointment.find({
    status: "scheduled",
    vendorJobLinkSentAt: null,
    $or: [
      { vendorJobLinkClaimedAt: null },
      { vendorJobLinkClaimedAt: { $lte: new Date(now.getTime() - JOB_LINK_LEASE_MS) } },
    ],
  })
    .sort({ confirmedStart: 1 })
    .limit(limit)
    .select("_id")
    .lean();

  let sent = 0;
  for (const { _id } of due) {
    try {
      const result = await sendVendorJobLink({ appointmentId: _id, now });
      if (result.sent) sent += 1;
    } catch (err) {
      console.error("[vendorJobLink] send failed", String(_id), err.message);
    }
  }
  if (sent) console.log(`[vendorJobLink] sent ${sent} job link(s)`);
  return sent;
}

// Due a reminder: booked, link delivered, arriving within the hour, not yet
// reminded -- and the link went out MORE than an hour before arrival. A
// booking confirmed inside the hour just received its link; a reminder on top
// would be noise.
function arrivalReminderFilter(now) {
  return {
    status: "scheduled",
    vendorJobLinkSentAt: { $ne: null },
    vendorArrivalReminderSentAt: null,
    confirmedStart: { $gt: now, $lte: new Date(now.getTime() + ARRIVAL_REMINDER_LEAD_MS) },
    $expr: {
      $lte: ["$vendorJobLinkSentAt", { $subtract: ["$confirmedStart", ARRIVAL_REMINDER_LEAD_MS] }],
    },
  };
}

/**
 * About an hour before arrival: "your job starts at 9:30, your link is in the
 * 'You're booked' email." Carries NO link -- issuing one would rotate the
 * token and kill the link the vendor may already have open. At-most-once: a
 * missed nudge costs nothing the vendor doesn't already have.
 */
async function sweepVendorArrivalReminders({ now = new Date(), limit = 50 } = {}) {
  const due = await Appointment.find(arrivalReminderFilter(now)).limit(limit).select("_id").lean();

  let sent = 0;
  for (const { _id } of due) {
    try {
      const appointment = await Appointment.findOneAndUpdate(
        { _id, ...arrivalReminderFilter(now) },
        { $set: { vendorArrivalReminderSentAt: now } },
        { new: true }
      );
      if (!appointment) continue;
      const outreach = await VendorOutreach.findOne({ appointmentId: appointment._id });
      if (!outreach?.toEmail) continue;
      const context = await loadBookingEmailContext(appointment);
      const email = buildVendorArrivalReminderEmail({
        vendorName: outreach.vendorNameSnapshot,
        category: context.category,
        city: context.city,
        scheduledArrivalAt: appointment.confirmedStart,
        timeZone: env.outreach_timezone,
        managerLabel: context.managerLabel,
      });
      await sendEmail({
        to: outreach.toEmail,
        subject: email.subject,
        text: email.text,
        html: email.html,
        categories: ["vendor_arrival_reminder"],
      });
      sent += 1;
    } catch (err) {
      console.error("[vendorArrivalReminder] send failed", String(_id), err.message);
    }
  }
  if (sent) console.log(`[vendorArrivalReminder] sent ${sent} reminder(s)`);
  return sent;
}

module.exports = {
  finalizeVendorAcceptance,
  sendVendorBookingConfirmation,
  sendVendorJobLink,
  sweepVendorJobLinks,
  sweepVendorArrivalReminders,
  ARRIVAL_REMINDER_LEAD_MS,
  JOB_LINK_LEASE_MS,
  evaluateQuoteAgainstQuota,
  ensureQuotaApprovalForVendorQuote,
  formatArrivalLabel,
  roundUpTo25,
};
