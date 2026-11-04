// Public, unauthenticated vendor response surface.
//
// There is no `vendor` role and no vendor session — the magic-link token IS the
// authorization, scoped to exactly one outreach: read this brief, submit one
// response. Nothing here may accept a requestId, vendorId, or email from the
// client.
//
// Privacy: the pre-accept payload must physically exclude address / unit /
// tenant identity. Hiding them in the UI would still ship them in the JSON. The
// projection lives in services/vendor/vendorBrief.service.js.

const MaintenanceRequest = require("../models/MaintenanceRequest");
const VendorOutreach = require("../models/VendorOutreach");
const Landlord = require("../models/Landlord");
const Property = require("../models/Property");
const Unit = require("../models/Unit");
const Tenant = require("../models/Tenant");
const { logAgentAction } = require("../services/audit/agentAction.service");
const { hashToken, hashOpaque, applyOutreachToSnapshot, buildOutreachLedgerPatch } =
  require("../services/vendor/vendorOutreach.service");
const { buildPublicBrief, buildRevealedDetails, publicWindows } = require("../services/vendor/vendorBrief.service");
const { getRelayContact } = require("../services/comms/relay.service");
const { finalizeVendorAcceptance } = require("../services/vendor/vendorAcceptance.service");
const { advanceOutreach } = require("../services/vendor/vendorOutreachSweeper.service");
const { refreshOutreachWindows, isWindowBookable } = require("../services/vendor/offeredWindows.service");
const { initialQuote } = require("../services/quotes/submissionContract.service");
const { currentQuote } = require("../services/quotes/currentQuote.service");

// An arrival this far in the past is a slow submit, not a booking for the past.
const ARRIVAL_PAST_GRACE_MS = 5 * 60 * 1000;

// A submit that began before the deadline still lands.
const SUBMIT_GRACE_MS = 60 * 1000;
const MAX_SUBMIT_ATTEMPTS = 20;

// One body for unknown / superseded / revoked / malformed tokens. Byte-identical
// so a caller cannot distinguish "never existed" from "retired".
const GENERIC_NOT_FOUND = {
  success: false,
  code: "invalid_link",
  message: "This link is not valid. It may have been replaced by a newer one.",
};

function notFound(res) {
  return res.status(404).json(GENERIC_NOT_FOUND);
}

async function loadOutreachContext(outreach) {
  const request = await MaintenanceRequest.findById(outreach.requestId).lean();
  if (!request) return null;

  const [landlord, property, unit, tenant] = await Promise.all([
    Landlord.findById(outreach.landlordId).select("firstName lastName companyName phone email").lean(),
    request.propertyId ? Property.findById(request.propertyId).select("name address").lean() : null,
    request.unitId ? Unit.findById(request.unitId).select("unitNumber").lean() : null,
    // `phone` is no longer selected: the vendor projection cannot reveal it, so
    // loading it here would only put it one careless spread away from the wire.
    request.tenantId ? Tenant.findById(request.tenantId).select("firstName lastName").lean() : null,
  ]);

  // Resolved here rather than inside buildRevealedDetails so that projection
  // stays synchronous and free of I/O — see the header of vendorBrief.service.
  const relayContact = await getRelayContact({
    requestId: outreach.requestId,
    appointmentId: outreach.appointmentId,
    identityId: outreach.identityId,
    managerPhone: landlord?.phone || null,
  });

  return { request, landlord, property, unit, tenant, relayContact };
}

