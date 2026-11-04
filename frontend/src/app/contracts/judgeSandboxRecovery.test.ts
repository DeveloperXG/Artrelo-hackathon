import { describe, expect, it } from 'vitest';
import { schemaErrors } from './irisValidate';
import {
  JUDGE_CONTRACT_VERSION, JUDGE_DEFS, SANDBOX_OFF,
  judgeSchemaErrors, parseRun, parseStatus,
} from './judgeSandbox';

// Independent protocol expectations, not a list derived from the adapter.
const legacy = ['tenant_submit', 'routing', 'vendor_quote', 'quote_resolution', 'booking', 'visit_change', 'vendor_reschedule', 'tenant_reschedule', 'vendor_work', 'tenant_completion', 'landlord_review', 'iris_segment', 'complete'];
const recovery = ['tenant_submit', 'routing', 'vendor_decline', 'vendor_quote', 'quote_resolution', 'booking', 'visit_change', 'vendor_reschedule', 'tenant_reschedule', 'vendor_work', 'tenant_completion', 'landlord_review', 'iris_segment', 'complete'];
const at = '2026-11-01T17:00:00Z';
const run = (total: number, index: number, code: string) => ({
  runId: 'run_owned', requestId: 'request_owned', revision: 7, state: 'ready_to_continue',
  step: { total, index, code, title: 'Server title', detail: 'Server-owned current step.' },
  allowedActions: ['continue', 'pause'], checkpoint: null, error: null,
  startedAt: at, updatedAt: at, completedAt: null,
});
const status = (value: unknown) => ({ contractVersion: '1.2.0', enabled: true, pairLabel: 'Synthetic pair', role: 'landlord', simulatedVendorIds: ['vendor_a', 'vendor_b'], run: value });
const positions = [legacy, recovery].flatMap(sequence => sequence.map((code, i) => ({ total: sequence.length, index: i + 1, code })));

describe('Guide1.1 exact legacy/recovery sequence boundary', () => {
  it.each(positions)('accepts total$total/index$index/$code directly and nested', ({ total, index, code }) => {
    const value = run(total, index, code);
    expect(judgeSchemaErrors('Run', value)).toEqual([]);
    expect(parseRun(value)).toEqual(value);
    expect(judgeSchemaErrors('Status', status(value))).toEqual([]);
    expect(parseStatus(status(value))).toEqual(status(value));
  });

  it.each(positions)('rejects every other known code at total$total/index$index', ({ total, index, code }) => {
    for (const wrong of recovery.filter(candidate => candidate !== code)) {
      const value = run(total, index, wrong);
      expect(judgeSchemaErrors('Run', value), wrong).not.toEqual([]);
      expect(parseRun(value), wrong).toBeNull();
      expect(judgeSchemaErrors('Status', status(value)), wrong).not.toEqual([]);
      expect(parseStatus(status(value)), wrong).toBe(SANDBOX_OFF);
    }
  });

  it('rejects a schema-valid swapped code in both readers and the controller validation entrypoint', () => {
    const swapped = run(14, 3, 'vendor_quote');
    // This is precisely the semantic regression the closed shape alone misses.
    expect(schemaErrors(JUDGE_DEFS.Run, swapped, JUDGE_DEFS)).toEqual([]);
    expect(schemaErrors(JUDGE_DEFS.Status, status(swapped), JUDGE_DEFS)).toEqual([]);
    expect(judgeSchemaErrors('Run', swapped)).toEqual(['$.step.code: does not match step index']);
    expect(judgeSchemaErrors('Status', status(swapped))).toEqual(['$.run.step.code: does not match step index']);
    expect(parseRun(swapped)).toBeNull();
    expect(parseStatus(status(swapped))).toBe(SANDBOX_OFF);
  });

  it('retains completed legacy histories without inserting a decline or resetting a run', () => {
    const completed = { ...run(13, 13, 'complete'), state: 'completed', allowedActions: [], completedAt: at };
    expect(parseStatus(status(completed))).toEqual(status(completed));
    expect(parseRun(completed)?.step).toEqual(completed.step);
    expect(JUDGE_CONTRACT_VERSION).toBe('1.2.0');
    expect(SANDBOX_OFF.contractVersion).toBe('1.2.0');
    expect(parseStatus(status(null))).toEqual(status(null));
  });

  it('fails closed for malformed totals, indices, unknown codes and old transport versions', () => {
    for (const total of [0, 12, 15, 13.5, '14', null]) {
      const value = { ...run(14, 3, 'vendor_decline'), step: { ...run(14, 3, 'vendor_decline').step, total } };
      expect(parseRun(value)).toBeNull();
      expect(parseStatus(status(value))).toBe(SANDBOX_OFF);
    }
    for (const index of [0, -1, 15, 3.5, '3', null]) {
      const value = { ...run(14, 3, 'vendor_decline'), step: { ...run(14, 3, 'vendor_decline').step, index } };
      expect(parseRun(value)).toBeNull();
      expect(parseStatus(status(value))).toBe(SANDBOX_OFF);
    }
    expect(parseRun(run(13, 14, 'complete'))).toBeNull();
    expect(parseRun(run(14, 3, 'approve_recovery'))).toBeNull();
    for (const value of [null, run(13, 3, 'vendor_quote'), run(14, 3, 'vendor_decline')]) {
      for (const contractVersion of ['1.0.0', '1.1.0']) expect(parseStatus({ ...status(value), contractVersion })).toBe(SANDBOX_OFF);
    }
  });

  it('keeps response and action/start inputs closed, with no client story/vendor/consent selectors', () => {
    const value = run(14, 3, 'vendor_decline');
    for (const invalid of [{ ...value, storyVersion: 'decline_recovery_v1' }, { ...value, step: { ...value.step, vendorId: 'vendor_b' } }]) {
      expect(parseRun(invalid)).toBeNull();
      expect(parseStatus(status(invalid))).toBe(SANDBOX_OFF);
    }
    expect(parseStatus({ ...status(value), story: 'decline_recovery_v1' })).toBe(SANDBOX_OFF);
    for (const extra of [{ storyVersion: 'decline_recovery_v1' }, { story: 'decline_recovery_v1' }, { vendorId: 'vendor_b' }, { consent: true }]) {
      expect(judgeSchemaErrors('StartInput', extra)).not.toEqual([]);
      expect(judgeSchemaErrors('ActionInput', { expectedRevision: 7, stepCode: 'vendor_decline', ...extra })).not.toEqual([]);
    }
    expect(judgeSchemaErrors('StartInput', {})).toEqual([]);
    expect(judgeSchemaErrors('ActionInput', { expectedRevision: 7, stepCode: 'vendor_decline' })).toEqual([]);
  });
});
