import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { JudgeSandboxController, type JudgeView } from './judgeController';
import {
  JUDGE_FALLBACK_MS,
  JUDGE_NUDGE_DEBOUNCE_MS,
  JudgeSandboxProvider,
  currentController,
  judgeFallbackDue,
  judgeFallbackPoll,
  judgeIdentity,
  subscribeJudgeNudges,
} from './JudgeSandboxProvider';
import { JudgeBanner } from './JudgeViews';

// Principal review: the provider must follow the signed-in identity. A switch
// from landlord A to B, or a sign-out, shows nothing of A's pair or run.

const api = {
  status: async () => ({ data: null }),
  start: async () => ({ data: null }),
  act: async () => ({ data: null }),
};

describe('judge sandbox follows the signed-in identity', () => {
  it('names an identity by role, sign-in account and role profile, and none when signed out', () => {
    expect(judgeIdentity({ id: 'prof_l1', accountId: 'acct_1', role: 'landlord' })).toBe('landlord:acct_1:prof_l1');
    // Same account, its tenant profile: a different identity.
    expect(judgeIdentity({ id: 'prof_t1', accountId: 'acct_1', role: 'tenant' })).toBe('tenant:acct_1:prof_t1');
    // Same role, another account.
    expect(judgeIdentity({ id: 'prof_l2', accountId: 'acct_2', role: 'landlord' })).toBe('landlord:acct_2:prof_l2');
    // A stored user from before accountId was kept still has a profile identity.
    expect(judgeIdentity({ id: 'prof_l1', role: 'landlord' })).toBe('landlord:-:prof_l1');
    expect(judgeIdentity(null)).toBeNull();
    expect(judgeIdentity({ id: '', accountId: 'acct_1', role: 'landlord' })).toBeNull();
  });

  it('treats a profile switch on the same account as a new identity, so the old run is gone', () => {
    const landlord = judgeIdentity({ id: 'prof_l1', accountId: 'acct_1', role: 'landlord' });
    const otherProfile = judgeIdentity({ id: 'prof_l9', accountId: 'acct_1', role: 'landlord' });
    const tenantProfile = judgeIdentity({ id: 'prof_t1', accountId: 'acct_1', role: 'tenant' });
    const a = new JudgeSandboxController({ api });
    const entry = { identity: landlord as string, controller: a };
    expect(currentController(entry, landlord)).toBe(a);
    expect(currentController(entry, otherProfile)).toBeNull();
    expect(currentController(entry, tenantProfile)).toBeNull();
  });

  it('coalesces live nudges for request and notice topics into one read-only refresh', () => {
    const listeners = new Set<(topic: string) => void>();
    const timers = new Map<number, () => void>();
    let next = 0;
    const env = {
      listen: (l: (topic: string) => void) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      setTimer: (fn: () => void, ms: number) => {
        expect(ms).toBe(JUDGE_NUDGE_DEBOUNCE_MS);
        timers.set((next += 1), fn);
        return next;
      },
      clearTimer: (h: unknown) => {
        timers.delete(h as number);
      },
    };
    const controller = { nudge: vi.fn(async () => {}) };
    const emit = (t: string) => listeners.forEach((l) => l(t));
    const stop = subscribeJudgeNudges(controller, env);
    for (const t of ['wallet', 'policy', 'request:req_1']) emit(t);
    expect(timers.size).toBe(0);
    emit('requests');
    emit('notifications');
    emit('requests');
    emit('resync');
    expect(timers.size).toBe(1);
    const [[handle, fire]] = [...timers.entries()];
    timers.delete(handle);
    fire();
    expect(controller.nudge).toHaveBeenCalledTimes(1);
    // Leaving the identity cancels a pending nudge and stops listening.
    emit('requests');
    stop();
    expect(timers.size).toBe(0);
    expect(listeners.size).toBe(0);
    expect(controller.nudge).toHaveBeenCalledTimes(1);
  });

  it('only uses a controller that belongs to the current identity', () => {
    const a = new JudgeSandboxController({ api });
    const entry = { identity: 'landlord:u_a', controller: a };
    expect(currentController(entry, 'landlord:u_a')).toBe(a);
    // Same render as the switch: A is already gone, before any cleanup runs.
    expect(currentController(entry, 'landlord:u_b')).toBeNull();
    expect(currentController(entry, 'tenant:u_a')).toBeNull();
    expect(currentController(entry, null)).toBeNull();
    expect(currentController(null, 'landlord:u_a')).toBeNull();
  });

  it('renders no banner for a new identity before its own status is read', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <JudgeSandboxProvider identity="landlord:u_b">
          <JudgeBanner />
        </JudgeSandboxProvider>
      </MemoryRouter>
    );
    expect(markup).not.toContain('judge-banner');
  });

  it('both shells pass the signed-in identity to the provider', () => {
    for (const layout of ['LandlordLayout', 'TenantLayout']) {
      const source = readFileSync(new URL(`../../layouts/${layout}.tsx`, import.meta.url), 'utf8');
      expect(source).toContain('<JudgeSandboxProvider identity={judgeIdentity(user)}>');
      // The bell is remounted per identity too: no old unread count or rows.
      expect(source).toMatch(/<NotificationBell\s+\/\/[^\n]*\n\s*key=\{judgeIdentity\(user\) \?\? 'signed-out'\}/);
    }
  });
});

