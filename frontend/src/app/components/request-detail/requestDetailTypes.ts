import type { SendTiming } from '../../types/landlord';
import type { AppealState } from '../../api/client';
import type { IntakeFollowUp, OutreachSummary, SafetyAssessment, TenantSafetyAssessment } from '../../types/requestWorkflow';

export type { SendTiming };

export interface TimelineEvent {
  status: string;
  note?: string;
  actorRole?: string;
  at: string;
}

export interface RequestAuditLog {
  _id: string;
  requestId: string;
  actor: string;
  actionType: string;
  summary: string;
  createdAt: string;
}

export interface RequestActivityItem {
  id: string;
  source: 'lifecycle' | 'audit';
  title: string;
  description?: string;
  actor?: string;
  at: string;
  colorKey?: string;
}

export interface RequestComment {
  authorId: string;
  authorRole: string;
  body: string;
  at: string;
}

export interface PriceEstimate {
  amountLow?: number;
  amountHigh?: number;
  currency?: string;
  /** "paid_job_average" for a network vendor: what they were actually paid
   *  for this trade. A network vendor with no paid history has NO estimate. */
  basis?: string;
  sampleSize?: number;
}

export interface AvailabilitySlot {
  slotId: string;
  label?: string;
  /** Null for the "flexible" option. */
  start?: string | null;
  end?: string | null;
  kind?: 'window' | 'asap' | 'flexible';
}

/** Outreach state mirrored onto a ledger entry. Derived from the VendorOutreach
 *  record on the server — treat as read-only. Absent on snapshots generated
 *  before vendor outreach shipped, hence every field is optional. */
export interface CandidateOutreachState {
  status?:
    | 'not_sent'
    /** Waiting for the vendor's next opening; nothing has been sent yet. */
    | 'scheduled'
    | 'queued'
    | 'sent'
    | 'delivery_failed'
    | 'viewed'
    | 'accepted'
    | 'declined'
    | 'expired'
    | 'superseded'
    | 'revoked';
  outreachId?: string | null;
  attempt?: number;
  channel?: string;
  /** Masked, e.g. "exc***@gmail.com". The real address never reaches the client. */
  toEmailMasked?: string | null;
  tier?: 'emergency' | 'urgent' | 'normal' | 'low' | null;
  /** When a `scheduled` outreach goes out. */
  scheduledFor?: string | null;
  sentAt?: string | null;
  lastAttemptAt?: string | null;
  firstViewedAt?: string | null;
  respondedAt?: string | null;
  responseDeadlineAt?: string | null;
  deliveryError?: string | null;
  decision?: {
    outcome?: 'accepted' | 'declined';
    quoteLow?: number | null;
    quoteHigh?: number | null;
    currency?: string;
    quoteNotes?: string | null;
    declineReason?: string | null;
    selectedWindowLabel?: string | null;
    scheduledArrivalAt?: string | null;
    durationMinutes?: number | null;
    respondedAt?: string | null;
  } | null;
  quotaCheck?: {
    limit?: number | null;
    quoteHigh?: number | null;
    overQuota?: boolean;
    evaluatedAt?: string | null;
  } | null;
  /** The price-confirmation round, when the manager authorized less than the
   *  vendor quoted. Null whenever no round has run. */
  counterOffer?: {
    status?: 'pending' | 'confirmed' | 'declined' | 'expired' | 'withdrawn';
    amount?: number | null;
    currency?: string;
    round?: number;
    quotedLow?: number | null;
    quotedHigh?: number | null;
    sentAt?: string | null;
    deadlineAt?: string | null;
    respondedAt?: string | null;
    declineReason?: string | null;
    deliveryError?: string | null;
  } | null;
  /** Landlord-only. Never present on any vendor-facing payload. */
  authorizedCeiling?: number | null;
}

export interface VendorRecommendationCandidate {
  candidateKey: string;
  vendorId?: string | null;
  providerName: string;
  providerVendorId: string;
  name: string;
  category?: string;
  service?: string | null;
  services?: string[];
  city?: string;
  candidateSource: string;
  isDemoVendor?: boolean;
  whyRecommended?: string;
  priceEstimate?: PriceEstimate | null;
  /** The windows outreach would offer, built from the vendor's hours. */
  availabilitySlots?: AvailabilitySlot[];
  /** The vendor's hours of operation, e.g. "24/7" or "Mon–Fri 9:00–17:00". */
  hoursLabel?: string | null;
  /** Live from the server on every read: open now, or when outreach would go out. */
  sendTiming?: SendTiming | null;
  avgResponseMinutes?: number;
  state?: string;
  displayGroup?: string;
  score?: number | null;
  reasonCodes?: string[];
  humanReadableReasons?: string[];
  holdReason?: string | null;
  draftMessage?: string;
  contactApproval?: {
    status?: string;
  };
  manualSelection?: {
    status?: string;
    overrideReason?: string | null;
  };
  managerDecision?: {
    status?: string;
  };
  contact?: {
    email?: string | null;
    phone?: string | null;
    hasEmail?: boolean;
  };
  outreach?: CandidateOutreachState;
}

