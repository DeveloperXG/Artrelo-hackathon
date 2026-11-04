// Shared helpers for reading and rewriting `MaintenanceRequest.vendorRecommendationSnapshot`.
//
// The snapshot is Schema.Types.Mixed, so Mongoose cannot track nested edits.
// The idiom throughout the codebase is: cloneSnapshot -> mutate the clone ->
// rebuildSnapshotSections -> reassign the whole field -> save().
//
// These live here (rather than inside request.controller.js) so the outreach
// services can use exactly the same implementation instead of a second,
// drifting copy.

const { groupLedger } = require("./vendorRecommendation.service");

const ACTIVE_CANDIDATE_STATES = ["approved_for_contact", "selected"];

const cloneSnapshot = (snapshot) => JSON.parse(JSON.stringify(snapshot || null));

const getSnapshotCandidates = (snapshot) => {
  if (Array.isArray(snapshot?.candidateLedger) && snapshot.candidateLedger.length) {
    return snapshot.candidateLedger;
  }

  return [
    ...(Array.isArray(snapshot?.recommendations) ? snapshot.recommendations : []),
    ...(Array.isArray(snapshot?.eligibleButNotTopCandidates)
      ? snapshot.eligibleButNotTopCandidates
      : []),
    ...(Array.isArray(snapshot?.heldCandidates) ? snapshot.heldCandidates : []),
    ...(Array.isArray(snapshot?.excludedCandidates) ? snapshot.excludedCandidates : []),
  ];
};

const getActiveCandidate = (snapshot) =>
  Array.isArray(snapshot?.candidateLedger)
    ? snapshot.candidateLedger.find((candidate) =>
        ACTIVE_CANDIDATE_STATES.includes(candidate.state)
      )
    : null;

// Strict lookup for WRITES. Unlike the controller's findSnapshotCandidate, this
// matches candidateKey only and never falls back to the merged section arrays —
// mutating an object that isn't in candidateLedger silently loses the write.
const findLedgerEntry = (snapshot, candidateKey) =>
  (Array.isArray(snapshot?.candidateLedger) ? snapshot.candidateLedger : []).find(
    (candidate) => candidate.candidateKey === candidateKey
  ) || null;

// A closed outreach round ends with the declined vendor retired and everyone
// else still parked in `held` by applyHoldStateToRemainingCandidates. That is
// the wrong shape for the next round: `held` entries render in a collapsed
// section with no Approve action, and activateCandidateState refuses them
// outright — so the very candidate the fallback approval names cannot be
// activated. Re-deal the remaining queue exactly as a fresh generation would.
//
// Mirrors the topK split in buildScoredLedgerEntries so a requeued round and a
// freshly generated one produce identical display groups. Only untouched
// candidates are re-dealt; anything already contacted, excluded, rejected, or
// active keeps the state it earned.
const REQUEUEABLE_STATES = ["held", "recommended", "pending"];

const requeueCandidatesForNextRound = (snapshot, { topK = 3 } = {}) => {
  const ledger = Array.isArray(snapshot?.candidateLedger) ? snapshot.candidateLedger : [];

  // No hasEmail filter here, deliberately: a vendor with no address on file is
  // still worth showing as a backup the manager can dispatch by hand. Only
  // pickNextCandidate, which chooses who receives an automated email, screens
  // on it.
  ledger
    .filter(
      (entry) =>
        REQUEUEABLE_STATES.includes(entry.state) &&
        (entry.outreach?.status || "not_sent") === "not_sent"
    )
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .forEach((entry, index) => {
      const isRecommended = index < topK;
      entry.state = isRecommended ? "recommended" : "pending";
      entry.displayGroup = isRecommended ? "recommended" : "eligible_not_top_k";
      entry.holdReason = null;
    });

  return snapshot;
};

