// Iris activity, v1 (ART-IRIS-001 M2 shared HTTP contract).
//
// GET /landlords/iris-activity            -> IrisActivityList
// GET /landlords/requests/:id/iris-activity -> IrisRequestActivity
//
// The server derives every field from persisted workflow state and logs; the
// client only renders it. Changing this shape needs principal coordination.

export const IRIS_ACTIVITY_VERSION = 1;

export type IrisStage = 'intake' | 'routing' | 'outreach' | 'scheduling' | 'work' | 'review' | 'closed';

export type IrisState = 'in_progress' | 'waiting' | 'completed' | 'failed' | 'needs_attention' | 'unknown';

/**
 * What Iris's own automation is doing (Amendment A), separate from the
 * maintenance `state`. Only `running` means work is executing right now: the
 * server sets it only while a persisted lease is live.
 */
export type IrisAutomationState =
  | 'running'
  | 'awaiting_landlord'
  | 'awaiting_vendor'
  | 'awaiting_tenant'
  | 'completed'
  | 'failed'
  | 'escalated'
  | 'idle'
  | 'unknown';

/** A reference to the authoritative pending ApprovalRequest; no payload. */
export interface IrisPendingApproval {
  approvalId: string;
  type: string;
  status: 'pending';
}

export interface IrisEventDetail {
  label: string;
  value: string;
}

export interface IrisEvent {
  id: string;
  requestId: string;
  source: 'lifecycle' | 'audit';
  /** Legacy free-text actor, kept for older payloads. */
  actor: string | null;
  /** Judge contract v1, additive: who actually acted. Absent on older payloads. */
  actorKind?: string | null;
  actorLabel?: string | null;
  /** The action was simulated (no real message or money). */
  simulated?: boolean | null;
  /** Where the result came from; only `model` establishes a real model call. */
  provenance?: { kind?: string | null; label?: string | null } | null;
  type: string;
  title: string;
  summary: string;
  at: string | null;
  /** Additive v1 occurrence-time provenance; absent on older payloads. */
  recordedAt?: string | null;
  timeBasis?: 'domain' | 'recorded' | 'unknown';
  state: IrisState;
  details: IrisEventDetail[];
}

export interface IrisRequestSummary {
  requestId: string;
  title: string;
  propertyLabel: string;
  unitLabel: string;
  status: string;
  stage: IrisStage;
  state: IrisState;
  summary: string;
  waitingFor: string | null;
  actionRequired: boolean;
  updatedAt: string | null;
  latestEvent: IrisEvent | null;
  /** Amendment A, additive. Absent on older payloads: read as unknown. */
  automationState?: IrisAutomationState;
  /** Amendment A, additive. Absent on older payloads: read as none. */
  pendingApproval?: IrisPendingApproval | null;
}

export interface IrisActivityList {
  version: 1;
  requests: IrisRequestSummary[];
  nextCursor: string | null;
}

export interface IrisRequestActivity {
  version: 1;
  request: IrisRequestSummary;
  events: IrisEvent[];
  nextCursor: string | null;
}