export interface VendorRecommendationSnapshot {
  version?: string;
  generatedAt?: string;
  defaultProvider?: string;
  requestSnapshot?: {
    category?: string;
    urgency?: string;
    vendorTypeNeeded?: string | null;
  };
  decision?: {
    actionType?: string;
    managerSummary?: string;
    approvalRequired?: boolean;
    quotaLimit?: number;
  };
  diagnostics?: {
    discoveredCount?: number;
    serviceMatchedCount?: number;
    eligibleCount?: number;
    recommendedCount?: number;
    outcomeCode?: string;
    commonExclusionReasons?: Array<{
      code: string;
      label: string;
      count: number;
    }>;
    recommendedNextAction?: string;
    /** Eligible minus everyone who already closed an outreach round here. */
    contactableCount?: number;
  };
  /** The manager's most recent routing action on this snapshot. */
  lastManagerAction?: {
    type?: string;
    candidateKey?: string;
    at?: string;
  } | null;
  /** The outreach round that just closed, written by advanceOutreach. Absent on
   *  snapshots generated before the fallback loop shipped, and absent until the
   *  first vendor declines or times out — so treat every field as optional and
   *  fall back to getLastClosedOutreach. */
  lastRound?: {
    candidateKey?: string;
    vendorName?: string;
    reason?: string;
    reasonLabel?: string;
    detail?: string | null;
    at?: string;
    vendorsContacted?: number;
    maxVendors?: number;
    // min(maxVendors, vendors this request could ever reach). Absent on rounds
    // closed before it was recorded; fall back to maxVendors.
    effectiveMaxVendors?: number;
    resolution?: 'awaiting_approval' | 'auto_advanced' | 'exhausted' | 'escalated';
    nextCandidateKey?: string | null;
    nextVendorName?: string | null;
  };
  candidateLedger?: VendorRecommendationCandidate[];
  recommendations?: VendorRecommendationCandidate[];
  eligibleButNotTopCandidates?: VendorRecommendationCandidate[];
  excludedCandidates?: VendorRecommendationCandidate[];
  heldCandidates?: VendorRecommendationCandidate[];
  approvalRequest?: {
    approvalRequestId?: string;
    status?: string;
    type?: string;
    candidateKey?: string;
  };
  manualAssignment?: {
    status?: string;
    selectedCandidateKey?: string;
    overrideReason?: string | null;
  };
  activeCandidateKey?: string | null;
  selectedCandidateKey?: string | null;
}

export interface RequestDetailRecord {
  _id: string;
  bookingVersion?: number;
  issueTitle: string;
  issueDescription: string;
  status: string;
  /** Canonical lifecycle stage from the backend (folds in vendor snapshot state). */
  lifecycleStatus?: string;
  urgency: string;
  category: string;
  estimatedCost?: number;
  finalCost?: number;
  /** Per-request quota ceiling once a manager has approved an increase. */
  quotaOverride?: number | null;
  /** "pending" | "routed" | "approval_needed" | "paused" | "failed". "paused" is
   *  the signal that the outreach loop is spent and Generate may unlock. */
  routingStatus?: string;
  responsibility?: string;
  rejectionReason?: string;
  appealWindowExpiresAt?: string;
  isAppealed?: boolean;
  appealNote?: string;
  /** Server-decided rejection/appeal state: what the rejection card offers. */
  appeal?: AppealState;
  vendorId?: { _id?: string; name?: string; phone?: string; company?: string } | string | null;
  selectedVendorId?: { _id?: string; name?: string } | string | null;
  unitId?: { unitNumber?: string } | string;
  propertyId?: { name?: string; address?: string } | string;
  createdAt: string;
  completedAt?: string;
  /** Set a week after completion/cancellation; the request then lives in the history views. */
  archivedAt?: string | null;
  completionNotes?: string;
  appointmentStatus?: string;
  /** Direct pay: what the landlord owes, or paid, the vendor for this job.
   *  Landlord payload only; null when the job wasn't direct or hasn't closed. */
  directPayment?: {
    appointmentId: string;
    status: 'due' | 'paid';
    amount: number;
    dueSince: string | null;
    paidAt: string | null;
    reference: string | null;
    vendorName: string | null;
  } | null;
  timeline?: TimelineEvent[];
  comments?: RequestComment[];
  routingGuidance?: RoutingGuidance;
  ai?: {
    summary?: string;
    shortTitle?: string;
    additionalNotes?: string;
    category?: string;
    urgency?: string;
    severity?: number;
    suggestedResponsibility?: string;
    suggestedVendorType?: string;
    safetyWarning?: string;
    emergencyServicesRecommended?: boolean;
    followUpQuestions?: string[];
  };
  vendorRecommendationSnapshot?: VendorRecommendationSnapshot | null;
  updatedAt?: string;
  revision?: number;
  /** Tenant: questions still owed. Landlord: what the tenant answered. */
  intakeFollowUp?: IntakeFollowUp | null;
  /** Full assessment for the landlord; only {state, revision} for the tenant. */
  safetyAssessment?: SafetyAssessment | TenantSafetyAssessment | null;
  /** Landlord only. */
  outreachSummary?: OutreachSummary | null;
}

