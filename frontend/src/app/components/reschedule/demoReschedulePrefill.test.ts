import { describe, expect, it, vi } from 'vitest';
import { SANDBOX_OFF, type JudgeRun } from '../../contracts/judgeSandbox';
import type { JudgeView } from '../judge/judgeController';
import type { BookingPayload } from '../../types/booking';
import { applyDemoReason, DEMO_RESCHEDULE_REASON, currentDemoWindows, demoRescheduleScope, readDemoWindows, type DemoRescheduleContext } from './demoReschedulePrefill';

const at = Date.parse('2026-11-10T12:00:00Z');
const run: JudgeRun = { runId: 'synthetic_run', requestId: 'request1', revision: 8, state: 'waiting_on_landlord', step: { index: 7, total: 14, code: 'visit_change', title: 'Visit change', detail: '' }, allowedActions: ['pause'], checkpoint: { kind: 'visit_change', requestId: 'request1', approvalId: null }, error: null, startedAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-10T12:00:00Z', completedAt: null };
const view: JudgeView = { loaded: true, status: { ...SANDBOX_OFF, enabled: true, role: 'landlord', pairLabel: 'Synthetic test pair', run }, busy: null, notice: null, polling: false, pollExpired: false, refreshFailed: false };
const context = (): DemoRescheduleContext => ({ view: structuredClone(view), requestId: 'request1', revision: 4, reason: '', rows: [{ start: '', end: '' }] });
const window = { start: '2026-11-13T12:00:00.000Z', end: '2026-11-13T14:00:00.000Z' };
const booking = (): BookingPayload => ({ vendorName: 'Synthetic vendor', reschedules: [], coordination: { phase: 'scheduled', revision: 4, rounds: 1, deadlineAt: '2026-11-11T12:00:00Z', arrivalAt: '2026-11-12T12:00:00Z', durationMinutes: 120, proposals: [window], capabilities: { state: 'confirmed', reasonCode: null, canConfirmInitial: false, canSuggestInitialAlternatives: false, canProposeInitialTime: false, canRequestReschedule: true, requiresRescheduleReason: true } } });

describe('demo-only server-window candidates', () => {
  it('adds only an explicitly requested editable synthetic reason and preserves any text including whitespace', () => {
    const c = context(), apply = vi.fn();
    expect(apply).not.toHaveBeenCalled(); expect(c.reason).toBe('');
    expect(applyDemoReason(() => c, apply)).toBe(true); expect(apply).toHaveBeenCalledExactlyOnceWith(DEMO_RESCHEDULE_REASON);
    for (const text of [' ', 'My actual reason']) { c.reason = text; expect(applyDemoReason(() => c, apply)).toBe(false); expect(c.reason).toBe(text); }
    c.reason = ''; c.view.status = SANDBOX_OFF; expect(applyDemoReason(() => c, apply)).toBe(false); expect(apply).toHaveBeenCalledTimes(1);
  });
  it('uses only returned alternatives, preserves source/order and does not invent calendar availability', () => {
    const data = booking(), before = JSON.stringify(data);
    expect(currentDemoWindows(data, 4, at)).toEqual([window]); expect(JSON.stringify(data)).toBe(before);
    expect(currentDemoWindows({ ...data, coordination: { ...data.coordination!, proposals: [] } }, 4, at)).toEqual([]);
  });
  it.each(['revision', 'capability', 'duration', 'arrival', 'active', 'missing-active-projection'] as const)('refuses stale/missing authoritative %s', field => {
    const data = booking();
    if (field === 'revision') data.coordination!.revision++;
    if (field === 'capability') data.coordination!.capabilities!.canRequestReschedule = false;
    if (field === 'duration') data.coordination!.durationMinutes = null;
    if (field === 'arrival') data.coordination!.arrivalAt = null;
    if (field === 'active') data.reschedules = [{ active: true } as never];
    if (field === 'missing-active-projection') delete data.reschedules;
    expect(currentDemoWindows(data, 4, at)).toEqual([]);
  });
  it('retains the two-hour earlier-visit cutoff plus the15-minute new-response floor', () => {
    const data = booking();
    data.coordination!.arrivalAt = new Date(at + (2 * 60 + 15) * 60_000).toISOString();
    expect(currentDemoWindows(data, 4, at)).toEqual([window]);
    expect(currentDemoWindows(data, 4, at + 1)).toEqual([]);
    data.coordination!.arrivalAt = '2026-11-12T12:00:00Z';
    data.coordination!.proposals = [{ start: new Date(at + (2 * 60 + 14) * 60_000).toISOString(), end: new Date(at + 5 * 3600_000).toISOString() }];
    expect(currentDemoWindows(data, 4, at)).toEqual([]);
  });
  it('rejects original/overlapping, short, past, malformed, sub-minute and beyond60-day windows', () => {
    for (const candidate of [
      { start: '2026-11-12T12:00:00Z', end: '2026-11-12T14:00:00Z' },
      { start: '2026-11-12T13:00:00Z', end: '2026-11-12T16:00:00Z' },
      { start: window.start, end: '2026-11-13T13:00:00Z' },
      { start: '2026-11-09T12:00:00Z', end: '2026-11-09T14:00:00Z' },
      { start: 'invalid', end: window.end },
      { start: '2026-11-13T12:00:30Z', end: '2026-11-13T15:00:00Z' },
      { start: '2027-02-13T12:00:00Z', end: '2027-02-13T15:00:00Z' },
    ]) expect(currentDemoWindows({ ...booking(), coordination: { ...booking().coordination!, proposals: [candidate] } }, 4, at)).toEqual([]);
    expect(currentDemoWindows(null, 4, at)).toEqual([]); expect(currentDemoWindows(booking(), 4, NaN)).toEqual([]);
  });
  it('refuses a lossy ambiguous local-clock conversion rather than changing its submitted instant', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const data = booking(); data.coordination!.arrivalAt = '2026-11-03T12:00:00Z';
      data.coordination!.proposals = [{ start: '2026-11-01T06:30:00Z', end: '2026-11-01T08:30:00Z' }];
      expect(currentDemoWindows(data, 4, Date.parse('2026-10-30T12:00:00Z'))).toEqual([]);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it('never offers the helper to ordinary/foreign/tenant/unknown/busy scopes or terminal runs', () => {
    const changes: ((c: DemoRescheduleContext) => void)[] = [
      c => { c.view.status = SANDBOX_OFF; }, c => { c.requestId = 'foreign'; }, c => { c.view.status.role = 'tenant'; },
      c => { c.view.loaded = false; }, c => { c.view.refreshFailed = true; }, c => { c.view.busy = 'continue'; },
      c => { c.view.notice = { kind: 'unknown' }; }, c => { c.disabled = true; }, c => { c.revision = 0; },
      c => { c.view.status.run!.state = 'completed'; }, c => { c.view.status.run!.state = 'failed'; },
    ];
    for (const change of changes) { const c = context(); change(c); expect(demoRescheduleScope(c)).toBeNull(); }
  });
  it('performs one explicit ordinary read and returns editable candidates without any write or consent', async () => {
    const c = context(), read = vi.fn(async () => ({ data: booking() }));
    const before = JSON.stringify(c);
    const result = await readDemoWindows({ current: () => c, read, now: () => at });
    expect(result.kind).toBe('ready'); if (result.kind === 'ready') expect(result.windows).toEqual([window]);
    expect(read).toHaveBeenCalledExactlyOnceWith('request1'); expect(JSON.stringify(c)).toBe(before);
  });
  it.each(['reason-edit', 'window-edit', 'request', 'identity', 'revision', 'disabled', 'slow', 'clock-backwards'] as const)('preserves late %s changes while a read is pending', async change => {
    const c = context(); let release!: (value: { data: BookingPayload }) => void, clock = at;
    const read = vi.fn(() => new Promise<{ data: BookingPayload }>(resolve => { release = resolve; }));
    const pending = readDemoWindows({ current: () => c, read, now: () => clock });
    if (change === 'reason-edit') c.reason = 'My edited reason';
    if (change === 'window-edit') c.rows = [{ start: '2026-11-14T12:00', end: '2026-11-14T15:00' }];
    if (change === 'request') c.requestId = 'other';
    if (change === 'identity') c.view.status = SANDBOX_OFF;
    if (change === 'revision') c.revision++;
    if (change === 'disabled') c.disabled = true;
    if (change === 'slow') clock += 30_001;
    if (change === 'clock-backwards') clock--;
    const edited = JSON.stringify(c); release({ data: booking() });
    expect(await pending).toEqual({ kind: 'changed' }); expect(JSON.stringify(c)).toBe(edited); expect(read).toHaveBeenCalledTimes(1);
  });
  it('keeps no-window and read-error states honest, never retries or changes existing input', async () => {
    const c = context(), noWindow = booking(); noWindow.coordination!.proposals = [];
    expect(await readDemoWindows({ current: () => c, read: async () => ({ data: noWindow }), now: () => at })).toEqual({ kind: 'unavailable' });
    const read = vi.fn(async () => { throw Error('Unavailable'); });
    expect(await readDemoWindows({ current: () => c, read, now: () => at })).toEqual({ kind: 'error' }); expect(read).toHaveBeenCalledTimes(1);
    c.rows[0].start = 'already typed';
    expect(await readDemoWindows({ current: () => c, read, now: () => at })).toEqual({ kind: 'changed' }); expect(read).toHaveBeenCalledTimes(1);
  });
});
