/**
 * Iris v2 wire types, mirrored by hand from the frozen contract
 * (contracts/iris.v2.json, revision 2.3, sha256 1457ee3d…3067). Every property is required;
 * nullable ones say so. Responses are checked against the schema itself
 * (contracts/irisContract.ts) before any of these types is trusted, so a drift
 * between this file and the contract fails a test, not a landlord.
 */

export type Ref = string;
export type Time = string;
/** Integer CAD cents. The UI never does arithmetic on it; text comes from the server. */
export type Minor = number;

export type ErrorCode =
  | 'invalid_input'
  | 'ambiguous_change'
  | 'auth_expired'
  | 'forbidden'
  | 'record_not_found'
  | 'conversation_expired'
  | 'conversation_limit'
  | 'turn_limit'
  | 'transcript_limit'
  | 'stale_context'
  | 'context_mismatch'
  | 'stale_policy'
  | 'impact_changed'
  | 'preview_expired'
  | 'preview_consumed'
  | 'policy_revision_required'
  | 'rate_limited'
  | 'concurrent_turn_limit'
  | 'impact_incomplete'
  | 'audit_unavailable'
  | 'model_unavailable'
  | 'invalid_model_output'
  | 'tool_limit'
  | 'turn_interrupted'
  | 'service_unavailable'
  | 'unsupported_setting'
  | 'stale_evidence';

export type Route =
  | 'dashboard_home'
  | 'requests'
  | 'decisions'
  | 'activity'
  | 'properties'
  | 'tenants'
  | 'vendors'
  | 'schedule'
  | 'wallet'
  | 'billing'
  | 'reports'
  | 'policy'
  | 'none';

export type Origin =
  | {
      segmentId: Ref;
      contextGeneration: number;
      requestContextId: null;
      contextKind: 'account';
      contextLabel: 'Your account policy';
    }
  | {
      segmentId: Ref;
      contextGeneration: number;
      requestContextId: string;
      contextKind: 'request';
      contextLabel: string;
    };

export type SourceType = 'product_guide' | 'account_record' | 'system_notice';

export interface Evidence {
  ref: Ref;
  kind:
    | 'request'
    | 'quote_revision'
    | 'final_statement'
    | 'decision'
    | 'checkpoint'
    | 'scheduling_event'
    | 'policy_revision'
    | 'policy_change'
    | 'audit'
    | 'help_article';
  recordId: string;
  requestId: string | null;
  routeKind: 'request_current' | 'decision_current' | 'policy_current' | 'schedule_current' | 'help_context' | 'none';
  publicRouteKind: Route | null;
  lastVerifiedAt: Time | null;
  revision: number | null;
  hash: string | null;
  occurredAt: Time | null;
  label: string;
}

export interface Fact {
  factId: Ref;
  code: string;
  text: string;
  evidenceRefs: Ref[];
  observedAt: Time;
}

interface BlockBase {
  id: Ref;
  sourceType: SourceType;
}

export interface ParagraphBlock extends BlockBase {
  kind: 'paragraph';
  text: string;
  factIds: Ref[];
  evidenceRefs: Ref[];
}

export interface FactsRow {
  label: string;
  value: string;
  factIds: Ref[];
  evidenceRefs: Ref[];
}

export interface FactsBlock extends BlockBase {
  kind: 'facts';
  title: string | null;
  rows: FactsRow[];
}

export interface CostCell {
  text: string;
  minor: Minor | null;
  currency: 'CAD' | null;
  factIds: Ref[];
  evidenceRefs: Ref[];
}

export interface CostRow {
  label: string;
  cells: CostCell[];
}

export interface CostBlock extends BlockBase {
  kind: 'cost_table';
  caption: string;
  columns: string[];
  rows: CostRow[];
  footerRows: CostRow[];
}

export interface TimelineEvent {
  at: Time | null;
  actorLabel: string;
  title: string;
  text: string;
  factIds: Ref[];
  evidenceRefs: Ref[];
}

export interface TimelineBlock extends BlockBase {
  kind: 'timeline';
  events: TimelineEvent[];
}

export type NoticeCode =
  | 'permission_refusal'
  | 'out_of_scope'
  | 'unavailable'
  | 'unknown'
  | 'stale_guide'
  | 'missing_guide'
  | 'restricted_topic'
  | 'partial_coverage'
  | 'rate_limited'
  | 'cancelled'
  | 'request_context_required'
  | 'context_changed'
  | 'unsupported_setting'
  | 'no_change_needed'
  | 'explanation_unavailable';

export interface NoticeBlock extends BlockBase {
  kind: 'notice';
  code: NoticeCode;
  text: string;
  evidenceRefs: Ref[];
}

export interface ClarificationBlock extends BlockBase {
  kind: 'clarification';
  questionCode:
    | 'exact_quota_required'
    | 'severity_required'
    | 'ambiguous_request'
    | 'missing_context'
    | 'current_value_differs';
  question: string;
  field: 'defaultQuotaMinor' | 'lowAutopilot' | 'mediumAutopilot' | 'requestContext' | null;
  choices: { label: string; value: string }[];
}

/**
 * Revision 2.3: the only free text the model writes. It has no sourceType (it
 * is not a record), cites 1..8 current facts, and is at most one per answer and
 * only first; the schema checks the shape and irisContract the position.
 */
export interface ExplanationBlock {
  id: Ref;
  kind: 'explanation';
  text: string;
  factIds: Ref[];
  evidenceRefs: Ref[];
}

export type Block =
  | ParagraphBlock
  | FactsBlock
  | CostBlock
  | TimelineBlock
  | NoticeBlock
  | ClarificationBlock
  | ExplanationBlock;

