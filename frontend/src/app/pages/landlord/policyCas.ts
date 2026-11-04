import { ApiError } from '../../api/client';
import type { Policy } from '../../types/landlord';

/**
 * Revision-checked Policy saves (frozen v2 policyCas). Every save says which
 * saved revision it was edited from; if Iris or another tab saved in between,
 * the server answers 409 stale_policy (or 428 if the revision is missing) and
 * nothing is overwritten. The page then keeps the person's unsaved edits on
 * screen until they choose to reload.
 */
export function buildPolicyPut(draft: Policy, loadedRevision: number | null, { hasWallet }: { hasWallet: boolean }) {
  return {
    defaultQuota: draft.defaultQuota,
    requireApprovalOverQuota: draft.requireApprovalOverQuota,
    requireApprovalForFirstTimeVendor: draft.requireApprovalForFirstTimeVendor,
    allowQuoteClarification: Boolean(draft.allowQuoteClarification),
    allowAutopilotForLowSeverity: draft.allowAutopilotForLowSeverity,
    allowAutopilotForMediumSeverity: draft.allowAutopilotForMediumSeverity,
    digestFrequency: draft.digestFrequency,
    emergencyNotificationChannels: draft.emergencyNotificationChannels,
    ...(hasWallet ? { lowFundsThreshold: draft.lowFundsThreshold } : {}),
    autoAdvanceOnVendorDecline: draft.autoAdvanceOnVendorDecline,
    maxOutreachAttempts: draft.maxOutreachAttempts,
    // null only when no policy has ever been saved for this account.
    expectedPolicyRevision: loadedRevision,
  };
}

export type SaveFailure =
  | { kind: 'stale'; currentPolicyRevision: number | null }
  | { kind: 'field'; field: 'defaultQuota' | 'maxOutreachAttempts' | 'lowFundsThreshold'; message: string }
  | { kind: 'other'; message: string };

export function classifySaveError(error: unknown): SaveFailure {
  const payload = error instanceof ApiError ? (error.payload as { code?: unknown; field?: unknown; currentPolicyRevision?: unknown } | null) : null;
  const code = payload && typeof payload.code === 'string' ? payload.code : null;
  if (
    error instanceof ApiError &&
    ((error.status === 409 && code === 'stale_policy') || (error.status === 428 && code === 'policy_revision_required'))
  ) {
    const current = payload?.currentPolicyRevision;
    return { kind: 'stale', currentPolicyRevision: typeof current === 'number' ? current : null };
  }
  const message = error instanceof Error ? error.message : '';
  const field = payload && typeof payload.field === 'string' ? payload.field : null;
  if (field === 'defaultQuota' || field === 'maxOutreachAttempts' || field === 'lowFundsThreshold') {
    return { kind: 'field', field, message };
  }
  return { kind: 'other', message };
}

/** Live nudges: a clean form reloads quietly; a form with edits is never wiped. */
export function onPolicyNudge(dirty: boolean): 'reload' | 'warn' {
  return dirty ? 'warn' : 'reload';
}

/** A nudge only matters if the saved revision moved past the one loaded. */
export function isNewerRevision(current: unknown, loaded: number | null): boolean {
  return typeof current === 'number' && (loaded === null || current > loaded);
}
