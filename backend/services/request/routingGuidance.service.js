// What the manager can do with a request's routing right now, decided once.
//
// These rules used to live twice: the server enforced them and the request
// page re-derived them in TypeScript to decide what to show. The copies
// drifted -- the page offered Regenerate the server refused, and hid Reject
// after the server had started allowing it. Now the server is the only
// author: assertRequestRouteableForRecommendations and the reject endpoint
// enforce these functions, and the landlord's request payloads carry their
// answers as `routingGuidance` for the page to show as-is.
//
// Pure: no I/O. Whether a selected vendor's booking is still live is the one
// fact that needs the database, so callers pass it in.

const env = require("../../config/env");
const { getActiveCandidate, getSnapshotCandidates } = require("../vendor/vendorSnapshot.service");
const { getPauseKind } = require("./decisionQueue.service");

// Outreach statuses that close a round for a given vendor.
const CLOSED_OUTREACH_STATUSES = ["declined", "expired", "superseded", "revoked"];

// A vendor who declined, timed out or was turned down is retired to one of
// these but keeps contactApproval "approved" from before.
const RETIRED_CANDIDATE_STATES = ["excluded", "manager_rejected"];

const REJECTABLE_STATUSES = ["pending", "queued", "approved"];
// The statuses a request can still be routed in (the generate guard's rule).
const ROUTABLE_STATUSES = ["queued", "approved"];

/**
 * A vendor who was approved and is still in play -- what blocks rejecting a
 * request. A retired vendor's leftover contactApproval does not count;
 * reading it as "engaged" blocked rejection forever once any vendor had ever
 * been approved, even with every vendor gone.
 */
const hasEngagedContactCandidate = (snapshot) =>
  getSnapshotCandidates(snapshot).some(
    (candidate) =>
      !RETIRED_CANDIDATE_STATES.includes(candidate?.state) &&
      (candidate?.state === "approved_for_contact" || candidate?.contactApproval?.status === "approved")
  );

const isRejectable = (request) =>
  REJECTABLE_STATUSES.includes(request?.status) &&
  !hasEngagedContactCandidate(request?.vendorRecommendationSnapshot);

/**
 * Why a fresh search must wait while the outreach loop is mid-round.
 *
 * A decline closes one round and opens the next; it also clears the active
 * candidate, so without this a regeneration could rebuild the ledger and
 * re-offer the vendor who just declined. The loop is live while some vendor
 * has closed a round, someone is left to contact, and routing hasn't paused.
 *
 * It used to say "Vendor outreach is still running" even when nothing was
 * running and the request was simply waiting on the manager to approve the
 * next vendor. It now says which of the two it is.
 */
const getOutreachLoopLockReason = (request) => {
  // With a vendor active, the request is waiting on THAT vendor, and the
  // active-candidate guard says so by name.
  if (getActiveCandidate(request?.vendorRecommendationSnapshot)) return "";

  const ledger = getSnapshotCandidates(request?.vendorRecommendationSnapshot);
  const roundClosed = ledger.some((candidate) =>
    CLOSED_OUTREACH_STATUSES.includes(candidate?.outreach?.status)
  );
  if (!roundClosed) return "";
  if (request.routingStatus === "paused") return "";

  const next = ledger.find(
    (candidate) =>
      ["recommended", "pending", "held"].includes(candidate.state) &&
      (candidate.outreach?.status || "not_sent") === "not_sent"
  );
  if (!next) return "";

  if (request.routingStatus === "approval_needed") {
    return `Waiting on your approval to contact ${next.name}. Approve or decline that vendor before searching again.`;
  }
  return `${next.name} is next in line for this request. Approve contact or turn them down before searching again.`;
};

/**
 * "X is being contacted", or for a scheduled send "outreach to X is scheduled
 * for Mon, Oct 5, 8:00 AM — cancel it first", so the manager knows both why
 * and what to do.
 */
const activeCandidateLockMessage = (candidate, prefix) => {
  const name = candidate?.name || "a vendor";
  const scheduledFor = candidate?.outreach?.status === "scheduled" ? candidate.outreach.scheduledFor : null;
  if (scheduledFor) {
    const when = new Intl.DateTimeFormat("en-CA", {
      timeZone: env.outreach_timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(scheduledFor));
    // The time never ends the sentence: en-CA writes "9:00 a.m.", and a
    // closing period after it printed "a.m..".
    return `${prefix}: outreach to ${name} is scheduled for ${when} — cancel the scheduled send first.`;
  }
  return `${prefix} while ${name} is being contacted for this request.`;
};

/**
 * Why a fresh vendor search is refused, or "" when it can run.
 *
 * `selectionIsLive`: whether request.selectedVendorId still has a live
 * booking behind it. A selection without one is stale and is released before
 * generating (releaseStaleVendorSelection), so it must not be reported as a
 * block. The generate endpoint runs that release first, so by then any
 * remaining selection is live -- hence the default.
 */
const getRegenerateBlockReason = (request, { selectionIsLive = true } = {}) => {
  if (!request) return "Request not found.";

  if (["completed", "rejected", "cancelled"].includes(request.status)) {
    return `Vendor recommendations cannot be generated for ${request.status} requests.`;
  }
  if (request.status === "in_progress") {
    return "Vendor recommendations cannot be generated while a request is in progress.";
  }
  if (!["queued", "approved"].includes(request.status)) {
    return "Vendor recommendations cannot be generated for this request.";
  }

  const loopLockReason = getOutreachLoopLockReason(request);
  if (loopLockReason) return loopLockReason;

  const activeCandidate = getActiveCandidate(request.vendorRecommendationSnapshot);
  if (activeCandidate) {
    return activeCandidateLockMessage(activeCandidate, "Vendor recommendations cannot be refreshed");
  }
  if (request.selectedVendorId && selectionIsLive) {
    return "Vendor recommendations cannot be refreshed while a selected vendor candidate exists.";
  }
  if (request.vendorId) {
    return "Vendor recommendations cannot be refreshed while a vendor is already assigned to the request.";
  }
  return "";
};

/**
 * The answers the landlord's request page shows. `regenerate` is left out of
 * list payloads (pass includeRegenerate: false): the list never shows it, and
 * it would need a booking lookup per row.
 */
const buildRoutingGuidance = (request, { selectionIsLive = false, includeRegenerate = true } = {}) => {
  const snapshot = request?.vendorRecommendationSnapshot;
  const guidance = {
    contactBlockReason: require('./requestWorkflow.service').holdReason(request),
    rejectable: isRejectable(request),
    // Only a request that can still be routed is "paused". Rejecting a request
    // also sets routingStatus "paused", and a rejected request reporting why
    // routing paused put the "every vendor tried" banner on a closed request.
    pauseKind:
      request?.routingStatus === "paused" && snapshot && ROUTABLE_STATUSES.includes(request?.status)
        ? getPauseKind(snapshot)
        : null,
  };
  if (includeRegenerate) {
    guidance.regenerateBlockReason = getRegenerateBlockReason(request, { selectionIsLive });
  }
  return guidance;
};

module.exports = {
  CLOSED_OUTREACH_STATUSES,
  activeCandidateLockMessage,
  buildRoutingGuidance,
  getOutreachLoopLockReason,
  getRegenerateBlockReason,
  hasEngagedContactCandidate,
  isRejectable,
};
