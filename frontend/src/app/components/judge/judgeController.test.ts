import { describe, expect, it, vi } from 'vitest';
import { JudgeSandboxController, type JudgeApi } from './judgeController';

// Existing 13-step fixtures intentionally exercise legacy histories under1.2.
const at = '2026-10-31T06:00:00.000Z';
const run = (over: Record<string, unknown> = {}) => ({
  runId: 'run_owned',
  requestId: 'req_owned',
  revision: 3,
  state: 'ready_to_continue',
  step: { index: 3, total: 13, code: 'vendor_quote', title: 'Vendor sends a quote', detail: 'The simulated vendor sends an itemized quote.' },
  allowedActions: ['continue', 'pause'],
  checkpoint: null,
  error: null,
  startedAt: at,
  updatedAt: at,
  completedAt: null,
  ...over,
});
const status = (r: unknown = run(), over: Record<string, unknown> = {}) => ({
  data: { contractVersion: '1.2.0', enabled: true, pairLabel: 'Judge pair 2', role: 'landlord', simulatedVendorIds: ['vendor_sim'], run: r, ...over },
});
const apiError = (status: number, payload: unknown) => Object.assign(new Error('x'), { status, payload });
const errorBody = (code: string) => ({ success: false, code, message: 'Server text that must not be shown.', retryAfterSeconds: null, nextAvailableAt: null });

function setup(api: Partial<JudgeApi> = {}, opts: { visible?: () => boolean } = {}) {
  let clock = 0;
  const timers: { fn: () => void; at: number }[] = [];
  const full: JudgeApi = {
    status: vi.fn(async () => status()),
    start: vi.fn(async () => ({ data: run({ revision: 1, state: 'waiting_on_tenant', step: { index: 1, total: 13, code: 'tenant_submit', title: 'Submit', detail: '' }, allowedActions: ['pause'] }) })),
    act: vi.fn(async () => ({ data: run({ revision: 4 }) })),
    ...api,
  };
  let n = 0;
  const controller = new JudgeSandboxController({
    api: full,
    newKey: () => `key_${(n += 1)}_abcdefghijklmnop`,
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    isVisible: opts.visible ?? (() => true),
  });
  /** Advance fake time, firing due timers in order. */
  const advance = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      clock = next.at;
      next.fn();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    }
    clock = end;
  };
  return { controller, api: full, advance, timers };
}