export interface Answer {
  blocks: Block[];
  evidence: Evidence[];
  coverage: 'complete' | 'partial' | 'unknown';
  source: 'offline_stub' | 'meta' | 'deterministic_records' | 'model_planned';
  model: string | null;
  observedAt: Time;
}

export type PolicyField = 'defaultQuota' | 'allowAutopilotForLowSeverity' | 'allowAutopilotForMediumSeverity';

export interface Stage {
  stage: 'preview' | 'validate' | 'confirm' | 'execute' | 'verify' | 'audit';
  state: 'not_started' | 'completed' | 'failed';
  at: Time | null;
}

export interface PolicyValues {
  defaultQuotaMinor: Minor | null;
  lowAutopilot: boolean;
  mediumAutopilot: boolean;
}

export interface PolicyChangeView {
  id: Ref;
  origin: Origin;
  state: 'preview_ready' | 'stale' | 'expired' | 'discarded' | 'applied' | 'failed';
  basePolicyRevision: number | null;
  appliedRevision: number | null;
  asOf: Time;
  expiresAt: Time;
  changes: { field: PolicyField; before: string; after: string }[];
  patchHash: string;
  impactHash: string;
  impactCounts: { eligible: number; passed: number; shadowed: number; notApplicable: number; unknown: number };
  impactCursor: string | null;
  impactComplete: boolean;
  stages: Stage[];
  verifiedValues: PolicyValues | null;
  auditRef: Ref | null;
  refreshState: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'not_required';
  errorCode: ErrorCode | null;
}

export interface WireError {
  code: ErrorCode;
  message: string;
  retryAfterSeconds: number | null;
}

export interface Activity {
  seq: number;
  tool: string;
  status: 'started' | 'completed' | 'failed';
  label: string;
  startedAt: Time;
  endedAt: Time | null;
}

export type TurnStatus =
  | 'accepted'
  | 'reading'
  | 'formatting'
  | 'completed'
  | 'refused'
  | 'cancelled'
  | 'interrupted'
  | 'unavailable';

export interface TurnView {
  schemaVersion: 2;
  turnId: Ref;
  conversationId: Ref;
  origin: Origin;
  trimmedSegmentIds: Ref[];
  status: TurnStatus;
  activities: Activity[];
  answer: Answer | null;
  preview: PolicyChangeView | null;
  /** UI-only. Stripped before a view is stored; see irisController. */
  confirmationToken: string | null;
  error: WireError | null;
  serverTime: Time;
}

export interface ConversationView {
  conversationId: Ref;
  createdAt: Time;
  idleExpiresAt: Time;
  absoluteExpiresAt: Time;
  limits: { maxMessageChars: 2000; maxTurns: 20 };
  serverTime: Time;
}

export interface AcceptedTurn {
  turnId: Ref;
  status: 'accepted';
  origin: Origin;
  serverTime: Time;
}

export interface Cancellation {
  turnId: Ref;
  status: 'cancelled' | 'completed' | 'refused' | 'interrupted' | 'unavailable';
  serverTime: Time;
}

export interface ConversationClosed {
  conversationId: Ref;
  status: 'closed';
  serverTime: Time;
}

export interface ImpactRow {
  requestRef: Ref;
  requestId: string;
  requestTitle: string;
  requestEvidenceRef: Ref;
  field: PolicyField;
  checkpoint: 'estimate' | 'contact' | 'vendor_quote';
  disposition: 'eligible_next' | 'retained_passed' | 'shadowed' | 'not_applicable' | 'legacy_unknown';
  reasonCode: string;
  reasonLabel: string;
  oldEffectiveMinor: Minor | null;
  newEffectiveMinor: Minor | null;
  quotaSource: 'request' | 'unit' | 'property' | 'category' | 'default' | 'unset' | 'unknown';
  basisRef: Ref | null;
  policyRevisionAtPass: number | null;
  nextActor: 'landlord' | 'tenant' | 'vendor' | 'system' | 'unknown';
  observedVersion: string;
  observedAt: Time;
}

export interface ImpactPage {
  previewId: Ref;
  asOf: Time;
  rows: ImpactRow[];
  nextCursor: string | null;
  complete: boolean;
}

export interface EvidenceView {
  evidence: Evidence;
  facts: Fact[];
  observedAt: Time;
}

export interface HttpErrorBody {
  success: false;
  message: string;
  code: ErrorCode;
  retryAfterSeconds: number | null;
  currentPolicyRevision: number | null;
  field: string | null;
}

/** Ordinary Policy page DTO (contract PolicyDTO). Quotas here are dollars, as before. */
export interface PolicyDTO {
  _id: string;
  landlordId: string;
  defaultQuota: number | null;
  categoryQuotas: Record<string, number>;
  propertyQuotas: Record<string, number>;
  unitQuotas: Record<string, number>;
  requireApprovalForExternalSearch: boolean;
  requireApprovalOverQuota: boolean;
  requireApprovalForFirstTimeVendor: boolean;
  allowQuoteClarification: boolean;
  allowAutopilotForLowSeverity: boolean;
  allowAutopilotForMediumSeverity: boolean;
  digestFrequency: 'instant' | 'hourly' | 'daily';
  emergencyNotificationChannels: ('email' | 'sms' | 'push')[];
  lowFundsThreshold: number;
  autoAdvanceOnVendorDecline: boolean;
  maxOutreachAttempts: number;
  policyRevision: number;
  policyChangeReceiptRef: Ref | null;
  auditRef: Ref | null;
  createdAt: Time | null;
  updatedAt: Time | null;
}