/**
 * What the manager may do with this request's routing, decided by the server
 * (backend/services/request/routingGuidance.service.js) with the same rules
 * its endpoints enforce. Shown as-is: the page used to re-derive these and
 * drifted from the server more than once.
 */
export interface RoutingGuidance {
  rejectable: boolean;
  pauseKind: 'vendors_exhausted' | 'no_eligible_vendors' | 'manager_rejected' | 'paused' | null;
  /** Detail payload only. Empty when a fresh vendor search can run. */
  regenerateBlockReason?: string;
}

export type RequestDetailTab = 'overview' | 'routing' | 'work' | 'messages' | 'activity';

// "Received" and "AI triage complete" used to be the first two steps. Both
// turn green the moment a tenant submits (triage runs during intake), so they
// never told a manager anything. `not_started` is the stage before the first
// remaining step -- no vendor search yet -- and has no step of its own.
export type RequestWorkflowStageKey =
  | 'not_started'
  | 'vendor_review'
  | 'contact_approved'
  | 'selected_or_scheduled'
  | 'completed';

export interface RequestWorkflowStage {
  key: RequestWorkflowStageKey;
  /** Index in WORKFLOW_STEPS of the last step reached; -1 before the first. */
  stepIndex: number;
  terminalStatus?: 'rejected' | 'cancelled';
}

export interface CostDisplay {
  label: string;
  value: string;
}

export interface HeroMetric {
  label: string;
  value: string;
  secondaryValue?: string;
}

export const DETAIL_STATUS_COLORS: Record<string, string> = {
  queued: 'bg-amber-500 text-white',
  approved: 'bg-sky-500 text-white',
  outreach_scheduled: 'bg-violet-500 text-white',
  needs_approval: 'bg-amber-600 text-white',
  contacting_vendor: 'bg-cyan-600 text-white',
  needs_vendor: 'bg-orange-500 text-white',
  assigned: 'bg-indigo-500 text-white',
  in_progress: 'bg-blue-500 text-white',
  completed: 'bg-emerald-500 text-white',
  rejected: 'bg-rose-500 text-white',
  appeal_pending: 'bg-fuchsia-500 text-white',
  cancelled: 'bg-slate-500 text-white',
};

export const TENANT_PRIORITY_LABELS: Record<string, string> = {
  low: 'Received',
  medium: 'Under review',
  high: 'Flagged as urgent',
  // Not "notice sent": whether anyone was alerted depends on their settings.
  emergency: 'Flagged as an emergency',
};

export const PROVIDER_SOURCE_LABELS: Record<string, string> = {
  preset: 'Your network',
  // Only in snapshots written before mock vendors were removed.
  mock_external: 'External vendor',
  manual_dispatch: 'Manual dispatch',
  taskrabbit: 'Taskrabbit',
  thumbtack: 'Thumbtack',
};

export const CANDIDATE_STATE_LABELS: Record<string, string> = {
  recommended: 'Recommended',
  pending: 'Eligible',
  approved_for_contact: 'Approved for contact',
  selected: 'Selected manually',
  held: 'On hold',
  manager_rejected: 'Rejected',
  excluded: 'Excluded',
};

export const CANDIDATE_STATE_BADGES: Record<string, string> = {
  recommended: 'bg-emerald-100 text-emerald-700',
  pending: 'bg-sky-100 text-sky-700',
  approved_for_contact: 'bg-indigo-100 text-indigo-700',
  selected: 'bg-violet-100 text-violet-700',
  held: 'bg-amber-100 text-amber-700',
  manager_rejected: 'bg-rose-100 text-rose-700',
  excluded: 'bg-slate-200 text-slate-700',
};

export const WORKFLOW_STEPS: Array<{
  key: RequestWorkflowStageKey;
  label: string;
}> = [
  { key: 'vendor_review', label: 'Vendor review' },
  { key: 'contact_approved', label: 'Contact approved' },
  { key: 'selected_or_scheduled', label: 'Assigned or scheduled' },
  { key: 'completed', label: 'Completed' },
];
