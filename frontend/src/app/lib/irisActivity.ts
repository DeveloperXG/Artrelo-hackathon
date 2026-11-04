// Display rules and the paging controller behind every Iris activity view
// (dashboard card, /dashboard/activity, the request Activity tab). One module so
// the three views cannot disagree about what a state or stage is called.
//
// Nothing here invents activity: labels translate the server's enums, and the
// controller only ever shows rows the API returned.

import { ApiError } from '../api/client';
import {
  IRIS_ACTIVITY_VERSION,
  type IrisAutomationState,
  type IrisActivityList,
  type IrisEvent,
  type IrisRequestActivity,
  type IrisRequestSummary,
  type IrisStage,
  type IrisState,
} from '../types/irisActivity';

export const IRIS_STATE_LABELS: Record<IrisState, string> = {
  in_progress: 'In progress',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  needs_attention: 'Needs attention',
  unknown: 'Status unknown',
};

/**
 * Badge colours, matching the request pills (STATUS_COLORS) in tone. The
 * lichen: half is the owner's pill table, used where a page is in the Lichen
 * scope; the request-detail Activity tab is not yet, and keeps the first half.
 * In Lichen, In progress and Needs attention share the Lichen pill, as the owner
 * specified; the label tells them apart, and needing you also carries the
 * "Your action needed" pill. Colour only, never motion: In progress is the
 * maintenance state and says nothing about Iris running.
 */
export const IRIS_STATE_TONES: Record<IrisState, string> = {
  in_progress: 'bg-blue-50 text-blue-700 ring-blue-200 lichen:bg-lichen-tint lichen:text-lichen-pill lichen:ring-0',
  waiting: 'bg-amber-50 text-amber-800 ring-amber-200 lichen:bg-pill-neutral lichen:text-chip-icon lichen:ring-0',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200 lichen:bg-chip lichen:text-meta lichen:ring-0',
  failed: 'bg-rose-50 text-rose-700 ring-rose-200 lichen:bg-alert-tint lichen:text-alert-text lichen:ring-0',
  needs_attention: 'bg-rose-50 text-rose-700 ring-rose-200 lichen:bg-lichen-tint lichen:text-lichen-pill lichen:ring-0',
  unknown: 'bg-slate-100 text-slate-600 ring-slate-200 lichen:bg-chip lichen:text-meta lichen:ring-0',
};

/** Timeline dot colour per state (decorative; the badge beside it is the label).
 * Live dots use lichen-icon: the Lichen fill itself is 1.9:1 on light content. */
export const IRIS_STATE_DOTS: Record<IrisState, string> = {
  in_progress: 'bg-blue-500 lichen:bg-lichen-icon',
  waiting: 'bg-amber-400 lichen:bg-chip-icon',
  completed: 'bg-emerald-500 lichen:bg-mist',
  failed: 'bg-rose-500 lichen:bg-alert',
  needs_attention: 'bg-rose-500 lichen:bg-lichen-icon',
  unknown: 'bg-slate-300 lichen:bg-control-border',
};

export const IRIS_STAGE_LABELS: Record<IrisStage, string> = {
  intake: 'Intake',
  routing: 'Choosing a vendor',
  outreach: 'Vendor outreach',
  scheduling: 'Scheduling',
  work: 'Work',
  review: 'Review',
  closed: 'Closed',
};

/**
 * The request's automation (deterministic routing and outreach), worded so it
 * cannot be read as the maintenance state: every label names the automation or
 * who it waits on. Only `running` says it is working. It is not Iris: Iris is
 * the Ask Iris assistant, which never runs this workflow.
 */
export const IRIS_AUTOMATION_LABELS: Record<IrisAutomationState, string> = {
  running: 'Automation is working on this',
  awaiting_landlord: 'Automation is waiting on you',
  awaiting_vendor: 'Automation is waiting on the vendor',
  awaiting_tenant: 'Automation is waiting on the tenant',
  completed: 'Automation has finished its part',
  failed: 'Automation could not finish',
  escalated: 'Automation handed this to you',
  idle: 'Automation is not doing anything now',
  unknown: 'Automation status not available',
};

/** Shorter form for compact rows (also the visible text there). */
export const IRIS_AUTOMATION_SHORT: Record<IrisAutomationState, string> = {
  running: 'Automation working',
  awaiting_landlord: 'Waiting on you',
  awaiting_vendor: 'Waiting on vendor',
  awaiting_tenant: 'Waiting on tenant',
  completed: 'Automation done',
  failed: 'Automation stopped',
  escalated: 'Escalated',
  idle: 'Automation idle',
  unknown: 'Status unknown',
};