function buildResponsePayload({ outreach, context }) {
  const brief = buildPublicBrief({
    request: context.request,
    outreach,
    landlord: context.landlord,
    property: context.property,
  });

  const payload = {
    brief,
    status: outreach.status,
    alreadyResponded: Boolean(outreach.respondedAt),
    negotiatedProposal: outreach.negotiatedProposal?.start ? {
      amount: outreach.negotiatedProposal.amountCents / 100, start: outreach.negotiatedProposal.start,
      durationMinutes: outreach.negotiatedProposal.durationMinutes, note: outreach.negotiatedProposal.note || "" } : null,
    decision: outreach.response?.outcome || null,
    respondedAt: outreach.respondedAt || null,
    quote: outreach.response?.outcome
      ? {
          low: currentQuote(outreach).low,
          high: currentQuote(outreach).high,
          currency: outreach.response.quoteCurrency || "CAD",
          notes: outreach.response.quoteNotes || null,
          ...(outreach.quoteContractVersion === 2 ? {
            revision: outreach.currentQuoteRevision,
            itemization: outreach.quoteRevisions?.find(row => row.revision === outreach.currentQuoteRevision)?.itemization || null,
          } : {}),
        }
      : null,
    scheduledArrivalAt: outreach.response?.scheduledArrivalAt || null,
    durationMinutes: outreach.response?.durationMinutes ?? null,
    declineReason: outreach.response?.declineReason || null,
    // The counter-offer round, when one is running. `counterOffer.amount` is the
    // ONE figure from the manager's authorization the vendor may see — it is the
    // number we are asking them to accept. `authorizedCeiling` must never appear
    // here: when the manager authorizes at or above the vendor's quoteHigh no
    // round opens at all, and the vendor is told nothing, because knowing the
    // manager would have paid more anchors their next quote upward.
    // See the authorizedCeiling comment in models/VendorOutreach.js.
    counterOffer:
      outreach.counterOffer?.status && outreach.counterOffer.status !== "none"
        ? {
            status: outreach.counterOffer.status,
            amount: outreach.counterOffer.amount ?? null,
            currency: outreach.counterOffer.currency || "CAD",
            deadlineAt: outreach.counterOffer.deadlineAt || null,
            note: outreach.counterOffer.note || null,
            respondedAt: outreach.counterOffer.respondedAt || null,
            declineReason: outreach.counterOffer.declineReason || null,
            originalQuote: {
              low: outreach.counterOffer.quotedLow ?? null,
              high: outreach.counterOffer.quotedHigh ?? null,
            },
          }
        : null,
  };

  // The gate. Revealed details exist only once the vendor has committed.
  //
  // Do NOT narrow this to exclude a pending counter-offer: the row deliberately
  // stays at `accepted` for that whole round precisely so this line needs no
  // change, and the vendor must still see the address while pricing travel.
  if (outreach.status === "accepted") {
    payload.revealed = buildRevealedDetails({
      request: context.request,
      outreach,
      landlord: context.landlord,
      property: context.property,
      unit: context.unit,
      tenant: context.tenant,
      relayContact: context.relayContact,
    });
  }

  return payload;
}

