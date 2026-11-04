import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Building2, CalendarDays, ChevronRight, ClipboardCheck, Clock, X } from 'lucide-react';
import PageHeader from '../../components/landlord/PageHeader';
import StatCard, { StatGrid } from '../../components/landlord/StatCard';
import ScheduleCalendar from '../../components/landlord/schedule/ScheduleCalendar';
import { landlordVisitClasses } from '../../components/landlord/schedule/CalendarEvent';
import {
  appointmentPlace,
  appointmentTitle,
  appointmentVendorName,
  matchesFilter,
  needsAttention,
  scheduleStyle,
  type ScheduleFilter,
} from '../../components/landlord/schedule/scheduleStatus';
import { Card } from '../../components/ui/card';
import { cn } from '../../components/ui/utils';
import {
  EmptyState,
  LandlordError,
  LandlordLoading,
  PageContainer,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import { useAppointments } from '../../hooks/useAppointments';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { markScheduleSeen } from '../../hooks/landlord/useLandlordBadges';
import { appointmentRequestId, type AppointmentItem } from '../../types/appointment';
import { isLichenLandlordPath } from '../../lib/lichenRoutes';

// The landlord's four tiles; the tenant page has its own set.
type LandlordFilter = Extract<ScheduleFilter, 'upcoming' | 'awaiting_tenant' | 'sign_off' | 'review'>;

const FILTER_LABELS: Record<LandlordFilter, string> = {
  upcoming: 'Upcoming visits',
  awaiting_tenant: 'Awaiting tenant',
  sign_off: 'Awaiting sign-off',
  review: 'Needs review',
};

// Reclaim only the enlarged rem gutter beyond 16px; keep the full type scale.
const SCHEDULE_PAGE = 'lichen lichen-light lichen-d4-schedule @container/page min-w-0 mx-[min(0px,calc(16px_-_1rem))] w-[calc(100%_+_max(0px,2rem_-_32px))] font-sans text-ink [overflow-wrap:anywhere] [&_:is(button,a)]:focus-visible:outline-solid [&_:is(button,a)]:focus-visible:outline-2 [&_:is(button,a)]:focus-visible:outline-offset-2 [&_:is(button,a)]:focus-visible:outline-ring [&_*]:motion-reduce:animate-none! [&_*]:motion-reduce:transition-none!';
const ATTENTION_COLUMNS = '@min-[56rem]/page:grid-cols-[7.5rem_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,1fr)_8rem_1.5rem]';
const SCHEDULE_ERROR = '[&_[role=alert]]:p-[16px] [&_[role=alert]>div]:min-w-0 [&_[role=alert]>div]:w-full [&_[role=alert]_button]:max-w-full [&_[role=alert]_button]:h-auto [&_[role=alert]_button]:whitespace-normal [&_[role=alert]_button]:py-2';

function whenLabel(a: AppointmentItem) {
  if (!a.confirmedStart) return { day: 'Time to be confirmed', time: a.proposedWindows?.[0] || '' };
  const start = new Date(a.confirmedStart);
  return {
    day: start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    time: start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  };
}

export default function LandlordSchedulePage() {
  useLandlordEntrance();
  // Opening the schedule IS the action available here — this page has no
  // controls to resolve a dispute or re-propose a time, so the badge clears on
  // arrival. Anything that needs deciding is on Decisions Needed regardless.
  useEffect(() => {
    markScheduleSeen();
    // And again on the way out: whatever changed while the schedule was open was
    // seen here, so it must not badge the tab the moment you leave.
    return () => markScheduleSeen();
  }, []);
  const navigate = useNavigate();
  const { appointments, loading, error, reload } = useAppointments('landlord');
  const [filter, setFilter] = useState<LandlordFilter | null>(null);
  // A week of seven columns doesn't fit a phone; it opens on the day instead.
  const wide = useMediaQuery('(min-width: 768px)');
  // Root owns activation. This page consumes the existing authoritative result.
  const presentation = isLichenLandlordPath(useLocation().pathname);
  const withPageScope = (content: ReactNode) => presentation ? <PageContainer className={cn(SCHEDULE_PAGE, SCHEDULE_ERROR)}>{content}</PageContainer> : content;

  const counts = useMemo(
    () => ({
      upcoming: appointments.filter((a) => matchesFilter(a, 'upcoming')).length,
      awaiting_tenant: appointments.filter((a) => matchesFilter(a, 'awaiting_tenant')).length,
      sign_off: appointments.filter((a) => matchesFilter(a, 'sign_off')).length,
      review: appointments.filter((a) => matchesFilter(a, 'review')).length,
    }),
    [appointments]
  );

  const visible = useMemo(() => appointments.filter((a) => matchesFilter(a, filter)), [appointments, filter]);

  // Unscheduled first (they can't be on the calendar at all), then by time.
  const attention = useMemo(
    () =>
      visible.filter(needsAttention).sort((a, b) => {
        const at = a.confirmedStart ? new Date(a.confirmedStart).getTime() : -Infinity;
        const bt = b.confirmedStart ? new Date(b.confirmedStart).getTime() : -Infinity;
        return at - bt;
      }),
    [visible]
  );

  const openRequest = (a: AppointmentItem) => {
    const id = appointmentRequestId(a);
    if (id) navigate(`/dashboard/requests/${id}`);
  };

  const toggle = (next: LandlordFilter) => setFilter((current) => (current === next ? null : next));

  if (loading) return withPageScope(<LandlordLoading label="Loading the schedule..." />);
  if (error) {
    return withPageScope(<LandlordError title="Schedule unavailable" message={error} onRetry={() => void reload()} />);
  }

  return (
    <PageContainer className={presentation ? SCHEDULE_PAGE : undefined}>
      <PageHeader
        title="Schedule"
        description="Track vendor visits and appointment progress across your properties."
      />

      <StatGrid className="mb-6">
        <StatCard
          icon={CalendarDays}
          label={FILTER_LABELS.upcoming}
          value={counts.upcoming}
          sub="Booked times ahead"
          onClick={() => toggle('upcoming')}
          active={filter === 'upcoming'}
          testId="schedule-filter-upcoming"
          wrap={presentation}
          entrance={!presentation}
        />
        <StatCard
          icon={Clock}
          tone={counts.awaiting_tenant ? 'amber' : 'slate'}
          label={FILTER_LABELS.awaiting_tenant}
          value={counts.awaiting_tenant}
          sub="Require tenant action"
          onClick={() => toggle('awaiting_tenant')}
          active={filter === 'awaiting_tenant'}
          delay={60}
          testId="schedule-filter-awaiting_tenant"
          wrap={presentation}
          entrance={!presentation}
        />
        <StatCard
          icon={ClipboardCheck}
          label={FILTER_LABELS.sign_off}
          value={counts.sign_off}
          sub="Work done, pending confirmation"
          onClick={() => toggle('sign_off')}
          active={filter === 'sign_off'}
          delay={120}
          testId="schedule-filter-sign_off"
          wrap={presentation}
          entrance={!presentation}
        />
        <StatCard
          icon={AlertTriangle}
          tone={counts.review ? 'rose' : 'slate'}
          label={FILTER_LABELS.review}
          value={counts.review}
          sub="Disputes and declined times"
          onClick={() => toggle('review')}
          active={filter === 'review'}
          delay={180}
          testId="schedule-filter-review"
          wrap={presentation}
          entrance={!presentation}
        />
      </StatGrid>

      {filter ? (
        <div className={presentation ? 'mb-4 flex min-w-0 flex-wrap items-center gap-2 text-sm text-meta' : 'mb-4 flex items-center gap-2 text-sm text-slate-600'} data-testid="schedule-active-filter">
          Showing <span className={presentation ? 'font-semibold text-ink' : 'font-semibold text-slate-900'}>{FILTER_LABELS[filter]}</span> only.
          <button
            type="button"
            onClick={() => setFilter(null)}
            onClickCapture={presentation ? event => {
              // Clearing removes this control. Return only this user action to
              // its surviving filter tile; never change filter or navigation.
              event.currentTarget.closest('.lichen-d4-schedule')
                ?.querySelector<HTMLElement>(`[data-testid="schedule-filter-${filter}"]`)?.focus();
            } : undefined}
            className={presentation ? 'inline-flex min-h-6 max-w-full items-center gap-1 rounded-full border border-control-border bg-card px-2.5 py-1 text-xs font-medium text-meta hover:text-ink' : 'inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-600 hover:text-slate-900'}
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        </div>
      ) : null}

      <ScheduleCalendar appointments={visible} initialView={wide ? 'week' : 'day'} onOpen={openRequest} landlordPresentation={presentation} />

      <Card className={presentation ? 'mt-6 min-w-0 gap-0 overflow-hidden rounded-lg border border-border p-0 shadow-none' : 'll-fade-up mt-6 gap-0 overflow-hidden border border-slate-200/70 p-0 shadow-sm'}>
        <div className={presentation ? 'px-[min(1rem,16px)] pb-3 pt-4' : 'px-5 pb-3 pt-5'}>
          <h3 className={presentation ? 'text-lg font-semibold text-ink' : 'text-lg font-semibold text-slate-900'}>Needs attention</h3>
          <p className={presentation ? 'mt-1 text-sm leading-6 text-meta' : 'text-sm text-slate-500'}>Visits waiting on someone, or without a time the calendar can show.</p>
        </div>
        {attention.length === 0 ? (
          <div className={presentation ? 'px-[min(1rem,16px)] pb-4' : 'px-5 pb-5'}>
            <EmptyState
              className={presentation ? 'min-w-0 px-[16px] [&_p]:max-w-full' : undefined}
              icon={Clock}
              title={appointments.length ? 'Nothing waiting on anyone' : 'Nothing booked'}
              description={
                appointments.length
                  ? 'Every visit has a confirmed time and no open questions.'
                  : 'Appointments appear as soon as a vendor accepts a job and commits to an arrival time.'
              }
              testId="landlord-schedule-empty"
            />
          </div>
        ) : (
          <div className={presentation ? 'divide-y divide-hairline border-t border-hairline' : 'divide-y divide-slate-100 border-t border-slate-100'} data-testid="schedule-attention">
            <div className={presentation ? `hidden gap-4 px-[min(1rem,16px)] py-2.5 text-xs font-semibold text-meta @min-[56rem]/page:grid ${ATTENTION_COLUMNS}` : 'hidden grid-cols-[9rem_1.3fr_1.2fr_1fr_10rem_1.5rem] gap-4 px-5 py-2.5 text-xs font-semibold text-slate-500 md:grid'}>
              <span>Date &amp; time</span>
              <span>Property</span>
              <span>Issue</span>
              <span>Vendor</span>
              <span>Status</span>
              <span />
            </div>
            {attention.map((a) => {
              const { day, time } = whenLabel(a);
              const { property, unit } = appointmentPlace(a);
              const style = scheduleStyle(a);
              return (
                <button
                  key={a._id}
                  type="button"
                  onClick={() => openRequest(a)}
                  data-testid={`schedule-attention-${a._id}`}
                  className={presentation ? `grid w-full min-w-0 grid-cols-1 items-start gap-x-4 gap-y-2 px-[min(1rem,16px)] py-4 text-left hover:bg-well ${ATTENTION_COLUMNS}` : 'grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-3.5 text-left transition hover:bg-slate-50 md:grid-cols-[9rem_1.3fr_1.2fr_1fr_10rem_1.5rem]'}
                >
                  <span className={presentation ? 'min-w-0 text-sm' : 'text-sm'}>
                    <span className={presentation ? 'font-medium text-ink' : 'font-medium text-slate-800'}>{day}</span>
                    {time ? <span className={presentation ? 'block text-xs text-meta' : 'block text-xs text-slate-500'}>{time}</span> : null}
                  </span>
                  <span className={presentation ? 'flex min-w-0 items-start gap-2.5' : 'flex min-w-0 items-center gap-2.5 max-md:col-span-2 max-md:row-start-2'}>
                    <span className={presentation ? 'hidden h-8 w-8 shrink-0 items-center justify-center rounded-md bg-chip text-chip-icon @min-[56rem]/page:flex' : 'hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 md:flex'}>
                      <Building2 className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className={presentation ? 'block text-sm text-ink [overflow-wrap:anywhere]' : 'block truncate text-sm text-slate-800'}>{property || '—'}</span>
                      {unit ? <span className={presentation ? 'block text-xs text-meta [overflow-wrap:anywhere]' : 'block truncate text-xs text-slate-500'}>{unit}</span> : null}
                    </span>
                  </span>
                  <span className={presentation ? 'min-w-0 text-sm text-ink [overflow-wrap:anywhere]' : 'truncate text-sm text-slate-700 max-md:col-span-2'}>{appointmentTitle(a)}</span>
                  <span className={presentation ? 'min-w-0 text-sm text-meta [overflow-wrap:anywhere]' : 'truncate text-sm text-slate-500 max-md:hidden'}>{appointmentVendorName(a)}</span>
                  <span className={presentation ? 'min-w-0' : 'max-md:col-start-2 max-md:row-start-1'}>
                    <span className={presentation ? cn('inline-block max-w-full rounded-full px-3 py-1 text-xs font-semibold', landlordVisitClasses(a).pill) : cn('inline-block rounded-full px-3 py-1 text-xs font-semibold', style.pill)}>
                      {style.label}
                    </span>
                  </span>
                  <ChevronRight className={presentation ? 'hidden h-4 w-4 text-meta @min-[56rem]/page:block' : 'hidden h-4 w-4 text-slate-300 md:block'} />
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {/* Finished visits are hidden here, not deleted -- see listAppointments. */}
      <p className={presentation ? 'mt-6 text-center text-xs leading-5 text-meta' : 'mt-6 text-center text-xs text-slate-400'} data-testid="schedule-history-note">
        Finished visits leave the schedule. Find them under each request, or in a property&apos;s{' '}
        <Link to="/dashboard/properties" className={presentation ? 'font-medium text-lichen-text underline underline-offset-2' : 'font-medium text-slate-500 underline-offset-2 hover:underline'}>
          history
        </Link>
        .
      </p>
    </PageContainer>
  );
}