/** Missing (legacy payload) or unrecognised values read as unknown. */
export function automationStateOf(summary: { automationState?: string | null }): IrisAutomationState {
  const value = summary.automationState;
  return own(IRIS_AUTOMATION_LABELS, value) ? (value as IrisAutomationState) : 'unknown';
}

/** Only the server's `running` may convey execution; maintenance in_progress never does. */
export function isIrisExecuting(summary: { automationState?: string | null }): boolean {
  return automationStateOf(summary) === 'running';
}

// Matches the Decisions page's approval type names.
const APPROVAL_TYPE_LABELS: Record<string, string> = {
  external_vendor_search: 'External vendor search',
  completion_review: 'Completion review',
  quota_increase: 'Quota increase',
  first_time_vendor: 'First-time vendor',
  vendor_contact_approval: 'Vendor contact',
  high_severity: 'High severity',
  tenant_caused_cost: 'Tenant-caused cost',
  other: 'Other',
};

export function approvalTypeLabel(type: string): string {
  const known = own(APPROVAL_TYPE_LABELS, type);
  if (known) return known;
  const clean = (type || '').replace(/[_-]+/g, ' ').trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'Approval';
}

/** Only a well-formed pending reference is actionable; anything else is none. */
export function pendingApprovalOf(summary: { pendingApproval?: unknown }) {
  const value = summary.pendingApproval as { approvalId?: unknown; type?: unknown; status?: unknown } | null | undefined;
  if (!value || value.status !== 'pending' || typeof value.approvalId !== 'string' || !value.approvalId) return null;
  return { approvalId: value.approvalId, type: typeof value.type === 'string' ? value.type : '', status: 'pending' as const };
}

export const IRIS_STAGE_ORDER: IrisStage[] = ['intake', 'routing', 'outreach', 'scheduling', 'work', 'review', 'closed'];