exports.getOutreachBrief = async (req, res) => {
  try {
    const tokenHash = hashToken(req.params.token || "");
    const outreach = await VendorOutreach.findOne({ tokenHash });
    if (!outreach) return notFound(res);

    const now = new Date();
    if (["superseded", "revoked"].includes(outreach.status)) return notFound(res);

    // Distinguishable from 404 on purpose: this vendor held a valid link, so a
    // "this job has moved on" page is more useful than a dead-link error.
    if (outreach.status === "expired" || (outreach.expiresAt && outreach.expiresAt < now)) {
      return res.status(410).json({
        success: false,
        code: "outreach_expired",
        message: "This job request has expired and has been passed to another provider.",
      });
    }

    const context = await loadOutreachContext(outreach);
    if (!context) return notFound(res);

    // Opened hours after it was sent: drop the windows that have passed, and
    // top up if too few are left, before the vendor sees them.
    await refreshOutreachWindows(outreach, { now });

    // The `firstViewedAt: null` guard makes the audit entry fire exactly once,
    // no matter how many times the vendor reopens the link.
    const firstView = await VendorOutreach.findOneAndUpdate(
      { _id: outreach._id, firstViewedAt: null },
      { $set: { firstViewedAt: now, lastViewedAt: now }, $inc: { viewCount: 1 } },
      { new: true }
    );

    if (firstView) {
      // Only promote sent -> viewed; never walk a terminal state backwards.
      if (outreach.status === "sent") {
        await VendorOutreach.updateOne({ _id: outreach._id, status: "sent" }, { $set: { status: "viewed" } });
        outreach.status = "viewed";
      }
      outreach.viewCount = firstView.viewCount;
      outreach.firstViewedAt = firstView.firstViewedAt;

      await logAgentAction({
        requestId: outreach.requestId,
        landlordId: outreach.landlordId,
        actor: "vendor",
        actionType: "vendor_outreach_viewed",
        summary: `${outreach.vendorNameSnapshot} opened the job request`,
        input: { candidateKey: outreach.candidateKey, attempt: outreach.attempt },
        output: { outreachId: outreach._id.toString() },
      });

      await applyOutreachToSnapshot({
        requestId: outreach.requestId,
        candidateKey: outreach.candidateKey,
        patch: buildOutreachLedgerPatch(outreach),
      });
    } else {
      const bumped = await VendorOutreach.findOneAndUpdate(
        { _id: outreach._id },
        { $set: { lastViewedAt: now }, $inc: { viewCount: 1 } },
        { new: true }
      );
      if (bumped) outreach.viewCount = bumped.viewCount;
    }

    return res.json({ success: true, data: buildResponsePayload({ outreach, context }) });
  } catch (err) {
    console.error("[getOutreachBrief] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

function validateSubmission(body, outreach, now = new Date()) {
  const outcome = String(body?.outcome || "").trim();
  if (!["accepted", "declined"].includes(outcome)) {
    return { error: "outcome must be 'accepted' or 'declined'." };
  }

  if (outcome === "declined") {
    const declineReason = String(body?.declineReason || "").trim();
    if (declineReason.length > 500) {
      return { error: "declineReason must be 500 characters or fewer." };
    }
    return { value: { outcome, declineReason: declineReason || "No reason given" } };
  }

  // Server-side allowlist — a client-supplied window is never trusted.
  const selectedSlotId = String(body?.selectedSlotId || "").trim();
  const selectedWindow = (outreach.offeredWindows || []).find(
    (slot) => slot.slotId === selectedSlotId
  );
  if (!selectedWindow) {
    return { error: "Select one of the offered time windows." };
  }

  let itemized;
  try { itemized = initialQuote(outreach, body); }
  catch (error) { return { error: "Check the itemized estimate and totals.", code: error.code, field: error.field, status: error.status }; }
  const quoteLow = itemized ? itemized.quoteLow : Number(body?.quoteLow);
  const quoteHigh = itemized ? itemized.quoteHigh : Number(body?.quoteHigh);
  if (!Number.isFinite(quoteLow) || !Number.isFinite(quoteHigh)) {
    return { error: "Provide a numeric low and high estimate." };
  }
  if (quoteLow < 0 || quoteHigh < 0) return { error: "Estimates cannot be negative." };
  if (quoteHigh < quoteLow) return { error: "The high estimate must be at least the low estimate." };
  if (quoteHigh > 1000000) return { error: "Estimate is out of range." };

  // A window is what the vendor CAN do; the arrival time is when they will
  // actually turn up. Artrelo has no access to the vendor's calendar, so only
  // they can narrow it — and without it the tenant can't plan to be home and
  // the landlord has nothing concrete to see.
  const arrivalRaw = body?.scheduledArrivalAt;
  if (!arrivalRaw) return { error: "Provide the time you expect to arrive." };
  const scheduledArrivalAt = new Date(arrivalRaw);
  if (Number.isNaN(scheduledArrivalAt.getTime())) {
    return { error: "Arrival time is not a valid date." };
  }

  if (selectedWindow.kind === "flexible" || !selectedWindow.start || !selectedWindow.end) {
    // Flexible slots carry no fixed date, so the vendor supplies both date and
    // time; all we can check is that it is sane.
    if (scheduledArrivalAt.getTime() < now.getTime() - 60 * 60 * 1000) {
      return { error: "Arrival time cannot be in the past." };
    }
    if (scheduledArrivalAt.getTime() > now.getTime() + 60 * 24 * 60 * 60 * 1000) {
      return { error: "Arrival time is too far in the future." };
    }
  } else {
    const start = new Date(selectedWindow.start).getTime();
    const end = new Date(selectedWindow.end).getTime();
    // Windows are clamped to now on refresh, but a form left open still holds
    // the time it was filled in with. `stale` keeps this off the attempt
    // counter: the clock ran out, the vendor didn't do anything wrong.
    if (scheduledArrivalAt.getTime() < now.getTime() - ARRIVAL_PAST_GRACE_MS) {
      return { error: "That arrival time has already passed. Pick a later time.", stale: true };
    }
    if (scheduledArrivalAt.getTime() < start || scheduledArrivalAt.getTime() >= end) {
      return { error: `Arrival time must fall inside the window you chose (${selectedWindow.label}).` };
    }
  }

  // Any length from 15 minutes to 12 hours, in 15-minute steps. It used to be
  // four fixed values (30m, 1h, 2h, half a day), which fit few real jobs.
  // Mirrored by frontend/src/app/pages/vendor/durationOnSite.ts.
  const durationMinutes = Number(body?.durationMinutes);
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 15 ||
    durationMinutes > 12 * 60 ||
    durationMinutes % 15 !== 0
  ) {
    return { error: "Enter how long you expect to be on site: 15 minutes to 12 hours, in 15-minute steps." };
  }

  const quoteNotes = String(body?.quoteNotes || "").trim();
  if (outreach.bookingVersion === 2) {
    const end = new Date(scheduledArrivalAt.getTime() + durationMinutes * 60_000);
    if (scheduledArrivalAt <= now || (selectedWindow.end && end > new Date(selectedWindow.end))) {
      return { error: "The whole visit must fit in a future available window.", stale: true };
    }
    const proposal = outreach.negotiatedProposal;
    if (proposal?.start && (quoteLow !== proposal.amountCents / 100 || quoteHigh !== proposal.amountCents / 100 ||
        scheduledArrivalAt.getTime() !== new Date(proposal.start).getTime() || durationMinutes !== proposal.durationMinutes)) {
      return { error: "Confirm the agreed price and time exactly, or decline this proposal." };
    }
  }
  if (quoteNotes.length > 1000) return { error: "Notes must be 1000 characters or fewer." };

  return {
    value: {
      outcome,
      quoteLow,
      quoteHigh,
      quoteNotes,
      ...(itemized ? { quoteSnapshot: itemized.snapshot } : {}),
      selectedSlotId,
      scheduledArrivalAt,
      durationMinutes,
      selectedWindow: {
        slotId: selectedWindow.slotId,
        start: selectedWindow.start,
        end: selectedWindow.end,
        label: selectedWindow.label,
        timeZone: selectedWindow.timeZone,
        kind: selectedWindow.kind,
      },
    },
  };
}

async function submitOutreachResponse(req, res, simulationSelector = null) {
  try {
    const tokenHash = hashToken(req.params.token || "");
    const selector = simulationSelector || { tokenHash };
    const existing = await VendorOutreach.findOne(selector);
    if (!existing) return notFound(res);
    if (["superseded", "revoked"].includes(existing.status)) return notFound(res);

    if (existing.submitAttempts >= MAX_SUBMIT_ATTEMPTS) {
      await VendorOutreach.updateOne(
        { _id: existing._id },
        { $set: { status: "revoked" }, $unset: { tokenHash: 1 } }
      );
      return notFound(res);
    }

    // The windows as they stand now, not as they stood when the page loaded.
    // A slot that expired while the form was open is answered with the fresh
    // list rather than counted as a bad submit: a slow vendor must not be
    // walked toward the attempt limit that revokes their link.
    const checkedAt = new Date();
    const offeredBefore = new Set((existing.offeredWindows || []).map((window) => window.slotId));
    await refreshOutreachWindows(existing, { now: checkedAt });
    const pickedSlotId = String(req.body?.selectedSlotId || "").trim();
    if (String(req.body?.outcome || "").trim() === "accepted" && pickedSlotId && offeredBefore.has(pickedSlotId)) {
      const picked = (existing.offeredWindows || []).find((window) => window.slotId === pickedSlotId);
      if (!picked || !isWindowBookable(picked, checkedAt)) {
        return res.status(409).json({
          success: false,
          code: "window_expired",
          message: "That time window has passed. Pick one of the updated windows.",
          data: { offeredWindows: publicWindows(existing.offeredWindows) },
        });
      }
    }

    const validation = validateSubmission(req.body, existing, checkedAt);
    if (validation.error) {
      if (!validation.stale) {
        await VendorOutreach.updateOne({ _id: existing._id }, { $inc: { submitAttempts: 1 } });
      }
      return res.status(validation.status || 400).json({
        success: false,
        message: validation.error,
        ...(validation.code ? { code: validation.code, field: validation.field } : {}),
        ...(validation.stale ? { code: "arrival_past" } : {}),
      });
    }

    const submission = validation.value;
    const now = new Date();
    const accepted = submission.outcome === "accepted";
    if (accepted && existing.bookingVersion === 2) {
      const calendar = require("../services/vendor/vendorCalendar.service");
      const identityId = await calendar.canonicalId(existing.identityId);
      try { await calendar.assertAvailable(identityId, submission.scheduledArrivalAt,
        new Date(submission.scheduledArrivalAt.getTime() + submission.durationMinutes * 60_000)); }
      catch (error) { return res.status(error.status || 409).json({ success: false,
        code: error.code || "time_unavailable", message: error.message }); }
    }

    // The single-use guard. This same conditional update is what the timeout
    // sweeper contends on, so exactly one of {vendor responds, sweep expires}
    // can win — never both, never neither.
    const outreach = await VendorOutreach.findOneAndUpdate(
      {
        ...selector,
        status: { $in: ["sent", "viewed"] },
        responseDeadlineAt: { $gt: new Date(now.getTime() - SUBMIT_GRACE_MS) },
      },
      {
        $set: {
          status: accepted ? "accepted" : "declined",
          respondedAt: now,
          revealedAt: accepted ? now : null,
          ...(submission.quoteSnapshot ? {
            currentQuoteRevision: 1,
            quoteRevisions: [submission.quoteSnapshot],
            quoteReview: { state: "pending", quoteHash: submission.quoteSnapshot.hash },
          } : {}),
          response: {
            outcome: submission.outcome,
            quoteLow: submission.quoteLow ?? null,
            quoteHigh: submission.quoteHigh ?? null,
            quoteCurrency: "CAD",
            quoteNotes: submission.quoteNotes || null,
            declineReason: submission.declineReason || null,
            selectedSlotId: submission.selectedSlotId || null,
            selectedWindow: submission.selectedWindow || null,
            scheduledArrivalAt: submission.scheduledArrivalAt || null,
            durationMinutes: submission.durationMinutes ?? null,
            submittedAt: now,
            submitterIpHash: hashOpaque(req.ip),
            submitterUaHash: hashOpaque(req.get("user-agent")),
          },
        },
        $inc: { submitAttempts: 1 },
      },
      { new: true }
    );

    // Lost the race: already answered, expired, or swept. Echo the decision that
    // did land so the page can say "you already responded" rather than error.
    if (!outreach) {
      const current = await VendorOutreach.findOne(selector);
      if (!current) return notFound(res);
      const context = await loadOutreachContext(current);
      return res.status(409).json({
        success: false,
        code: current.respondedAt ? "already_responded" : "outreach_closed",
        message: current.respondedAt
          ? "You have already responded to this job request."
          : "This job request is no longer accepting responses.",
        data: context ? buildResponsePayload({ outreach: current, context }) : null,
      });
    }

    // Decline is terminal — retire the token immediately. Accept keeps it live
    // so the vendor can reopen the page to re-read the address.
    if (!accepted) {
      await VendorOutreach.updateOne({ _id: outreach._id }, { $unset: { tokenHash: 1 } });
    }

    await applyOutreachToSnapshot({
      requestId: outreach.requestId,
      candidateKey: outreach.candidateKey,
      patch: buildOutreachLedgerPatch(outreach),
    });

    await logAgentAction({
      requestId: outreach.requestId,
      landlordId: outreach.landlordId,
      actor: "vendor",
      actionType: accepted ? "vendor_response_accepted" : "vendor_response_declined",
      summary: accepted
        ? `${outreach.vendorNameSnapshot} accepted the job (quote $${submission.quoteLow}–$${submission.quoteHigh})`
        : `${outreach.vendorNameSnapshot} declined the job: ${submission.declineReason}`,
      input: { candidateKey: outreach.candidateKey, attempt: outreach.attempt },
      output: accepted
        ? {
            quoteLow: submission.quoteLow,
            quoteHigh: submission.quoteHigh,
            selectedWindow: submission.selectedWindow?.label || null,
          }
        : { declineReason: submission.declineReason },
    });

    const context = await loadOutreachContext(outreach);

    if (accepted) {
      // Quota check + appointment creation. Deliberately non-fatal: the vendor's
      // response is already durably recorded, and failing their request here
      // would be both confusing and pointless.
      try {
        if (outreach.quoteContractVersion === 2) {
          await require("../services/quotes/quoteCheckpoint.service").claimQuoteCheckpoint({ outreachId: outreach._id,
            landlordId: outreach.landlordId });
          await require("../services/quotes/review.service").queueRuntimeReview({ subjectId: outreach._id,
            stage: "quote", landlordId: outreach.landlordId });
        }
        await finalizeVendorAcceptance({ outreachId: outreach._id });
      } catch (err) {
        console.error("[submitOutreachResponse] finalize failed", err);
      }
    } else {
      // Move to the next queued vendor straight away rather than waiting for
      // the sweeper's next tick.
      try {
        await advanceOutreach({ outreach, reason: "declined" });
      } catch (err) {
        console.error("[submitOutreachResponse] advance failed", err);
      }
    }

    const fresh = await VendorOutreach.findById(outreach._id);
    return res.json({
      success: true,
      data: context ? buildResponsePayload({ outreach: fresh || outreach, context }) : null,
    });
  } catch (err) {
    console.error("[submitOutreachResponse] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * The counter-offer round: the vendor confirms or declines the amount the
 * manager authorized.
 *
 * The body carries a decision and nothing else. The AMOUNT IS NEVER READ FROM
 * THE CLIENT — it comes from counterOffer.amount, which only raiseCounterOffer
 * writes. A vendor who posts `{decision: "confirmed", amount: 9999}` books at
 * the authorized figure, not theirs.
 *
 * This handler only ever $sets dotted `counterOffer.*` paths. It must never
 * write `response`, which holds the original quote and is evidence.
 */
// Ordinary HTTP still requires its unchanged magic-link token. The only
// non-token path is a private server simulation capability, never req.body.
exports.submitOutreachResponse = (req, res) => submitOutreachResponse(req, res);
exports.submitSimulatedOutreach = async (outreachId, body) => {
  const binding = require('../services/judgeSandbox/simulationScope.service').requireVendorScope();
  const selector = { _id: outreachId, landlordId: binding.landlordId, requestId: binding.requestId, vendorId: binding.vendorId, simulatedDelivery: true };
  if (!await VendorOutreach.exists(selector)) throw Object.assign(new Error('Simulation record unavailable'), { code: 'record_not_found', execution: 'not_started' });
  let status = 200, output;
  const res = { status(code) { status = code;return this; }, json(value) { output = value;return this; } };
  await submitOutreachResponse({ params: {}, body, ip: '127.0.0.1', get: () => 'judge-core-simulation' }, res, selector);
  return { status, data: output };
};

async function submitCounterOfferResponse(req, res, simulationSelector = null) {
  try {
    const now = new Date();
    const tokenHash = hashToken(req.params.token || "");
    const selector = simulationSelector || { tokenHash };
    const outreach = await VendorOutreach.findOne(selector);
    if (!outreach) return notFound(res);
    if (["superseded", "revoked"].includes(outreach.status)) return notFound(res);

    if ((outreach.submitAttempts || 0) >= MAX_SUBMIT_ATTEMPTS) {
      await VendorOutreach.updateOne(
        { _id: outreach._id },
        { $set: { status: "revoked" }, $unset: { tokenHash: 1 } }
      );
      return notFound(res);
    }

    const decision = String(req.body?.decision || "").trim();
    if (!["confirmed", "declined"].includes(decision)) {
      await VendorOutreach.updateOne({ _id: outreach._id }, { $inc: { submitAttempts: 1 } });
      return res.status(400).json({
        success: false,
        message: "Choose whether you can do the job for the approved amount.",
      });
    }

    const declineReason = String(req.body?.declineReason || "").trim();
    if (declineReason.length > 500) {
      await VendorOutreach.updateOne({ _id: outreach._id }, { $inc: { submitAttempts: 1 } });
      return res.status(400).json({ success: false, message: "Reason is too long (max 500)." });
    }

    const accepted = decision === "confirmed";

    // The single-use guard, mirroring submitOutreachResponse. Every terminal
    // transition — confirm, decline, sweep-expire, manager withdraw — contends on
    // `counterOffer.status: "pending"`, so exactly one can win. `appointmentId:
    // null` is belt and braces: if a booking somehow already landed, a late
    // confirm becomes a no-op rather than a double-book.
    const claimed = await VendorOutreach.findOneAndUpdate(
      {
        ...selector,
        "counterOffer.status": "pending",
        "counterOffer.deadlineAt": { $gt: new Date(now.getTime() - SUBMIT_GRACE_MS) },
        appointmentId: null,
      },
      {
        $set: {
          "counterOffer.status": accepted ? "confirmed" : "declined",
          "counterOffer.respondedAt": now,
          "counterOffer.declineReason": accepted ? null : declineReason || "No reason given",
          "counterOffer.submitterIpHash": hashOpaque(req.ip),
          "counterOffer.submitterUaHash": hashOpaque(req.get("user-agent")),
          ...(accepted ? {} : { status: "declined" }),
        },
        $inc: { submitAttempts: 1 },
      },
      { new: true }
    );

    if (!claimed) {
      const current = await VendorOutreach.findOne(selector);
      if (!current) return notFound(res);
      const staleContext = await loadOutreachContext(current);
      return res.status(409).json({
        success: false,
        code: current.counterOffer?.respondedAt ? "counter_offer_answered" : "counter_offer_closed",
        message: current.counterOffer?.respondedAt
          ? "You have already answered this amount."
          : "This price request is no longer open.",
        data: staleContext ? buildResponsePayload({ outreach: current, context: staleContext }) : null,
      });
    }

    // Declining is terminal — retire the link immediately. A confirm keeps it
    // live so the vendor can reopen the page and re-read the address.
    if (!accepted) {
      await VendorOutreach.updateOne({ _id: claimed._id }, { $unset: { tokenHash: 1 } });
    }

    await applyOutreachToSnapshot({
      requestId: claimed.requestId,
      candidateKey: claimed.candidateKey,
      patch: buildOutreachLedgerPatch(claimed),
    });

    await logAgentAction({
      requestId: claimed.requestId,
      landlordId: claimed.landlordId,
      actor: "vendor",
      actionType: accepted ? "vendor_counter_offer_confirmed" : "vendor_counter_offer_declined",
      summary: accepted
        ? `${claimed.vendorNameSnapshot} confirmed the job at $${claimed.counterOffer?.amount}`
        : `${claimed.vendorNameSnapshot} declined the authorized $${claimed.counterOffer?.amount}: ${
            claimed.counterOffer?.declineReason
          }`,
      input: { outreachId: claimed._id.toString(), candidateKey: claimed.candidateKey },
      output: accepted
        ? { amount: claimed.counterOffer?.amount ?? null }
        : {
            amount: claimed.counterOffer?.amount ?? null,
            declineReason: claimed.counterOffer?.declineReason || null,
          },
    });

    const context = await loadOutreachContext(claimed);

    if (accepted) {
      // Non-fatal for the same reason as the accept path: the vendor's answer is
      // already durably recorded, and failing their request here helps nobody.
      try {
        await finalizeVendorAcceptance({ outreachId: claimed._id });
      } catch (err) {
        console.error("[submitCounterOfferResponse] finalize failed", err);
      }
    } else {
      try {
        await advanceOutreach({ outreach: claimed, reason: "counter_offer_declined" });
      } catch (err) {
        console.error("[submitCounterOfferResponse] advance failed", err);
      }
    }

    const fresh = await VendorOutreach.findById(claimed._id);
    return res.json({
      success: true,
      data: context ? buildResponsePayload({ outreach: fresh || claimed, context }) : null,
    });
  } catch (err) {
    console.error("[submitCounterOfferResponse] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
exports.submitCounterOfferResponse = (req, res) => submitCounterOfferResponse(req, res);
exports.submitSimulatedCounterOffer = async outreachId => {
  const binding = require('../services/judgeSandbox/simulationScope.service').requireVendorScope();
  const selector = { _id: outreachId, landlordId: binding.landlordId, requestId: binding.requestId, vendorId: binding.vendorId, simulatedDelivery: true };
  if (!await VendorOutreach.exists(selector)) throw Object.assign(new Error('Simulation record unavailable'), { code: 'record_not_found', execution: 'not_started' });
  let status = 200, output;
  const res = { status(code) { status = code;return this; }, json(value) { output = value;return this; } };
  await submitCounterOfferResponse({ params: {}, body: { decision: 'confirmed' }, ip: '127.0.0.1', get: () => 'judge-core-simulation' }, res, selector);
  return { status, data: output };
};
