/**
 * Judge sandbox state for one signed-in tab: the status read, the bounded
 * status poll and the four run actions. No React and no DOM, so the rules are
 * tested directly:
 *
 * - Disabled by default. Until a valid enabled status arrives, nothing renders.
 * - The server's allowedActions is the only button list.
 * - One action at a time, each with its own Idempotency-Key, sent once. A lost
 *   response or an unknown outcome re-reads status; the action is never resent.
 * - Polling runs only while the run is "running" and the tab is visible, every
 *   pollMilliseconds, and stops after pollStopMilliseconds with a manual
 *   "Check again".
 * - One controller per signed-in identity. After dispose() it sends nothing
 *   and drops any response still in flight, so a sign-out or account switch
 *   can never show or act on the previous account's run.
 */
import {
  JUDGE_POLL_MS,
  JUDGE_POLL_STOP_MS,
  SANDBOX_OFF,
  judgeSchemaErrors,
  parseErrorBody,
  parseRun,
  parseStatus,
  type JudgeAction,
  type JudgeErrorCode,
  type JudgeRun,
  type JudgeStatus,
} from '../../contracts/judgeSandbox';

export interface JudgeApi {
  status: () => Promise<{ data?: unknown }>;
  start: (idempotencyKey: string) => Promise<{ data?: unknown }>;
  act: (
    runId: string,
    action: JudgeAction,
    body: { expectedRevision: number; stepCode: string },
    idempotencyKey: string
  ) => Promise<{ data?: unknown }>;
}

export type JudgeNotice =
  | { kind: 'error'; code: JudgeErrorCode; retryAfterSeconds: number | null; nextAvailableAt: string | null }
  /** No usable answer: the request may or may not have taken effect. */
  | { kind: 'unknown' };

export interface JudgeView {
  loaded: boolean;
  status: JudgeStatus;
  busy: 'start' | JudgeAction | null;
  notice: JudgeNotice | null;
  /** Status reads are under way (bounded). */
  polling: boolean;
  /** The bounded poll ran out while the run was still working. */
  pollExpired: boolean;
  /** The last status read failed; what is shown may be out of date. */
  refreshFailed: boolean;
}

interface Options {
  api: JudgeApi;
  newKey?: () => string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  isVisible?: () => boolean;
}

