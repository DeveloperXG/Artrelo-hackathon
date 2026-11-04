import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { AppointmentItem } from '../../../types/appointment';
import { Card } from '../../ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../ui/hover-card';
import { cn } from '../../ui/utils';
import { TENANT_PORTAL, useTenantPresentation } from '../../tenant/tenantPresentation';
import { tenantVisitClasses } from '../../tenant/tenantRoles';
import {
  CalendarEventBlock,
  OverflowChip,
  ScheduleAudienceContext,
  timeLabel,
  useScheduleAudience,
  LandlordSchedulePresentationContext,
  useLandlordSchedulePresentation,
  LANDLORD_SCHEDULE_PORTAL,
  landlordVisitClasses,
  VisitSummary,
  landlordPortalStyle,
  useLandlordVisitPreview,
} from './CalendarEvent';
import {
  addDays,
  eventEnd,
  hourRange,
  layoutDay,
  minutesOfDay,
  monthGrid,
  sameDay,
  startOfDay,
  weekDays,
  type CalEvent,
} from './calendarLayout';
import { appointmentPlace, appointmentTitle, scheduleStyle, type ScheduleAudience } from './scheduleStatus';

export type CalendarView = 'day' | 'week' | 'month';

type Placed = { appointment: AppointmentItem; start: Date; end: Date };

const HOUR_PX = 64;
/** Lanes a busy slot may split into before the rest fold into "+N more". */
const MAX_LANES: Record<'day' | 'week', number> = { day: 6, week: 3 };
/** From this many lanes a block drops to time + place, with details on hover. */
const COMPACT_AT: Record<'day' | 'week', number> = { day: 4, week: 2 };
const MONTH_VISIBLE = 3;
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function toPlaced(appointments: AppointmentItem[]): Placed[] {
  return appointments
    .filter((a) => a.confirmedStart)
    .map((a) => {
      const start = new Date(a.confirmedStart as string);
      return { appointment: a, start, end: eventEnd(start, a.confirmedEnd ? new Date(a.confirmedEnd) : null) };
    })
    .filter((p) => !Number.isNaN(p.start.getTime()));
}

