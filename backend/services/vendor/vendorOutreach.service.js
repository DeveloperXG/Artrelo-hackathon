// Vendor outreach orchestration: mint a token, render the email, send it, and
// project the resulting state onto the recommendation snapshot.
//
// VendorOutreach is the source of truth. The `outreach` object on the snapshot
// ledger entry is a derived read-cache — see models/VendorOutreach.js.

const crypto = require("crypto");
const env = require("../../config/env");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const Landlord = require("../../models/Landlord");
const Vendor = require("../../models/Vendor");
const VendorOutreach = require("../../models/VendorOutreach");
const { sendEmail } = require("../notification/email.service");
const { buildVendorOutreachEmail } = require("../notification/templates/vendorOutreachEmail");
const { logAgentAction } = require("../audit/agentAction.service");
const {
  resolveOutreachTier,
  resolveResponseSla,
  resolveSendTiming,
  buildOfferedWindows,
  formatWindowLabel,
  getTierLabel,
} = require("./vendorOutreachPolicy.service");
const { buildPublicBrief } = require("./vendorBrief.service");
const { stripDraftDisclaimer } = require("./vendorMessageDraft.service");
const { ensureVendorIdentity } = require("./vendorIdentity.service");
const {
  cloneSnapshot,
  findLedgerEntry,
  rebuildSnapshotSections,
} = require("./vendorSnapshot.service");

const TOKEN_BYTES = 32; // 256 bits
const EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

// 256 bits of entropy makes the hash preimage-infeasible, which is why it is
// stored unsalted — a salt would break the single indexed lookup on the hash.
function generateOutreachToken() {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  return { raw, hash: hashToken(raw), last4: raw.slice(-4) };
}