describe('judge sandbox controller', () => {
  const nextStep = (over: Record<string, unknown> = {}) => run({
    revision: 4,
    step: { index: 4, total: 13, code: 'quote_resolution', title: 'Resolve quote', detail: '' },
    ...over,
  });

  it('cues only a newer same-run step observed by a fresh read while away, without acting', async () => {
    const read = vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(status(run({ revision: 4 })))
      .mockResolvedValueOnce(status(nextStep({ revision: 5 }))).mockResolvedValue(status(nextStep({ revision: 5 })));
    const { controller, api } = setup({ status: read });
    controller.observeReturnLocation('policy', false);
    expect(controller.returnStepReadyAt('policy')).toBe(false);
    await controller.read(); // First read establishes a baseline, never readiness.
    expect(controller.returnStepReadyAt('policy')).toBe(false);
    await controller.read(); // Revision alone is not a step advance.
    expect(controller.returnStepReadyAt('policy')).toBe(false);
    await controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(true);
    await controller.read(); // Persistent until acknowledged by navigation.
    expect(controller.returnStepReadyAt('policy')).toBe(true);
    expect(api.start).not.toHaveBeenCalled();
    expect(api.act).not.toHaveBeenCalled();
  });

  it('preserves the cue across other landlord pages, but acknowledges actual Guide visits', async () => {
    const read = vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(status(nextStep())).mockResolvedValue(status(nextStep({ revision: 5 })));
    const { controller } = setup({ status: read });
    await controller.read();
    controller.observeReturnLocation('policy', false);
    await controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(true);
    expect(controller.returnStepReadyAt('new-location')).toBe(false); // Before the route effect.
    expect(controller.returnStepReadyAt('new-location', false)).toBe(true); // Known away destination never blanks the cue.
    expect(controller.returnStepReadyAt('guide-before-effect', true)).toBe(false);
    controller.observeReturnLocation('activity', false);
    expect(controller.returnStepReadyAt('activity')).toBe(true);
    await controller.read();
    expect(controller.returnStepReadyAt('activity')).toBe(true);
    controller.observeReturnLocation('guide', true);
    expect(controller.returnStepReadyAt('guide')).toBe(false);
    await controller.read();
    controller.observeReturnLocation('policy-again', false);
    expect(controller.returnStepReadyAt('policy-again')).toBe(false);
    await controller.read();
    expect(controller.returnStepReadyAt('policy-again')).toBe(false);
    controller.observeReturnLocation('activity', false);
    expect(controller.returnStepReadyAt('activity')).toBe(false);
  });

  it.each([
    status(null), status(nextStep(), { role: 'tenant' }), status(null, { enabled: false, role: null, pairLabel: null, simulatedVendorIds: [] }),
    status(nextStep({ runId: 'run_other' })), status(nextStep(), { pairLabel: 'Other pair' }),
    status(nextStep({ requestId: 'req_other' })), status(nextStep({ startedAt: '2026-11-01T06:00:00.000Z' })),
    status(nextStep({ revision: 3 })), status(nextStep({ state: 'completed', allowedActions: [] })),
    status(nextStep({ state: 'running' })), status(nextStep({ state: 'paused' })),
    status(nextStep({ state: 'failed', allowedActions: [] })),
    status(nextStep({ error: { code: 'service_unavailable', retryable: true, retryAfterSeconds: null, nextAvailableAt: null } })),
    status(run({ revision: 4, step: { index: 2, total: 13, code: 'routing', title: 'Routing', detail: '' } })),
    status(run({ revision: 4, step: { index: 4, total: 14, code: 'vendor_quote', title: 'Quote', detail: '' } })),
  ])('does not promote missing/changed scope, terminal, invalid revision or regressed progress: %j', async (answer) => {
    const read = vi.fn().mockResolvedValueOnce(status()).mockResolvedValue(answer);
    const { controller } = setup({ status: read });
    controller.observeReturnLocation('policy', false);
    await controller.read();
    await controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(false);
  });

  it('keeps readiness during routine background reads, but clears failed/malformed reads and rebaselines', async () => {
    let resolve!: (v: { data: unknown }) => void;
    const read = vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(status(nextStep()))
      .mockImplementationOnce(() => new Promise<{ data: unknown }>(r => { resolve = r; }))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(status(nextStep({ revision: 6 })))
      .mockResolvedValueOnce({ data: { ...status().data, extra: true } });
    const { controller } = setup({ status: read });
    controller.observeReturnLocation('policy', false);
    await controller.read();
    await controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(true);
    const pending = controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(true);
    resolve(status(nextStep({ revision: 5 })));
    await pending;
    expect(controller.returnStepReadyAt('policy')).toBe(true);
    await controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(false);
    await controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(false);
    await controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(false);
  });

  it('does not promote an action response, busy/unknown state or a new identity controller', async () => {
    let resolve!: (v: { data: unknown }) => void;
    const read = vi.fn().mockResolvedValueOnce(status()).mockResolvedValue(status(nextStep()));
    const { controller } = setup({ status: read, act: vi.fn(() => new Promise<{ data: unknown }>(r => { resolve = r; })) });
    controller.observeReturnLocation('policy', false);
    await controller.read();
    const pending = controller.act('continue');
    await controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(false);
    resolve({ data: nextStep() });
    await pending;
    expect(controller.returnStepReadyAt('policy')).toBe(false);
    await controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(false);
    controller.dispose();
    expect(controller.returnStepReadyAt('policy')).toBe(false);
    const changed = setup({ status: vi.fn(async () => status(nextStep())) }).controller;
    changed.observeReturnLocation('policy', false);
    await changed.read();
    expect(changed.returnStepReadyAt('policy')).toBe(false);
  });

  it('holds a running advance until a fresh stable step, and hides paused/expired/unknown views', async () => {
    const read = vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(status(nextStep({ state: 'running' })))
      .mockResolvedValue(status(nextStep({ revision: 5 })));
    const { controller } = setup({ status: read });
    controller.observeReturnLocation('policy', false);
    await controller.read();
    await controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(false);
    await controller.read();
    expect(controller.returnStepReadyAt('policy')).toBe(true);
    controller.view = { ...controller.view, polling: true };
    expect(controller.returnStepReadyAt('policy')).toBe(true);
    for (const flags of [{ pollExpired: true }, { notice: { kind: 'unknown' as const } }]) {
      const original = controller.view;
      controller.view = { ...original, ...flags };
      expect(controller.returnStepReadyAt('policy')).toBe(false);
      controller.view = original;
    }
  });

  it('does not flicker through overlapping polling/nudges or resurrect after Guide acknowledgement', async () => {
    const answers: { resolve: (v: { data: unknown }) => void }[] = [];
    const read = vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(status(nextStep()))
      .mockImplementation(() => { const d = deferred<{ data: unknown }>(); answers.push(d); return d.promise; });
    const { controller, api } = setup({ status: read });
    controller.observeReturnLocation('policy', false);
    await controller.read(); await controller.read();
    const observed: boolean[] = [];
    controller.subscribe(() => observed.push(controller.returnStepReadyAt('policy')));
    const pending = controller.read();
    const nudges = [controller.nudge(), controller.nudge()];
    expect(controller.returnStepReadyAt('policy')).toBe(true);
    answers[0].resolve(status(nextStep({ revision: 5 })));
    await pending; await new Promise(resolve => setTimeout(resolve, 0));
    expect(controller.returnStepReadyAt('policy')).toBe(true);
    answers[1].resolve(status(nextStep({ revision: 5 })));
    await Promise.all(nudges);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(Boolean)).toBe(true);
    const afterAck = controller.read();
    controller.observeReturnLocation('guide', true);
    controller.observeReturnLocation('policy-again', false);
    answers[2].resolve(status(nextStep({ revision: 6 })));
    await afterAck;
    expect(controller.returnStepReadyAt('policy-again')).toBe(false);
    expect(api.start).not.toHaveBeenCalled(); expect(api.act).not.toHaveBeenCalled();
  });

  const decline = () => run({ step: { index: 3, total: 14, code: 'vendor_decline', title: 'Vendor declines', detail: 'The simulated vendor declines; ordinary backend policy decides recovery.' } });
  const recoveredQuote = () => run({ revision: 4, step: { index: 4, total: 14, code: 'vendor_quote', title: 'Recovered vendor quote', detail: 'A second simulated vendor delivery was recorded before this quote.' } });

  it('reads a14-step decline and sends only the current revision/code before showing the recovered quote', async () => {
    const { controller, api } = setup({ status: vi.fn(async () => status(decline())), act: vi.fn(async () => ({ data: recoveredQuote() })) });
    await controller.read();
    expect(controller.view.status.run?.step).toMatchObject({ index: 3, total: 14, code: 'vendor_decline' });
    expect(api.act).not.toHaveBeenCalled(); // Reading a decline never advances recovery automatically.
    await controller.act('continue');
    expect(api.act).toHaveBeenCalledExactlyOnceWith('run_owned', 'continue', { expectedRevision: 3, stepCode: 'vendor_decline' }, 'key_1_abcdefghijklmnop');
    expect(controller.view.status.run).toEqual(recoveredQuote());
    expect(controller.view.notice).toBeNull();
  });

  it('keeps recovery busy and never submits a second action while awaiting the server', async () => {
    let release!: (value: { data: unknown }) => void;
    const act = vi.fn(() => new Promise<{ data: unknown }>(resolve => { release = resolve; }));
    const { controller } = setup({ status: vi.fn(async () => status(decline())), act });
    await controller.read();
    const pending = controller.act('continue');
    expect(controller.view.busy).toBe('continue');
    await controller.act('continue');
    await controller.act('pause');
    expect(act).toHaveBeenCalledTimes(1);
    release({ data: recoveredQuote() });
    await pending;
    expect(controller.view.busy).toBeNull();
  });

  it.each(['stale', 'lost', 'malformed'] as const)('re-reads a14-step %s outcome without retrying recovery', async outcome => {
    const act = vi.fn(async () => {
      if (outcome === 'stale') throw apiError(409, errorBody('stale_revision'));
      if (outcome === 'lost') throw new TypeError('offline');
      return { data: run({ step: { ...recoveredQuote().step as object, index: 3 } }) };
    });
    const read = vi.fn().mockResolvedValueOnce(status(decline())).mockResolvedValueOnce(status(recoveredQuote()));
    const { controller } = setup({ status: read, act });
    await controller.read();
    await controller.act('continue');
    expect(act).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(controller.view.status.run).toEqual(recoveredQuote());
    expect(controller.view.notice).toMatchObject(outcome === 'stale' ? { kind: 'error', code: 'stale_revision' } : { kind: 'unknown' });
  });

  it('fails closed before the first read for a schema-valid wrong14-step index/code', async () => {
    const { controller, api } = setup({ status: vi.fn(async () => status(run({ step: { ...recoveredQuote().step as object, index: 3 } }))) });
    await controller.read();
    expect(controller.view.status.enabled).toBe(false);
    expect(controller.view.refreshFailed).toBe(true);
    await controller.act('continue');
    expect(api.act).not.toHaveBeenCalled();
  });

  it('never gives a tenant control over the14-step decline even with server action labels', async () => {
    const { controller, api } = setup({ status: vi.fn(async () => status(decline(), { role: 'tenant' })) });
    await controller.read();
    await controller.start();
    await controller.act('continue');
    await controller.act('pause');
    expect(controller.view.status.run?.step.total).toBe(14);
    expect(api.start).not.toHaveBeenCalled();
    expect(api.act).not.toHaveBeenCalled();
  });

  it('U1: is off before the first read, after a failed read and for a disabled status', async () => {
    const failing = setup({ status: vi.fn(async () => Promise.reject(apiError(404, { success: false, code: 'record_not_found' }))) });
    expect(failing.controller.view.status.enabled).toBe(false);
    await failing.controller.read();
    expect(failing.controller.view).toMatchObject({ loaded: true, refreshFailed: true });
    expect(failing.controller.view.status.enabled).toBe(false);

    const off = setup({ status: vi.fn(async () => ({ data: { contractVersion: '1.2.0', enabled: false, pairLabel: null, role: null, simulatedVendorIds: [], run: null } })) });
    await off.controller.read();
    expect(off.controller.view.status.enabled).toBe(false);

    const malformed = setup({ status: vi.fn(async () => status(run({ allowedActions: ['approve'] }))) });
    await malformed.controller.read();
    expect(malformed.controller.view.status.enabled).toBe(false);
    expect(malformed.controller.view.refreshFailed).toBe(true);
  });

  it('keeps what is shown when a later read fails, and says so', async () => {
    const statusFn = vi.fn(async () => status()).mockResolvedValueOnce(status()).mockRejectedValueOnce(new TypeError('offline'));
    const { controller } = setup({ status: statusFn });
    await controller.read();
    await controller.read();
    expect(controller.view.status.enabled).toBe(true);
    expect(controller.view.refreshFailed).toBe(true);
  });

  it('only sends actions the server allows, with the run revision and step, and a fresh key each time', async () => {
    const { controller, api } = setup();
    await controller.read();
    await controller.act('resume'); // not in allowedActions
    expect(api.act).not.toHaveBeenCalled();
    await controller.act('continue');
    expect(api.act).toHaveBeenCalledTimes(1);
    expect(api.act).toHaveBeenCalledWith('run_owned', 'continue', { expectedRevision: 3, stepCode: 'vendor_quote' }, 'key_1_abcdefghijklmnop');
    expect(controller.view.status.run?.revision).toBe(4);
  });

  it('ignores a second action while one is in flight (one Continue per click)', async () => {
    let release: (v: unknown) => void = () => {};
    const act = vi.fn(() => new Promise<{ data?: unknown }>((r) => (release = r)));
    const { controller } = setup({ act });
    await controller.read();
    const first = controller.act('continue');
    await controller.act('continue');
    await controller.act('pause');
    expect(act).toHaveBeenCalledTimes(1);
    expect(controller.view.busy).toBe('continue');
    release({ data: run({ revision: 4 }) });
    await first;
    expect(controller.view.busy).toBeNull();
  });

  it('U6: a lost response re-reads status and never resends', async () => {
    const act = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
    const { controller, api } = setup({ act });
    await controller.read();
    (api.status as ReturnType<typeof vi.fn>).mockClear();
    await controller.act('continue');
    expect(act).toHaveBeenCalledTimes(1);
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(controller.view.notice).toEqual({ kind: 'unknown' });
  });

  it('maps closed error bodies, re-reads on stale revision, and treats unknown bodies as unknown outcome', async () => {
    const stale = setup({ act: vi.fn(async () => Promise.reject(apiError(409, errorBody('stale_revision')))) });
    await stale.controller.read();
    (stale.api.status as ReturnType<typeof vi.fn>).mockClear();
    await stale.controller.act('continue');
    expect(stale.controller.view.notice).toMatchObject({ kind: 'error', code: 'stale_revision' });
    expect(stale.api.status).toHaveBeenCalledTimes(1);

    const odd = setup({ act: vi.fn(async () => Promise.reject(apiError(500, { message: 'stack trace here' }))) });
    await odd.controller.read();
    await odd.controller.act('continue');
    expect(odd.controller.view.notice).toEqual({ kind: 'unknown' });
  });

  it('Start refuses for a tenant, or when a run exists; run_exists re-reads the run', async () => {
    const tenant = setup({ status: vi.fn(async () => status(null, { role: 'tenant' })) });
    await tenant.controller.read();
    await tenant.controller.start();
    expect(tenant.api.start).not.toHaveBeenCalled();

    const exists = setup();
    await exists.controller.read();
    await exists.controller.start();
    expect(exists.api.start).not.toHaveBeenCalled();

    const statusFn = vi.fn(async () => status()).mockResolvedValueOnce(status(null));
    const race = setup({ status: statusFn, start: vi.fn(async () => Promise.reject(apiError(409, errorBody('run_exists')))) });
    await race.controller.read();
    await race.controller.start();
    expect(race.api.start).toHaveBeenCalledTimes(1);
    expect(race.controller.view.status.run?.runId).toBe('run_owned');
  });

  it('U5: polls every 2 s only while running and visible, and stops at 60 s with Check again', async () => {
    const statusFn = vi.fn(async () => status(run({ state: 'running', allowedActions: [] })));
    const { controller, advance } = setup({ status: statusFn });
    await controller.read();
    controller.pollIfWorking();
    expect(controller.view.polling).toBe(true);
    statusFn.mockClear();
    await advance(10_000);
    expect(statusFn).toHaveBeenCalledTimes(5);
    await advance(60_000);
    expect(controller.view.polling).toBe(false);
    expect(controller.view.pollExpired).toBe(true);
    const calls = statusFn.mock.calls.length;
    await advance(30_000);
    expect(statusFn.mock.calls.length).toBe(calls);
  });

  it('does not read while the tab is hidden, and stops when the run leaves running', async () => {
    let visible = false;
    const statusFn = vi.fn(async () => status(run({ state: 'running', allowedActions: [] })));
    const { controller, advance } = setup({ status: statusFn }, { visible: () => visible });
    await controller.read();
    controller.pollIfWorking();
    statusFn.mockClear();
    await advance(6_000);
    expect(statusFn).not.toHaveBeenCalled();
    visible = true;
    statusFn.mockResolvedValue(status(run({ state: 'waiting_on_landlord', allowedActions: ['pause'] })));
    await advance(2_000);
    expect(statusFn).toHaveBeenCalledTimes(1);
    expect(controller.view.polling).toBe(false);
    await advance(10_000);
    expect(statusFn).toHaveBeenCalledTimes(1);
  });
  // A sign-out or account switch disposes the old identity's controller. Nothing
  // it was waiting for may reach the screen or trigger another request.
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
  };

  it('drops a status answer that arrives after dispose', async () => {
    const late = deferred<{ data: unknown }>();
    const { controller, api } = setup({ status: vi.fn(() => late.promise) });
    const seen = vi.fn();
    controller.subscribe(seen);
    const pending = controller.read();
    controller.dispose();
    late.resolve(status());
    await pending;
    expect(controller.view.status.enabled).toBe(false);
    expect(controller.view.status.pairLabel).toBeNull();
    expect(seen).not.toHaveBeenCalled();
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it('drops a late action answer after dispose, without a follow-up read or a resend', async () => {
    for (const outcome of ['success', 'lost', 'error'] as const) {
      const late = deferred<{ data: unknown }>();
      const { controller, api, timers } = setup({ act: vi.fn(() => late.promise) });
      await controller.read();
      const pending = controller.act('continue');
      controller.dispose();
      if (outcome === 'success') late.resolve({ data: run({ revision: 4, state: 'running', allowedActions: [] }) });
      else if (outcome === 'lost') late.reject(new TypeError('Failed to fetch'));
      else late.reject(apiError(409, errorBody('stale_revision')));
      await pending;
      expect(api.act).toHaveBeenCalledTimes(1);
      // Only the read before the action: none after the old identity left.
      expect(api.status).toHaveBeenCalledTimes(1);
      expect(controller.view.status.run?.revision).toBe(3);
      expect(controller.view.notice).toBeNull();
      expect(timers).toHaveLength(0);
    }
  });

  it('sends nothing at all once disposed, and stops a poll in progress', async () => {
    const { controller, api, timers, advance } = setup({ status: vi.fn(async () => status(run({ state: 'running', allowedActions: [] }))) });
    await controller.read();
    controller.pollIfWorking();
    expect(timers).toHaveLength(1);
    controller.dispose();
    expect(timers).toHaveLength(0);
    await controller.read();
    await controller.checkAgain();
    await controller.start();
    await controller.act('pause');
    controller.pollIfWorking();
    await advance(10_000);
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(api.start).not.toHaveBeenCalled();
    expect(api.act).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });
  // Live nudges from the paired tenant's request or either role's notices move
  // the run card without a manual reload: read-only, coalesced, never an action.
  it('a nudge reads status once for an enabled sandbox and never acts', async () => {
    const { controller, api } = setup();
    await controller.read();
    await controller.nudge();
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(api.start).not.toHaveBeenCalled();
    expect(api.act).not.toHaveBeenCalled();
  });

  it('ignores nudges when the sandbox is off, the tab is hidden, or after dispose', async () => {
    const off = setup({ status: vi.fn(async () => ({ data: { contractVersion: '1.2.0', enabled: false, pairLabel: null, role: null, simulatedVendorIds: [], run: null } })) });
    await off.controller.read();
    await off.controller.nudge();
    expect(off.api.status).toHaveBeenCalledTimes(1);

    let visible = true;
    const hidden = setup({}, { visible: () => visible });
    await hidden.controller.read();
    visible = false;
    await hidden.controller.nudge();
    expect(hidden.api.status).toHaveBeenCalledTimes(1);

    const gone = setup();
    await gone.controller.read();
    gone.controller.dispose();
    await gone.controller.nudge();
    expect(gone.api.status).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst: a read already in flight is followed by exactly one fresh read', async () => {
    const answers: { resolve: (v: { data: unknown }) => void }[] = [];
    const statusFn = vi.fn(() => {
      const d = deferred<{ data: unknown }>();
      answers.push(d);
      return d.promise;
    });
    const { controller } = setup({ status: statusFn });
    const first = controller.read();
    answers[0].resolve(status());
    await first;
    // A focus read is in flight when the tenant's change is nudged three times.
    const focusRead = controller.read();
    const nudges = [controller.nudge(), controller.nudge(), controller.nudge()];
    answers[1].resolve(status(run({ revision: 3 })));
    await focusRead;
    await new Promise((r) => setTimeout(r, 0));
    expect(statusFn).toHaveBeenCalledTimes(3);
    // Further nudges while that fresh read runs queue one more, not one each.
    const late = [controller.nudge(), controller.nudge()];
    const step4 = { index: 4, total: 13, code: 'quote_resolution', title: 'Resolve', detail: '' };
    answers[2].resolve(status(run({ revision: 5, step: step4 })));
    await new Promise((r) => setTimeout(r, 0));
    expect(statusFn).toHaveBeenCalledTimes(4);
    answers[3].resolve(status(run({ revision: 5, step: step4 })));
    await Promise.all([...nudges, ...late]);
    expect(statusFn).toHaveBeenCalledTimes(4);
    expect(controller.view.status.run?.step.index).toBe(4);
  });

  it('a single nudge during a focus read still reads again, since that read may predate the change', async () => {
    const answers: { resolve: (v: { data: unknown }) => void }[] = [];
    const statusFn = vi.fn(() => {
      const d = deferred<{ data: unknown }>();
      answers.push(d);
      return d.promise;
    });
    const { controller } = setup({ status: statusFn });
    const first = controller.read();
    answers[0].resolve(status());
    await first;
    const focusRead = controller.read();
    const nudged = controller.nudge();
    answers[1].resolve(status(run({ revision: 3 })));
    await focusRead;
    await new Promise((r) => setTimeout(r, 0));
    expect(statusFn).toHaveBeenCalledTimes(3);
    answers[2].resolve(status(run({ revision: 6 })));
    await nudged;
    expect(controller.view.status.run?.revision).toBe(6);
  });

  it('drops a nudged read whose answer arrives after an identity change', async () => {
    const late = deferred<{ data: unknown }>();
    const statusFn = vi.fn().mockResolvedValueOnce(status()).mockImplementationOnce(() => late.promise);
    const { controller } = setup({ status: statusFn });
    await controller.read();
    const nudged = controller.nudge();
    controller.dispose();
    late.resolve(status(run({ revision: 9 })));
    await nudged;
    expect(controller.view.status.run?.revision).toBe(3);
    expect(statusFn).toHaveBeenCalledTimes(2);
  });
});
