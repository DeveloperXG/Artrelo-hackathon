// The rejection -> appeal lifecycle, in one place.
//
//   rejected ──(tenant appeals within the window, once)──▶ appeal pending
//      │                                                      │
//      ├─(landlord withdraws the rejection)──▶ queued ◀──(landlord accepts)
//      │                                                      │
//      └─(window closes, no appeal: hourly sweep)  (landlord declines)──▶ deleted
//
// A request gets ONE appeal (`appealUsed` survives the reopen), so rejecting a
// reopened request again is final at once rather than opening another round.
//
// Every transition is a single conditional write (findOneAndUpdate /
// findOneAndDelete with the state it expects), so a tenant appealing at the
// same moment the landlord withdraws cannot both win.
//
// The appeal state the pages render is computed here, on the server, rather
// than from appealWindowExpiresAt in the browser, so a skewed client clock can
// neither show a dead Appeal button nor hide a live one.

const env = require("../../config/env");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const Tenant = require("../../models/Tenant");
const { logAgentAction } = require("../audit/agentAction.service");
const { notifyUser } = require("../notification/notify.service");
const {
  buildRequestRejectedEmail,
  buildRequestReopenedEmail,
  buildRequestFinalRejectionEmail,
} = require("../notification/templates/requestDecisionEmail");
const { deleteRequestsWithCascade } = require("./rejectedRequestCleanup.service");
const { getQuotaUsage } = require("./requestQuota.service");

const APPEAL_WINDOW_HOURS = 48;
const APPEAL_NOTE_MAX = 1000;
const REASON_MAX = 1000;

class AppealError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const appBase = () => String(env.app_public_url || "http://localhost:3000").replace(/\/+$/, "");
const tenantRequestUrl = (requestId) => `${appBase()}/portal/requests/${requestId}`;
const tenantPortalUrl = () => `${appBase()}/portal`;

const isWindowOpen = (request, now) =>
  Boolean(request?.appealWindowExpiresAt) && new Date(request.appealWindowExpiresAt).getTime() > new Date(now).getTime();

/**
 * What the pages may show and offer for a request's rejection/appeal. Pure.
 *
 *   state  none      not rejected (or a legacy rejection with no window)
 *          available rejected, window open, no appeal yet
 *          pending   the tenant appealed; waiting on the landlord
 *          expired   the window closed with no appeal (the sweep deletes it)
 *   canAppeal      the tenant's Appeal button
 *   canReopen      the landlord's Withdraw rejection / Accept appeal
 *   rejectIsFinal  rejecting now would be final (the one appeal is spent)
 */
function buildAppealState(request, now = new Date()) {
  const rejectIsFinal = Boolean(request?.appealUsed);
  const base = {
    state: "none",
    canAppeal: false,
    canReopen: false,
    rejectIsFinal,
    rejectedAt: request?.rejectedAt || null,
    windowExpiresAt: request?.appealWindowExpiresAt || null,
    note: request?.appealNote || null,
    appealedAt: request?.appealedAt || null,
  };
  if (!request || request.status !== "rejected") return base;

  if (request.isAppealed) return { ...base, state: "pending", canReopen: true };
  if (!request.appealWindowExpiresAt) return base;
  if (!isWindowOpen(request, now)) return { ...base, state: "expired" };
  return { ...base, state: "available", canAppeal: !request.appealUsed, canReopen: true };
}

const loadTenantContact = (tenantId) =>
  Tenant.findById(tenantId).select("firstName email unit notificationPreferences").lean();

// Email only when the tenant hasn't turned email off.
const emailOf = (tenant) => (tenant && tenant.notificationPreferences?.email !== false ? tenant.email : undefined);

// A free-text reason as one sentence: landlords often end it with a full stop
// already, and "upkeep.." reads as a typo.
const asSentence = (text) => `${String(text || "").trim().replace(/[.!?]+$/, "")}.`;