// Derived outreach summary for the snapshot root. Recomputed on every rebuild,
// so it self-heals and can never drift from the ledger.
const buildSnapshotOutreachSummary = (snapshot) => {
  const active = getActiveCandidate(snapshot);
  if (!active?.outreach || active.outreach.status === "not_sent") return null;
  return {
    activeCandidateKey: active.candidateKey,
    status: active.outreach.status,
    attempt: active.outreach.attempt || 0,
    lastSentAt: active.outreach.sentAt || null,
    responseDeadlineAt: active.outreach.responseDeadlineAt || null,
  };
};

/**
 * Writes an approved quota increase into the snapshot's decision block.
 *
 * `decision` is produced once at generation and normally left frozen, which is
 * correct for the routing *action* — but `quotaLimit` is a fact about the
 * request, not a record of what was decided. When a vendor-quote approval
 * raises the limit we deliberately skip regeneration (it would replace the
 * whole Mixed field and destroy the ledger), so without this the decision block
 * keeps advertising the old limit and every consumer of it disagrees with
 * `request.quotaOverride`.
 *
 * Mutates and returns the snapshot; the caller reassigns and saves.
 */
const applyQuotaLimitToSnapshot = (snapshot, newLimit) => {
  if (!snapshot) return snapshot;
  // Guard before coercing: Number("") and Number(null) are both 0, which would
  // silently write a $0 quota. Zero itself is a legitimate limit, so it has to
  // survive — only genuinely absent or non-numeric input is rejected.
  if (newLimit === null || newLimit === undefined || String(newLimit).trim() === "") {
    return snapshot;
  }
  const parsed = Number(newLimit);
  if (!Number.isFinite(parsed) || parsed < 0) return snapshot;

  snapshot.decision = { ...(snapshot.decision || {}), quotaLimit: parsed };
  return snapshot;
};

// A regeneration rebuilds every candidate, drafts included. A draft the
// manager edited and saved (draftEditedAt, set by updateVendorRecommendationDraft)
// is their words, not a template: carry it onto the same candidate in the new
// ledger. Mutates and returns `next`; candidates absent from `previous` keep the
// freshly generated draft.
const carryOverEditedDrafts = (previous, next) => {
  const edited = new Map(
    getSnapshotCandidates(previous)
      .filter((candidate) => candidate?.draftEditedAt && candidate?.draftMessage)
      .map((candidate) => [candidate.candidateKey, candidate])
  );
  if (!edited.size) return next;
  for (const candidate of Array.isArray(next?.candidateLedger) ? next.candidateLedger : []) {
    const prior = edited.get(candidate.candidateKey);
    if (!prior) continue;
    candidate.draftMessage = prior.draftMessage;
    candidate.draftEditedAt = prior.draftEditedAt;
  }
  return next;
};

const rebuildSnapshotSections = (snapshot) => {
  const candidateLedger = Array.isArray(snapshot?.candidateLedger) ? snapshot.candidateLedger : [];
  const groups = groupLedger(candidateLedger);
  snapshot.recommendations = groups.recommendations;
  snapshot.eligibleButNotTopCandidates = groups.eligibleButNotTopCandidates;
  snapshot.excludedCandidates = groups.excludedCandidates;
  snapshot.heldCandidates = groups.heldCandidates;
  const activeCandidate = getActiveCandidate(snapshot);
  snapshot.activeCandidateKey = activeCandidate?.candidateKey || null;
  snapshot.selectedCandidateKey =
    candidateLedger.find((candidate) => candidate.state === "selected")?.candidateKey || null;
  snapshot.outreach = buildSnapshotOutreachSummary(snapshot);
  return snapshot;
};

module.exports = {
  ACTIVE_CANDIDATE_STATES,
  cloneSnapshot,
  getSnapshotCandidates,
  getActiveCandidate,
  findLedgerEntry,
  requeueCandidatesForNextRound,
  rebuildSnapshotSections,
  carryOverEditedDrafts,
  buildSnapshotOutreachSummary,
  applyQuotaLimitToSnapshot,
};