function buildResponseUrl(rawToken) {
  const base = String(env.app_public_url || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/vendor-response/${rawToken}`;
}

// "excelojeifo3.0@gmail.com" -> "exc***@gmail.com". The snapshot is returned to
// the landlord UI, so the full address never goes into it.
function maskEmail(email) {
  const value = String(email || "").trim();
  if (!value.includes("@")) return null;
  const [local, domain] = value.split("@");
  const head = local.slice(0, Math.min(3, local.length));
  return `${head}${local.length > 3 ? "***" : ""}@${domain}`;
}

function hashOpaque(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

/* ------------------------------------------------------------------ *
 * Snapshot projection (the derived read-cache)
 * ------------------------------------------------------------------ */

function buildOutreachLedgerPatch(outreach) {
  if (!outreach) {
    return { status: "not_sent", outreachId: null, attempt: 0 };
  }
  const toIso = (value) => (value ? new Date(value).toISOString() : null);

  return {
    status: outreach.status,
    outreachId: outreach._id?.toString?.() || null,
    attempt: outreach.attempt || 0,
    channel: outreach.channel || "email",
    toEmailMasked: maskEmail(outreach.toEmail),
    tier: outreach.tier || null,
    // Emitted even when null (see counterOffer below): a delivered row must
    // clear the scheduled time the ledger was showing.
    scheduledFor: outreach.status === "scheduled" ? toIso(outreach.scheduledFor) : null,
    sentAt: toIso(outreach.sentAt),
    lastAttemptAt: toIso(outreach.sentAt || outreach.createdAt),
    firstViewedAt: toIso(outreach.firstViewedAt),
    respondedAt: toIso(outreach.respondedAt),
    responseDeadlineAt: toIso(outreach.responseDeadlineAt),
    deliveryError: outreach.deliveryError || null,
    decision: outreach.response?.outcome
      ? {
          outcome: outreach.response.outcome,
          quoteLow: require("../quotes/currentQuote.service").currentQuote(outreach).low,
          quoteHigh: require("../quotes/currentQuote.service").currentQuote(outreach).high,
          currency: outreach.response.quoteCurrency || "CAD",
          quoteNotes: outreach.response.quoteNotes || null,
          declineReason: outreach.response.declineReason || null,
          selectedWindowLabel: outreach.response.selectedWindow?.label || null,
          scheduledArrivalAt: toIso(outreach.response.scheduledArrivalAt),
          durationMinutes: outreach.response.durationMinutes ?? null,
          respondedAt: toIso(outreach.respondedAt),
        }
      : null,
    quotaCheck: outreach.quotaCheck?.evaluatedAt
      ? {
          limit: outreach.quotaCheck.limit ?? null,
          quoteHigh: outreach.quotaCheck.quoteHigh ?? null,
          overQuota: Boolean(outreach.quotaCheck.overQuota),
          evaluatedAt: toIso(outreach.quotaCheck.evaluatedAt),
        }
      : null,
    // Emitted even when null, deliberately. projectOutreachOntoSnapshot merges
    // with a spread, so a key OMITTED from the patch survives on the ledger
    // forever — the read-path repair would actively preserve a stale
    // `counterOffer: {status: "pending"}` long after the round closed.
    counterOffer:
      outreach.counterOffer?.status && outreach.counterOffer.status !== "none"
        ? {
            status: outreach.counterOffer.status,
            amount: outreach.counterOffer.amount ?? null,
            currency: outreach.counterOffer.currency || "CAD",
            round: outreach.counterOffer.round ?? 0,
            quotedLow: outreach.counterOffer.quotedLow ?? null,
            quotedHigh: outreach.counterOffer.quotedHigh ?? null,
            sentAt: toIso(outreach.counterOffer.sentAt),
            deadlineAt: toIso(outreach.counterOffer.deadlineAt),
            respondedAt: toIso(outreach.counterOffer.respondedAt),
            declineReason: outreach.counterOffer.declineReason || null,
            deliveryError: outreach.counterOffer.deliveryError || null,
          }
        : null,
    // Landlord-facing surface only — the snapshot never leaves the manager UI.
    authorizedCeiling: outreach.authorizedCeiling ?? null,
  };
}

// Merges an outreach patch into one ledger entry. Reloads the request so we
// operate on the freshest snapshot; the caller's in-memory copy may be stale.
async function applyOutreachToSnapshot({ requestId, candidateKey, patch, extraEntryFields }) {
  const request = await MaintenanceRequest.findById(requestId);
  if (!request?.vendorRecommendationSnapshot) return null;

  const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
  const entry = findLedgerEntry(snapshot, candidateKey);
  if (!entry) return null;

  entry.outreach = { ...(entry.outreach || {}), ...patch };
  if (extraEntryFields) Object.assign(entry, extraEntryFields);

  request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
  await request.save();
  const { publish } = require("../realtime/liveEvents.service");
  const recipients = [request.landlordId, request.tenantId?._id || request.tenantId];
  publish(recipients, `request:${request._id}`); publish(recipients, "requests");
  return request.vendorRecommendationSnapshot;
}

// Read-path repair: the snapshot cache can be clobbered by a concurrent
// read-modify-write, so re-derive it from the VendorOutreach rows on read.
// Returns the snapshot object (mutated in place) — does not save.
async function projectOutreachOntoSnapshot(snapshot, requestId) {
  if (!snapshot || !Array.isArray(snapshot.candidateLedger)) return snapshot;

  const rows = await VendorOutreach.find({ requestId })
    .sort({ attempt: -1, createdAt: -1 })
    .lean();
  if (!rows.length) return snapshot;

  const latestByCandidate = new Map();
  rows.forEach((row) => {
    if (!latestByCandidate.has(row.candidateKey)) latestByCandidate.set(row.candidateKey, row);
  });

  snapshot.candidateLedger = snapshot.candidateLedger.map((entry) => {
    const row = latestByCandidate.get(entry.candidateKey);
    if (!row) return entry;
    return { ...entry, outreach: { ...(entry.outreach || {}), ...buildOutreachLedgerPatch(row) } };
  });

  return rebuildSnapshotSections(snapshot);
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

function resolveCandidateEmail(candidate) {
  return candidate?.contact?.email || candidate?.email || null;
}

/**
 * Contact details for a candidate, preferring the snapshot and falling back to
 * the Vendor collection.
 *
 * The fallback matters for two reasons:
 *  - Snapshots generated before outreach shipped have no `contact` block at
 *    all, and they cannot simply be regenerated: once a candidate reaches
 *    `approved_for_contact`, assertRequestRouteableForRecommendations refuses
 *    to refresh. Without this lookup those requests are permanently stuck.
 *  - `businessHours` was never a ledger field, so window generation always fell
 *    back to Mon-Fri 08:00-18:00 and a Mon-Sat vendor never got Saturday slots.
 *
 * The snapshot is a cache; the Vendor collection is the truth for contact info.
 */
async function resolveCandidateContact(candidate, vendorRepository = Vendor) {
  const snapshotEmail = resolveCandidateEmail(candidate);

  const query = candidate?.vendorId
    ? { _id: candidate.vendorId }
    : candidate?.providerVendorId
      ? { providerName: candidate.providerName, providerVendorId: candidate.providerVendorId }
      : null;

  let vendor = null;
  if (query) {
    vendor = await vendorRepository
      .findOne(query)
      .select("email phone businessHours operatingHours")
      .lean()
      .catch(() => null);
  }

  const email = snapshotEmail || vendor?.email || null;
  return {
    email,
    phone: candidate?.contact?.phone || vendor?.phone || null,
    // Prefer the live profile — the ledger never carried this field.
    businessHours: vendor?.businessHours || candidate?.businessHours || null,
    // Structured hours, preferred by the policy over the display string.
    operatingHours: vendor?.operatingHours || null,
    resolvedFrom: snapshotEmail ? "snapshot" : vendor?.email ? "vendor_lookup" : "none",
  };
}

/**
 * Creates the VendorOutreach row, renders the email, sends it, and projects the
 * result onto the snapshot.
 *
 * Throws only for programmer errors and the duplicate-attempt collision; the
 * caller (approveVendorRecommendationContact) treats delivery failure as
 * non-fatal so a mail outage cannot roll back a successful contact approval.
 */
async function sendVendorOutreach({
  request,
  candidate,
  draftMessage,
  actorUserId,
  initiation = actorUserId ? 'landlord' : 'unknown',
  attempt = 1,
  landlord: providedLandlord,
  now = new Date(),
  initialRoutingToken,
  negotiatedProposal,
  bookingActionToken,
}) {
  require('../request/requestWorkflow.service').assertContactAllowed(request);
  await require("../billing/billingAccount.service").bookingSnapshot({ landlordId: request.landlordId, request, now });
  if (["completed", "rejected", "cancelled", "in_progress", "assigned"].includes(request.status) || request.archivedAt) {
    const err = new Error("This request is no longer waiting for vendor contact.");
    err.code = "request_not_routeable"; err.statusCode = 409; throw err;
  }
  const assertInitialClaim = async () => {
    if (!initialRoutingToken) return;
    const live = await MaintenanceRequest.exists({ _id: request._id,
      status: { $in: ["queued", "approved"] }, archivedAt: null, vendorId: null, selectedVendorId: null,
      "initialRouting.status": "processing", "initialRouting.leaseToken": initialRoutingToken,
      "initialRouting.leaseUntil": { $gt: new Date() } });
    if (!live) {
      const err = new Error("Initial routing was superseded before contact");
      err.code = "initial_routing_superseded"; throw err;
    }
  };
  await assertInitialClaim();
  // Recommendation snapshots written before mock vendors were removed can still
  // hold demo candidates. Every one of them shared a single real inbox, so
  // approving one would email a stranger about a tenant's home.
  if (candidate?.candidateSource === "mock_external" || candidate?.isDemoVendor) {
    const err = new Error("This was a demo vendor and cannot be contacted. Regenerate recommendations from your vendor network.");
    err.code = "demo_vendor_not_contactable";
    err.statusCode = 409;
    throw err;
  }

  const contact = await resolveCandidateContact(candidate);
  const toEmail = contact.email;
  if (!toEmail) {
    const err = new Error("This vendor has no email address on file, so outreach cannot be sent.");
    err.code = "vendor_missing_email";
    err.statusCode = 422;
    throw err;
  }

  let firstContactDecisionId = null;
  if (attempt === 1 && ['policy_auto_start', 'landlord'].includes(initiation)) {
    const authorization = await require('./firstContact.service').claim({ requestId: request._id, landlordId: request.landlordId,
      candidateKey: candidate.candidateKey, mode: initiation === 'policy_auto_start' ? 'policy_auto_start' : 'human_contact', actorUserId, initialRoutingToken });
    firstContactDecisionId = authorization.record?._id || null;
  }

  const timeZone = env.outreach_timezone;
  const tier = resolveOutreachTier(request);
  const vendorProfile = { businessHours: contact.businessHours, operatingHours: contact.operatingHours };
  // Standard and low-priority jobs wait for the vendor's own hours: approving
  // at 6 PM for a vendor who opens at 8 AM schedules the send for 8 AM rather
  // than emailing a closed business (and starting their response clock).
  const timing = resolveSendTiming({ tier, vendor: vendorProfile, now, timeZone });

  const messageBody = stripDraftDisclaimer(draftMessage || candidate.draftMessage || "");
  // A real hash even for a scheduled row whose link is never sent: the sparse
  // unique index on tokenHash still indexes explicit nulls, so two token-less
  // rows would collide. Delivery rotates it to the token actually emailed.
  const placeholder = generateOutreachToken();

  // Every new offer needs a global contractor for the shared booking calendar.
  // Resolution failures stop before delivery and remain recoverable.
  let identityId = null;
  try {
    const { identity, mergeCandidateId } = await ensureVendorIdentity({
      phone: contact.phone,
      email: toEmail,
      name: candidate.name,
      providerName: candidate.providerName,
      providerVendorId: candidate.providerVendorId,
    });
    identityId = identity?._id || null;
    if (mergeCandidateId) {
      console.warn(
        "[sendVendorOutreach] identity merge candidate",
        identityId?.toString(),
        mergeCandidateId.toString()
      );
    }
  } catch (err) {
    console.error("[sendVendorOutreach] identity resolution failed", err.message);
  }

  if (!identityId) {
    const error = new Error("The vendor identity could not be prepared. Please retry.");
    error.code = "vendor_identity_unavailable"; error.statusCode = 503; throw error;
  }
  // The unique indexes claim the attempt and the request before sending, so a
  // duplicate can never produce a duplicate email.
  let outreach;
  try {
    outreach = await VendorOutreach.create({
      requestId: request._id,
      landlordId: request.landlordId,
      tenantId: request.tenantId?._id || request.tenantId,
      vendorId: candidate.vendorId || null,
      identityId,
      candidateKey: candidate.candidateKey,
      providerName: candidate.providerName,
      providerVendorId: candidate.providerVendorId,
      vendorNameSnapshot: candidate.name,
      toEmail,
      attempt,
      bookingVersion: 2,
      ...(env.quote_itemization_enabled ? { quoteContractVersion: 2 } : {}),
      ...(bookingActionToken ? { bookingActionToken } : {}),
      ...(negotiatedProposal ? { negotiatedProposal, authorizedCeiling: negotiatedProposal.amountCents / 100 } : {}),
      tokenHash: placeholder.hash,
      tokenLast4: placeholder.last4,
      status: timing.sendNow ? "queued" : "scheduled",
      initiation,
      firstContactDecisionId,
      scheduledFor: timing.sendNow ? null : timing.scheduledFor,
      tier,
      messageBody,
    });
  } catch (err) {
    if (err?.code === 11000) {
      const duplicate = new Error("Outreach has already been sent to this vendor for this request.");
      duplicate.code = "outreach_already_sent";
      duplicate.statusCode = 409;
      throw duplicate;
    }
    throw err;
  }

  // Identity resolution and row creation can take time. Cancellation or a lost
  await MaintenanceRequest.updateOne({ _id: request._id }, { $set: { bookingVersion: 2 } });
  // lease in that interval must not schedule or send a retired request.
  try { await assertInitialClaim(); } catch (err) {
    await VendorOutreach.updateOne({ _id: outreach._id }, { $set: { status: "revoked" }, $unset: { tokenHash: 1 } });
    throw err;
  }
  if (!timing.sendNow) {
    await applyOutreachToSnapshot({
      requestId: request._id,
      candidateKey: candidate.candidateKey,
      patch: buildOutreachLedgerPatch(outreach),
    });
    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "system",
      actionType: "vendor_outreach_scheduled",
      summary: `${candidate.name} is closed right now — outreach scheduled for ${formatWindowLabel(
        timing.scheduledFor,
        timing.scheduledFor,
        timeZone
      ).split(" – ")[0]}`,
      input: { candidateKey: candidate.candidateKey, attempt, tier, actorUserId: actorUserId || null },
      output: { outreachId: outreach._id.toString(), scheduledFor: timing.scheduledFor.toISOString() },
    });
    return { outreach, delivered: false, scheduled: true, escalateImmediately: false, slaLabel: null, delivery: null };
  }

  return deliverOutreach({
    outreach,
    request,
    candidate,
    contact,
    landlord: providedLandlord,
    now,
  });
}

/**
 * Deliver an outreach row: compute the offer and the response clock AT
 * DELIVERY TIME, mint the link, send the email, project onto the snapshot.
 *
 * Shared by the immediate path above and by the scheduled release
 * (releaseScheduledOutreach in the sweeper), so a Monday 8 AM send offers
 * Monday-relative windows and starts the SLA on Monday, not when the manager
 * clicked Approve on Friday night.
 */
async function deliverOutreach({ outreach, request, candidate, contact: providedContact, landlord: providedLandlord, now = new Date() }) {
  // Recheck persisted review holds when a scheduled email is released.
  const workflowLive = await MaintenanceRequest.findById(request._id);
  if (!workflowLive) throw Object.assign(new Error('Request no longer exists.'),{code:'request_not_routeable',statusCode:409});
  require('../request/requestWorkflow.service').assertContactAllowed(workflowLive);
  await require("../billing/billingAccount.service").bookingSnapshot({ landlordId: request.landlordId, request, now });
  const timeZone = env.outreach_timezone;
  const tier = outreach.tier;
  const name = candidate?.name || outreach.vendorNameSnapshot;
  const candidateKey = candidate?.candidateKey || outreach.candidateKey;
  const contact =
    providedContact ||
    (await resolveCandidateContact({
      ...(candidate || {}),
      vendorId: candidate?.vendorId || outreach.vendorId,
      providerName: candidate?.providerName || outreach.providerName,
      providerVendorId: candidate?.providerVendorId || outreach.providerVendorId,
    }));
  const vendorProfile = { businessHours: contact.businessHours, operatingHours: contact.operatingHours };

  if (outreach.bookingVersion === 2) {
    const live = await MaintenanceRequest.findById(request._id).select("status archivedAt selectedVendorId vendorId +bookingActionToken +bookingActionUntil").lean();
    if (!live || live.archivedAt || ["completed", "rejected", "cancelled", "in_progress", "assigned"].includes(live.status) ||
        (live.selectedVendorId && String(live.selectedVendorId) !== String(outreach.vendorId)) ||
        (live.bookingActionUntil > now && live.bookingActionToken !== outreach.bookingActionToken)) {
      await VendorOutreach.updateOne({ _id: outreach._id }, { $set: { status: "revoked" }, $unset: { tokenHash: 1 } });
      const error = new Error("This request is no longer waiting for contact."); error.code = "request_not_routeable"; throw error;
    }
  }
  const proposal = outreach.negotiatedProposal;
  if (proposal?.start && new Date(proposal.start) <= now) {
    await VendorOutreach.updateOne({ _id: outreach._id }, { $set: { status: "expired" }, $unset: { tokenHash: 1 } });
    const error = new Error("The agreed arrival passed before delivery. Arrange a fresh time.");
    error.code = "proposal_expired"; error.statusCode = 409; throw error;
  }
  const offeredWindows = proposal?.start ? [{ slotId: "negotiated", kind: "window", timeZone,
    start: new Date(proposal.start), end: new Date(new Date(proposal.start).getTime() + proposal.durationMinutes * 60_000),
    label: formatWindowLabel(new Date(proposal.start), new Date(new Date(proposal.start).getTime() + proposal.durationMinutes * 60_000), timeZone) }] :
    buildOfferedWindows({ tier, now, vendor: vendorProfile, timeZone });
  const { responseDeadlineAt, escalateImmediately, slaLabel } = resolveResponseSla({
    tier,
    sentAt: now,
    timeZone,
    vendor: vendorProfile,
  });
  const token = generateOutreachToken();

  outreach.tokenHash = token.hash;
  outreach.tokenLast4 = token.last4;
  outreach.offeredWindows = offeredWindows;
  outreach.responseDeadlineAt = responseDeadlineAt;
  outreach.expiresAt = new Date(responseDeadlineAt.getTime() + EXPIRY_GRACE_MS);

  const landlord =
    providedLandlord ||
    (await Landlord.findById(request.landlordId).select("firstName lastName companyName phone email").lean());

  const brief = buildPublicBrief({
    request,
    outreach,
    landlord,
    property: request.propertyId,
  });

  const { subject, html, text } = buildVendorOutreachEmail({
    vendorName: name,
    brief,
    offeredWindows,
    responseUrl: buildResponseUrl(token.raw),
    responseDeadlineAt,
    tier,
    timeZone,
    messageBody: outreach.messageBody,
    managerName: brief.manager.name,
    managerCompany: brief.manager.company,
    expiresAt: outreach.expiresAt,
    photoCount: brief.photoCount,
  });

  let delivery = { delivered: false, provider: "disabled" };
  const simulation = await require('../judgeSandbox/simulationScope.service').acceptOutreachDelivery({
    outreachId: outreach._id, requestId: request._id, landlordId: request.landlordId, vendorId: outreach.vendorId });
  if (simulation) delivery = simulation;
  else if (env.outreach_email_enabled) {
    const beforeSend = await MaintenanceRequest.findById(request._id);
    if (!beforeSend) throw Object.assign(new Error('Request no longer exists.'),{code:'request_not_routeable',statusCode:409});
    require('../request/requestWorkflow.service').assertContactAllowed(beforeSend);
    delivery = await sendEmail({
      to: outreach.toEmail,
      subject,
      text,
      html,
      categories: ["vendor-outreach"],
      previewUrl: buildResponseUrl(token.raw),
    });
  }

  // A real provider acceptance or an explicitly scoped isolated simulation
  // receipt advances this domain state. Simulation remains separately marked;
  // an ordinary development stub still cannot establish contact.
  const delivered = Boolean(delivery.delivered) && !delivery.stub;
  outreach.simulatedDelivery = delivery.simulated === true;
  outreach.status = delivered ? "sent" : "delivery_failed";
  outreach.deliveryUnconfirmed = !delivered && Boolean(delivery.uncertain);
  outreach.sentAt = delivered ? now : undefined;
  outreach.deliveryProvider = delivery.provider || null;
  outreach.deliveryMessageId = delivery.messageId || null;
  // Every failure carries a reason the manager can read on the request. The
  // switched-off path used to store none, so the panel said only "could not
  // be delivered" -- indistinguishable from a provider rejection, and it
  // logged nothing either.
  outreach.deliveryError = delivered
    ? null
    : delivery.error ||
      (delivery.provider === "disabled"
        ? "Vendor email is switched off on the server, so nothing was sent."
        : "The email provider didn't accept the message.");
  await outreach.save();

  if (!delivered) {
    // No address: this line lands in hosted logs.
    console.warn(
      `[vendorOutreach] delivery failed outreach=${outreach._id} attempt=${outreach.attempt} ` +
        `provider=${delivery.provider || "unknown"}` +
        (delivery.provider === "disabled" ? " (OUTREACH_EMAIL_ENABLED is off)" : "") +
        ` error=${JSON.stringify(outreach.deliveryError)}`
    );
  }

  await applyOutreachToSnapshot({
    requestId: request._id,
    candidateKey,
    patch: buildOutreachLedgerPatch(outreach),
  });

  await logAgentAction({
    requestId: request._id,
    landlordId: request.landlordId,
    actor: delivered ? "ai_agent" : "system",
    actionType: delivered ? "vendor_outreach_sent" : "vendor_outreach_send_failed",
    summary: delivered
      ? `Outreach email sent to ${name} (${getTierLabel(tier)}, reply due in ${slaLabel})`
      : `Outreach email to ${name} failed to send`,
    input: { candidateKey, attempt: outreach.attempt, tier, scheduledFor: outreach.scheduledFor || null },
    output: {
      outreachId: outreach._id.toString(),
      provider: delivery.provider || null,
      vendorId: outreach.vendorId ? String(outreach.vendorId) : null,
      // Masked — the real address is only on the outreach document.
      to: maskEmail(outreach.toEmail),
      responseDeadlineAt: responseDeadlineAt.toISOString(),
      error: delivery.error || null,
    },
  });

  if (escalateImmediately) {
    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "system",
      actionType: "vendor_outreach_escalated",
      summary: `Emergency request escalated for manager attention at outreach time (${slaLabel} SLA)`,
      input: { candidateKey, tier },
      output: { responseDeadlineAt: responseDeadlineAt.toISOString() },
    });
  }

  return { outreach, delivered, scheduled: false, escalateImmediately, slaLabel, delivery, rawToken: token.raw };
}

// Retires the current attempt so its magic link stops resolving, then sends a
// fresh one. Used by the landlord Resend action and by the Slice 4 sweeper.
async function supersedeOutreach(outreach, supersededBy = null) {
  await VendorOutreach.updateOne(
    { _id: outreach._id },
    { $set: { status: "superseded", supersededBy }, $unset: { tokenHash: 1 } }
  );
}

module.exports = {
  MAX_ATTEMPTS,
  hashToken,
  generateOutreachToken,
  buildResponseUrl,
  maskEmail,
  hashOpaque,
  buildOutreachLedgerPatch,
  applyOutreachToSnapshot,
  projectOutreachOntoSnapshot,
  sendVendorOutreach,
  deliverOutreach,
  supersedeOutreach,
  resolveCandidateEmail,
  resolveCandidateContact,
};