const clip = (text, max) => {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const hoursFromNow = (date, now) => {
  const hours = Math.ceil((new Date(date).getTime() - new Date(now).getTime()) / 3600000);
  if (hours <= 1) return "in about an hour";
  if (hours < 48) return `in about ${hours} hours`;
  return `in about ${Math.round(hours / 24)} days`;
};

/**
 * The tenant's "what now" after a final rejection. Careful about the limits:
 * the honest answer to "can I just send it again?" is "yes, but it costs a
 * request, and unchanged it will likely be rejected again".
 */
function finalRejectionNextSteps(quota, now = new Date()) {
  let limitLine;
  if (!quota) {
    limitLine = "Each new request uses one of your daily and weekly request limits.";
  } else if (quota.blocked && quota.nextAvailableAt) {
    limitLine = `You're at your request limit right now (${quota.daily.used} of ${quota.daily.limit} today, ${quota.weekly.used} of ${quota.weekly.limit} this week). Your next request is available ${hoursFromNow(
      quota.nextAvailableAt,
      now
    )}.`;
  } else {
    limitLine = `It uses 1 of your request limit: you've used ${quota.daily.used} of ${quota.daily.limit} today and ${quota.weekly.used} of ${quota.weekly.limit} this week.`;
  }
  return [
    "This request is closed and can't be appealed again.",
    `If the problem is still happening or has changed, send a new request describing what's different, such as new photos or new symptoms. ${limitLine}`,
    "If you disagree with the decision, contact your property manager directly. Sending the same issue again unchanged will likely be rejected again.",
    "Emergencies (a gas smell, flooding, no heat, sparking or exposed wiring) are never limited. Report them any time, and call emergency services if anyone is in danger.",
  ];
}

// ---------------------------------------------------------------- notifications

async function notifyTenantRejected(request) {
  const tenant = await loadTenantContact(request.tenantId);
  const email = buildRequestRejectedEmail({
    firstName: tenant?.firstName,
    issueTitle: request.issueTitle,
    reason: request.rejectionReason,
    appealWindowHours: APPEAL_WINDOW_HOURS,
    url: tenantRequestUrl(request._id),
  });
  return notifyUser({
    userId: request.tenantId,
    type: "request_rejected",
    title: "Your request was rejected",
    message: clip(
      `"${request.issueTitle}" was rejected. Reason: ${asSentence(request.rejectionReason)} You have ${APPEAL_WINDOW_HOURS} hours to appeal once.`,
      1000
    ),
    metadata: { workOrderId: request._id.toString(), priority: "high" },
    email: emailOf(tenant),
    emailSubject: email.subject,
    emailHtml: email.html,
    emailText: email.text,
    emailCategory: "request_rejected",
  });
}

// ---------------------------------------------------------------- transitions

/**
 * The tenant's one appeal. Throws AppealError on refusal.
 */
async function submitAppeal({ requestId, tenantId, note, now = new Date() }) {
  const text = String(note || "").trim();
  if (!text) throw new AppealError(400, "appeal_note_required", "Tell your property manager why the request should be reconsidered.");
  if (text.length > APPEAL_NOTE_MAX) {
    throw new AppealError(400, "appeal_note_too_long", `Appeals must be ${APPEAL_NOTE_MAX} characters or fewer.`);
  }

  const at = new Date(now);
  const updated = await MaintenanceRequest.findOneAndUpdate(
    {
      _id: requestId,
      tenantId,
      status: "rejected",
      isAppealed: { $ne: true },
      appealUsed: { $ne: true },
      appealWindowExpiresAt: { $gt: at },
    },
    {
      $set: { isAppealed: true, appealUsed: true, appealNote: text, appealedAt: at },
      $push: { timeline: { status: "rejected", note: `Appeal submitted: ${text}`, actorRole: "tenant", actorId: tenantId, at } },
    },
    { new: true }
  );

  if (!updated) {
    // Say WHY, from the request as it is now.
    const current = await MaintenanceRequest.findOne({ _id: requestId, tenantId })
      .select("status isAppealed appealUsed appealWindowExpiresAt")
      .lean();
    if (!current) throw new AppealError(404, "request_not_found", "Request not found");
    if (current.status !== "rejected") throw new AppealError(409, "appeal_not_allowed", "Only rejected requests can be appealed.");
    if (current.isAppealed) throw new AppealError(409, "appeal_already_submitted", "You've already appealed this request.");
    if (current.appealUsed) throw new AppealError(409, "appeal_already_used", "This request has already had its appeal.");
    throw new AppealError(409, "appeal_window_closed", "The appeal window for this request has closed.");
  }

  await logAgentAction({
    requestId: updated._id,
    landlordId: updated.landlordId,
    actor: "tenant",
    actionType: "request_appealed",
    summary: "Tenant appealed the rejection",
    input: { note: text },
    output: { rejectionReason: updated.rejectionReason, appealedAt: at },
  });
  if (updated.landlordId) {
    notifyUser({
      userId: updated.landlordId,
      type: "request_appeal_submitted",
      title: "A tenant appealed a rejection",
      message: clip(`The tenant appealed "${updated.issueTitle}": ${text}`, 1000),
      metadata: { workOrderId: updated._id.toString(), priority: "high" },
    });
  }
  return updated;
}

/**
 * Withdraw a rejection (no appeal yet, window open) or accept the appeal. The
 * request goes back to queued with routing reset and a fresh history, exactly
 * like a new request -- but it is the same request, so it spends no new slot
 * of the tenant's limits and its links and photos keep working.
 */
async function reopenRejectedRequest({ requestId, landlordId, actorId, note = "", now = new Date() }) {
  const at = new Date(now);
  const request = await MaintenanceRequest.findOne({ _id: requestId, landlordId }).lean();
  if (!request) throw new AppealError(404, "request_not_found", "Request not found");
  const appeal = buildAppealState(request, at);
  if (!appeal.canReopen) {
    throw new AppealError(
      409,
      "request_not_reopenable",
      request.status === "rejected"
        ? "The appeal window has closed, so this rejection can no longer be withdrawn."
        : "Only a rejected request can be reopened."
    );
  }

  // A request belongs to the unit, not the person: reopening work for someone
  // who has since left would put a stranger's job back in the new tenant's way.
  const tenant = await loadTenantContact(request.tenantId);
  if (!tenant || String(tenant.unit || "") !== String(request.unitId || "")) {
    throw new AppealError(409, "tenant_left_unit", "The tenant who sent this request no longer lives in the unit.");
  }

  const wasAppeal = Boolean(request.isAppealed);
  const landlordNote = String(note || "").trim().slice(0, 500);
  const seed = [
    wasAppeal ? "Reopened after the tenant's appeal." : "Rejection withdrawn by the landlord.",
    `Previously rejected: ${asSentence(request.rejectionReason || "no reason given")}`,
    wasAppeal && request.appealNote ? `Tenant's appeal: ${request.appealNote}` : "",
    landlordNote ? `Landlord's note: ${landlordNote}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const updated = await MaintenanceRequest.findOneAndUpdate(
    {
      _id: requestId,
      landlordId,
      status: "rejected",
      ...(wasAppeal ? { isAppealed: true } : { isAppealed: { $ne: true }, appealWindowExpiresAt: { $gt: at } }),
    },
    {
      // Routing starts over as if the request were new. Clearing the snapshot
      // alone is not enough: the quota raised for the first round would cap the
      // second, and a vendor's old quote would read as the estimate.
      $set: {
        status: "queued",
        routingStatus: "pending",
        vendorRecommendationSnapshot: null,
        vendorRecommendation: null,
        selectedVendorId: null,
        vendorId: null,
        quotaOverride: null,
        estimatedCost: 0,
        appointmentStatus: "none",
        isAppealed: false,
        reopenedAt: at,
        initialRouting: { status: "pending", attempts: 0, nextAttemptAt: at,
          cleanupBefore: at, requiresContactReview: true },
        // Fresh history: one seed entry that keeps the context of why.
        timeline: [{ status: "queued", note: seed, actorRole: "landlord", actorId, at }],
      },
      $unset: {
        rejectionReason: "",
        rejectedAt: "",
        appealWindowExpiresAt: "",
        appealNote: "",
        appealedAt: "",
        routingDecision: "",
        quotaSnapshot: "",
        eta: "",
      },
    },
    { new: true }
  );
  if (!updated) {
    throw new AppealError(409, "request_not_reopenable", "This request changed while you were looking at it. Refresh and try again.");
  }

  // Cleanup and search belong to the durable worker. A crash here must not
  // strand the reopened request, and search must never race cleanup. No vendor
  // is engaged on a rejectable request; the closed rounds' audit is retained.

  await logAgentAction({
    requestId: updated._id,
    landlordId,
    actor: "landlord",
    actionType: wasAppeal ? "request_appeal_accepted" : "request_rejection_withdrawn",
    summary: wasAppeal ? "Landlord accepted the appeal and reopened the request" : "Landlord withdrew the rejection",
    input: { note: landlordNote || undefined },
    output: {
      status: updated.status,
      previousRejectionReason: request.rejectionReason,
      appealNote: request.appealNote || undefined,
      vendorSearchQueued: true,
      previousQuotaOverride: request.quotaOverride ?? undefined,
    },
  });

  const email = buildRequestReopenedEmail({
    firstName: tenant.firstName,
    issueTitle: updated.issueTitle,
    wasAppeal,
    url: tenantRequestUrl(updated._id),
  });
  notifyUser({
    userId: updated.tenantId,
    type: "request_reopened",
    title: wasAppeal ? "Your appeal was accepted" : "Your request was reopened",
    message: `"${updated.issueTitle}" is back in the queue. It doesn't use another of your requests.`,
    metadata: { workOrderId: updated._id.toString(), priority: "normal" },
    email: emailOf(tenant),
    emailSubject: email.subject,
    emailHtml: email.html,
    emailText: email.text,
    emailCategory: "request_reopened",
  });

  return { request: updated, wasAppeal };
}

