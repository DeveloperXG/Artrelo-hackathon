export interface VendorContactCandidateState {
  candidateKey: string;
  name: string;
  draftMessage?: string;
  state?: string;
  contactApproval?: {
    status?: string;
  };
  outreach?: {
    status?: string;
    scheduledFor?: string | null;
  };
}

/** The send waiting for a closed vendor's opening, if there is one. */
export function getScheduledOutreachCandidate(snapshot?: VendorContactSnapshotState | null) {
  return (
    (snapshot?.candidateLedger || []).find((candidate) => candidate.outreach?.status === 'scheduled') || null
  );
}

export interface VendorContactSnapshotState {
  recommendations?: VendorContactCandidateState[];
  candidateLedger?: VendorContactCandidateState[];
  approvalRequest?: {
    candidateKey?: string;
    status?: string;
  } | null;
  activeCandidateKey?: string | null;
  selectedCandidateKey?: string | null;
}

export type VendorContactActionState =
  | { kind: 'available'; candidate: VendorContactCandidateState }
  | { kind: 'approved'; candidate: VendorContactCandidateState }
  | { kind: 'selected'; candidate: VendorContactCandidateState }
  | { kind: 'none'; candidate: null };

// A vendor who declined, timed out, or was turned down is retired to one of
// these but keeps contactApproval "approved" from before. Counting them as the
// approved contact hid Approve contact for anyone else once a vendor had ever
// been approved. Display only: whether the request can be REJECTED is the
// server's answer (routingGuidance.rejectable, see canRejectRequest).
const RETIRED_STATES = new Set(['excluded', 'manager_rejected']);

const findCandidate = (
  candidates: VendorContactCandidateState[],
  candidateKey?: string | null
) => candidates.find((candidate) => candidate.candidateKey === candidateKey);

export function getVendorContactActionState(
  snapshot?: VendorContactSnapshotState | null
): VendorContactActionState {
  if (!snapshot) return { kind: 'none', candidate: null };

  const candidates = snapshot.candidateLedger || snapshot.recommendations || [];
  const selectedCandidate =
    findCandidate(candidates, snapshot.selectedCandidateKey) ||
    candidates.find((candidate) => candidate.state === 'selected');
  if (selectedCandidate) return { kind: 'selected', candidate: selectedCandidate };

  const approvedCandidate =
    findCandidate(candidates, snapshot.activeCandidateKey) ||
    candidates.find(
      (candidate) =>
        candidate.state === 'approved_for_contact' ||
        (candidate.contactApproval?.status === 'approved' && !RETIRED_STATES.has(candidate.state || ''))
    );
  if (approvedCandidate) return { kind: 'approved', candidate: approvedCandidate };

  const approvalCandidate =
    snapshot.approvalRequest?.status === 'pending'
      ? findCandidate(candidates, snapshot.approvalRequest.candidateKey)
      : undefined;
  const availableCandidate =
    approvalCandidate ||
    snapshot.recommendations?.find((candidate) =>
      ['recommended', 'pending', undefined].includes(candidate.state)
    );

  return availableCandidate
    ? { kind: 'available', candidate: availableCandidate }
    : { kind: 'none', candidate: null };
}

export function canApproveVendorContact(
  snapshot: VendorContactSnapshotState | null | undefined,
  candidateKey: string
) {
  const action = getVendorContactActionState(snapshot);
  return action.kind === 'available' && action.candidate.candidateKey === candidateKey;
}