function titleFor(view: CalendarView, anchor: Date) {
  if (view === 'day') {
    return anchor.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  }
  if (view === 'month') return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const days = weekDays(anchor);
  const first = days[0];
  const last = days[6];
  const sameMonth = first.getMonth() === last.getMonth();
  const left = first.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const right = last.toLocaleDateString(undefined, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `Week of ${left} – ${right}, ${last.getFullYear()}`;
}

function step(view: CalendarView, anchor: Date, direction: 1 | -1) {
  if (view === 'day') return addDays(anchor, direction);
  if (view === 'week') return addDays(anchor, 7 * direction);
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

/** Week or day: a time grid with visits placed by the lane layout. */
function TimeGrid({
  days,
  events,
  mode,
  onOpen,
}: {
  days: Date[];
  events: Placed[];
  mode: 'day' | 'week';
  onOpen: (a: AppointmentItem) => void;
}) {
  const tenantPresentation = useTenantPresentation();
  const landlordPresentation = useLandlordSchedulePresentation();
  const readable = tenantPresentation || landlordPresentation;
  const byDay = useMemo(
    () => days.map((day) => events.filter((e) => sameDay(e.start, day))),
    [days, events]
  );
  const [fromHour, toHour] = useMemo(
    () => hourRange(byDay.flat().map((e) => ({ id: e.appointment._id, start: e.start, end: e.end }))),
    [byDay]
  );
  const hours = Array.from({ length: toHour - fromHour }, (_, i) => fromHour + i);
  const height = hours.length * HOUR_PX;
  const today = new Date();

  // Re-render once a minute so the "now" line moves.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const yOf = (date: Date) => ((minutesOfDay(date) - fromHour * 60) / 60) * HOUR_PX;
  const columns = `${landlordPresentation ? '64px' : '4rem'} repeat(${days.length}, minmax(${mode === 'week' ? '7.5rem' : '0'}, 1fr))`;

  return (
    <div className="overflow-x-auto" tabIndex={readable ? 0 : undefined} role={readable ? 'region' : undefined} aria-label={readable ? 'Appointment time grid' : undefined}>
      <div className={mode === 'week' ? 'min-w-[60rem]' : ''}>
        {/* Day headings */}
        <div className={cn('grid border-b border-slate-200 in-[.lichen-d5]:border-border', landlordPresentation && 'border-border')} style={{ gridTemplateColumns: columns }}>
          <div />
          {days.map((day) => {
            const isToday = sameDay(day, today);
            return (
              <div key={day.toISOString()} className={cn('border-l border-slate-100 px-2 py-3 text-center in-[.lichen-d5]:border-hairline', landlordPresentation && 'border-hairline')}>
                <div className={cn('text-sm font-semibold', isToday ? 'text-[#137fec] in-[.lichen-d5]:text-lichen-text' : "text-slate-800 in-[.lichen-d5]:text-ink", landlordPresentation && (isToday ? 'text-lichen-text' : 'text-ink'))}>
                  {day.toLocaleDateString(undefined, { weekday: 'short' })}
                </div>
                <div
                  className={cn(
                    'mx-auto mt-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs',
                    isToday ? 'bg-[#137fec] font-semibold text-white in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground' : "text-slate-500 in-[.lichen-d5]:text-meta",
                    landlordPresentation && (isToday ? 'h-auto min-h-6 bg-primary text-primary-foreground' : 'h-auto min-h-6 text-meta')
                  )}
                >
                  {day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Grid */}
        <div className="grid" style={{ gridTemplateColumns: columns }}>
          <div className="relative" style={{ height }}>
            {hours.map((hour) => (
              <div
                key={hour}
                // Labels sit centred on their line, except the first, which
                // would be cut in half by the top edge.
                className={cn(
                  "absolute right-2 whitespace-nowrap text-[11px] text-slate-400 in-[.lichen-d5]:text-meta",
                  hour === fromHour ? 'translate-y-0.5' : '-translate-y-1/2', landlordPresentation && 'font-mono text-meta'
                )}
                style={{ top: (hour - fromHour) * HOUR_PX }}
              >
                {timeLabel(new Date(2000, 0, 1, hour))}
              </div>
            ))}
          </div>

          {days.map((day, index) => {
            const dayEvents = byDay[index];
            const calEvents: CalEvent[] = dayEvents.map((e) => ({ id: e.appointment._id, start: e.start, end: e.end }));
            const { placed, overflow } = layoutDay(calEvents, MAX_LANES[mode]);
            const lookup = new Map(dayEvents.map((e) => [e.appointment._id, e]));
            const isToday = sameDay(day, today);
            const nowY = yOf(today);
            return (
              <div
                key={day.toISOString()}
                className={cn("relative border-l border-slate-100 in-[.lichen-d5]:border-hairline", isToday && 'bg-[#137fec]/[0.02] in-[.lichen-d5]:bg-well', landlordPresentation && 'border-hairline', landlordPresentation && isToday && 'bg-well')}
                style={{ height }}
              >
                {hours.map((hour) => (
                  <div
                    key={hour}
                    className={cn('absolute inset-x-0 border-t border-slate-100 in-[.lichen-d5]:border-hairline', landlordPresentation && 'border-hairline')}
                    style={{ top: (hour - fromHour) * HOUR_PX }}
                  />
                ))}

                {placed.map((p) => {
                  const event = lookup.get(p.id);
                  if (!event) return null;
                  const top = yOf(event.start);
                  const minutes = (event.end.getTime() - event.start.getTime()) / 60_000;
                  return (
                    <CalendarEventBlock
                      key={p.id}
                      appointment={event.appointment}
                      start={event.start}
                      compact={p.lanes >= COMPACT_AT[mode]}
                      onOpen={() => onOpen(event.appointment)}
                      style={{
                        top: top + 1,
                        height: Math.max(30, (minutes / 60) * HOUR_PX - 3),
                        left: `calc(${(p.lane / p.lanes) * 100}% + 3px)`,
                        width: `calc(${100 / p.lanes}% - 6px)`,
                      }}
                    />
                  );
                })}

                {overflow.map((chip) => {
                  const items = chip.ids
                    .map((id) => lookup.get(id))
                    .filter((e): e is Placed => Boolean(e))
                    .map((e) => ({ appointment: e.appointment, start: e.start }));
                  const minutes = (chip.end.getTime() - chip.start.getTime()) / 60_000;
                  return (
                    <OverflowChip
                      key={chip.ids.join('|')}
                      items={items}
                      onOpen={onOpen}
                      style={{
                        top: yOf(chip.start) + 1,
                        height: Math.max(30, (minutes / 60) * HOUR_PX - 3),
                        left: `calc(${(chip.lane / chip.lanes) * 100}% + 3px)`,
                        width: `calc(${100 / chip.lanes}% - 6px)`,
                      }}
                    />
                  );
                })}

                {isToday && nowY >= 0 && nowY <= height ? (
                  <div className="pointer-events-none absolute inset-x-0 z-10" style={{ top: nowY }} aria-hidden>
                    <div className={cn('relative h-px bg-rose-500 in-[.lichen-d5]:bg-alert-text', landlordPresentation && 'bg-alert-text')}>
                      <span className={cn('absolute -left-1 -top-1 h-2 w-2 rounded-full bg-rose-500 in-[.lichen-d5]:bg-alert-text', landlordPresentation && 'bg-alert-text')} />
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Month: a fixed six-week grid, three visits per day before "+N more". */
function MonthGrid({
  anchor,
  events,
  onOpen,
}: {
  anchor: Date;
  events: Placed[];
  onOpen: (a: AppointmentItem) => void;
}) {
  const tenantPresentation = useTenantPresentation();
  const landlordPresentation = useLandlordSchedulePresentation();
  const readable = tenantPresentation || landlordPresentation;
  const cells = monthGrid(anchor);
  const today = new Date();
  return (
    <div className="overflow-x-auto" tabIndex={readable ? 0 : undefined} role={readable ? 'region' : undefined} aria-label={readable ? 'Appointment month grid' : undefined}>
      <div className="min-w-[42rem]">
        <div className={cn('grid grid-cols-7 border-b border-slate-200 in-[.lichen-d5]:border-border', landlordPresentation && 'border-border')}>
          {WEEKDAY_NAMES.map((name) => (
            <div key={name} className={cn('px-2 py-2.5 text-center text-xs font-semibold text-slate-500 in-[.lichen-d5]:text-meta', landlordPresentation && 'text-meta')}>
              {name}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((day) => {
            const inMonth = day.getMonth() === anchor.getMonth();
            const dayEvents = events
              .filter((e) => sameDay(e.start, day))
              .sort((a, b) => a.start.getTime() - b.start.getTime());
            const shown = dayEvents.slice(0, dayEvents.length > MONTH_VISIBLE ? MONTH_VISIBLE - 1 : MONTH_VISIBLE);
            const rest = dayEvents.slice(shown.length);
            return (
              <div
                key={day.toISOString()}
                className={cn("min-h-[7.5rem] border-b border-l border-slate-100 p-1.5 in-[.lichen-d5]:border-hairline", !inMonth && "bg-slate-50/60 in-[.lichen-d5]:bg-well", landlordPresentation && 'border-hairline', landlordPresentation && !inMonth && 'bg-well')}
              >
                <div
                  className={cn(
                    'mb-1 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs',
                    sameDay(day, today)
                      ? 'bg-[#137fec] font-semibold text-white in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground'
                      : inMonth
                        ? "text-slate-700 in-[.lichen-d5]:text-ink"
                        : "text-slate-400 in-[.lichen-d5]:text-meta",
                    landlordPresentation && (sameDay(day, today) ? 'bg-primary text-primary-foreground' : inMonth ? 'text-ink' : 'text-meta')
                  )}
                >
                  {day.getDate()}
                </div>
                <div className="space-y-1">
                  {shown.map((e) => (
                    <MonthPill key={e.appointment._id} event={e} onOpen={onOpen} />
                  ))}
                  {rest.length ? (
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className={cn('w-full rounded-md px-1.5 py-0.5 text-left text-[11px] font-semibold text-slate-500 hover:bg-slate-100 in-[.lichen-d5]:text-meta in-[.lichen-d5]:hover:bg-chip', landlordPresentation && 'min-h-6 text-meta hover:bg-chip')}
                        >
                          +{rest.length} more
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" collisionPadding={landlordPresentation ? 16 : undefined} style={landlordPresentation ? landlordPortalStyle('popover') : undefined} className={cn('w-64 space-y-1 p-2',tenantPresentation && `${TENANT_PORTAL} max-w-[calc(100vw-2rem)] shadow-none`, landlordPresentation && LANDLORD_SCHEDULE_PORTAL)}>
                        {dayEvents.map((e) => (
                          <MonthPill key={e.appointment._id} event={e} onOpen={onOpen} expanded={landlordPresentation} />
                        ))}
                      </PopoverContent>
                    </Popover>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MonthPill({ event, onOpen, expanded = false }: { event: Placed; onOpen: (a: AppointmentItem) => void; expanded?: boolean }) {
  const landlordPresentation = useLandlordSchedulePresentation();
  const preview = useLandlordVisitPreview(landlordPresentation && !expanded, event.appointment._id);
  const style = scheduleStyle(event.appointment, useScheduleAudience());
  const { property, unit } = appointmentPlace(event.appointment);
  // The tenant's appointments carry no property or unit (they only have one
  // home), so their pills name the issue instead.
  const place = [property, unit].filter(Boolean).join(' · ') || appointmentTitle(event.appointment);
  const pill = (
    <button
      {...preview.trigger}
      type="button"
      onClick={() => onOpen(event.appointment)}
      title={`${style.label}`}
      aria-label={landlordPresentation ? `${timeLabel(event.start)}, ${place}: ${appointmentTitle(event.appointment)} — ${style.label}` : undefined}
      data-testid={`schedule-event-${event.appointment._id}`}
      className={cn(
        "flex w-full items-center gap-1 truncate rounded-md border-l-[3px] px-1.5 py-0.5 text-left text-[11px] text-slate-700 in-[.lichen-d5]:text-ink",
        style.block, tenantVisitClasses(event.appointment.status).block,
        landlordPresentation && `${landlordVisitClasses(event.appointment).block} min-h-6 text-ink focus-visible:ring-2 focus-visible:ring-ring`,
        landlordPresentation && expanded && 'block whitespace-normal p-3'
      )}
    >
      {landlordPresentation && expanded ? <VisitSummary appointment={event.appointment} start={event.start} /> : <>
        <span className="shrink-0 font-semibold">{timeLabel(event.start)}</span>
        <span className="truncate">{place}</span>
      </>}
    </button>
  );
  if (!landlordPresentation || expanded) return pill;
  return <HoverCard {...preview.root} openDelay={150} closeDelay={80}>
    <HoverCardTrigger asChild>{pill}</HoverCardTrigger>
    <HoverCardContent {...preview.content} side="bottom" align="start" collisionPadding={16} style={landlordPortalStyle('hover-card')} className={cn('w-64 p-3', LANDLORD_SCHEDULE_PORTAL)}>
      <VisitSummary appointment={event.appointment} start={event.start} />
    </HoverCardContent>
  </HoverCard>;
}

/**
 * Visits on a calendar, for the landlord or the tenant (`audience` changes the
 * status wording, not the layout). Only visits with a confirmed time can be
 * placed; each page lists the rest under the calendar, so nothing is lost by
 * not being drawable.
 */
export default function ScheduleCalendar({
  appointments,
  initialView,
  onOpen,
  audience = 'landlord',
  landlordPresentation = false,
}: {
  appointments: AppointmentItem[];
  initialView: CalendarView;
  onOpen: (a: AppointmentItem) => void;
  audience?: ScheduleAudience;
  landlordPresentation?: boolean;
}) {
  const tenantPresentation = useTenantPresentation();
  const presentation = landlordPresentation && audience === 'landlord' && !tenantPresentation;
  const [view, setView] = useState<CalendarView>(initialView);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const events = useMemo(() => toPlaced(appointments), [appointments]);
  const days = useMemo(() => (view === 'day' ? [anchor] : weekDays(anchor)), [view, anchor]);

  // The breakpoint can change the default after mount (a rotated phone).
  useEffect(() => setView(initialView), [initialView]);

  return (
    <ScheduleAudienceContext.Provider value={audience}>
    <LandlordSchedulePresentationContext.Provider value={presentation}>
    <Card className={cn(!presentation && 'll-fade-up', 'gap-0 overflow-hidden border border-slate-200/70 p-0 shadow-sm in-[.lichen-d5]:border-border in-[.lichen-d5]:shadow-none', presentation && 'lichen-d4-calendar min-w-0 rounded-lg border-border font-sans text-ink shadow-none [&_button]:focus-visible:outline-solid [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-ring [&_*]:motion-reduce:animate-none! [&_*]:motion-reduce:transition-none!')}>
      <div className={cn('flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between in-[.lichen-d5]:border-hairline', presentation && 'flex-wrap border-hairline px-[16px]')}>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setAnchor(startOfDay(new Date()))}
            className={cn('h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card in-[.lichen-d5]:text-ink in-[.lichen-d5]:hover:bg-well', presentation && 'h-auto min-h-9 rounded-md border-control-border bg-card py-1.5 text-ink shadow-none hover:bg-well')}
            data-testid="schedule-today"
          >
            Today
          </button>
          <div className={cn('inline-flex rounded-lg border border-slate-200 bg-white shadow-sm in-[.lichen-d5]:border-border in-[.lichen-d5]:shadow-none in-[.lichen-d5]:bg-card', presentation && 'rounded-md border-control-border bg-card shadow-none')}>
            <button
              type="button"
              aria-label="Previous"
              onClick={() => setAnchor((current) => step(view, current, -1))}
              className={cn('flex h-9 w-9 items-center justify-center rounded-l-lg text-slate-600 transition hover:bg-slate-50 in-[.lichen-d5]:text-meta in-[.lichen-d5]:hover:bg-well', presentation && 'rounded-l-md text-meta hover:bg-well')}
              data-testid="schedule-prev"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Next"
              onClick={() => setAnchor((current) => step(view, current, 1))}
              className={cn('flex h-9 w-9 items-center justify-center rounded-r-lg border-l border-slate-200 text-slate-600 transition hover:bg-slate-50 in-[.lichen-d5]:border-border in-[.lichen-d5]:text-meta in-[.lichen-d5]:hover:bg-well', presentation && 'rounded-r-md border-control-border text-meta hover:bg-well')}
              data-testid="schedule-next"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <h3 className={cn('ml-1 text-base font-semibold text-slate-900 sm:text-lg in-[.lichen-d5]:text-ink', presentation && 'min-w-0 text-ink [overflow-wrap:anywhere]')} data-testid="schedule-range-title">
            {titleFor(view, anchor)}
          </h3>
        </div>
        <div className={cn('inline-flex self-start rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-sm font-medium sm:self-auto in-[.lichen-d5]:max-w-full in-[.lichen-d5]:flex-wrap in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-well', presentation && 'max-w-full flex-wrap rounded-md border-control-border bg-well')}>
          {(['day', 'week', 'month'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
              data-testid={`schedule-view-${option}`}
              className={cn(
                'rounded-md px-4 py-1.5 capitalize transition',
                view === option ? 'bg-[#137fec] text-white shadow-sm in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:shadow-none' : "text-slate-600 hover:text-slate-900 in-[.lichen-d5]:text-meta in-[.lichen-d5]:hover:text-ink",
                presentation && (view === option ? 'bg-primary text-primary-foreground shadow-none underline decoration-current decoration-2 underline-offset-4' : 'text-meta hover:text-ink')
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {view === 'month' ? (
        <MonthGrid anchor={anchor} events={events} onOpen={onOpen} />
      ) : (
        <TimeGrid days={days} events={events} mode={view} onOpen={onOpen} />
      )}
    </Card>
    </LandlordSchedulePresentationContext.Provider>
    </ScheduleAudienceContext.Provider>
  );
}
