export interface ContactCandidate {
  candidateKey: string;
  name: string;
  draftMessage?: string;
  state?: string;
  contactApproval?: {
    status?: string;
  };
  /** Live, from the landlord request detail: send now or at their next opening. */
  sendTiming?: SendTiming | null;
}

/** Whether outreach to a vendor would go out now, computed live by the server
 *  from the vendor's hours of operation. Never stored on the snapshot. */
export interface SendTiming {
  openNow: boolean;
  nextOpenAt: string | null;
  nextOpenLabel: string | null;
  hoursLabel: string | null;
  sendNow: boolean;
  scheduledFor: string | null;
  scheduledForLabel: string | null;
}

export interface VendorRecommendationSnapshot {
  recommendations?: ContactCandidate[];
  candidateLedger?: ContactCandidate[];
  approvalRequest?: {
    _id?: string;
    candidateKey?: string;
    status?: string;
  } | null;
  activeCandidateKey?: string | null;
  selectedCandidateKey?: string | null;
}

export interface RoutingSummary {
  actionType?: string | null;
  approvalRequired?: boolean;
  approvalRequestId?: string | null;
  activeCandidateKey?: string | null;
  activeCandidateName?: string | null;
  activeCandidateSource?: string | null;
  activeCandidateState?: string | null;
  topCandidateKey?: string | null;
  topCandidateName?: string | null;
  topCandidateSource?: string | null;
  assignedVendorId?: string | null;
  assignedVendorName?: string | null;
}

export interface RequestItem {
  _id: string;
  issueTitle: string;
  issueDescription: string;
  ai?: { shortTitle?: string; summary?: string } | null;
  status: string;
  urgency: string;
  category: string;
  createdAt: string;
  updatedAt?: string;
  archivedAt?: string | null;
  estimatedCost?: number;
  finalCost?: number;
  responsibility?: string;
  routingDecision?: string;
  appointmentStatus?: string;
  quotaOverride?: number | null;
  vendorId?: { _id?: string; name?: string } | string | null;
  selectedVendorId?: { _id?: string; name?: string } | string | null;
  tenantId?: { firstName?: string; lastName?: string; email?: string } | string;
  unitId?: { unitNumber?: string } | string;
  propertyId?: { _id?: string; name?: string } | string;
  vendorRecommendation?: {
    routingDecision?: { decision?: string; summary?: string };
    managerAction?: { type?: string } | null;
  } | null;
  vendorRecommendationSnapshot?: VendorRecommendationSnapshot | null;
  routingSummary?: RoutingSummary | null;
  /** Server-decided routing answers (rejectable, pauseKind). */
  routingGuidance?: import('../components/request-detail/requestDetailTypes').RoutingGuidance;
  /** The server's lifecycle label (queued, approved, needs_vendor, ...). */
  lifecycleStatus?: string;
  rejectionReason?: string;
  /** Server-decided rejection/appeal state (appeal pending, can reopen, ...). */
  appeal?: import('../api/client').AppealState;
  /** Latest automatic or manual vendor outreach, as persisted by the server. */
  outreachSummary?: import('./requestWorkflow').OutreachSummary | null;
  safetyAssessment?: import('./requestWorkflow').SafetyAssessment | null;
  intakeFollowUp?: import('./requestWorkflow').IntakeFollowUp | null;
}

export interface PropertyUnit {
  _id: string;
  unitNumber: string;
}

/** Why one proposed identifier cannot become a unit. Mirrors the server's codes. */
export type UnitBatchErrorCode =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'DUPLICATE_IN_BATCH'
  | 'ALREADY_EXISTS';

export interface UnitBatchRow {
  index: number;
  input: string;
  name: string;
  valid: boolean;
  errors: { code: UnitBatchErrorCode; message: string }[];
}

export interface UnitBatchSummary {
  total: number;
  valid: number;
  invalid: number;
  empty: number;
  tooLong: number;
  duplicates: number;
  collisions: number;
}

/** The server's verdict on a whole batch — from the dry run or from a 422. */
export interface UnitBatchResult {
  rows: UnitBatchRow[];
  summary: UnitBatchSummary;
  valid: boolean;
}

export interface UnitBatchCreated {
  created: PropertyUnit[];
  summary: UnitBatchSummary & { created: number };
}

/** Why one proposed property cannot be created. Mirrors the server's codes. */
export type PortfolioErrorCode =
  | 'NAME_REQUIRED'
  | 'ADDRESS_REQUIRED'
  | 'NAME_TOO_LONG'
  | 'ADDRESS_TOO_LONG'
  | 'DUPLICATE_IN_BATCH'
  | 'ALREADY_EXISTS'
  | 'NO_UNITS';

