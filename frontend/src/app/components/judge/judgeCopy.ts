// Every string the judge sandbox UI shows, and where each checkpoint links.
// Fixed copy only: the server's error message is never rendered, so no raw
// exception or provider text can reach the page.
import { decisionsFocusHref } from '../landlord/decisionHref';
import type {
  JudgeAction,
  JudgeCheckpoint,
  JudgeErrorCode,
  JudgeRunState,
} from '../../contracts/judgeSandbox';

export const STATE_LABEL: Record<JudgeRunState, string> = {
  running: 'Working on this step',
  waiting_on_tenant: 'Waiting on the tenant',
  waiting_on_landlord: 'Waiting on you',
  ready_to_continue: 'Ready to continue',
  paused: 'Paused',
  failed: 'Stopped',
  completed: 'Run complete',
};

export const ACTION_LABEL: Record<JudgeAction, string> = {
  continue: 'Continue',
  pause: 'Pause',
  resume: 'Resume',
};

export const BUSY_LABEL: Record<'start' | JudgeAction, string> = {
  start: 'Starting…',
  continue: 'Continuing…',
  pause: 'Pausing…',
  resume: 'Resuming…',
};

const when = (iso: string | null) => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export function errorCopy(code: JudgeErrorCode, nextAvailableAt: string | null, retryAfterSeconds: number | null): string {
  const at = when(nextAvailableAt);
  const wait = retryAfterSeconds ? ` Try again in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} min.` : '';
  switch (code) {
    case 'unsupported_scenario':
      return 'This request is outside the guided demo scenario. The demo is stopped; the ordinary request and safety process remain available. Do not retry, reset or reseed this run, or change real facts to fit the demo.';
    case 'run_exists':
      return 'This pair already has its run. Showing it now.';
    case 'stale_revision':
      return 'This step changed in another window. Showing the current step.';
    case 'step_not_ready':
      return 'This step is still waiting on something. See below.';
    case 'checkpoint_requires_human':
      return 'This step needs a person to decide on its own page. Continue cannot do it for you.';
    case 'tenant_quota_reached':
      return `The tenant's request limit is reached${at ? ` until ${at}` : ''}. Ask the organisers for a spare pair.`;
    case 'open_request_cap':
      return 'This unit already has 2 open requests, the most it can have.';
    case 'no_free_visit_time':
      return 'There is no free visit time for this step. The run is waiting.';
    case 'wallet_funding_required':
      return 'A synthetic Wallet hold is blocking this step. Ask the organisers to check it; judge funding controls are unavailable. Nothing was charged.';
    case 'idempotency_conflict':
    case 'ambiguous_request':
      return 'That did not match a single request in this pair. Nothing was changed.';
    case 'action_unknown':
      return 'We could not confirm whether that step ran. Showing what the server has now.';
    case 'run_busy':
      return 'Another step is still running. Wait for it to finish.';
    case 'ai_unavailable':
      return 'The AI step is unavailable right now. The run shows what happened instead; nothing is presented as AI.';
    case 'ai_cap_reached':
      return `The AI limit for this sandbox is reached.${wait}`;
    case 'rate_limited':
      return `Too many tries in a short time.${wait || ' Try again shortly.'}`;
    case 'forbidden_role':
      return 'Only the landlord of this pair can move the run.';
    case 'auth_expired':
      return 'Your session ended. Sign in again to continue.';
    case 'sandbox_disabled':
    case 'record_not_found':
      return 'The sandbox run is not available.';
    case 'invalid_input':
    case 'service_unavailable':
    default:
      return 'Something went wrong on our side. Nothing new was started.';
  }
}

export const UNKNOWN_OUTCOME = 'An earlier action response could not be confirmed. No action was resent. The recorded server status is shown above.';

export interface CheckpointLink {
  /** What the person has to do, in one sentence. */
  text: string;
  href: string | null;
  label: string | null;
}

const requestHref = (role: 'landlord' | 'tenant', requestId: string) =>
  role === 'landlord' ? `/dashboard/requests/${requestId}` : `/portal/requests/${requestId}`;

/**
 * Where a checkpoint is handled. Every link goes to an existing page with its
 * own confirmation; nothing here acts for anyone. The tenant only gets the
 * checkpoints that are theirs.
 */
export function checkpointLink(checkpoint: JudgeCheckpoint | null, role: 'landlord' | 'tenant'): CheckpointLink | null {
  if (!checkpoint) return null;
  const { kind, requestId } = checkpoint;
  if (role === 'tenant') {
    if (kind === 'tenant_submit') {
      return { text: 'Submit a maintenance request for your unit.', href: '/portal/new', label: 'New request' };
    }
    if (kind === 'tenant_completion' && requestId) {
      return { text: 'Confirm whether the work is done.', href: '/portal/schedule', label: 'Review the work' };
    }
    if (kind === 'booking' && requestId) {
      return { text: 'Review the proposed original visit and confirm it on your request. A proposal is not a confirmed appointment.', href: requestHref('tenant', requestId), label: 'Review original visit' };
    }
    if (kind === 'visit_change' && requestId) {
      return {
        text: 'Answer the proposed visit change.',
        href: requestHref('tenant', requestId),
        label: 'Open your request',
      };
    }
    return null;
  }
  switch (kind) {
    case 'tenant_submit':
      return {
        text: "Use this pair's tenant in a separate signed-in browser profile to submit a request.",
        href: null,
        label: null,
      };
    case 'approval':
      if (!checkpoint.approvalId) return {
        text: 'Review the recorded request hold or schedule on the ordinary request. No Decision has been identified for this checkpoint.',
        href: requestId ? requestHref('landlord', requestId) : null,
        label: requestId ? 'Open request review' : null,
      };
      return { text: 'A decision is waiting for you.', href: requestId ? decisionsFocusHref(requestId) : '/dashboard/decisions', label: 'Open Decisions' };
    case 'quote_over_limit':
      return {
        text: 'The quote is above your limit and needs your decision.',
        href: requestId ? decisionsFocusHref(requestId) : '/dashboard/decisions',
        label: 'Open Decisions',
      };
    case 'wallet_funding':
      return { text: 'A synthetic Wallet hold needs organiser attention. Judge funding controls are unavailable; no transfer is established.', href: '/dashboard/wallet', label: 'Review Wallet hold' };
    case 'tenant_completion':
      return { text: 'Waiting for the tenant to confirm the work is done.', href: requestId ? requestHref('landlord', requestId) : null, label: requestId ? 'Open request' : null };
    case 'iris_review':
      return {
        text: 'Open the request and use Ask Iris. Continue does not ask Iris for you.',
        href: requestId ? requestHref('landlord', requestId) : null,
        label: requestId ? 'Open request' : null,
      };
    case 'visit_change':
    case 'booking':
    case 'vendor_work':
    default:
      return { text: 'Review it on the request.', href: requestId ? requestHref('landlord', requestId) : null, label: requestId ? 'Open request' : null };
  }
}

export const HACKATHON_BADGE = 'Built during the hackathon';
export const SIMULATED_VENDOR = 'Simulated vendor';