function defaultKey() {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `judge-${random}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

/** The HTTP status and body of a failed call, if there was a response at all. */
function failure(err: unknown): { status: number; payload: unknown } | null {
  if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    const e = err as { status: number; payload?: unknown };
    return e.status > 0 ? { status: e.status, payload: e.payload } : null;
  }
  return null;
}

export class JudgeSandboxController {
  view: JudgeView = {
    loaded: false,
    status: SANDBOX_OFF,
    busy: null,
    notice: null,
    polling: false,
    pollExpired: false,
    refreshFailed: false,
  };

  private listeners = new Set<() => void>();
  private api: JudgeApi;
  private newKey: () => string;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (handle: unknown) => void;
  private isVisible: () => boolean;
  private timer: unknown = null;
  private pollStartedAt = 0;
  private disposed = false;
  private reading: Promise<void> | null = null;
  private nudging = false;
  private nudged = false;
  private returnLocation: { key: string; onGuide: boolean } | null = null;
  private returnBaseline: { pair: string | null; run: JudgeRun } | null = null;
  private returnReady = false;
  private freshStatus: JudgeStatus | null = null;

  constructor(options: Options) {
    this.api = options.api;
    this.newKey = options.newKey ?? defaultKey;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.isVisible =
      options.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getView = () => this.view;

  /** Presentation-only, identity-local memory. Only a Guide visit acknowledges
   * the step; other landlord pages preserve an observed cue. */
  observeReturnLocation(key: string, onGuide: boolean) {
    if (this.disposed || (this.returnLocation?.key === key && this.returnLocation.onGuide === onGuide)) return;
    const acknowledge = !this.returnLocation || onGuide || this.returnLocation.onGuide;
    this.returnLocation = { key, onGuide };
    if (acknowledge) {
      this.returnReady = false;
      this.returnBaseline = this.returnSnapshotCurrent() ? this.returnSnapshot(this.view.status) : null;
    }
    this.set({});
  }

  returnStepReadyAt(key: string, onGuide?: boolean): boolean {
    const run = this.view.status.run;
    const currentGuide = onGuide ?? (this.returnLocation?.key === key ? this.returnLocation.onGuide : true);
    return Boolean(this.returnLocation && !currentGuide && !this.returnLocation.onGuide &&
      this.returnReady && this.returnSnapshotCurrent() &&
      run && run.state !== 'running' && run.state !== 'paused');
  }

  private returnSnapshot(status: JudgeStatus) {
    const run = status.run;
    return status.enabled && status.role === 'landlord' && run &&
      !run.error && run.state !== 'completed' && run.state !== 'failed'
      ? { pair: status.pairLabel, run } : null;
  }

  private returnSnapshotCurrent() {
    // An ordinary background read does not invalidate the last good snapshot.
    // Actual failure, uncertainty or action state still suppresses readiness.
    return this.view.loaded && this.freshStatus === this.view.status &&
      !this.view.busy && !this.view.notice &&
      !this.view.pollExpired && !this.view.refreshFailed;
  }

  private observeReturnStatus(status: JudgeStatus) {
    const next = this.returnSnapshot(status), previous = this.returnBaseline;
    this.freshStatus = status;
    // An action/error/unknown answer is not a fresh baseline for this cue.
    if (!next || this.view.busy || this.view.notice || this.view.pollExpired) {
      this.returnBaseline = null;
      this.returnReady = false;
      return;
    }
    const sameScope = previous && previous.pair === next.pair &&
      previous.run.runId === next.run.runId && previous.run.requestId === next.run.requestId &&
      previous.run.startedAt === next.run.startedAt && previous.run.step.total === next.run.step.total;
    if (!this.returnLocation || this.returnLocation.onGuide || !previous || !sameScope ||
      next.run.revision < previous.run.revision || next.run.step.index < previous.run.step.index) {
      this.returnReady = false;
    } else if (next.run.step.index > previous.run.step.index) {
      this.returnReady = next.run.revision > previous.run.revision && next.run.step.code !== previous.run.step.code;
    }
    this.returnBaseline = next;
  }

  private set(patch: Partial<JudgeView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Stop any poll; the controller can be used again (React effects re-run). */
  stop() {
    this.stopPolling();
  }

  /** Final teardown: nothing is sent, read or announced after this, and late responses are dropped. */
  dispose() {
    this.disposed = true;
    this.returnBaseline = null;
    this.returnReady = false;
    this.stopPolling();
    this.listeners.clear();
  }

  /** Read status. A failed read keeps sandbox actions off and marks eligibility
   * unknown; a later valid read clears the failure. Later failures retain data. */
  read(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.reading) return this.reading;
    this.reading = (async () => {
      try {
        const envelope = await this.api.status();
        if (judgeSchemaErrors('Status', envelope?.data).length) throw new Error('Invalid sandbox status');
        const status = parseStatus(envelope?.data);
        this.observeReturnStatus(status);
        this.set({ loaded: true, status, refreshFailed: false });
      } catch {
        this.returnBaseline = null;
        this.returnReady = false;
        this.freshStatus = null;
        this.set(this.view.loaded ? { refreshFailed: true } : { loaded: true, status: SANDBOX_OFF, refreshFailed: true });
      } finally {
        this.reading = null;
      }
    })();
    return this.reading;
  }

  /**
   * The server nudged a topic that can move this run (the paired tenant's
   * request, a notice). One status read, coalesced: a nudge during a read
   * queues exactly one more read after it, since the read in flight may
   * predate the change. Only for an enabled sandbox in a visible tab; a
   * hidden tab catches up on the resync when it returns. Never acts.
   */
  async nudge(): Promise<void> {
    if (this.disposed || !this.view.status.enabled || !this.isVisible()) return;
    if (this.nudging) {
      this.nudged = true;
      return;
    }
    this.nudging = true;
    try {
      if (this.reading) await this.reading;
      do {
        this.nudged = false;
        await this.read();
      } while (this.nudged && !this.disposed);
    } finally {
      this.nudging = false;
    }
    this.pollIfWorking();
  }

  /** A manual "Check again": one read, and a fresh poll window if the run is still working. */
  async checkAgain() {
    this.set({ pollExpired: false });
    await this.read();
    this.pollIfWorking();
  }

  private setRun(run: JudgeRun) {
    this.set({ status: { ...this.view.status, run } });
  }

  async start() {
    const { status, busy } = this.view;
    if (this.disposed || busy || !status.enabled || status.role !== 'landlord' || status.run) return;
    await this.mutate('start', () => this.api.start(this.newKey()));
  }

  async act(action: JudgeAction) {
    const { status, busy } = this.view;
    const run = status.run;
    if (this.disposed || busy || !status.enabled || status.role !== 'landlord' || !run || !run.allowedActions.includes(action)) return;
    const body = { expectedRevision: run.revision, stepCode: run.step.code };
    await this.mutate(action, () => this.api.act(run.runId, action, body, this.newKey()));
  }

  private async mutate(busy: 'start' | JudgeAction, call: () => Promise<{ data?: unknown }>) {
    this.returnBaseline = null;
    this.returnReady = false;
    this.freshStatus = null;
    this.set({ busy, notice: null, pollExpired: false });
    try {
      const envelope = await call();
      // Signed out or switched account while waiting: this answer is not ours to show.
      if (this.disposed) return;
      const run = parseRun(envelope?.data);
      if (run) {
        this.setRun(run);
      } else {
        // A success we cannot read: say so and re-read rather than guess.
        this.set({ notice: { kind: 'unknown' } });
        await this.read();
      }
    } catch (err) {
      if (this.disposed) return;
      const response = failure(err);
      const body = response ? parseErrorBody(response.payload) : null;
      if (!body) {
        this.set({ notice: { kind: 'unknown' } });
      } else {
        this.set({
          notice: {
            kind: 'error',
            code: body.code,
            retryAfterSeconds: body.retryAfterSeconds,
            nextAvailableAt: body.nextAvailableAt,
          },
        });
      }
      // What the server holds now decides what is shown; never resend.
      await this.read();
    } finally {
      this.set({ busy: null });
      this.pollIfWorking();
    }
  }

  /** Start a bounded poll if the run is working; otherwise make sure none is running. */
  pollIfWorking() {
    if (this.disposed) return;
    if (this.view.status.run?.state === 'running') {
      if (!this.timer) {
        this.pollStartedAt = this.now();
        this.set({ polling: true, pollExpired: false });
        this.schedule();
      }
    } else {
      this.stopPolling();
    }
  }

  private schedule() {
    this.timer = this.setTimer(() => void this.tick(), JUDGE_POLL_MS);
  }

  private async tick() {
    this.timer = null;
    if (this.disposed) return;
    if (this.now() - this.pollStartedAt >= JUDGE_POLL_STOP_MS) {
      this.set({ polling: false, pollExpired: true });
      return;
    }
    if (this.isVisible()) await this.read();
    if (this.view.status.run?.state === 'running') {
      this.schedule();
    } else {
      this.set({ polling: false });
    }
  }

  private stopPolling() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.view.polling) this.set({ polling: false });
  }
}
