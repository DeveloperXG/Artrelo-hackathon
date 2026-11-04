import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import contractJson from '../../contracts/iris.v2.json';
import { createIrisContract } from '../../contracts/irisContract';
import type { Policy } from '../../types/landlord';
import { buildPolicyPut, classifySaveError, isNewerRevision, onPolicyNudge } from './policyCas';

const contract = createIrisContract(contractJson);

const draft = {
  defaultQuota: 300,
  requireApprovalOverQuota: true,
  requireApprovalForFirstTimeVendor: false,
  allowQuoteClarification: true,
  allowAutopilotForLowSeverity: true,
  allowAutopilotForMediumSeverity: false,
  digestFrequency: 'daily',
  emergencyNotificationChannels: ['sms'],
  lowFundsThreshold: 100,
  autoAdvanceOnVendorDecline: true,
  maxOutreachAttempts: 3,
  policyRevision: 4,
} as unknown as Policy;

describe('revision-checked policy saves', () => {
  it('sends the revision the form was loaded at, and nothing it was not given', () => {
    const body = buildPolicyPut(draft, 4, { hasWallet: false });
    expect(body.expectedPolicyRevision).toBe(4);
    expect(body).not.toHaveProperty('lowFundsThreshold');
    expect(body).not.toHaveProperty('policyRevision');
    expect(buildPolicyPut(draft, 4, { hasWallet: true }).lowFundsThreshold).toBe(100);
  });

  it('the body is a valid frozen PolicyPut', () => {
    const defs = contractJson.$defs as Record<string, unknown>;
    expect(defs.PolicyPut).toBeTruthy();
    expect(contract.errorsFor('PolicyPut', buildPolicyPut(draft, 4, { hasWallet: true }))).toEqual([]);
  });

  it('409 stale_policy and 428 policy_revision_required keep the draft as a stale notice', () => {
    const stale = new ApiError('Policy changed', 409, { code: 'stale_policy', currentPolicyRevision: 5 });
    expect(classifySaveError(stale)).toEqual({ kind: 'stale', currentPolicyRevision: 5 });
    const missing = new ApiError('Revision required', 428, { code: 'policy_revision_required' });
    expect(classifySaveError(missing)).toEqual({ kind: 'stale', currentPolicyRevision: null });
    // A 409 for something else is not a stale notice.
    expect(classifySaveError(new ApiError('Other', 409, { code: 'other' })).kind).toBe('other');
  });

  it('field errors still land beside their field', () => {
    const e = new ApiError('Too many', 400, { field: 'maxOutreachAttempts' });
    expect(classifySaveError(e)).toEqual({ kind: 'field', field: 'maxOutreachAttempts', message: 'Too many' });
    expect(classifySaveError(new Error('boom'))).toEqual({ kind: 'other', message: 'boom' });
  });

  it('a live nudge never wipes a form with edits', () => {
    expect(onPolicyNudge(false)).toBe('reload');
    expect(onPolicyNudge(true)).toBe('warn');
    expect(isNewerRevision(5, 4)).toBe(true);
    expect(isNewerRevision(4, 4)).toBe(false);
    expect(isNewerRevision(undefined, 4)).toBe(false);
    expect(isNewerRevision(1, null)).toBe(true);
  });
});
