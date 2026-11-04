import type { ErrorCode, EvidenceView, ImpactPage, Origin, PolicyChangeView, TurnView } from '../../types/irisV2';
import { IrisCallError, type IrisApi, type IrisFailure } from './irisApi';

/**
 * Everything Iris remembers in the browser, as plain data with no React.
 *
 * The rules it enforces come from the frozen v2 contract (lifecycle,
 * navigation, provenance) and M5_SCOPED_PLAN:
 * - one conversation id across every landlord page; the visible transcript is
 *   a list of immutable segments, one per resolved context (account or one
 *   request). A segment's label is the server's, fixed when it resolved.
 * - every route change bumps the context generation. Work from an older
 *   generation can never land in the current segment: a pending read is
 *   stopped, a late preview is discarded, a late answer stays in its own
 *   segment and loses any confirmation token.
 * - confirmation tokens live only in a private map, never in state, never in
 *   a log or storage; they are dropped the moment they cannot be used.
 * - a submitted confirmation is tracked outside the transcript, survives
 *   navigation, close and conversation expiry, and is resolved by reading
 *   status, never by posting again on its own.
 * - signOut() clears everything synchronously and no call is made afterwards.
 */

export const ACCOUNT_CONTEXT_LABEL = 'Your account policy';
const ID_24 = /^[a-fA-F0-9]{24}$/;
const DEFAULT_POLL_MS = 900; // contract transport.pollingMs is 750-1000
const STATUS_POLL_MS = 2000;
const STATUS_POLL_LIMIT = 30;
const TRANSPORT_RETRY_LIMIT = 3;
export const MAX_MESSAGE_CHARS = 2000;

export type TurnPhase = 'sending' | 'active' | 'done' | 'stopped' | 'failed';

export interface TurnItem {
  /** = clientTurnId; also the idempotency key for the POST. */
  key: string;
  text: string;
  generation: number;
  turnId: string | null;
  phase: TurnPhase;
  /** Why it stopped: the person pressed Stop, or moved to another context. */
  stoppedBy: 'person' | 'context' | null;
  /** Latest server view, with confirmationToken always null. */
  view: TurnView | null;
  failure: IrisFailure | null;
}

export interface Segment {
  /**
   * The server's segmentId once resolved. A segment is (key, generation): the
   * contract does not promise a new segmentId when the same request comes
   * back in a later generation, so the key alone is not unique.
   */
  key: string;
  origin: Origin;
  generation: number;
  items: TurnItem[];
}

export type ContextStatus = 'unresolved' | 'resolving' | 'resolved' | 'unavailable' | 'failed';

export interface PendingConfirm {
  previewId: string;
  clientActionId: string;
  /**
   * confirming: POST in flight. unknown: no answer; reading status.
   * not_applied: status verified the change was NOT applied and the preview is
   * still valid; the person may confirm again (same action id). settled: known.
   */
  phase: 'confirming' | 'unknown' | 'not_applied' | 'settled';
  view: PolicyChangeView | null;
  failure: IrisFailure | null;
  /** Status reads ran out while still unknown; the person can check again. */
  statusStalled: boolean;
}

