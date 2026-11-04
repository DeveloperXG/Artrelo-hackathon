/**
 * Request workflow contract (docs/request-workflow-contract.md, approved
 * 2026-10-21). Every shape here is what the server sends; the client never
 * derives eligibility, safety, or outreach state on its own.
 */

export type IntakeMode = 'routine' | 'safety';

export type CreationBlockReason = 'unit_unlinked' | 'open_cap' | 'daily_limit' | 'weekly_limit';

/** GET /tenants/requests/quota → data.creationEligibility. */
export interface CreationEligibility {
  allowed: boolean;
  reasons: CreationBlockReason[];
  openCount: number;
  openCap: number;
  nextAvailableAt: string | null;
  evaluatedAt: string;
}

export type IntakeTopicId = 'location' | 'timeline' | 'impact' | 'safety';
export type IntakeAnswerState = 'answered' | 'unknown' | 'declined';

export interface IntakeFollowUpQuestion {
  topicId: IntakeTopicId;
  question: string;
  state: 'missing' | IntakeAnswerState;
  value: string;
}

export interface IntakeFollowUpAnswer {
  topicId: string;
  state: IntakeAnswerState;
  value: string;
}

/** Tenant request list/detail → intakeFollowUp. */
export interface IntakeFollowUp {
  revision: number;
  state: 'awaiting_answers' | 'ready_for_review' | 'reviewed';
  questions: IntakeFollowUpQuestion[];
  answers: IntakeFollowUpAnswer[];
  submittedAt: string | null;
  reviewedAt: string | null;
  /** Landlord only: why vendor contact may proceed despite remaining topics. */
  reviewReason?: string;
  remainingTopics: string[];
}

/** PUT /tenants/requests/:id/intake-details body. */
export interface IntakeDetailsSubmission {
  revision: number;
  submissionId: string;
  answers: { topicId: string; state: IntakeAnswerState; value?: string }[];
}

export type SafetyProvenance = 'rules' | 'tenant' | 'model' | 'landlord';

/** Landlord payloads carry the full assessment. */
export interface SafetyAssessment {
  state: 'confirmed_hazard' | 'needs_review' | 'none';
  revision: number;
  provenance: SafetyProvenance[];
  ruleCodes: string[];
  reviewedAt?: string;
  reviewReason?: string;
}

/** Tenant payloads expose only the state and revision. */
/** Tenants see whether a person has assessed the concern, never the reason. */
export type TenantSafetyAssessment = Pick<SafetyAssessment, 'state' | 'revision'> & { reviewedAt?: string | null };

export interface SimilarRequest {
  id: string;
  issueTitle: string;
  reason: string;
  createdAt: string;
}

export type OutreachInitiation = 'policy_auto_start' | 'policy_auto_advance' | 'landlord' | 'unknown';
/** `closed` (expired, revoked, superseded) is not a vendor reply. Older
 *  servers send those as `responded` with the raw status in responseStatus. */
export type OutreachSummaryState = 'preparing' | 'scheduled' | 'sent' | 'failed' | 'unconfirmed' | 'responded' | 'closed';

/** Landlord list/detail → outreachSummary. */
export interface OutreachSummary {
  outreachId: string;
  vendorName: string;
  initiation: OutreachInitiation;
  state: OutreachSummaryState;
  scheduledFor: string | null;
  sentAt: string | null;
  updatedAt: string | null;
  /** Raw outcome for responded (accepted/declined) and closed states. */
  responseStatus: string | null;
  /** When the summarised event was recorded (never a future schedule).
   *  Absent from older servers; null when nothing was recorded. */
  eventAt?: string | null;
  respondedAt?: string | null;
}

export type SafetyReviewDisposition = 'retain_urgent' | 'classify_routine';

/** 409 codes the workflow endpoints share. */
export type WorkflowConflictCode = 'stale_revision' | 'request_not_editable' | 'idempotency_conflict';
