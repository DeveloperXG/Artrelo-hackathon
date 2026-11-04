// A request's lifecycle label -- the status chip on the request page, the
// Requests table and its status filter -- decided once, on the server.
//
// It was derived three times (here, and twice in the frontend) and the copies
// drifted: this one never learned `outreach_scheduled`, and all three kept
// reading "Approved" after every vendor had declined or been turned down,
// because a retired vendor keeps contactApproval "approved" from before. The
// landlord payloads now carry it as `lifecycleStatus`, and the page shows it.
//
// Pure: no I/O.

const { getActiveCandidate, getSnapshotCandidates } = require("../vendor/vendorSnapshot.service");
const { hasEngagedContactCandidate } = require("./routingGuidance.service");

const TERMINAL_STATUSES = ["completed", "rejected", "cancelled"];
const ROUTABLE_STATUSES = ["queued", "approved"];

// Broad on purpose, and only for the tenant's label: from the tenant's side,
// once the landlord has approved contacting anyone the request is "approved",
// whatever has happened between the landlord and vendors since.
const hasApprovedContactCandidate = (snapshot) =>
  getSnapshotCandidates(snapshot).some(
    (candidate) =>
      candidate?.state === "approved_for_contact" || candidate?.contactApproval?.status === "approved"
  );

const hasSelectedCandidate = (snapshot) =>
  Boolean(snapshot?.selectedCandidateKey) ||
  getSnapshotCandidates(snapshot).some((candidate) => candidate?.state === "selected");

const hasScheduledOutreach = (snapshot) =>
  getSnapshotCandidates(snapshot).some((candidate) => candidate?.outreach?.status === "scheduled");

/**
 * @param audience "landlord" says where the request is in vendor routing, in
 *   this order:
 *     outreach_scheduled  approved, waiting on the vendor's opening hours
 *     needs_approval      waiting on the manager: the next vendor, a
 *                         first-time vendor, or an over-quota quote
 *     contacting_vendor   a vendor has been emailed; waiting on their answer
 *     needs_vendor        paused with nobody being contacted
 *     approved            approved, but no vendor search has run yet
 *   "approved" used to cover all of these: it is the raw status, set the
 *   first time contact is approved and never cleared, so the tag read
 *   "Approved" through declines, re-approvals and turned-down quotes.
 *   "tenant" keeps the tenant's simpler view, unchanged.
 */
function deriveRequestLifecycleStatus(request, { audience = "tenant" } = {}) {
  if (!request) return "queued";
  const { status } = request;
  // Derived, not stored: the raw status stays "rejected" until the landlord
  // decides the appeal, but both sides need to see it is waiting on someone.
  if (status === "rejected" && request.isAppealed) return "appeal_pending";
  if (TERMINAL_STATUSES.includes(status)) return status;
  if (status === "in_progress") return "in_progress";

  const snapshot = request.vendorRecommendationSnapshot;
  if (status === "assigned" || request.vendorId || hasSelectedCandidate(snapshot)) return "assigned";

  if (audience !== "landlord") {
    return status === "approved" || hasApprovedContactCandidate(snapshot) ? "approved" : "queued";
  }

  if (hasScheduledOutreach(snapshot)) return "outreach_scheduled";

  const routing = snapshot && ROUTABLE_STATUSES.includes(status);
  // Before "contacting": a vendor whose over-quota quote is waiting on the
  // manager has been contacted, but the next move is the manager's.
  if (routing && request.routingStatus === "approval_needed") return "needs_approval";
  if (routing && getActiveCandidate(snapshot)) return "contacting_vendor";
  if (routing && request.routingStatus === "paused") return "needs_vendor";
  if (status === "approved" || hasEngagedContactCandidate(snapshot)) return "approved";
  return "queued";
}

module.exports = { deriveRequestLifecycleStatus };