/**
 * Close a request for good: delete it (and everything hanging off it) from
 * both portals, keep one private audit record, and tell the tenant why and what
 * they can do next.
 *
 * `filter` is the state the caller expects the request to be in; the delete is
 * conditional on it, so a request that changed underneath returns null and is
 * left alone. `kind` is "appeal_declined" or "rejected_after_appeal".
 */
async function finalizeRejection({ filter, reason, kind, actorId, now = new Date() }) {
  const deleted = await MaintenanceRequest.findOneAndDelete(filter).lean();
  if (!deleted) return null;
  await deleteRequestsWithCascade([deleted._id], { label: "finalizeRejection" });

  // The tombstone. No requestId, so the cascade above (and any later one)
  // leaves it alone: if the tenant ever says "I reported this and it vanished",
  // the landlord still has what was reported, what was decided, and when.
  await logAgentAction({
    requestId: null,
    landlordId: deleted.landlordId,
    actor: "landlord",
    actionType: "request_finally_rejected",
    summary: `Request "${deleted.issueTitle}" was finally rejected and removed`,
    input: { reason },
    metadata: {
      kind,
      actorId,
      deletedRequestId: String(deleted._id),
      tenantId: deleted.tenantId ? String(deleted.tenantId) : null,
      propertyId: deleted.propertyId ? String(deleted.propertyId) : null,
      unitId: deleted.unitId ? String(deleted.unitId) : null,
      issueTitle: deleted.issueTitle,
      issueDescription: clip(deleted.issueDescription, 2000),
      category: deleted.category,
      firstRejectionReason: deleted.rejectionReason || null,
      appealNote: deleted.appealNote || null,
      createdAt: deleted.createdAt,
      rejectedAt: deleted.rejectedAt || null,
      appealedAt: deleted.appealedAt || null,
      finalizedAt: new Date(now),
    },
  });

  const [tenant, quota] = await Promise.all([
    loadTenantContact(deleted.tenantId),
    getQuotaUsage(deleted.tenantId, now).catch(() => null),
  ]);
  const lead =
    kind === "appeal_declined"
      ? `Your property manager reviewed your appeal for "${deleted.issueTitle}" and kept their decision.`
      : `Your property manager rejected "${deleted.issueTitle}" again. It already had its one appeal, so this decision is final.`;
  const nextSteps = finalRejectionNextSteps(quota, now);
  const email = buildRequestFinalRejectionEmail({
    firstName: tenant?.firstName,
    issueTitle: deleted.issueTitle,
    lead,
    reason,
    nextSteps,
    url: tenantPortalUrl(),
  });
  // No workOrderId: the request is gone, and the cascade deletes notifications
  // by that field. The message carries everything the tenant needs.
  const head = `${lead} Reason: ${clip(reason, 300)}\n\nWhat you can do next:\n`;
  // Awaited (notifyUser never throws): this notice is the only trace of the
  // request the tenant has left, so it must exist once the response is sent.
  await notifyUser({
    userId: deleted.tenantId,
    type: "request_rejected_final",
    title: kind === "appeal_declined" ? "Your appeal was declined" : "Final decision on your request",
    message: clip(head + nextSteps.map((step) => `• ${step}`).join("\n"), 1000),
    metadata: { priority: "high" },
    email: emailOf(tenant),
    emailSubject: email.subject,
    emailHtml: email.html,
    emailText: email.text,
    emailCategory: "request_rejected_final",
  });

  return deleted;
}

async function declineAppeal({ requestId, landlordId, actorId, reason, now = new Date() }) {
  const text = String(reason || "").trim();
  if (!text) throw new AppealError(400, "reason_required", "Tell the tenant why the appeal is declined.");
  if (text.length > REASON_MAX) throw new AppealError(400, "reason_too_long", `Reasons must be ${REASON_MAX} characters or fewer.`);

  const deleted = await finalizeRejection({
    filter: { _id: requestId, landlordId, status: "rejected", isAppealed: true },
    reason: text,
    kind: "appeal_declined",
    actorId,
    now,
  });
  if (!deleted) {
    const exists = await MaintenanceRequest.exists({ _id: requestId, landlordId });
    if (!exists) throw new AppealError(404, "request_not_found", "Request not found");
    throw new AppealError(409, "no_pending_appeal", "There is no appeal waiting on this request.");
  }
  return deleted;
}

module.exports = {
  APPEAL_WINDOW_HOURS,
  AppealError,
  buildAppealState,
  finalRejectionNextSteps,
  notifyTenantRejected,
  submitAppeal,
  reopenRejectedRequest,
  finalizeRejection,
  declineAppeal,
};
