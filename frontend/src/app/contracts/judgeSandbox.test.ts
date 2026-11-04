import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import contractJson from './judgeSandbox.v1.json';
import {
  JUDGE_POLL_MS,
  JUDGE_POLL_STOP_MS,
  JUDGE_STEP_COUNT,
  SANDBOX_OFF,
  judgeSchemaErrors,
  parseErrorBody,
  parseRun,
  parseStatus,
} from './judgeSandbox';

// Frozen by Principal; ACKed before the first frontend edit.
const FROZEN_SHA256 = '22a95c8d034b4b7a3d535864b371853c88cfb6fa92a242effc146eea1a42c60b';

// Existing 13-step fixtures intentionally exercise legacy histories under1.2.
const at = '2026-10-31T06:00:00.000Z';
const sampleRun = {
  runId: 'run_owned',
  requestId: null,
  revision: 1,
  state: 'waiting_on_tenant',
  step: { index: 1, total: 13, code: 'tenant_submit', title: 'Submit the tenant request', detail: 'Use the paired tenant account.' },
  allowedActions: ['pause'],
  checkpoint: { kind: 'tenant_submit', requestId: null, approvalId: null },
  error: null,
  startedAt: at,
  updatedAt: at,
  completedAt: null,
};
const enabled = { contractVersion: '1.2.0', enabled: true, pairLabel: 'Judge pair 1', role: 'landlord', simulatedVendorIds: ['vendor_owned'], run: sampleRun };
const disabled = { contractVersion: '1.2.0', enabled: false, pairLabel: null, role: null, simulatedVendorIds: [], run: null };

describe('judge sandbox contract v1', () => {
  it('is the exact frozen bytes', () => {
    const bytes = readFileSync(fileURLToPath(new URL('./judgeSandbox.v1.json', import.meta.url)));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FROZEN_SHA256);
  });

  it('accepts the backend examples: own run, enabled status, disabled status, inputs', () => {
    expect(judgeSchemaErrors('Run', sampleRun)).toEqual([]);
    expect(judgeSchemaErrors('Status', enabled)).toEqual([]);
    expect(judgeSchemaErrors('Status', disabled)).toEqual([]);
    expect(judgeSchemaErrors('StartInput', {})).toEqual([]);
    expect(judgeSchemaErrors('ActionInput', { expectedRevision: 1, stepCode: 'vendor_quote' })).toEqual([]);
    for (const code of Object.keys(contractJson.errors)) {
      expect(judgeSchemaErrors('Error', { success: false, code, message: 'Safe copy.', retryAfterSeconds: null, nextAvailableAt: null })).toEqual([]);
    }
  });

  it('rejects owner, pair, consent and method selectors and unknown actions', () => {
    for (const injected of [{ landlordId: 'foreign' }, { pairId: 'foreign' }, { tenantConfirm: true }, { method: 'approve_bill' }]) {
      expect(judgeSchemaErrors('StartInput', injected)).not.toEqual([]);
    }
    for (const input of [
      { expectedRevision: 0, stepCode: 'vendor_quote' },
      { expectedRevision: 1, stepCode: 'approve' },
      { expectedRevision: 1, stepCode: 'vendor_quote', vendorId: 'foreign' },
      { expectedRevision: 1, stepCode: 'vendor_quote', confirmed: true },
    ]) {
      expect(judgeSchemaErrors('ActionInput', input)).not.toEqual([]);
    }
    expect(parseRun({ ...sampleRun, allowedActions: ['approve'] })).toBeNull();
    expect(parseErrorBody({ success: false, code: 'provider_dump', message: 'x', retryAfterSeconds: null, nextAvailableAt: null })).toBeNull();
  });

  it('reads anything but a valid enabled status as off', () => {
    expect(parseStatus(enabled)).toEqual(enabled);
    expect(parseStatus(disabled)).toBe(SANDBOX_OFF);
    expect(parseStatus(undefined)).toBe(SANDBOX_OFF);
    expect(parseStatus({ ...enabled, role: 'admin_override' })).toBe(SANDBOX_OFF);
    expect(parseStatus({ ...enabled, contractVersion: '2.0.0' })).toBe(SANDBOX_OFF);
    expect(parseStatus({ ...enabled, extra: true })).toBe(SANDBOX_OFF);
  });

  it('exposes the frozen limits', () => {
    expect(JUDGE_STEP_COUNT).toBe(14);
    expect(JUDGE_POLL_MS).toBe(2000);
    expect(JUDGE_POLL_STOP_MS).toBe(60000);
  });
});