export interface PortfolioBatchRow {
  index: number;
  name: string;
  address: string;
  valid: boolean;
  errors: { code: PortfolioErrorCode; message: string }[];
  units: UnitBatchResult;
}

export interface PortfolioBatchSummary {
  properties: number;
  units: number;
  validProperties: number;
  invalidProperties: number;
  duplicateProperties: number;
  existingProperties: number;
  invalidUnits: number;
  duplicateUnits: number;
}

export interface PortfolioBatchResult {
  properties: PortfolioBatchRow[];
  summary: PortfolioBatchSummary;
  valid: boolean;
}

export interface PortfolioImported {
  properties: Property[];
  summary: PortfolioBatchSummary & { propertiesCreated: number; unitsCreated: number };
}

export interface Property {
  _id: string;
  name: string;
  address: string;
  description?: string;
  units?: PropertyUnit[];
  /** Set once retired: hidden from lists and pickers, kept for history. */
  archivedAt?: string | null;
}

/** A tenant standing between the landlord and deleting a property/unit. */
export interface DeletionBlockingTenant {
  _id: string;
  name: string;
  email: string;
  unitLabel: string;
  moveOut: { status: 'requested' | 'completed'; requestedAt: string | null } | null;
}

/** The server's verdict on deleting a property or unit. */
export interface DeletionCheck {
  kind: 'property' | 'unit';
  label: string;
  propertyId: string;
  blocked: boolean;
  blockers: { tenants: DeletionBlockingTenant[]; openRequests: number };
  hasHistory: boolean;
  /** What confirming does: archive when it has history, delete when not. */
  action: 'archive' | 'delete' | null;
}

export interface TenantMoveOutStatus {
  linked: boolean;
  unitLabel: string | null;
  propertyName: string | null;
  moveOut: { status: 'requested' | 'completed'; requestedAt: string | null; completedAt: string | null } | null;
}

export interface InviteCode {
  _id: string;
  code: string;
  expiresAt: string;
  createdAt?: string;
  propertyId?: { name?: string } | string;
  unitId?: { unitNumber?: string } | string;
}

export interface TenantItem {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  unit?: { _id?: string; unitNumber?: string; propertyId?: string } | string | null;
  status?: 'pending' | 'active' | 'inactive';
  moveOut?: { status: 'requested' | 'completed'; requestedAt?: string | null } | null;
}

export interface VendorItem {
  _id: string;
  name: string;
  email?: string;
  phone?: string;
  specialties?: string[];
  /** Trades the landlord typed beyond the preset list. */
  customSpecialties?: string[];
  company?: string;
  city?: string;
  serviceAreas?: string[];
  emergencyAvailable?: boolean;
  /** Structured hours; absent on vendors created before hours were required. */
  operatingHours?: import('../components/landlord/vendors/vendorHours').OperatingHours;
  /** Display string derived from operatingHours by the server. */
  businessHours?: string;
  notes?: string;
  successfulJobs?: number;
  responseStats?: { averageFirstResponseMinutes?: number };
  /** "trusted" skips the per-job first-time-vendor approval. */
  verificationStatus?: 'trusted' | 'unverified' | 'blocked' | 'mock_verified';
}

export interface Policy {
  _id: string;
  /** null until the landlord chooses one; nothing is auto-contacted meanwhile. */
  defaultQuota: number | null;
  requireApprovalForExternalSearch: boolean;
  requireApprovalOverQuota: boolean;
  requireApprovalForFirstTimeVendor: boolean;
  /** Iris may send one routine, line-specific question about an itemized quote
   *  or final statement without asking first. Never authorizes a price. */
  allowQuoteClarification?: boolean;
  allowAutopilotForLowSeverity: boolean;
  allowAutopilotForMediumSeverity: boolean;
  digestFrequency: 'instant' | 'hourly' | 'daily';
  emergencyNotificationChannels: string[];
  lowFundsThreshold: number;
  /** Vendor outreach fallback. Optional — policies saved before outreach
   *  shipped won't carry them until the next save. */
  autoAdvanceOnVendorDecline?: boolean;
  maxOutreachAttempts?: number;
  /** Saved revision this policy was read at (frozen v2 policyCas). Sent back
   *  as expectedPolicyRevision so a save never overwrites a newer one. */
  policyRevision?: number;
  policyChangeReceiptRef?: string | null;
  auditRef?: string | null;
}

