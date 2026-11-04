import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { onLiveEvent, RESYNC_TOPIC } from '../../lib/liveEvents';
import { JudgeSandboxAPI } from '../../api/client';
import { SANDBOX_OFF } from '../../contracts/judgeSandbox';
import { JUDGE_BELL_POLL_MS, visiblePoll, type PollEnv } from '../notifications/notificationFeed';
import { JudgeSandboxController, type JudgeView } from './judgeController';

const OFF_VIEW: JudgeView = {
  loaded: true,
  status: SANDBOX_OFF,
  busy: null,
  notice: null,
  polling: false,
  pollExpired: false,
  refreshFailed: false,
};

const Ctx = createContext<JudgeSandboxController | null>(null);

/** Who the controller belongs to: role, sign-in account and role profile, or
 *  null when signed out. One account can hold a landlord and a tenant profile,
 *  so a profile switch is a new identity even on the same account. */
export function judgeIdentity(
  user: { id?: string; accountId?: string; role?: string } | null | undefined
): string | null {
  return user && user.id && user.role ? `${user.role}:${user.accountId || '-'}:${user.id}` : null;
}

/** Live topics that can move the paired run: the tenant's request and either role's notices. */
export const JUDGE_NUDGE_TOPICS = new Set(['requests', 'notifications', RESYNC_TOPIC]);
/** Bursts (one step writing a request and two notices) collapse into one status read. */
export const JUDGE_NUDGE_DEBOUNCE_MS = 300;

type NudgeEnv = {
  listen: (listener: (topic: string) => void) => () => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

const liveEnv: NudgeEnv = {
  listen: onLiveEvent,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Turn live nudges for the run's topics into one debounced, read-only status refresh. */
export function subscribeJudgeNudges(controller: Pick<JudgeSandboxController, 'nudge'>, env: NudgeEnv = liveEnv) {
  let timer: unknown = null;
  const unsubscribe = env.listen((topic) => {
    if (!JUDGE_NUDGE_TOPICS.has(topic)) return;
    if (timer !== null) env.clearTimer(timer);
    timer = env.setTimer(() => {
      timer = null;
      void controller.nudge();
    }, JUDGE_NUDGE_DEBOUNCE_MS);
  });
  return () => {
    unsubscribe();
    if (timer !== null) env.clearTimer(timer);
    timer = null;
  };
}

/** Fallback read cadence, the same as the judge bell's. */
export const JUDGE_FALLBACK_MS = JUDGE_BELL_POLL_MS;

/** A run that the other role or a server step can still move: enabled, and not finished. */
export function judgeFallbackDue(view: JudgeView): boolean {
  const state = view.status.run?.state;
  return view.status.enabled && state !== 'completed' && state !== 'failed';
}

/**
 * Live nudges are the fast path, but some changes publish none (a landlord
 * decision, a server step after commit). While the tab is visible and the
 * sandbox run can still move, read status every JUDGE_FALLBACK_MS through the
 * coalesced, read-only nudge. A user without the sandbox never sends a request.
 */
export function judgeFallbackPoll(
  controller: Pick<JudgeSandboxController, 'nudge' | 'getView'>,
  env?: PollEnv
): () => void {
  return visiblePoll(
    () => {
      if (judgeFallbackDue(controller.getView())) void controller.nudge();
    },
    JUDGE_FALLBACK_MS,
    env
  );
}

type Entry = { identity: string; controller: JudgeSandboxController };

/** The controller to show, only while it still belongs to the signed-in identity. */
export function currentController(entry: Entry | null, identity: string | null): JudgeSandboxController | null {
  return entry && identity && entry.identity === identity ? entry.controller : null;
}

/** One controller per signed-in identity (landlord or tenant). Reads status
 *  once, again when the window regains focus or a live nudge arrives, and
 *  every 5 s while the tab is visible and the run can still move. A new identity, or none, disposes the old controller: its pair,
 *  banner and run vanish in that same render, and its late responses are
 *  dropped without a follow-up read. */
export function JudgeSandboxProvider({
  children,
  identity,
  controller: injected,
}: {
  children: ReactNode;
  /** judgeIdentity(user); null means signed out and nothing is read. */
  identity?: string | null;
  /** Tests pass their own controller (fake API, fake timers). */
  controller?: JudgeSandboxController;
}) {
  const [entry, setEntry] = useState<Entry | null>(null);
  useEffect(() => {
    if (!injected && !identity) return;
    // Created here, not in render, so StrictMode's second effect pass gets a
    // fresh controller instead of a disposed one.
    const controller = injected ?? new JudgeSandboxController({ api: JudgeSandboxAPI });
    if (!injected) setEntry({ identity: identity as string, controller });
    const refresh = () => void controller.read().then(() => controller.pollIfWorking());
    refresh();
    window.addEventListener('focus', refresh);
    const unsubscribe = subscribeJudgeNudges(controller);
    const stopFallback = judgeFallbackPoll(controller);
    return () => {
      window.removeEventListener('focus', refresh);
      unsubscribe();
      stopFallback();
      if (injected) {
        controller.stop();
        return;
      }
      controller.dispose();
      setEntry((current) => (current?.controller === controller ? null : current));
    };
  }, [identity, injected]);
  const controller = injected ?? currentController(entry, identity ?? null);
  return <Ctx.Provider value={controller}>{children}</Ctx.Provider>;
}

const noop = () => () => {};

/** The sandbox view, or "off" outside a provider (and before the first read). */
export function useJudgeSandbox(): { view: JudgeView; controller: JudgeSandboxController | null } {
  const controller = useContext(Ctx);
  const view = useSyncExternalStore(
    controller ? (l) => controller.subscribe(l) : noop,
    controller ? controller.getView : () => OFF_VIEW,
    controller ? controller.getView : () => OFF_VIEW
  );
  return { view, controller };
}

export function useJudgeSandboxEnabled(): boolean {
  return useJudgeSandbox().view.status.enabled;
}

/** True only for this pair's own simulated vendors, as listed by the server. */
export function useIsSimulatedVendor(vendorId: string | null | undefined): boolean {
  const { status } = useJudgeSandbox().view;
  return Boolean(status.enabled && vendorId && status.simulatedVendorIds.includes(vendorId));
}
