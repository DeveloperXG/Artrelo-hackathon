import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock, FileText, Settings } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LandlordAPI } from '../../api/client';
import PageHeader from '../../components/landlord/PageHeader';
import StatCard, { StatGrid, percentChange } from '../../components/landlord/StatCard';
import RequestTable from '../../components/landlord/RequestTable';
import RequestsTable from '../../components/landlord/RequestsTable';
import { Card } from '../../components/ui/card';
import {
  FieldLabel,
  LandlordError,
  LandlordLoading,
  fieldClass,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import { useLandlordProperties } from '../../hooks/landlord/useLandlordProperties';
import { useLandlordRequests } from '../../hooks/landlord/useLandlordRequests';
import { useLandlordVendors } from '../../hooks/landlord/useLandlordVendors';
import { useRequestActions } from '../../hooks/landlord/useRequestActions';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { markRequestsSeen } from '../../hooks/landlord/useLandlordBadges';
import { getRequestLifecycleStatus } from '../../components/landlord/requestHelpers';
import { isOpenRequest } from '../../components/landlord/requestsTableData';
import type { Stats } from '../../types/landlord';
import TablePagination from '../../components/landlord/TablePagination';
import { paginate } from '../../lib/paginate';
import { selectRequests, type RequestPeriod, type RequestSort } from '../../lib/requestIdentity';
import { useLiveTopic } from '../../hooks/useLiveTopic';
import { D3Page, D3State, D3_FIELD, useD3PageActive } from '../../components/request-detail/d3Presentation';

// Client-side, like the tenants and vendors lists: the page already holds every
// request for its stat tiles and filters, so paging the server would only make
// those counts wrong.
const PAGE_SIZE = 10;

const requestStatuses = [
  { label: 'All', value: '' },
  { label: 'Queued', value: 'queued' },
  { label: 'Approved', value: 'approved' },
  { label: 'Needs approval', value: 'needs_approval' },
  { label: 'Contacting vendor', value: 'contacting_vendor' },
  { label: 'Outreach scheduled', value: 'outreach_scheduled' },
  { label: 'Needs vendor', value: 'needs_vendor' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Appeal pending', value: 'appeal_pending' },
  { label: 'Cancelled', value: 'cancelled' },
];

export default function RequestsPage() {
  const d3 = useD3PageActive();
  useLandlordEntrance();
  // Opening the list IS reading what arrived, so the "new requests" badge
  // clears here. Nothing else about a request is cleared by looking at it —
  // anything needing a decision still surfaces on Decisions Needed.
  useEffect(() => {
    markRequestsSeen();
    // And again on the way out: whatever changed while the list was open was
    // seen here, so it must not badge the tab the moment you leave.
    return () => markRequestsSeen();
  }, []);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // `open` is the tile's filter: every status that isn't finished.
  const status = searchParams.get('status') || '';
  const propertyId = searchParams.get('propertyId') || '';
  const query = searchParams.get('q') || '';
  const sort: RequestSort = ['oldest', 'updated'].includes(searchParams.get('sort') || '') ? searchParams.get('sort') as RequestSort : 'newest';
  const period: RequestPeriod = ['day', 'week', 'month'].includes(searchParams.get('period') || '') ? searchParams.get('period') as RequestPeriod : 'all';
  // In the URL like the filters, so Back from a request returns to the same page.
  const page = Number.parseInt(searchParams.get('page') || '1', 10) || 1;
  const filters = useMemo(() => {
    const next: Record<string, string> = {};
    if (propertyId) next.propertyId = propertyId;
    return next;
  }, [propertyId]);
  // A table of nine columns doesn't fit a phone; it keeps the card list.
  const wide = useMediaQuery('(min-width: 768px)');

  const { requests, loading: requestsLoading, error: requestsError, reload: reloadRequests } =
    useLandlordRequests(filters);
  useLiveTopic('requests', () => void reloadRequests());
  const { properties, loading: propertiesLoading, error: propertiesError } = useLandlordProperties();
  const { vendors, reload: reloadVendors } = useLandlordVendors();
  // Only for "completed this month" and its comparison; the list never waits on it.
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    LandlordAPI.stats()
      .then((response) => setStats((response.data as Stats) || null))
      .catch(() => setStats(null));
  }, []);
  const { openApproveContact, openRejectRequest, assignVendor, completeRequest, dialogs } =
    useRequestActions({
      vendors,
      onAfterMutation: async () => {
        await Promise.all([reloadRequests(), reloadVendors()]);
      },
    });

  const setStatus = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('status', value);
    else next.delete('status');
    // A different filter is a different list: start it from the top.
    next.delete('page');
    setSearchParams(next);
  };

  const setPage = (value: number) => {
    const next = new URLSearchParams(searchParams);
    if (value > 1) next.set('page', String(value));
    else next.delete('page');
    setSearchParams(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const loading = requestsLoading || propertiesLoading;
  const error = requestsError || propertiesError;
  const filteredRequests = useMemo(() => {
    const matchingStatus = status === 'open' ? requests.filter(isOpenRequest)
      : status ? requests.filter((request) => getRequestLifecycleStatus(request) === status) : requests;
    return selectRequests(matchingStatus, { query, sort, period });
  }, [requests, status, query, sort, period]);
  const setListOption = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('page');
    setSearchParams(next, { replace: key === 'q' });
  };
  // paginate clamps, so a page past the end (after a filter or a reject
  // shrinks the list) shows the last page rather than an empty table.
  const paged = paginate(filteredRequests, page, PAGE_SIZE);

  const counts = useMemo(() => {
    const open = requests.filter(isOpenRequest);
    return {
      open: open.length,
      urgent: open.filter((request) => ['high', 'emergency'].includes(request.urgency)).length,
      inProgress: requests.filter((request) => getRequestLifecycleStatus(request) === 'in_progress').length,
      queued: requests.filter((request) => getRequestLifecycleStatus(request) === 'queued').length,
    };
  }, [requests]);

  if (loading) {
    return <D3State><LandlordLoading label="Loading requests..." /></D3State>;
  }

  if (error) {
    return (
      <D3State><LandlordError title="Requests unavailable" message={error} onRetry={() => void reloadRequests()} /></D3State>
    );
  }

  const monthly = stats?.monthly || [];
  const thisMonth = monthly[monthly.length - 1];
  const lastMonth = monthly[monthly.length - 2];
  const completedChange = thisMonth && lastMonth ? percentChange(thisMonth.resolved, lastMonth.resolved) : null;

  return (
    <D3Page>
      <PageHeader title="Maintenance Requests" description="Track, triage, assign, and resolve tenant requests." />

      <StatGrid className="mb-6">
        <StatCard
          wrap={d3}
          icon={FileText}
          tone="blue"
          label="Open requests"
          value={counts.open}
          sub={counts.urgent ? `${counts.urgent} urgent` : 'None urgent'}
          onClick={() => setStatus(status === 'open' ? '' : 'open')}
          active={status === 'open'}
          testId="requests-stat-open"
        />
        <StatCard
          wrap={d3}
          icon={Settings}
          tone="blue"
          label="In progress"
          value={counts.inProgress}
          sub="Vendor on the job"
          onClick={() => setStatus(status === 'in_progress' ? '' : 'in_progress')}
          active={status === 'in_progress'}
          delay={60}
        />
        <StatCard
          wrap={d3}
          icon={Clock}
          tone={counts.queued ? 'amber' : 'blue'}
          label="Awaiting review"
          value={counts.queued}
          sub="Queued, not yet routed"
          onClick={() => setStatus(status === 'queued' ? '' : 'queued')}
          active={status === 'queued'}
          delay={120}
        />
        <StatCard
          wrap={d3}
          icon={CheckCircle2}
          tone="emerald"
          label="Completed this month"
          value={thisMonth?.resolved ?? '—'}
          delta={completedChange === null ? null : { percent: completedChange, upIsGood: true, label: 'from last month' }}
          delay={180}
        />
      </StatGrid>

      <Card className="ll-fade-up mb-5 gap-4 border border-slate-200/70 p-5 shadow-sm lichen:rounded-lg lichen:border-border lichen:shadow-lichen-card">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_1fr_1fr]">
          <label className="space-y-1.5"><FieldLabel className="lichen:text-meta">Search requests</FieldLabel>
            <input className={`${fieldClass} ${D3_FIELD}`} value={query} onChange={event => setListOption('q', event.target.value)} placeholder="Title, reference, property, unit or tenant" data-testid="request-search" />
          </label>
          <label className="space-y-1.5"><FieldLabel className="lichen:text-meta">Sort by</FieldLabel>
            <select className={`${fieldClass} ${D3_FIELD}`} value={sort} onChange={event => setListOption('sort', event.target.value)} data-testid="request-sort">
              <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="updated">Recently updated</option>
            </select>
          </label>
          <label className="space-y-1.5"><FieldLabel className="lichen:text-meta">Submitted</FieldLabel>
            <select className={`${fieldClass} ${D3_FIELD}`} value={period} onChange={event => setListOption('period', event.target.value)} data-testid="request-period">
              <option value="all">Any time</option><option value="day">Last 24 hours</option><option value="week">Last 7 days</option><option value="month">Last 30 days</option>
            </select>
          </label>
        </div>
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="space-y-2">
            <FieldLabel className="lichen:text-meta">Filter by status</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {status === 'open' ? (
                <button
                  type="button"
                  aria-pressed
                  onClick={() => setStatus('')}
                  className="rounded-full border border-transparent bg-[#137fec] px-3.5 py-1.5 text-sm font-medium text-white shadow-sm shadow-[#137fec]/25 lichen:bg-primary lichen:text-primary-foreground lichen:shadow-none"
                >
                  Open ✕
                </button>
              ) : null}
              {requestStatuses.map((option) => {
                const active = status === option.value;
                return (
                  <button
                    key={option.value || 'all'}
                    type="button"
                    aria-pressed={active}
                    data-testid={`filter-${option.value || 'all'}-btn`}
                    onClick={() => setStatus(option.value)}
                    className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition motion-reduce:transition-none lichen:shadow-none ${
                      active
                        ? 'border-transparent bg-[#137fec] text-white shadow-sm shadow-[#137fec]/25 lichen:bg-primary lichen:text-primary-foreground'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-[#137fec]/40 hover:text-[#137fec] lichen:border-border lichen:bg-card lichen:text-meta lichen:hover:border-control-border lichen:hover:bg-well lichen:hover:text-ink'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="w-full space-y-1.5 xl:max-w-xs">
            <FieldLabel className="lichen:text-meta">Property</FieldLabel>
            <select
              data-testid="request-property-filter"
              value={propertyId}
              onChange={(event) => {
                const next = new URLSearchParams(searchParams);
                if (event.target.value) next.set('propertyId', event.target.value);
                else next.delete('propertyId');
                next.delete('page');
                setSearchParams(next);
              }}
              className={`${fieldClass} ${D3_FIELD}`}
            >
              <option value="">All properties</option>
              {properties.map((property) => (
                <option key={property._id} value={property._id}>
                  {property.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <p className="mb-3 text-xs text-slate-500 lichen:text-meta" aria-live="polite">{filteredRequests.length} request{filteredRequests.length === 1 ? '' : 's'} · New marks unopened requests submitted in the last 24 hours on this browser.</p>

      <Card
        className={`ll-fade-up gap-0 border border-slate-200/70 shadow-sm lichen:rounded-lg lichen:border-border lichen:shadow-lichen-card ${wide ? 'overflow-hidden p-0' : 'p-4'}`}
        style={{ animationDelay: '70ms' }}
      >
        {wide ? (
          <RequestsTable
            requests={paged.rows}
            onApproveContact={openApproveContact}
            onReject={openRejectRequest}
            onAssign={(id) => void assignVendor(id)}
            // Pass the record, not just the id, so the dialog can prefill the
            // agreed quote instead of asking for a number from nothing.
            onComplete={(id) => completeRequest(requests.find((r) => r._id === id) || id)}
            onView={(id) => navigate(`/dashboard/requests/${id}`)}
          />
        ) : (
          <RequestTable
            requests={paged.rows}
            onApproveContact={openApproveContact}
            onReject={openRejectRequest}
            onAssign={(id) => void assignVendor(id)}
            onComplete={(id) => completeRequest(requests.find((r) => r._id === id) || id)}
            onView={(id) => navigate(`/dashboard/requests/${id}`)}
            variant="compact"
          />
        )}
        {paged.totalPages > 1 ? (
          <div className={wide ? 'border-t border-slate-100 px-5 py-3 lichen:border-hairline' : 'mt-4 border-t border-slate-100 pt-4 lichen:border-hairline'}>
            <TablePagination
              page={paged.page}
              totalPages={paged.totalPages}
              total={paged.total}
              from={paged.from}
              to={paged.to}
              noun="requests"
              onPageChange={setPage}
              testId="requests-pagination"
            />
          </div>
        ) : null}
      </Card>
      {dialogs}
    </D3Page>
  );
}
