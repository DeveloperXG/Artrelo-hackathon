import {
  AlertCircle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Flag,
  HelpCircle,
  Hourglass,
  Loader2,
  PauseCircle,
  UserRound,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { relativeTime } from '../../lib/relativeTime';
import { decisionsFocusHref } from '../landlord/decisionHref';
import { LICHEN_FOCUS } from '../ui/lichen';
import { SimulatedVendorPill } from '../judge/JudgeBadges';
import {
  IRIS_AUTOMATION_LABELS,
  IRIS_AUTOMATION_SHORT,
  absoluteTime,
  eventActor,
  approvalTypeLabel,
  automationStateOf,
  pendingApprovalOf,
  locationLabel,
  parseActivityTime,
  stageLabel,
  stateDot,
  stateLabel,
  stateTone,
} from '../../lib/irisActivity';
import type { IrisAutomationState, IrisEvent, IrisRequestSummary } from '../../types/irisActivity';

// Shared pieces of the three Iris activity views. Every string rendered here
// comes from the API's projection; nothing is synthesised client-side.
//
// Overview and /dashboard/activity are in the Lichen scope; the request-detail
// Activity tab is not yet. The lichen: variants restyle the former and leave
// the latter exactly as it was.

/** Long unbroken values (an email, a pasted URL) wrap instead of overflowing. */
const WRAP = '[overflow-wrap:anywhere]';

export function requestActivityHref(requestId: string) {
  return `/dashboard/requests/${encodeURIComponent(requestId)}?tab=activity`;
}

export function IrisStateBadge({ state }: { state: string }) {
  return (
    <span
      data-testid="iris-state"
      data-state={state}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${stateTone(state)}`}
    >
      {stateLabel(state)}
    </span>
  );
}

export function ActionRequiredPill() {
  return (
    <span
      data-testid="iris-action-required"
      // Lichen fill: "needs you". The icon and the words carry it too.
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-rose-500 px-2 py-0.5 text-[11px] font-semibold text-white lichen:bg-lichen lichen:text-on-lichen"
    >
      <AlertCircle className="h-3 w-3" aria-hidden="true" />
      Your action needed
    </span>
  );
}

/** Relative time with the exact one on hover; a missing time says so. */
export function ActivityTime({ at, className = '' }: { at: string | null; className?: string }) {
  const date = parseActivityTime(at);
  if (!date) return <span className={`text-xs text-slate-400 lichen:text-meta ${className}`}>Time not recorded</span>;
  return (
    <time
      dateTime={date.toISOString()}
      title={absoluteTime(at)}
      className={`text-xs text-slate-400 lichen:font-mono lichen:text-meta ${className}`}
    >
      {relativeTime(date)}
    </time>
  );
}

export function WaitingFor({ value }: { value: string | null }) {
  if (!value) return null;
  return (
    <p className={`flex items-start gap-1.5 text-xs text-amber-800 lichen:text-chip-icon ${WRAP}`} data-testid="iris-waiting-for">
      <Hourglass className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span>Waiting for {value}</span>
    </p>
  );
}

// Static icons on purpose: nothing spins or pulses, so no state can look
// busy. Only `running` (a live server lease) gets the "working" icon and tone.
// Lichen: running and waiting-on-you are Lichen (live / needs you), each with
// its own icon and words; waiting on others is neutral, done is Mist, failure
// and hand-back are Alert.
const AUTOMATION_VISUALS: Record<IrisAutomationState, { icon: LucideIcon; tone: string }> = {
  running: { icon: Bot, tone: 'text-[#137fec] lichen:text-lichen-text' },
  awaiting_landlord: { icon: ClipboardCheck, tone: 'text-rose-600 lichen:text-lichen-text' },
  awaiting_vendor: { icon: Wrench, tone: 'text-amber-700 lichen:text-chip-icon' },
  awaiting_tenant: { icon: UserRound, tone: 'text-amber-700 lichen:text-chip-icon' },
  completed: { icon: CheckCircle2, tone: 'text-emerald-600 lichen:text-mist-text' },
  failed: { icon: XCircle, tone: 'text-rose-600 lichen:text-alert-text' },
  escalated: { icon: Flag, tone: 'text-rose-600 lichen:text-alert-text' },
  idle: { icon: PauseCircle, tone: 'text-slate-500 lichen:text-meta' },
  unknown: { icon: HelpCircle, tone: 'text-slate-500 lichen:text-meta' },
};

/**
 * What Iris's automation is doing -- separate from the maintenance state badge.
 * Compact rows show the short label; the full sentence is the accessible name
 * either way, so a screen reader never hears just "Waiting".
 */
export function IrisAutomationIndicator({
  summary,
  compact = false,
}: {
  summary: Pick<IrisRequestSummary, 'automationState'>;
  compact?: boolean;
}) {
  const state = automationStateOf(summary);
  const { icon: Icon, tone } = AUTOMATION_VISUALS[state];
  const full = IRIS_AUTOMATION_LABELS[state];
  return (
    <span
      data-testid="iris-automation"
      data-automation={state}
      title={full}
      className={`inline-flex min-w-0 items-center gap-1 text-xs font-medium ${tone}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {compact ? (
        <>
          <span aria-hidden="true" className="truncate">
            {IRIS_AUTOMATION_SHORT[state]}
          </span>
          <span className="sr-only">{full}</span>
        </>
      ) : (
        <span>{full}</span>
      )}
    </span>
  );
}

/**
 * The one way into a pending approval from activity: the existing Decisions
 * page focused on this request -- the same link the routing summary uses, so
 * both act on the same ApprovalRequest. Rendered only for a pending reference.
 */
export function PendingDecisionLink({ summary }: { summary: Pick<IrisRequestSummary, 'requestId' | 'pendingApproval'> }) {
  const approval = pendingApprovalOf(summary);
  if (!approval) return null;
  return (
    <Link
      to={decisionsFocusHref(summary.requestId)}
      data-testid="iris-decision-link"
      data-approval-id={approval.approvalId}
      className={`relative z-10 inline-flex items-center gap-1 rounded-md text-xs font-semibold text-[#137fec] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]/50 lichen:text-lichen-text ${LICHEN_FOCUS}`}
    >
      Review decision: {approvalTypeLabel(approval.type)}
      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
    </Link>
  );
}

/**
 * One request, grouped: what stage it is at, the latest meaningful action,
 * what it is waiting on, what Iris is doing and whether the landlord must act.
 *
 * The title link is stretched over the row (an ::after overlay) so the whole
 * row opens the request's Activity tab, while the decision link stays a
 * separate sibling above it -- no anchor inside an anchor.
 */
export function IrisRequestRow({ summary, compact = false }: { summary: IrisRequestSummary; compact?: boolean }) {
  const location = locationLabel(summary);
  const latest = summary.latestEvent;
  return (
    <div
      data-testid="iris-request-row"
      data-request-id={summary.requestId}
      className="group relative flex w-full flex-wrap items-start gap-3 rounded-xl px-2 py-2.5 text-left transition hover:bg-slate-50 lichen:rounded-md lichen:hover:bg-hairline/60"
    >
      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${stateDot(summary.state)}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 basis-24 space-y-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to={requestActivityHref(summary.requestId)}
            data-testid="iris-request-link"
            // The focus cue is drawn on the stretched ::after, so it outlines
            // the whole row; in Lichen as a solid outline, not a soft ring.
            className={`min-w-0 text-sm font-medium text-slate-900 after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-[#137fec]/50 lichen:text-ink lichen:after:rounded-md lichen:focus-visible:after:outline-2 lichen:focus-visible:after:outline-solid lichen:focus-visible:after:outline-ring lichen:focus-visible:after:ring-0 ${compact ? 'line-clamp-1' : 'line-clamp-2'} ${WRAP}`}
          >
            {summary.title || 'Untitled request'}
          </Link>
          {summary.actionRequired ? <ActionRequiredPill /> : null}
        </span>
        <span className={`block text-xs text-slate-500 lichen:text-meta ${compact ? 'truncate' : WRAP}`}>
          {[location, stageLabel(summary.stage)].filter(Boolean).join(' · ')}
        </span>
        <span className={`block text-sm text-slate-600 lichen:text-nav ${compact ? 'line-clamp-1' : 'line-clamp-2'} ${WRAP}`}>
          {latest ? latest.title : summary.summary || 'No activity recorded yet.'}
        </span>
        {!compact || summary.waitingFor ? <WaitingFor value={summary.waitingFor} /> : null}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <IrisAutomationIndicator summary={summary} compact={compact} />
          <PendingDecisionLink summary={summary} />
        </span>
      </span>
      <span className="ml-auto flex shrink-0 flex-col items-end gap-1.5">
        <IrisStateBadge state={summary.state} />
        <ActivityTime at={latest?.at ?? summary.updatedAt} />
      </span>
      <ChevronRight
        className="mt-1 hidden h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-slate-500 sm:block lichen:text-meta lichen:group-hover:text-ink"
        aria-hidden="true"
      />
    </div>
  );
}

/** One recorded step. Details open with a native disclosure. */
export function IrisEventItem({ event }: { event: IrisEvent }) {
  const { label: actor, simulated, provenance } = eventActor(event);
  const details = (event.details || []).filter((detail) => detail && detail.label && detail.value);
  return (
    <li className="relative" data-testid="iris-event" data-event-id={event.id}>
      <span
        className={`absolute -left-[31px] top-1 h-4 w-4 rounded-full border-2 border-white lichen:border-card ${stateDot(event.state)}`}
        aria-hidden="true"
      />
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <h4 className={`min-w-0 text-sm font-semibold text-slate-900 lichen:text-ink ${WRAP}`}>{event.title}</h4>
        <IrisStateBadge state={event.state} />
      </div>
      {event.summary ? <p className={`mt-1 text-sm leading-6 text-slate-600 lichen:text-nav ${WRAP}`}>{event.summary}</p> : null}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500 lichen:text-meta">
        {actor ? <span className={WRAP} data-testid="iris-event-actor">{actor}</span> : null}
        {simulated && actor !== 'Simulated vendor' ? <SimulatedVendorPill className="!px-1.5 !py-0" /> : null}
        {provenance ? <span className={WRAP} data-testid="iris-event-provenance">({provenance})</span> : null}
        {actor || simulated || provenance ? <span aria-hidden="true">·</span> : null}
        <ActivityTime at={event.at} />
      </div>
      {details.length > 0 ? (
        <details className="group mt-2 rounded-lg border border-slate-200 bg-slate-50/60 lichen:rounded-md lichen:border-border lichen:bg-well" data-testid="iris-event-details">
          <summary className={`flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]/50 [&::-webkit-details-marker]:hidden lichen:text-nav lichen:hover:text-ink ${LICHEN_FOCUS}`}>
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
            <span className="group-open:hidden">Show details</span>
            <span className="hidden group-open:inline">Hide details</span>
            <span className="text-slate-400 lichen:font-mono lichen:text-meta">({details.length})</span>
          </summary>
          <dl className="grid gap-x-4 gap-y-1.5 border-t border-slate-200 px-3 py-2.5 text-xs sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)] lichen:border-border">
            {details.map((detail, index) => (
              <div key={`${detail.label}-${index}`} className="contents">
                <dt className={`font-medium text-slate-500 lichen:text-meta ${WRAP}`}>{detail.label}</dt>
                <dd className={`mb-1 text-slate-800 sm:mb-0 lichen:text-ink ${WRAP}`}>{detail.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </li>
  );
}

export function IrisEventTimeline({ events }: { events: IrisEvent[] }) {
  return (
    <ol className="relative ml-1.5 space-y-5 border-l border-slate-200 pl-6 lichen:border-hairline" data-testid="iris-timeline">
      {events.map((event) => (
        <IrisEventItem key={event.id} event={event} />
      ))}
    </ol>
  );
}

/** "Load older" control with its own error; only rendered while a cursor exists. */
export function LoadMoreButton({
  hasMore,
  loading,
  error,
  onClick,
  label,
}: {
  hasMore: boolean;
  loading: boolean;
  error: string;
  onClick: () => void;
  label: string;
}) {
  if (!hasMore) return null;
  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      {error ? (
        <p role="alert" className="text-xs text-rose-700 lichen:text-alert-text">
          {error}
        </p>
      ) : null}
      {/* aria-disabled, not disabled: a natively disabled button drops keyboard
          focus to <body> mid-load, and the next Tab starts from the top. */}
      <button
        type="button"
        onClick={loading ? undefined : onClick}
        aria-disabled={loading || undefined}
        data-testid="iris-load-more"
        className={`inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]/50 aria-disabled:cursor-wait aria-disabled:opacity-60 lichen:rounded-md lichen:border-control-border lichen:bg-transparent lichen:text-ink lichen:shadow-none lichen:hover:bg-hairline ${LICHEN_FOCUS}`}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
        {loading ? 'Loading…' : error ? 'Try again' : label}
      </button>
    </div>
  );
}

/**
 * Non-blocking note when a background refresh fails over rows already shown.
 * The status region stays mounted while empty so screen readers announce the
 * message when it appears, not only when the region is inserted with it.
 */
export function RefreshNote({ message }: { message: string }) {
  return (
    <p
      role="status"
      className={
        message
          ? 'mb-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800 lichen:rounded-md lichen:border-lichen-line lichen:bg-lichen-wash lichen:text-lichen-text'
          : 'sr-only'
      }
    >
      {message}
    </p>
  );
}
