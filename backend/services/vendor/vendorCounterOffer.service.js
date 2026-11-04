// The counter-offer round: what happens when a manager authorizes an amount
// BETWEEN the vendor's quoteLow and quoteHigh.
//
// The vendor quoted a range. Authorizing the top of it books immediately (see
// vendorAcceptance.service). Authorizing less is not something we can impose —
// the vendor never agreed to it — so we ask, and the job books only if they say
// yes. If they say no, or say nothing, advanceOutreach moves to the next vendor.
//
// STATE. The row stays at the top-level status `accepted` for the whole pending
// round; `counterOffer.status` is the real state machine. That is deliberate:
//   - finalizeVendorAcceptance early-returns unless status is `accepted`, so a
//     confirm re-enters it naturally.
//   - the address reveal gate in vendorPortal.controller is `status ===
//     "accepted"`; the vendor must still see the address while pricing travel,
//     and this way that line needs no change at all.
//   - the offer-timeout sweep matches status sent/viewed, so it provably cannot
//     touch a row in this round. The two sweeps are disjoint claims.
// Only the terminal transitions move the top-level status.
//
// TOKEN. The raw magic-link token is never persisted (only its sha256), so the
// original link cannot be re-sent — rotation is forced, not chosen. Rotation is
// a single `$set` of a real hash inside the raise CAS, which is also what keeps
// it clear of the sparse-unique-index hazard on tokenHash.

const env = require("../../config/env");
const { currentQuote } = require("../quotes/currentQuote.service");
const VendorOutreach = require("../../models/VendorOutreach");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const Landlord = require("../../models/Landlord");
const Property = require("../../models/Property");
const { logAgentAction } = require("../audit/agentAction.service");
const { sendEmail } = require("../notification/email.service");
const {
  buildVendorCounterOfferEmail,
} = require("../notification/templates/vendorCounterOfferEmail");
const {
  generateOutreachToken,
  buildResponseUrl,
  buildOutreachLedgerPatch,
  applyOutreachToSnapshot,
} = require("./vendorOutreach.service");
const { resolveResponseSla } = require("./vendorOutreachPolicy.service");
const { resolveRequestCity, formatCityLabel } = require("./vendorScoring.service");

// Mirrors SUBMIT_GRACE_MS in vendorPortal.controller and GRACE_MS in the offer
// sweeper: exactly one of {vendor answers, sweep expires} may win.
const COUNTER_OFFER_GRACE_MS = 60 * 1000;

// The offer round reuses the tier SLA, but an emergency tier is 15 minutes and
// that is not a negotiation window — a vendor already committed to this job
// deserves longer to answer a price question than to answer the job itself.
const MIN_COUNTER_OFFER_MS = 4 * 60 * 60 * 1000;

// How long the link outlives the deadline, matching EXPIRY_GRACE_MS on the offer.
const COUNTER_OFFER_EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * The amount a job is actually booked at.
 *
 * A ceiling is a ceiling, not a price: authorizing $400 against a $180–$320
 * quote still books at $320. Only a confirmed counter-offer books at the
 * authorized number, because that is the one the vendor negotiated to.
 *
 * Shared with vendorCompletion.controller so the completion draft measures the
 * vendor's final invoice against the same figure.
 */
function resolveBookedAmount(outreach) {
  if (outreach?.counterOffer?.status === "confirmed") {
    const negotiated = Number(outreach.counterOffer.amount);
    if (Number.isFinite(negotiated) && negotiated > 0) return negotiated;
  }
  const rawQuote = currentQuote(outreach).high;
  if (rawQuote === null || rawQuote === undefined || rawQuote === "") return null;
  const quoted = Number(rawQuote);
  return Number.isFinite(quoted) && quoted >= 0 ? quoted : null;
}

function resolveCounterOfferDeadline({ tier, from = new Date(), timeZone }) {
  const { responseDeadlineAt } = resolveResponseSla({
    tier: tier || "normal",
    sentAt: from,
    timeZone: timeZone || env.outreach_timezone,
  });
  const floor = new Date(from.getTime() + MIN_COUNTER_OFFER_MS);
  return responseDeadlineAt > floor ? responseDeadlineAt : floor;
}

/** Pure. The sweep claim for counter-offers that ran out of time. */
function expiredCounterOfferFilter(now = new Date()) {
  return {
    "counterOffer.status": "pending",
    "counterOffer.deadlineAt": { $lte: new Date(now.getTime() - COUNTER_OFFER_GRACE_MS) },
  };
}

/**
 * Open a counter-offer round.
 *
 * ORDERING IS LOAD-BEARING: the CAS runs first, the email second. If the email
 * fails after the CAS, the row is `pending` with a deadline and the sweep
 * reclaims it — self-healing. Sending first would risk a live link on a row with
 * nothing to do, and a CAS that never ran leaves the sweeper nothing to match,
 * which is a permanent stall.
 *
 * Returns null when the CAS loses (already booked, already raised) — the caller
 * must treat that as a no-op, not an error.
 */
