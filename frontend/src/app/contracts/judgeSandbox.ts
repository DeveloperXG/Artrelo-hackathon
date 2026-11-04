/**
 * Judge sandbox contract 1.2.0 (judgeSandbox.v1.json, sha256
 * 22a95c8d034b4b7a3d535864b371853c88cfb6fa92a242effc146eea1a42c60b,
 * frozen by Principal; the JSON is a byte copy and is never edited here).
 * Every status, run and error body is checked against it before use, with the
 * same closed validator as the Iris contract. Anything that does not check out
 * is treated as "sandbox off", never guessed at.
 */
import contractJson from './judgeSandbox.v1.json';
import { schemaErrors, type JsonSchema, type SchemaDefs } from './irisValidate';

const contract = contractJson as unknown as {
  contractVersion: string;
  basePath: string;
  steps: string[];
  legacySteps: string[];
  errors: Record<string, number>;
  limits: { pollMilliseconds: number; pollStopMilliseconds: number; actionBodyBytes: number };
  $defs: SchemaDefs;
};

export const JUDGE_CONTRACT_VERSION = contract.contractVersion;
export const JUDGE_BASE_PATH = contract.basePath;
export const JUDGE_POLL_MS = contract.limits.pollMilliseconds;
export const JUDGE_POLL_STOP_MS = contract.limits.pollStopMilliseconds;
export const JUDGE_STEP_COUNT = contract.steps.length;
export const JUDGE_DEFS = contract.$defs;

export type JudgeStepCode =
  | 'tenant_submit' | 'routing' | 'vendor_decline' | 'vendor_quote' | 'quote_resolution' | 'booking' | 'visit_change'
  | 'vendor_reschedule' | 'tenant_reschedule' | 'vendor_work' | 'tenant_completion'
  | 'landlord_review' | 'iris_segment' | 'complete';
export type JudgeRunState =
  | 'running' | 'waiting_on_tenant' | 'waiting_on_landlord' | 'ready_to_continue' | 'paused' | 'failed' | 'completed';
export type JudgeAction = 'continue' | 'pause' | 'resume';
export type JudgeCheckpointKind =
  | 'approval' | 'quote_over_limit' | 'visit_change' | 'wallet_funding' | 'tenant_submit'
  | 'booking' | 'vendor_work' | 'tenant_completion' | 'iris_review';
export type JudgeErrorCode =
  | 'invalid_input' | 'auth_expired' | 'forbidden_role' | 'record_not_found' | 'sandbox_disabled'
  | 'run_exists' | 'stale_revision' | 'step_not_ready' | 'checkpoint_requires_human'
  | 'tenant_quota_reached' | 'open_request_cap' | 'no_free_visit_time' | 'wallet_funding_required'
  | 'idempotency_conflict' | 'ambiguous_request' | 'action_unknown' | 'run_busy'
  | 'unsupported_scenario'
  | 'ai_unavailable' | 'ai_cap_reached' | 'rate_limited' | 'service_unavailable';

export interface JudgeRunError {
  code: JudgeErrorCode;
  retryable: boolean;
  retryAfterSeconds: number | null;
  nextAvailableAt: string | null;
}

export interface JudgeCheckpoint {
  kind: JudgeCheckpointKind;
  requestId: string | null;
  approvalId: string | null;
}

export interface JudgeRun {
  runId: string;
  requestId: string | null;
  revision: number;
  state: JudgeRunState;
  step: { index: number; total: number; code: JudgeStepCode; title: string; detail: string };
  allowedActions: JudgeAction[];
  checkpoint: JudgeCheckpoint | null;
  error: JudgeRunError | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export interface JudgeStatus {
  contractVersion: '1.2.0';
  enabled: boolean;
  pairLabel: string | null;
  role: 'landlord' | 'tenant' | null;
  simulatedVendorIds: string[];
  run: JudgeRun | null;
}

export interface JudgeErrorBody {
  success: false;
  code: JudgeErrorCode;
  message: string;
  retryAfterSeconds: number | null;
  nextAvailableAt: string | null;
}

export type JudgeDefName = 'Status' | 'Run' | 'Error' | 'StartInput' | 'ActionInput';

export function judgeSchemaErrors(name: JudgeDefName, value: unknown): string[] {
  const errors = schemaErrors(JUDGE_DEFS[name] as JsonSchema, value, JUDGE_DEFS);
  if (errors.length) return errors;
  // The closed schema checks the shape/count. Only after that may we inspect
  // the run and bind its code to the exact server-owned legacy/recovery index.
  const run = name === 'Run' ? value as JudgeRun : name === 'Status' ? (value as JudgeStatus).run : null;
  if (!run) return [];
  const steps = run.step.total === contract.legacySteps.length ? contract.legacySteps : contract.steps;
  return run.step.code === steps[run.step.index - 1]
    ? []
    : [`${name === 'Status' ? '$.run' : '$'}.step.code: does not match step index`];
}

const valid = (name: JudgeDefName, value: unknown) => judgeSchemaErrors(name, value).length === 0;

/** The sandbox as the UI may show it. Off whenever the body is missing, malformed or disabled. */
export const SANDBOX_OFF: JudgeStatus = {
  contractVersion: '1.2.0',
  enabled: false,
  pairLabel: null,
  role: null,
  simulatedVendorIds: [],
  run: null,
};

export function parseStatus(value: unknown): JudgeStatus {
  if (!valid('Status', value)) return SANDBOX_OFF;
  const status = value as JudgeStatus;
  return status.enabled ? status : SANDBOX_OFF;
}

export function parseRun(value: unknown): JudgeRun | null {
  return valid('Run', value) ? (value as JudgeRun) : null;
}

export function parseErrorBody(value: unknown): JudgeErrorBody | null {
  return valid('Error', value) ? (value as JudgeErrorBody) : null;
}