/** GET /landlords/routing-setup — what vendor routing can reach right now. */
export interface RoutingSetup {
  /** Vendors a request can be routed to (active, in the landlord's network). */
  activeVendorCount: number;
  maxOutreachAttempts: number;
  /** min(activeVendorCount, maxOutreachAttempts). */
  effectiveCap: number;
  /** False while anything in `missing` blocks finding or contacting vendors. */
  ready: boolean;
  /** In the order to fix them: there is no point choosing a cap with no vendors. */
  missing: Array<'vendors' | 'max_vendors'>;
}

/** A decision derived from a request's state rather than an ApprovalRequest row. */
export interface RoutingDecisionItem {
  type:
    | 'contact_approval'
    | 'routing_paused'
    | 'tenant_time_unconfirmed'
    | 'vendor_no_show'
    | 'appeal_review'
    /** The tenant sent follow-up details; nothing moves until a person reviews them. */
    | 'intake_review'
    /** A tenant- or model-raised safety concern awaiting a human assessment. */
    | 'safety_review';
  requestId: string;
  title: string;
  urgency: string | null;
  propertyName: string | null;
  unitNumber: string | null;
  createdAt: string | null;
  /** Why routing paused, e.g. "Vendor declined". */
  reason: string | null;
  /** routing_paused only: which kind of pause, so the card says something true. */
  pauseKind?: 'vendors_exhausted' | 'no_eligible_vendors' | 'manager_rejected' | 'paused' | null;
  candidate: { candidateKey: string; name: string } | null;
  // Booking items (tenant_time_unconfirmed, vendor_no_show) only.
  appointmentId?: string;
  vendorName?: string | null;
  arrivalAt?: string | null;
  /** When the tenant was due to confirm the time. */
  deadline?: string | null;
  /** When the tenant reported the no-show, and what they said. For
   *  appeal_review: when the tenant appealed, and their appeal. */
  reportedAt?: string | null;
  note?: string | null;
}

export interface ApprovalRequestItem {
  _id: string;
  requestId: string;
  type: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt: string;
  amountRequested?: number;
  reason?: string;
  payload?: {
    /** Discriminator. Absent on routing approvals; set on the vendor-quote and
     *  completion-overage variants, which carry a different quota shape. */
    source?: 'vendor_quote' | 'completion_overage' | 'outreach_fallback' | 'iris_cost_review';
    /** cost_review: what is being asked. Server-owned, like everything below. */
    purpose?: 'clarification_permission' | 'scope_review' | 'analysis_unavailable';
    stage?: 'quote' | 'invoice';
    subjectId?: string;
    /** The exact itemized revision the decision was raised on. A decision
     *  echoes these back; a changed quote makes the server refuse it (409). */
    quoteRevision?: number;
    quoteHash?: string;
    contextHash?: string;
    analysisId?: string;
    /** type `other`: a single coordination step, never the whole request. */
    actionScope?: 'coordination_step';
    stepId?: 'review_coordination';
    question?: string;
    outreachId?: string;
    candidateKey?: string;
    vendorName?: string;
    priority?: string;
    completionId?: string;
    /** The vendor's own explanation, captured at submit on a completion overage. */
    overageReason?: string | null;
    quota?: {
      limit?: number;
      /** Routing-approval shape. */
      estimatedAmountHigh?: number;
      lowestEligibleCost?: number;
      /** Vendor-quote shape: the range the vendor actually asked for. */
      quotedAmount?: number;
      quotedLow?: number;
      suggestedQuota?: number;
      basis?: string;
    };
  };
}

export interface AgentLogItem {
  _id: string;
  requestId: string;
  actor: string;
  actionType: string;
  summary: string;
  createdAt: string;
}

export type TrendBucket = { key: string; label: string; requests: number; resolved: number; cost: number };

export interface Stats {
  /** Live (non-archived) properties and units only. */
  propertyCount: number;
  unitCount: number;
  /** Tenants who haven't moved out. */
  tenantCount: number;
  /** Live units with at least one current tenant. */
  occupiedUnitCount?: number;
  pendingMoveOutCount?: number;
  /** Every request ever raised. */
  requestCount: number;
  /** Requests that are not completed, rejected or cancelled — what "open" means. */
  openRequestCount?: number;
  urgentCount: number;
  /** Realised spend: final cost of completed work only. */
  totalCost: number;
  /** Promised but not yet spent — the vendor quote ceiling for in-flight jobs. */
  committedCost?: number;
  completedCount?: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  /** Last 12 months, oldest first. Incoming by createdAt; resolved and cost by completedAt. */
  monthly: TrendBucket[];
  /** Last 30 days, same rules. Absent from a server older than this field. */
  daily?: TrendBucket[];
}