// Connected run (task_8e6770313f1c): a landlord decision moved the run to the
// tenant's step, but no nudge reached the card and it stayed one step behind
// until a window focus. The visible-only fallback keeps it current.
describe('judge run card fallback read', () => {
  const view = (enabled: boolean, state: string | null) =>
    ({ status: { enabled, run: state ? { state } : null } }) as unknown as JudgeView;

  function fakeEnv(visible = true) {
    const env = {
      visible,
      ticks: [] as Array<() => void>,
      listeners: [] as Array<() => void>,
      cleared: 0,
      isVisible: () => env.visible,
      onVisibilityChange: (l: () => void) => {
        env.listeners.push(l);
        return () => void env.listeners.splice(env.listeners.indexOf(l), 1);
      },
      setInterval: (fn: () => void, ms: number) => {
        expect(ms).toBe(JUDGE_FALLBACK_MS);
        env.ticks.push(fn);
        return env.ticks.length;
      },
      clearInterval: () => {
        env.ticks.length = 0;
        env.cleared += 1;
      },
      fire: () => env.ticks.forEach((fn) => fn()),
    };
    return env;
  }

  it('is due for an enabled sandbox whose run can still move, including before a run starts', () => {
    expect(JUDGE_FALLBACK_MS).toBe(5_000);
    expect(judgeFallbackDue(view(true, null))).toBe(true);
    for (const s of ['running', 'waiting_on_tenant', 'waiting_on_landlord', 'ready_to_continue', 'paused']) {
      expect(judgeFallbackDue(view(true, s))).toBe(true);
    }
    expect(judgeFallbackDue(view(true, 'completed'))).toBe(false);
    expect(judgeFallbackDue(view(true, 'failed'))).toBe(false);
    expect(judgeFallbackDue(view(false, null))).toBe(false);
  });

  it('nudges (read-only) each tick only while due, and never without the sandbox', () => {
    const env = fakeEnv();
    let current = view(true, 'waiting_on_landlord');
    const controller = { nudge: vi.fn(async () => {}), getView: () => current };
    const stop = judgeFallbackPoll(controller, env);
    env.fire();
    env.fire();
    expect(controller.nudge).toHaveBeenCalledTimes(2);
    current = view(true, 'completed');
    env.fire();
    current = view(false, null);
    env.fire();
    expect(controller.nudge).toHaveBeenCalledTimes(2);
    stop();
    expect(env.ticks).toHaveLength(0);
  });

  it('holds no timer while the tab is hidden and restarts when it is shown', () => {
    const env = fakeEnv(false);
    const controller = { nudge: vi.fn(async () => {}), getView: () => view(true, 'waiting_on_tenant') };
    const stop = judgeFallbackPoll(controller, env);
    expect(env.ticks).toHaveLength(0);
    env.visible = true;
    env.listeners.forEach((l) => l());
    env.fire();
    expect(controller.nudge).toHaveBeenCalledTimes(1);
    env.visible = false;
    env.listeners.forEach((l) => l());
    expect(env.ticks).toHaveLength(0);
    stop();
    expect(env.listeners).toHaveLength(0);
  });

  it('is wired into the provider and torn down with it', () => {
    const src = readFileSync(new URL('./JudgeSandboxProvider.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/const stopFallback = judgeFallbackPoll\(controller\);/);
    expect(src).toMatch(/unsubscribe\(\);\s*stopFallback\(\);/);
  });
});