/** Own keys only: "toString" or "constructor" from a server is not a state. */
function own<V>(table: Record<string, V>, key: unknown): V | undefined {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** An unexpected enum from a newer server reads as unknown, never as a crash. */
export function stateLabel(state: string): string {
  return own(IRIS_STATE_LABELS, state) ?? IRIS_STATE_LABELS.unknown;
}
export function stateTone(state: string): string {
  return own(IRIS_STATE_TONES, state) ?? IRIS_STATE_TONES.unknown;
}
export function stateDot(state: string): string {
  return own(IRIS_STATE_DOTS, state) ?? IRIS_STATE_DOTS.unknown;
}
export function stageLabel(stage: string): string {
  return own(IRIS_STAGE_LABELS, stage) ?? 'Stage unknown';
}

/** Who acted, from the server's actorKind (judge contract v1). The automated
 *  workflow is never shown as Iris, and an Iris-assisted Policy save arrives
 *  as `landlord`: the person saved it. */
export const ACTOR_KIND_LABELS: Record<string, string> = {
  landlord: 'Landlord',
  tenant: 'Tenant',
  vendor: 'Vendor',
  simulated_vendor: 'Simulated vendor',
  automation: 'Automation',
  iris_assistant: 'Ask Iris',
  ai_triage: 'AI triage',
  system: 'System',
  unknown: 'Unknown',
};

const PROVENANCE_LABELS: Record<string, string> = {
  rules: 'Rules',
  model: 'AI model',
  records: 'From your records',
  simulation: 'Simulation',
  fallback: 'Fallback, no AI',
  unknown: 'Source unknown',
};

// Older payloads say "Iris" for every automated step; that cannot tell the
// workflow from a model call, so it reads as Unknown rather than as Iris.
const LEGACY_AMBIGUOUS = /^(iris|ai[\s_-]*agent)$/i;
const NAMES_IRIS = /\biris\b/i;
const HUMAN_KINDS = new Set(['landlord', 'tenant']);

export interface EventActor {
  label: string | null;
  simulated: boolean;
  provenance: string | null;
}

export function eventActor(event: Pick<IrisEvent, 'actor' | 'actorKind' | 'actorLabel' | 'simulated' | 'provenance'>): EventActor {
  const kind = event.actorKind && own(ACTOR_KIND_LABELS, event.actorKind) ? event.actorKind : null;
  const named = (event.actorLabel || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  // The server's own name wins where it knows one ("AI cost analysis" is not
  // Ask Iris), except that a person's action is never credited to Iris.
  const usable = named && !(HUMAN_KINDS.has(kind || '') && NAMES_IRIS.test(named)) && !LEGACY_AMBIGUOUS.test(named);
  let label: string | null;
  if (kind) {
    label = usable ? named : ACTOR_KIND_LABELS[kind];
  } else if (event.actor && LEGACY_AMBIGUOUS.test(event.actor.trim())) {
    // Older data: "Iris" cannot tell the workflow from a model call.
    label = ACTOR_KIND_LABELS.unknown;
  } else {
    label = usable ? named : actorLabel(event.actor);
  }
  const simulated = event.simulated === true || kind === 'simulated_vendor';
  const pKind = event.provenance?.kind && own(PROVENANCE_LABELS, event.provenance.kind) ? event.provenance.kind : null;
  return { label, simulated, provenance: pKind ? PROVENANCE_LABELS[pKind] : null };
}

/** "tenant", "vendor_portal", "iris" -> "Tenant", "Vendor portal", "Iris". */
export function actorLabel(actor: string | null): string | null {
  const clean = (actor || '').replace(/[_-]+/g, ' ').trim();
  if (!clean) return null;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function locationLabel(summary: Pick<IrisRequestSummary, 'propertyLabel' | 'unitLabel'>): string {
  return [summary.propertyLabel, summary.unitLabel]
    .map((part) => (part || '').trim())
    .filter((part) => part && part !== '-')
    .join(' · ');
}

/** A missing timestamp stays missing: never rendered as "just now". */
export function parseActivityTime(at: string | null | undefined): Date | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function absoluteTime(at: string | null | undefined): string {
  const date = parseActivityTime(at);
  return date ? date.toLocaleString() : 'Time not recorded';
}

// ---------------------------------------------------------------------------
// Response checks. The contract is versioned; a payload this client does not
// understand is an error state, not a half-rendered feed.

export class IrisActivityFormatError extends Error {}

function assertVersion(data: unknown): asserts data is { version: number } {
  if (!data || typeof data !== 'object' || (data as { version?: unknown }).version !== IRIS_ACTIVITY_VERSION) {
    throw new IrisActivityFormatError('Activity came back in a format this page does not understand.');
  }
}

export function readActivityList(data: unknown): IrisActivityList {
  assertVersion(data);
  const list = data as Partial<IrisActivityList>;
  if (!Array.isArray(list.requests)) throw new IrisActivityFormatError('Activity list is missing its requests.');
  return { version: 1, requests: list.requests, nextCursor: list.nextCursor ?? null };
}

export function readRequestActivity(data: unknown): IrisRequestActivity {
  assertVersion(data);
  const detail = data as Partial<IrisRequestActivity>;
  if (!detail.request || !Array.isArray(detail.events)) {
    throw new IrisActivityFormatError('Request activity is missing its events.');
  }
  return { version: 1, request: detail.request, events: detail.events, nextCursor: detail.nextCursor ?? null };
}

/** Landlord-facing wording for a failed load; no server internals. */
export function activityErrorMessage(error: unknown): string {
  if (error instanceof IrisActivityFormatError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 404) return 'This request was not found.';
    if (error.status === 401 || error.status === 403) return 'You do not have access to this activity.';
  }
  return 'Activity could not be loaded.';
}

// ---------------------------------------------------------------------------
// Merging pages.

/**
 * A refreshed first page followed by what was already loaded below it, each
 * key once. The fresh copy wins and keeps the server's order: the server is the
 * one place that knows how ties and missing timestamps sort.
 */
export function mergeByKey<T>(fresh: T[], loaded: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of [...fresh, ...loaded]) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** An older page appended under what is shown; anything already shown is skipped. */
export function appendByKey<T>(loaded: T[], older: T[], keyOf: (item: T) => string): T[] {
  return mergeByKey(loaded, older, keyOf);
}

export const requestKey = (item: IrisRequestSummary) => item.requestId;
export const eventKey = (item: IrisEvent) => item.id;

// ---------------------------------------------------------------------------
// The paging controller.

export type FeedPage<T, M> = { items: T[]; nextCursor: string | null; meta: M };

export interface FeedState<T, M> {
  items: T[];
  meta: M | null;
  nextCursor: string | null;
  /** First load, before anything is shown. */
  loading: boolean;
  /** A first-load failure: nothing to show. */
  error: string;
  /** A background refresh failed; the rows shown are the last good ones. */
  refreshError: string;
  loadingMore: boolean;
  loadMoreError: string;
}

/**
 * What a refresh does to pages fetched by loadMore():
 *
 * - 'reset' (request lists): back to the fresh first page and its cursor.
 *   Membership and state of an older page can change -- a request completes
 *   and leaves the active list -- and only a refetch could show that, so an
 *   older page is never kept on as if it were current.
 * - 'retain' (one request's events): recorded history does not change, so
 *   older pages stay below the refreshed first page.
 */
export type RefreshPolicy = 'reset' | 'retain';

/**
 * Owns one feed's rows. Pure TypeScript so it can be tested without a DOM.
 *
 * - refresh() refetches the first page; what happens to older pages follows
 *   the RefreshPolicy.
 * - Overlapping refreshes coalesce: one in flight, at most one queued behind it.
 * - Responses are checked against a generation (bumped by stop()) and a paging
 *   epoch (bumped when a refresh replaces the cursor). A response from an
 *   obsolete one is a complete no-op: it writes nothing, so it cannot end or
 *   overwrite a newer load in progress.
 */
export class FeedController<T, M> {
  private state: FeedState<T, M>;
  private listeners = new Set<() => void>();
  private generation = 0;
  private pagingEpoch = 0;
  private refreshing: Promise<void> | null = null;
  private refreshQueued = false;
  private stopped = false;
  /** Pages fetched below the first by loadMore() since the cursor was last reset. */
  private olderPages = 0;
  /** A page has loaded at least once; later failures keep those rows. */
  private hasData = false;

  constructor(
    private readonly fetchPage: (cursor: string | null) => Promise<FeedPage<T, M>>,
    private readonly keyOf: (item: T) => string,
    private readonly policy: RefreshPolicy
  ) {
    this.state = FeedController.initial();
  }

  private static initial<T, M>(): FeedState<T, M> {
    return {
      items: [],
      meta: null,
      nextCursor: null,
      loading: true,
      error: '',
      refreshError: '',
      loadingMore: false,
      loadMoreError: '',
    };
  }

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<FeedState<T, M>>) {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Begin (or resume) serving. Safe to call after stop(): StrictMode does. */
  start() {
    this.stopped = false;
    // A load cut off by stop() can never finish now; let a new one start.
    if (this.state.loadingMore) this.set({ loadingMore: false });
    return this.refresh();
  }

  /** Stop serving: in-flight and queued responses become no-ops. */
  stop() {
    this.stopped = true;
    this.generation += 1;
    this.refreshing = null;
    this.refreshQueued = false;
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.refreshing) {
      this.refreshQueued = true;
      return this.refreshing;
    }
    const generation = this.generation;
    // Retrying from the error state shows loading again, not the old error.
    if (!this.hasData && this.state.error) this.set({ loading: true, error: '' });
    const run = async () => {
      try {
        const page = await this.fetchPage(null);
        if (generation !== this.generation) return;
        this.hasData = true;
        const keepOlder = this.policy === 'retain' && this.olderPages > 0;
        // Recorded events never disappear: one that slid off the first page now
        // sits between it and the older pages already shown, so every loaded
        // row is kept (de-duplicated). Dropping it would leave a silent gap
        // that the deeper cursor would never fill.
        const tail = keepOlder ? this.state.items : [];
        const patch: Partial<FeedState<T, M>> = {
          items: mergeByKey(page.items, tail, this.keyOf),
          meta: page.meta,
          loading: false,
          error: '',
          refreshError: '',
        };
        if (!keepOlder) {
          // The cursor is replaced, so a load from the old one is obsolete.
          this.pagingEpoch += 1;
          this.olderPages = 0;
          Object.assign(patch, { nextCursor: page.nextCursor, loadingMore: false, loadMoreError: '' });
        }
        this.set(patch);
      } catch (error) {
        if (generation !== this.generation) return;
        if (!this.hasData) {
          this.set({ loading: false, error: activityErrorMessage(error) });
        } else {
          this.set({ refreshError: 'Could not refresh. Showing the last activity loaded.' });
        }
      }
    };
    const promise: Promise<void> = run().finally(() => {
      if (this.refreshing !== promise) return;
      this.refreshing = null;
      if (this.refreshQueued && !this.stopped && generation === this.generation) {
        this.refreshQueued = false;
        void this.refresh();
      }
    });
    this.refreshing = promise;
    return promise;
  }

  async loadMore(): Promise<void> {
    const { nextCursor, loadingMore } = this.state;
    if (this.stopped || loadingMore || !nextCursor) return;
    const generation = this.generation;
    const epoch = this.pagingEpoch;
    const current = () => generation === this.generation && epoch === this.pagingEpoch;
    this.set({ loadingMore: true, loadMoreError: '' });
    try {
      const page = await this.fetchPage(nextCursor);
      if (!current()) return;
      this.olderPages += 1;
      this.set({
        items: appendByKey(this.state.items, page.items, this.keyOf),
        nextCursor: page.nextCursor,
        loadingMore: false,
      });
    } catch (error) {
      if (!current()) return;
      this.set({ loadingMore: false, loadMoreError: activityErrorMessage(error) });
    }
  }
}