async function raiseCounterOffer({ request, outreach, ceiling, actorUserId = null, note = "" }) {
  const amount = Number(ceiling);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("raiseCounterOffer requires a positive ceiling");
  }

  const now = new Date();
  const quotedLow = Number(currentQuote(outreach).low ?? 0) || null;
  const quotedHigh = Number(currentQuote(outreach).high ?? 0) || null;
  const deadlineAt = resolveCounterOfferDeadline({ tier: outreach.tier, from: now });
  const token = generateOutreachToken();

  const claimed = await VendorOutreach.findOneAndUpdate(
    {
      _id: outreach._id,
      status: "accepted",
      appointmentId: null,
      "counterOffer.status": { $in: ["none", null] },
    },
    {
      $set: {
        // Rotation. Never a null — see the tokenHash comment on the model.
        tokenHash: token.hash,
        tokenLast4: token.last4,
        // The original link 410s once expiresAt passes, and accepting never
        // extended it. Without this a manager deciding on day 2 would send the
        // vendor to a dead page.
        expiresAt: new Date(deadlineAt.getTime() + COUNTER_OFFER_EXPIRY_GRACE_MS),
        // The offer round and this round share the abuse counter, and it hard
        // revokes at 20. Reset so a chatty offer round can't starve this one.
        submitAttempts: 0,
        authorizedCeiling: amount,
        authorizedCeilingAt: now,
        authorizedBy: actorUserId || null,
        "counterOffer.status": "pending",
        "counterOffer.amount": amount,
        "counterOffer.currency": outreach.response?.quoteCurrency || "CAD",
        "counterOffer.quotedLow": quotedLow,
        "counterOffer.quotedHigh": quotedHigh,
        "counterOffer.note": note || "",
        "counterOffer.sentAt": now,
        "counterOffer.deadlineAt": deadlineAt,
        "counterOffer.deliveryError": null,
        "counterOffer.respondedAt": null,
        "counterOffer.declineReason": null,
      },
      $inc: { "counterOffer.round": 1 },
    },
    { new: true }
  );

  // Lost the race, or the row moved on. Discard the token we generated and send
  // nothing — a second live link for one job is exactly what this guard prevents.
  if (!claimed) return null;

  await applyOutreachToSnapshot({
    requestId: claimed.requestId,
    candidateKey: claimed.candidateKey,
    patch: buildOutreachLedgerPatch(claimed),
  });

  await logAgentAction({
    requestId: claimed.requestId,
    landlordId: claimed.landlordId,
    actor: "landlord",
    actionType: "vendor_counter_offer_sent",
    summary: `Authorized $${amount} for ${claimed.vendorNameSnapshot} (quoted $${quotedLow}–$${quotedHigh}) — awaiting their confirmation`,
    input: { outreachId: claimed._id.toString(), candidateKey: claimed.candidateKey },
    output: {
      amount,
      quotedLow,
      quotedHigh,
      deadlineAt: deadlineAt.toISOString(),
      round: claimed.counterOffer?.round ?? 1,
    },
  });

  // Non-fatal. The authorization is durably recorded and the sweep will advance
  // if the vendor never answers, so a mail outage must not throw this away.
  try {
    const [landlord, property] = await Promise.all([
      Landlord.findById(claimed.landlordId).select("firstName lastName companyName").lean(),
      request?.propertyId
        ? Property.findById(request.propertyId?._id || request.propertyId)
            .select("address city")
            .lean()
        : null,
    ]);

    const email = buildVendorCounterOfferEmail({
      vendorName: claimed.vendorNameSnapshot,
      amount,
      currency: claimed.counterOffer?.currency || "CAD",
      quotedLow,
      quotedHigh,
      responseUrl: buildResponseUrl(token.raw),
      deadlineAt,
      timeZone: env.outreach_timezone,
      note,
      managerName: [landlord?.firstName, landlord?.lastName].filter(Boolean).join(" "),
      managerCompany: landlord?.companyName,
      category: request?.category || "Maintenance",
      city: formatCityLabel(resolveRequestCity({ property })) || "your service area",
    });

    await sendEmail({
      to: claimed.toEmail,
      subject: email.subject,
      text: email.text,
      html: email.html,
      categories: ["vendor_counter_offer"],
      previewUrl: buildResponseUrl(token.raw),
    });
  } catch (err) {
    console.error("[raiseCounterOffer] email failed", err.message);
    await VendorOutreach.updateOne(
      { _id: claimed._id },
      { $set: { "counterOffer.deliveryError": err.message || "send failed" } }
    ).catch(() => {});
  }

  return claimed;
}

/**
 * Close a counter-offer that ran out of time. Atomic claim, so a vendor
 * answering in the same tick wins and this becomes a no-op.
 */
async function expireCounterOffer(outreachId) {
  return VendorOutreach.findOneAndUpdate(
    { _id: outreachId, "counterOffer.status": "pending" },
    {
      $set: { "counterOffer.status": "expired", status: "expired" },
      $unset: { tokenHash: 1 },
    },
    { new: true }
  );
}

module.exports = {
  COUNTER_OFFER_GRACE_MS,
  MIN_COUNTER_OFFER_MS,
  COUNTER_OFFER_EXPIRY_GRACE_MS,
  resolveBookedAmount,
  resolveCounterOfferDeadline,
  expiredCounterOfferFilter,
  raiseCounterOffer,
  expireCounterOffer,
};