export interface IrisState {
  phase: 'idle' | 'starting' | 'ready' | 'expired' | 'signed_out';
  open: boolean;
  conversationId: string | null;
  generation: number;
  route: { requestContextId: string | null; key: string; valid: boolean } | null;
  context: { status: ContextStatus; origin: Origin | null; failure: IrisFailure | null };
  segments: Segment[];
  /** The server trimmed older inactive segments (TurnView.trimmedSegmentIds). */
  trimmed: boolean;
  /** turn_limit, transcript_limit or conversation_limit: needs New conversation. */
  limit: ErrorCode | null;
  /** A conversation-level failure (e.g. could not start). */
  failure: IrisFailure | null;
  /** Bumped on every context change so the composer can clear its draft. */
  draftEpoch: number;
  pendingConfirms: PendingConfirm[];
  /** Preview ids whose confirmation token is held and still usable. */
  livePreviewIds: string[];
  /** Latest known server state per policy change, from confirm/discard/status. */
  policyChanges: Record<string, PolicyChangeView>;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IrisControllerOptions {
  newId?: () => string;
  scheduler?: Scheduler;
  pollMs?: number;
  /**
   * False once the browser session is gone (logout clears it synchronously).
   * Checked before every call so a promise that settles between sign-out and
   * unmount cannot start another request.
   */
  isSignedIn?: () => boolean;
}

const initialState = (): IrisState => ({
  phase: 'idle',
  open: false,
  conversationId: null,
  generation: 0,
  route: null,
  context: { status: 'unresolved', origin: null, failure: null },
  segments: [],
  trimmed: false,
  limit: null,
  failure: null,
  draftEpoch: 0,
  pendingConfirms: [],
  livePreviewIds: [],
  policyChanges: {},
});

const failureOf = (error: unknown): IrisFailure =>
  error instanceof IrisCallError ? error.failure : { kind: 'transport' };

const httpCode = (failure: IrisFailure | null) => (failure?.kind === 'http' ? failure.code : null);

const TERMINAL: TurnView['status'][] = ['completed', 'refused', 'cancelled', 'interrupted', 'unavailable'];
const LIMIT_CODES: ErrorCode[] = ['turn_limit', 'transcript_limit', 'conversation_limit'];
const SETTLED_REFRESH: PolicyChangeView['refreshState'][] = ['completed', 'partial', 'failed', 'not_required'];

export function contextKeyFor(requestContextId: string | null) {
  return requestContextId ? `request:${requestContextId}` : 'account';
}

export class IrisController {
  private state: IrisState = initialState();
  private readonly listeners = new Set<() => void>();
  private readonly tokens = new Map<string, { token: string; generation: number }>();
  private readonly timers = new Set<unknown>();
  /** Status/receipt timers: survive expiry and New conversation, end at sign-out. */
  private readonly sessionTimers = new Set<unknown>();
  private readonly aborts = new Set<AbortController>();
  /** Bumped by New conversation/expiry: older chat results are dropped. */
  private epoch = 0;
  /** Bumped only by signOut: confirm/status/discard results survive conversation changes. */
  private sessionEpoch = 0;
  private disposed = false;
  private paused = false;
  /** The close of a replaced conversation, settled before its successor is created. */
  private closing: Promise<unknown> | null = null;
  /** The conversation this page closed on pagehide; sent at most once per id. */
  private closedOnPagehide: string | null = null;
  private readonly newId: () => string;
  private readonly scheduler: Scheduler;
  private readonly pollMs: number;
  private readonly isSignedIn: () => boolean;

  constructor(
    private readonly api: IrisApi,
    options: IrisControllerOptions = {}
  ) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.scheduler = options.scheduler ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.isSignedIn = options.isSignedIn ?? (() => true);
  }

