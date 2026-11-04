import type { ErrorCode, NoticeCode, PolicyChangeView, Stage } from '../../types/irisV2';
import type { IrisFailure } from './irisApi';

/**
 * Fixed copy for every closed error code. The server's message is never
 * shown: every contract error carries the same generic sentence, and the code
 * is what decides what the person can do next.
 */
export const ERROR_COPY: Record<ErrorCode, string> = {
  invalid_input: 'Iris could not use that request. Check it and try again.',
  ambiguous_change: 'Iris needs the exact change: say the amount in CAD and which severity you mean.',
  auth_expired: 'Your session ended. Sign in again to keep using Iris.',
  forbidden: 'This is not available to your account.',
  record_not_found: 'Iris could not find that record for your account.',
  conversation_expired: 'This conversation ended after a period of inactivity. Start a new conversation to continue.',
  // The server caps a profile at two open conversations; one closes after 30
  // minutes without activity. Nothing here can close one this page never held.
  conversation_limit:
    'Iris already has two conversations open for your account, the most it allows at once. An unused conversation closes after 30 minutes; try again then.',
  turn_limit: 'This conversation has reached its limit of 20 questions. Start a new conversation to continue.',
  transcript_limit: 'This conversation is too long to continue. Start a new conversation to keep asking.',
  stale_context: 'The page changed while Iris was answering. Ask again on this page.',
  context_mismatch: 'The page changed while Iris was answering. Ask again on this page.',
  stale_policy: 'Your policy changed after this preview was made. No change was applied by this confirmation. Ask Iris for a new preview.',
  impact_changed: 'The requests this change affects have changed. No change was applied by this confirmation. Ask Iris for a new preview.',
  preview_expired: 'This preview expired. No change was applied by this confirmation. Ask Iris for a new preview.',
  preview_consumed: 'This preview was already used. Iris is checking what happened to it.',
  policy_revision_required: 'Reload your policy before saving, so no newer change is overwritten.',
  rate_limited: 'Too many requests right now. Wait a moment and try again.',
  concurrent_turn_limit: 'Iris is still answering another question. Wait for it to finish.',
  impact_incomplete: 'Iris could not list every request this change affects, so it cannot be confirmed. Ask again in a moment.',
  audit_unavailable: 'Your policy was not changed: the change could not be recorded, so it was rolled back. Try again later.',
  model_unavailable: 'Iris is not available right now. Your records are unchanged.',
  invalid_model_output: 'Iris could not put together a reliable answer. Your records are unchanged.',
  tool_limit: 'This question needs more records than Iris can read at once. Ask about one thing at a time.',
  turn_interrupted: 'This answer was interrupted. Ask again to start a new answer.',
  service_unavailable: 'Iris is not available right now. Try again in a moment.',
  unsupported_setting: 'Iris cannot change this setting. You can review it on the Policy page.',
  stale_evidence: 'This source has changed since the answer was given, so it is no longer shown.',
};

export function failureCopy(failure: IrisFailure | null): string {
  if (!failure) return '';
  switch (failure.kind) {
    case 'http': {
      const base = ERROR_COPY[failure.code];
      if (failure.retryAfterSeconds && (failure.code === 'rate_limited' || failure.code === 'concurrent_turn_limit')) {
        return `${base} You can try again in ${failure.retryAfterSeconds} seconds.`;
      }
      return base;
    }
    case 'transport':
      return 'Iris could not reach Artrelo. Check your connection and try again.';
    case 'unexpected':
      return 'Something went wrong on our side. Try again in a moment.';
    case 'contract':
      return 'Iris received an answer it could not verify, so it is not shown.';
    case 'aborted':
      return '';
  }
}

/** "30 seconds", "2 minutes": a Retry-After for people. */
export function waitCopy(seconds: number | null): string {
  if (!seconds || seconds <= 0) return 'a few minutes';
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** A confirmation that came back with an error. A 429 was never submitted. */
export function confirmFailureCopy(failure: IrisFailure | null): string {
  if (failure?.kind === 'http' && failure.code === 'rate_limited') {
    return `Too many policy changes were confirmed in a short time, so this one was not submitted and nothing changed. This preview has been cleared. Wait ${waitCopy(failure.retryAfterSeconds)}, then ask Iris for a fresh preview.`;
  }
  return failureCopy(failure);
}

export const STOPPED_COPY = {
  person: 'This answer was stopped. This turn did not apply a policy change.',
  context: 'Stopped when you moved to another page. This turn did not apply a policy change.',
};

export const NOTICE_TITLES: Record<NoticeCode, string> = {
  permission_refusal: 'Not available',
  out_of_scope: 'Outside what Iris covers',
  unavailable: 'Unavailable',
  unknown: 'Not recorded',
  stale_guide: 'Guide being updated',
  missing_guide: 'No guide yet',
  restricted_topic: 'Not available here',
  partial_coverage: 'Partial answer',
  rate_limited: 'Slow down',
  cancelled: 'Stopped',
  request_context_required: 'Open a request first',
  context_changed: 'Page changed',
  unsupported_setting: 'Read-only setting',
  no_change_needed: 'No change needed',
  explanation_unavailable: 'Explanation unavailable',
};

export const STAGE_LABELS: Record<Stage['stage'], string> = {
  preview: 'Preview',
  validate: 'Validate',
  confirm: 'Confirm',
  execute: 'Execute',
  verify: 'Verify',
  audit: 'Audit',
};

export const REFRESH_COPY: Record<PolicyChangeView['refreshState'], string> = {
  pending: 'Re-checking open requests against the new policy has not started yet.',
  running: 'Re-checking open requests against the new policy…',
  completed: 'Open requests were re-checked against the new policy.',
  partial: 'Some open requests could not be re-checked yet. Your policy change is saved.',
  failed: 'Re-checking open requests failed. Your policy change is saved; the check will be retried.',
  not_required: 'No open requests needed re-checking.',
};

export const POLICY_STATE_COPY: Record<PolicyChangeView['state'], string> = {
  preview_ready: 'Preview — nothing has changed yet.',
  stale: 'Your policy changed after this preview. No change was applied.',
  expired: 'This preview expired. No change was applied.',
  discarded: 'This preview was discarded. No change was applied.',
  applied: 'Applied and verified.',
  failed: 'Not applied.',
};

export const FIELD_LABELS: Record<PolicyChangeView['changes'][number]['field'], string> = {
  defaultQuota: 'Default quota',
  allowAutopilotForLowSeverity: 'Low-severity autopilot',
  allowAutopilotForMediumSeverity: 'Medium-severity autopilot',
};
