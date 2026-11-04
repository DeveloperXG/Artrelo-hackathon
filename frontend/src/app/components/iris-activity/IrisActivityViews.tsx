import { Activity, ArrowRight, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card } from '../ui/card';
import { DetailCard } from '../request-detail/detailUi';
import { HackathonBadge } from '../judge/JudgeBadges';
import { EmptyState } from '../landlord/landlordUi';
import { stageLabel } from '../../lib/irisActivity';
import type { IrisEvent, IrisRequestSummary } from '../../types/irisActivity';
import {
  ActionRequiredPill,
  ActivityTime,
  IrisAutomationIndicator,
  IrisEventTimeline,
  IrisRequestRow,
  IrisStateBadge,
  LoadMoreButton,
  PendingDecisionLink,
  RefreshNote,
  WaitingFor,
} from './IrisActivityParts';

/** What every view gets from its feed hook. */
export interface FeedView {
  loading: boolean;
  error: string;
  refreshError: string;
  nextCursor: string | null;
  loadingMore: boolean;
  loadMoreError: string;
  loadMore: () => void;
  refresh: () => void;
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-sm text-rose-800 lichen:rounded-md lichen:border-alert-line lichen:bg-alert-tint lichen:text-alert-text"
      data-testid="iris-error"
    >
      <span>{message}</span>{' '}
      <button type="button" onClick={onRetry} className="rounded-sm font-semibold underline underline-offset-2 hover:text-rose-900 lichen:hover:text-ink">
        Try again
      </button>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <p className="py-6 text-sm text-slate-500 lichen:text-meta" role="status" data-testid="iris-loading">
      {label}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Dashboard card: the few active requests with the newest activity.

export function IrisActivityCardView({ feed, requests }: { feed: FeedView; requests: IrisRequestSummary[] }) {
  return (
    // Overview only, which is in the Lichen scope.
    <Card className="ll-fade-up flex min-w-0 flex-col gap-3 border-border p-5" data-testid="overview-iris-activity">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex flex-wrap items-center gap-2 font-semibold text-ink"><span>Activity</span><HackathonBadge /></h3>
        <Link
          to="/dashboard/activity"
          className="inline-flex shrink-0 items-center gap-1 rounded-sm text-sm font-medium text-lichen-text hover:underline"
        >
          View all
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>
      {feed.loading ? (
        <Loading label="Loading activity…" />
      ) : feed.error ? (
        <LoadError message={feed.error} onRetry={feed.refresh} />
      ) : requests.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-10 text-sm text-meta" data-testid="iris-empty">
          No active requests right now.
        </div>
      ) : (
        <>
          <RefreshNote message={feed.refreshError} />
          <ul className="-mx-2 flex-1 space-y-0.5">
            {requests.map((summary) => (
              <li key={summary.requestId}>
                <IrisRequestRow summary={summary} compact />
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Central page: every request, grouped, newest activity first.

export function IrisActivityListView({
  feed,
  requests,
  activeOnly,
}: {
  feed: FeedView;
  requests: IrisRequestSummary[];
  activeOnly: boolean;
}) {
  if (feed.loading) return <Loading label="Loading activity…" />;
  if (feed.error) return <LoadError message={feed.error} onRetry={feed.refresh} />;
  if (requests.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        testId="iris-empty"
        title={activeOnly ? 'No active requests' : 'No activity yet'}
        description={
          activeOnly
            ? 'Requests that are still open will appear here as work happens on them.'
            : 'Activity appears here once a tenant submits a request.'
        }
      />
    );
  }
  return (
    <div aria-busy={feed.loadingMore || undefined}>
      <RefreshNote message={feed.refreshError} />
      <ul className="-mx-2 divide-y divide-slate-100 lichen:divide-hairline" data-testid="iris-request-list">
        {requests.map((summary) => (
          <li key={summary.requestId} className="py-0.5">
            <IrisRequestRow summary={summary} />
          </li>
        ))}
      </ul>
      <LoadMoreButton
        hasMore={Boolean(feed.nextCursor)}
        loading={feed.loadingMore}
        error={feed.loadMoreError}
        onClick={feed.loadMore}
        label="Load more requests"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Request Activity tab: where the request stands, then every recorded step.

export function RequestStandingSummary({ summary }: { summary: IrisRequestSummary }) {
  return (
    <section
      aria-label="Where this request stands"
      data-testid="iris-request-standing"
      className={`mb-5 rounded-xl border px-4 py-3 ${
        summary.actionRequired ? 'border-rose-200 bg-rose-50/60' : 'border-slate-200 bg-slate-50/60'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Stage</span>
        <span className="text-sm font-semibold text-slate-900">{stageLabel(summary.stage)}</span>
        <IrisStateBadge state={summary.state} />
        {summary.actionRequired ? <ActionRequiredPill /> : null}
      </div>
      {summary.summary ? (
        <p className="mt-1.5 text-sm leading-6 text-slate-700 [overflow-wrap:anywhere]">{summary.summary}</p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <IrisAutomationIndicator summary={summary} />
        <PendingDecisionLink summary={summary} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <WaitingFor value={summary.waitingFor} />
        <span className="text-xs text-slate-400">
          Last update <ActivityTime at={summary.updatedAt} />
        </span>
      </div>
    </section>
  );
}

export function IrisRequestActivityView({
  feed,
  summary,
  events,
}: {
  feed: FeedView;
  summary: IrisRequestSummary | null;
  events: IrisEvent[];
}) {
  return (
    <DetailCard
      icon={Clock}
      iconColor="#a855f7"
      title="Activity"
      action={<HackathonBadge />}
      description="What Iris, the tenant, vendors and you have done on this request. Newest first."
      id="request-detail-tab-activity"
      role="tabpanel"
      aria-labelledby="request-detail-tab-button-activity"
    >
      {feed.loading ? (
        <Loading label="Loading activity…" />
      ) : feed.error ? (
        <LoadError message={feed.error} onRetry={feed.refresh} />
      ) : (
        <div aria-busy={feed.loadingMore || undefined}>
          <RefreshNote message={feed.refreshError} />
          {summary ? <RequestStandingSummary summary={summary} /> : null}
          {events.length > 0 ? (
            <IrisEventTimeline events={events} />
          ) : (
            <div
              className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-8 text-center text-sm text-slate-400"
              data-testid="iris-empty"
            >
              No events recorded yet.
            </div>
          )}
          <LoadMoreButton
            hasMore={Boolean(feed.nextCursor)}
            loading={feed.loadingMore}
            error={feed.loadMoreError}
            onClick={feed.loadMore}
            label="Load older activity"
          />
        </div>
      )}
    </DetailCard>
  );
}