  // ---- store ----------------------------------------------------------------

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<IrisState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch, livePreviewIds: [...this.tokens.keys()] };
    for (const listener of this.listeners) listener();
  }

  private updateItem(key: string, patch: Partial<TurnItem>) {
    this.set({
      segments: this.state.segments.map((segment) =>
        segment.items.some((item) => item.key === key)
          ? { ...segment, items: segment.items.map((item) => (item.key === key ? { ...item, ...patch } : item)) }
          : segment
      ),
    });
  }

  private findItem(key: string) {
    for (const segment of this.state.segments) {
      const item = segment.items.find((candidate) => candidate.key === key);
      if (item) return item;
    }
    return null;
  }

  private later(fn: () => void, ms: number, scope: 'conversation' | 'session' = 'conversation') {
    const set = scope === 'session' ? this.sessionTimers : this.timers;
    const handle = this.scheduler.setTimeout(() => {
      set.delete(handle);
      if (!this.disposed) fn();
    }, ms);
    set.add(handle);
  }

  private abortable() {
    const controller = new AbortController();
    this.aborts.add(controller);
    return {
      signal: controller.signal,
      done: () => this.aborts.delete(controller),
    };
  }

  /**
   * Runs an API call and drops its result if what it belonged to moved on:
   * 'conversation' work (context, turns) ends with expiry or New conversation;
   * 'session' work (confirm, status, discard) ends only with sign-out.
   */
  private async guarded<T>(
    run: () => Promise<T>,
    scope: 'conversation' | 'session' = 'conversation'
  ): Promise<{ ok: true; value: T } | { ok: false; failure: IrisFailure } | null> {
    const epoch = this.epoch;
    const sessionEpoch = this.sessionEpoch;
    const stale = () =>
      this.disposed || sessionEpoch !== this.sessionEpoch || (scope === 'conversation' && epoch !== this.epoch);
    if (this.disposed) return null;
    if (!this.isSignedIn()) {
      this.signOut();
      return null;
    }
    try {
      const value = await run();
      return stale() ? null : { ok: true, value };
    } catch (error) {
      return stale() ? null : { ok: false, failure: failureOf(error) };
    }
  }

  // ---- route and context ----------------------------------------------------

  /** Called by the shell on every location change with the matched request id. */
  setRoute(requestContextId: string | null) {
    if (this.disposed) return;
    const key = contextKeyFor(requestContextId);
    const previous = this.state.route;
    if (previous && previous.key === key) return;
    const valid = requestContextId === null || ID_24.test(requestContextId);
    const route = { requestContextId: valid ? requestContextId : null, key, valid };
    if (!previous) {
      this.set({ route });
      return;
    }
    const generation = this.state.generation + 1;
    this.leaveGeneration(generation);
    this.set({
      route,
      generation,
      draftEpoch: this.state.draftEpoch + 1,
      context: { status: 'unresolved', origin: null, failure: null },
    });
    if (this.state.open) void this.resolveContext();
  }

  /** Stop work that belongs to the context being left. Never deletes messages. */
  private leaveGeneration(nextGeneration: number) {
    for (const segment of this.state.segments) {
      for (const item of segment.items) {
        if (item.generation >= nextGeneration) continue;
        if (item.phase === 'sending' || item.phase === 'active') {
          this.updateItem(item.key, { phase: 'stopped', stoppedBy: 'context' });
          if (item.turnId) this.cancelQuietly(item.turnId);
        }
      }
    }
    for (const [previewId, held] of this.tokens) {
      if (held.generation >= nextGeneration) continue;
      // A preview being confirmed is not "unused"; its outcome is tracked.
      if (this.state.pendingConfirms.some((p) => p.previewId === previewId)) continue;
      this.tokens.delete(previewId);
      this.discardQuietly(previewId);
    }
  }

  async open() {
    if (this.disposed) return;
    this.set({ open: true });
    if (!(await this.ensureConversation())) return;
    if (this.state.context.status === 'unresolved' || this.state.context.status === 'failed') {
      await this.resolveContext();
    }
  }

  close() {
    this.set({ open: false });
  }

  /** Pause polling while the tab is hidden; resume when it is visible again. */
  setPaused(paused: boolean) {
    this.paused = paused;
  }

  private async ensureConversation(): Promise<boolean> {
    if (this.state.conversationId) return true;
    if (this.state.phase === 'starting') return false;
    this.set({ phase: 'starting', failure: null });
    const result = await this.guarded(() => this.api.createConversation(this.newId()));
    if (!result) return false;
    if (!result.ok) {
      const code = httpCode(result.failure);
      this.set({
        phase: 'idle',
        failure: result.failure,
        limit: code && LIMIT_CODES.includes(code) ? code : this.state.limit,
      });
      return false;
    }
    this.set({ phase: 'ready', conversationId: result.value.conversationId, limit: null });
    return true;
  }

  async resolveContext() {
    const route = this.state.route;
    const conversationId = this.state.conversationId;
    if (!route || !conversationId || this.disposed) return;
    if (!route.valid) {
      this.set({ context: { status: 'unavailable', origin: null, failure: null } });
      return;
    }
    const generation = this.state.generation;
    this.set({ context: { status: 'resolving', origin: null, failure: null } });
    const call = this.abortable();
    const result = await this.guarded(() =>
      this.api.resolveContext(
        conversationId,
        { requestContextId: route.requestContextId, contextGeneration: generation },
        call.signal
      )
    );
    call.done();
    if (!result || generation !== this.state.generation) return;
    if (!result.ok) {
      const code = httpCode(result.failure);
      if (code === 'conversation_expired') return this.expire();
      const unavailable = code === 'record_not_found' || code === 'forbidden';
      this.set({ context: { status: unavailable ? 'unavailable' : 'failed', origin: null, failure: result.failure } });
      return;
    }
    const origin = result.value;
    if (origin.contextGeneration !== generation || origin.requestContextId !== route.requestContextId) {
      this.set({ context: { status: 'failed', origin: null, failure: { kind: 'contract' } } });
      return;
    }
    const last = this.state.segments[this.state.segments.length - 1];
    const segments =
      last && last.key === origin.segmentId && last.generation === generation
        ? this.state.segments
        : [
            // An earlier divider nobody asked anything under is dropped, so
            // quick page-to-page navigation does not stack empty dividers.
            ...this.state.segments.filter((s) => s.items.length > 0),
            { key: origin.segmentId, origin, generation, items: [] },
          ];
    this.set({ segments, context: { status: 'resolved', origin, failure: null } });
  }

  // ---- turns ----------------------------------------------------------------

  canSend() {
    const s = this.state;
    return (
      !this.disposed &&
      s.phase === 'ready' &&
      !s.limit &&
      s.context.status === 'resolved' &&
      !s.segments.some((segment) => segment.items.some((i) => i.phase === 'sending' || i.phase === 'active'))
    );
  }

  async send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_MESSAGE_CHARS || !this.canSend()) return false;
    const origin = this.state.context.origin!;
    const item: TurnItem = {
      key: this.newId(),
      text: trimmed,
      generation: this.state.generation,
      turnId: null,
      phase: 'sending',
      stoppedBy: null,
      view: null,
      failure: null,
    };
    this.set({
      segments: this.state.segments.map((segment) =>
        segment.key === origin.segmentId && segment.generation === origin.contextGeneration
          ? { ...segment, items: [...segment.items, item] }
          : segment
      ),
    });
    await this.postTurn(item.key);
    return true;
  }

  /** Re-send a turn that got no answer, with the SAME clientTurnId. */
  async retry(key: string) {
    const item = this.findItem(key);
    if (!item || item.phase !== 'failed' || item.turnId || item.generation !== this.state.generation) return;
    if (item.failure?.kind !== 'transport' && item.failure?.kind !== 'unexpected') return;
    this.updateItem(key, { phase: 'sending', failure: null });
    await this.postTurn(key);
  }

  private async postTurn(key: string) {
    const item = this.findItem(key);
    const conversationId = this.state.conversationId;
    if (!item || !conversationId) return;
    const route = this.state.route!;
    const call = this.abortable();
    const result = await this.guarded(() =>
      this.api.postTurn(
        conversationId,
        {
          clientTurnId: item.key,
          text: item.text,
          requestContextId: route.requestContextId,
          contextGeneration: item.generation,
        },
        call.signal
      )
    );
    call.done();
    if (!result) return;
    const current = this.findItem(key);
    if (!current) return;
    if (!result.ok) {
      if (current.phase === 'stopped') return;
      return this.turnFailed(key, result.failure);
    }
    const accepted = result.value;
    if (accepted.origin.contextGeneration !== item.generation) {
      return this.turnFailed(key, { kind: 'contract' });
    }
    this.updateItem(key, { turnId: accepted.turnId });
    if (current.phase === 'stopped') {
      // Accepted after the person stopped it or moved on: cancel, never show.
      this.cancelQuietly(accepted.turnId);
      return;
    }
    this.updateItem(key, { phase: 'active' });
    this.later(() => void this.poll(key, 0), this.pollMs);
  }

  private turnFailed(key: string, failure: IrisFailure) {
    this.updateItem(key, { phase: 'failed', failure });
    const code = httpCode(failure);
    if (code === 'conversation_expired') this.expire();
    else if (code && LIMIT_CODES.includes(code)) this.set({ limit: code });
    else if (code === 'stale_context' || code === 'context_mismatch') {
      this.set({ context: { status: 'unresolved', origin: null, failure: null } });
      void this.resolveContext();
    }
  }

  private async poll(key: string, transportFailures: number) {
    const item = this.findItem(key);
    if (!item || item.phase !== 'active' || !item.turnId) return;
    if (this.paused) {
      this.later(() => void this.poll(key, transportFailures), this.pollMs);
      return;
    }
    const call = this.abortable();
    const result = await this.guarded(() => this.api.getTurn(item.turnId!, call.signal));
    call.done();
    if (!result) return;
    const current = this.findItem(key);
    if (!current || current.phase !== 'active') return;
    if (!result.ok) {
      const failure = result.failure;
      const code = httpCode(failure);
      if (code === 'conversation_expired') return this.expire();
      if (failure.kind === 'http' && (code === 'rate_limited' || code === 'concurrent_turn_limit')) {
        this.later(() => void this.poll(key, transportFailures), Math.max(1, failure.retryAfterSeconds ?? 1) * 1000);
        return;
      }
      if ((failure.kind === 'transport' || failure.kind === 'unexpected') && transportFailures < TRANSPORT_RETRY_LIMIT) {
        this.later(() => void this.poll(key, transportFailures + 1), this.pollMs * 2 ** (transportFailures + 1));
        return;
      }
      return this.turnFailed(key, failure);
    }
    this.applyTurnView(key, result.value);
  }

  private applyTurnView(key: string, incoming: TurnView) {
    const item = this.findItem(key)!;
    if (incoming.origin.contextGeneration !== item.generation) {
      // A view can never move to another segment. Treat as drift and stop.
      return this.turnFailed(key, { kind: 'contract' });
    }
    const token = incoming.confirmationToken;
    const view: TurnView = { ...incoming, confirmationToken: null };
    if (view.preview && token) {
      if (item.generation === this.state.generation) {
        this.tokens.set(view.preview.id, { token, generation: item.generation });
      } else {
        this.discardQuietly(view.preview.id);
      }
    }
    if (view.trimmedSegmentIds.length) {
      const drop = new Set(view.trimmedSegmentIds);
      const currentKey = this.state.context.origin?.segmentId;
      this.set({
        segments: this.state.segments.filter(
          (s) => !drop.has(s.key) || (s.key === currentKey && s.generation === this.state.generation)
        ),
        trimmed: true,
      });
    }
    const terminal = TERMINAL.includes(view.status);
    this.updateItem(key, { view, phase: terminal ? 'done' : 'active' });
    if (view.error?.code === 'conversation_expired') return this.expire();
    if (view.error && LIMIT_CODES.includes(view.error.code)) this.set({ limit: view.error.code });
    if (!terminal) this.later(() => void this.poll(key, 0), this.pollMs);
  }

  /** The person pressed Stop. Reads only: a confirmed write is never "stopped". */
  stop(key: string) {
    const item = this.findItem(key);
    if (!item || (item.phase !== 'sending' && item.phase !== 'active')) return;
    this.updateItem(key, { phase: 'stopped', stoppedBy: 'person' });
    if (item.turnId) this.cancelQuietly(item.turnId);
  }

  private cancelQuietly(turnId: string) {
    void this.guarded(() => this.api.cancelTurn(turnId, this.newId()));
  }

  // ---- preview, confirm, discard --------------------------------------------

  /** True only while the token is held and the preview's context is current. */
  canConfirm(previewId: string) {
    const held = this.tokens.get(previewId);
    if (!held || held.generation !== this.state.generation || this.disposed) return false;
    const pending = this.state.pendingConfirms.find((p) => p.previewId === previewId);
    return !pending || pending.phase === 'not_applied';
  }

  private previewView(previewId: string): PolicyChangeView | null {
    if (this.state.policyChanges[previewId]) return this.state.policyChanges[previewId];
    for (const segment of this.state.segments) {
      for (const item of segment.items) if (item.view?.preview?.id === previewId) return item.view.preview;
    }
    return null;
  }

  async confirm(previewId: string) {
    if (!this.canConfirm(previewId)) return;
    const preview = this.previewView(previewId);
    const held = this.tokens.get(previewId)!;
    if (!preview) return;
    const existing = this.state.pendingConfirms.find((p) => p.previewId === previewId);
    // Same action id on a deliberate second try: if the first did land, the
    // server returns that receipt instead of writing twice.
    const clientActionId = existing?.clientActionId ?? this.newId();
    this.putPending({ previewId, clientActionId, phase: 'confirming', view: null, failure: null, statusStalled: false });
    const result = await this.guarded(() =>
      this.api.confirm(previewId, {
        confirmationToken: held.token,
        clientActionId,
        expectedPolicyRevision: preview.basePolicyRevision,
        patchHash: preview.patchHash,
        impactHash: preview.impactHash,
      }),
      'session'
    );
    if (!result) return;
    if (result.ok) return this.settle(previewId, result.value, null);
    const failure = result.failure;
    if (failure.kind === 'http') {
      if (failure.code === 'preview_consumed') {
        this.tokens.delete(previewId);
        return this.readStatus(previewId, 0);
      }
      if (failure.code === 'auth_expired') return;
      if (failure.code === 'rate_limited') {
        // Refused before it was submitted. Nothing is retried on its own: the
        // unused preview is released, and the person asks for a fresh one
        // once Retry-After has passed.
        this.settle(previewId, null, failure);
        this.discardQuietly(previewId);
        return;
      }
      // A 4xx refusal, or audit_unavailable (rolled back), says nothing was
      // applied. Any other 5xx only says the server could not finish: the
      // outcome is unknown, so it is read from status like a lost response.
      if (failure.status < 500 || failure.code === 'audit_unavailable') return this.settle(previewId, null, failure);
    }
    // No usable answer: the outcome is unknown. Read status; never re-post.
    this.putPending({ previewId, clientActionId, phase: 'unknown', view: null, failure, statusStalled: false });
    return this.readStatus(previewId, 0);
  }

  /** The person asks to check an unknown outcome again after reads stalled. */
  checkStatus(previewId: string) {
    const pending = this.state.pendingConfirms.find((p) => p.previewId === previewId);
    if (!pending || pending.phase !== 'unknown') return;
    this.putPending({ ...pending, statusStalled: false });
    void this.readStatus(previewId, 0);
  }

  private async readStatus(previewId: string, attempt: number) {
    const result = await this.guarded(() => this.api.getPolicyChange(previewId), 'session');
    if (!result) return;
    const pending = this.state.pendingConfirms.find((p) => p.previewId === previewId);
    if (!pending) return;
    if (result.ok) {
      const view = result.value;
      if (view.state === 'preview_ready') {
        // Verified NOT applied and still valid. Offer the same action again.
        this.putPending({ ...pending, phase: 'not_applied', view, failure: null });
        this.set({ policyChanges: { ...this.state.policyChanges, [previewId]: view } });
        return;
      }
      return this.settle(previewId, view, null);
    }
    if (httpCode(result.failure) === 'auth_expired') return;
    if (attempt + 1 >= STATUS_POLL_LIMIT) {
      this.putPending({ ...pending, statusStalled: true });
      return;
    }
    this.later(() => void this.readStatus(previewId, attempt + 1), STATUS_POLL_MS, 'session');
  }

  private settle(previewId: string, view: PolicyChangeView | null, failure: IrisFailure | null) {
    this.tokens.delete(previewId);
    const pending = this.state.pendingConfirms.find((p) => p.previewId === previewId);
    this.putPending({
      previewId,
      clientActionId: pending?.clientActionId ?? '',
      phase: 'settled',
      view,
      failure,
      statusStalled: false,
    });
    if (view) {
      this.set({ policyChanges: { ...this.state.policyChanges, [previewId]: view } });
      if (view.state === 'applied' && !SETTLED_REFRESH.includes(view.refreshState)) {
        this.later(() => void this.refreshReceipt(previewId, 0), STATUS_POLL_MS, 'session');
      }
    }
  }

  /** After a verified save, follow the separate re-evaluation status. */
  private async refreshReceipt(previewId: string, attempt: number) {
    const result = await this.guarded(() => this.api.getPolicyChange(previewId), 'session');
    if (!result || !result.ok) {
      if (result && attempt + 1 < STATUS_POLL_LIMIT) {
        this.later(() => void this.refreshReceipt(previewId, attempt + 1), STATUS_POLL_MS, 'session');
      }
      return;
    }
    const view = result.value;
    this.set({ policyChanges: { ...this.state.policyChanges, [previewId]: view } });
    const pending = this.state.pendingConfirms.find((p) => p.previewId === previewId);
    if (pending) this.putPending({ ...pending, view });
    if (!SETTLED_REFRESH.includes(view.refreshState) && attempt + 1 < STATUS_POLL_LIMIT) {
      this.later(() => void this.refreshReceipt(previewId, attempt + 1), STATUS_POLL_MS, 'session');
    }
  }

  private putPending(next: PendingConfirm) {
    const others = this.state.pendingConfirms.filter((p) => p.previewId !== next.previewId);
    this.set({ pendingConfirms: [...others, next] });
  }

  async discard(previewId: string) {
    if (!this.tokens.has(previewId)) return;
    if (this.state.pendingConfirms.some((p) => p.previewId === previewId && p.phase !== 'not_applied')) return;
    this.tokens.delete(previewId);
    this.set({});
    const result = await this.guarded(() => this.api.discard(previewId, this.newId()), 'session');
    if (result?.ok) this.set({ policyChanges: { ...this.state.policyChanges, [previewId]: result.value } });
  }

  private discardQuietly(previewId: string) {
    void this.guarded(() => this.api.discard(previewId, this.newId()), 'session').then((result) => {
      if (result?.ok) this.set({ policyChanges: { ...this.state.policyChanges, [previewId]: result.value } });
    });
  }

  // ---- sources and impact ---------------------------------------------------

  /** Source peek. Re-authorised by the server on every read, from any page. */
  async evidence(ref: string, signal?: AbortSignal) {
    return this.guarded<EvidenceView>(() => this.api.getEvidence(ref, signal), 'session');
  }

  async impactPage(previewId: string, cursor: string | null, signal?: AbortSignal) {
    return this.guarded<ImpactPage>(() => this.api.getImpact(previewId, cursor, signal), 'session');
  }

  // ---- conversation lifetime ------------------------------------------------

  /** Expiry clears chat and unused action state; pending confirms stay. */
  private expire() {
    this.dropConversationWork();
    this.set({
      phase: 'expired',
      conversationId: null,
      segments: [],
      trimmed: false,
      limit: null,
      context: { status: 'unresolved', origin: null, failure: null },
    });
  }

  /**
   * The page is going away (refresh, closed tab, navigation). One best-effort
   * keepalive close of this tab's own current conversation, so it does not hold
   * one of the profile's two slots until the idle expiry. Only the id this tab
   * created; never an unknown or other tab's conversation, never a session
   * refresh or retry. A crash or killed tab fires nothing, and a conversation
   * still being created has no id yet, so both wait for the idle expiry.
   * A pending confirm is left alone: it is never re-sent, and its outcome stays
   * readable from the account's durable receipt.
   */
  pagehide() {
    const conversationId = this.state.conversationId;
    if (this.disposed || !conversationId || this.closedOnPagehide === conversationId || !this.isSignedIn()) return;
    this.closedOnPagehide = conversationId;
    this.api.closeOnPagehide(conversationId, this.newId()).catch(() => {});
  }

  /** Restored from the back/forward cache: the conversation closed on pagehide is gone. */
  pageshow(persisted: boolean) {
    if (!persisted || this.disposed) return;
    if (this.closedOnPagehide && this.closedOnPagehide === this.state.conversationId) this.expire();
    this.closedOnPagehide = null;
  }

  /** Explicit New conversation: release the old memory slot, start clean. */
  async newConversation() {
    if (this.disposed) return;
    const old = this.state.conversationId;
    for (const previewId of [...this.tokens.keys()]) {
      if (this.state.pendingConfirms.some((p) => p.previewId === previewId)) continue;
      this.discardQuietly(previewId);
    }
    this.dropConversationWork();
    // A profile holds at most two open conversations, so the replacement is
    // created only once the old one's close has settled; otherwise the create
    // can race it into conversation_limit. A failed close is not retried or
    // papered over: the create then reports whatever the server says.
    if (old) {
      const closing = this.guarded(() => this.api.closeConversation(old, this.newId()), 'session');
      this.closing = closing;
      void closing.finally(() => {
        if (this.closing === closing) this.closing = null;
      });
    }
    this.set({
      phase: 'idle',
      conversationId: null,
      segments: [],
      trimmed: false,
      limit: null,
      failure: null,
      context: { status: 'unresolved', origin: null, failure: null },
    });
    if (this.closing) await this.closing;
    if (this.disposed) return;
    if (this.state.open) await this.open();
  }

  private dropConversationWork() {
    this.epoch += 1;
    for (const controller of this.aborts) controller.abort();
    this.aborts.clear();
    for (const handle of this.timers) this.scheduler.clearTimeout(handle);
    this.timers.clear();
    for (const previewId of [...this.tokens.keys()]) {
      if (!this.state.pendingConfirms.some((p) => p.previewId === previewId)) this.tokens.delete(previewId);
    }
    // Pending confirms are account-owned; their status reads and timers are
    // session-scoped and keep running.
  }

  /**
   * Auth loss or sign-out. Synchronous: every timer and request is stopped,
   * every token and record is dropped, and nothing is called afterwards.
   */
  signOut() {
    this.epoch += 1;
    this.sessionEpoch += 1;
    for (const controller of this.aborts) controller.abort();
    this.aborts.clear();
    for (const handle of this.timers) this.scheduler.clearTimeout(handle);
    this.timers.clear();
    for (const handle of this.sessionTimers) this.scheduler.clearTimeout(handle);
    this.sessionTimers.clear();
    this.tokens.clear();
    this.state = { ...initialState(), phase: 'signed_out' };
    for (const listener of this.listeners) listener();
    this.disposed = true;
  }
}
