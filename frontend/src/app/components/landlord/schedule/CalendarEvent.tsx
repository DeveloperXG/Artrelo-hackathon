import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AppointmentItem } from '../../../types/appointment';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { cn } from '../../ui/utils';
import { TENANT_PORTAL, useTenantPresentation } from '../../tenant/tenantPresentation';
import { tenantVisitClasses } from '../../tenant/tenantRoles';
import {
  appointmentPlace,
  appointmentTitle,
  appointmentVendorName,
  scheduleStyle,
  scheduleState,
  type ScheduleAudience,
} from './scheduleStatus';

export const timeLabel = (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * Whose calendar this is. ScheduleCalendar sets it once; every block, pill and
 * "+N more" list reads it, so the tenant's calendar says "Confirm the time"
 * where the landlord's says "Awaiting tenant".
 */
export const ScheduleAudienceContext = createContext<ScheduleAudience>('landlord');
// Presentation only. The caller's role and route guards remain authoritative.
export const LandlordSchedulePresentationContext = createContext(false);
export function useLandlordSchedulePresentation() {
  return useContext(LandlordSchedulePresentationContext);
}

export const LANDLORD_SCHEDULE_PORTAL = 'lichen lichen-light lichen-d4-calendar font-sans text-ink border-border rounded-lg shadow-none [overflow-wrap:anywhere] max-w-[calc(100vw-32px)] max-h-[calc(100dvh-32px)] overflow-y-auto focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:animate-none! motion-reduce:transition-none! [&_*]:motion-reduce:animate-none! [&_*]:motion-reduce:transition-none! [&_button]:focus-visible:outline-solid [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-offset-2 [&_button]:focus-visible:outline-ring';

// Radix reports the space at the actual placement after collision padding.
// Viewport-only caps can still put a tall summary above its available edge.
export function landlordPortalStyle(kind: 'popover' | 'hover-card'): CSSProperties {
  return {
    maxWidth: `min(calc(100vw - 32px), var(--radix-${kind}-content-available-width, calc(100vw - 32px)))`,
    maxHeight: `min(calc(100dvh - 32px), var(--radix-${kind}-content-available-height, calc(100dvh - 32px)))`,
  };
}

/** Local preview focus only; Enter/Space/click still belong to request navigation. */
export class LandlordVisitPreviewFocus {
  trigger: HTMLButtonElement | null = null;
  content: HTMLDivElement | null = null;
  private keyboard = false;
  private pendingFocus = false;
  private suppressReturnOpen = false;
  private returningFrom: EventTarget | null = null;
  private disposed = false;
  constructor(private readonly change: (open: boolean) => void) {}
  mount = () => { this.disposed = false; };
  dispose = () => { this.disposed = true; this.pendingFocus = false; this.keyboard = false; this.suppressReturnOpen = false; this.returningFrom = null; };
  setTrigger = (node: HTMLButtonElement | null) => { this.trigger = node; };
  setContent = (node: HTMLDivElement | null) => {
    this.content = node;
    if (node && this.pendingFocus && !this.disposed) {
      this.pendingFocus = false;
      node.focus({ preventScroll: true });
    }
  };
  onOpenChange = (open: boolean) => {
    if (this.disposed) return;
    if (open && this.suppressReturnOpen) { this.suppressReturnOpen = false; this.returningFrom = null; return; }
    if (!open && this.keyboard && this.content?.contains(document.activeElement)) return;
    this.change(open);
  };
  onPointerEnter = () => { this.suppressReturnOpen = false; this.returningFrom = null; };
  onTriggerFocus = (event: ReactFocusEvent<HTMLButtonElement>) => {
    if (event.relatedTarget !== this.returningFrom) this.onPointerEnter();
  };
  onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (this.disposed || event.defaultPrevented || event.key !== 'ArrowDown' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    this.onPointerEnter();
    this.keyboard = true;
    this.pendingFocus = !this.content;
    this.change(true);
    this.content?.focus({ preventScroll: true });
  };
  onEscapeKeyDown = (event: KeyboardEvent) => {
    if (this.disposed) return;
    event.preventDefault();
    const restore = this.keyboard && this.content?.contains(document.activeElement);
    this.keyboard = false;
    this.pendingFocus = false;
    this.change(false);
    if (restore && this.trigger) {
      this.suppressReturnOpen = true;
      this.returningFrom = this.content;
      this.trigger.focus({ preventScroll: true });
    }
  };
  onContentBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (this.disposed || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    this.keyboard = false;
    this.pendingFocus = false;
    if (event.relatedTarget === this.trigger) { this.suppressReturnOpen = true; this.returningFrom = event.currentTarget; }
    this.change(false);
  };
}

export function useLandlordVisitPreview(active: boolean, appointmentId: string) {
  const [open, setOpen] = useState(false);
  const focus = useRef<LandlordVisitPreviewFocus | null>(null);
  if (!focus.current) focus.current = new LandlordVisitPreviewFocus(setOpen);
  const controller = focus.current;
  useEffect(() => { controller.mount(); return controller.dispose; }, [controller]);
  const id = `landlord-schedule-details-${appointmentId}`;
  return {
    root: active ? { open, onOpenChange: controller.onOpenChange } : {},
    trigger: active ? {
      ref: controller.setTrigger, onKeyDown: controller.onTriggerKeyDown,
      onFocus: controller.onTriggerFocus, onPointerEnter: controller.onPointerEnter,
      'aria-description': 'Arrow Down opens visit details; Enter or Space opens the request.',
      'aria-keyshortcuts': 'ArrowDown', 'aria-controls': open ? id : undefined, 'aria-expanded': open,
    } : {},
    content: active ? {
      id, ref: controller.setContent, tabIndex: -1, role: 'region' as const,
      'aria-label': 'Visit details', onBlur: controller.onContentBlur,
      onEscapeKeyDown: controller.onEscapeKeyDown,
    } : {},
  };
}

/** Paint only; canonical state, wording and date decisions stay in scheduleStatus. */
export function landlordVisitClasses(appointment: AppointmentItem) {
  const state = scheduleState(appointment);
  if (state === 'scheduled' || state === 'completed') return {
    block: 'border-mist-text bg-mist-tint', dot: 'bg-mist-text',
    pill: state === 'completed' ? 'bg-pill-neutral text-chip-icon' : 'bg-mist-tint text-mist-text',
  };
  if (['in_review', 'disputed', 'failed'].includes(state)) return {
    block: 'border-alert-text bg-alert-tint', dot: 'bg-alert-text', pill: 'bg-alert-tint text-alert-text',
  };
  if (['awaiting_tenant', 'awaiting_vendor', 'work_verifying', 'needs_new_time'].includes(state)) return {
    block: 'border-lichen-text bg-lichen-tint', dot: 'bg-lichen-text', pill: 'bg-lichen-tint text-lichen-text',
  };
  return { block: 'border-control-border bg-well', dot: 'bg-chip-icon', pill: 'bg-pill-neutral text-chip-icon' };
}

export function useScheduleAudience() {
  return useContext(ScheduleAudienceContext);
}

function placeLine(a: AppointmentItem) {
  const { property, unit } = appointmentPlace(a);
  return [property, unit].filter(Boolean).join(' · ');
}

/** Everything about one visit, for a hover card or a "+N more" list. */
export function VisitSummary({ appointment, start }: { appointment: AppointmentItem; start: Date }) {
  const landlordPresentation = useLandlordSchedulePresentation();
  const style = scheduleStyle(appointment, useScheduleAudience());
  const roles = landlordVisitClasses(appointment);
  return (
    <div className="min-w-0 text-left">
      <div className={cn('text-xs font-semibold text-slate-500 in-[.lichen-d5]:text-meta', landlordPresentation && 'font-mono text-meta')}>{timeLabel(start)}</div>
      <div className={cn('truncate text-sm font-semibold text-slate-900 in-[.lichen-d5]:text-ink in-[.lichen-d5]:whitespace-normal', landlordPresentation && 'whitespace-normal text-ink')}>{placeLine(appointment) || 'Visit'}</div>
      <div className={cn('truncate text-sm text-slate-700 in-[.lichen-d5]:text-ink in-[.lichen-d5]:whitespace-normal', landlordPresentation && 'whitespace-normal text-ink')}>{appointmentTitle(appointment)}</div>
      <div className={cn('truncate text-xs text-slate-500 in-[.lichen-d5]:text-meta in-[.lichen-d5]:whitespace-normal', landlordPresentation && 'whitespace-normal text-meta')}>{appointmentVendorName(appointment)}</div>
      <span className={cn('mt-1.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold', style.pill, tenantVisitClasses(appointment.status).pill, landlordPresentation && `${roles.pill} max-w-full whitespace-normal text-xs [overflow-wrap:anywhere]`)}>
        {style.label}
      </span>
    </div>
  );
}

/**
 * One visit on the time grid.
 *
 * At full width it shows the lot — time, property · unit, issue, vendor,
 * status. When it shares its slot with others (`compact`) there is room only
 * for the time and the place, with the status carried by the left rule's
 * colour; hovering or focusing shows the rest, and clicking still opens the
 * request.
 */
export function CalendarEventBlock({
  appointment,
  start,
  compact,
  style,
  onOpen,
}: {
  appointment: AppointmentItem;
  start: Date;
  compact: boolean;
  style: CSSProperties;
  onOpen: () => void;
}) {
  const tenantPresentation = useTenantPresentation();
  const landlordPresentation = useLandlordSchedulePresentation();
  const roles = landlordVisitClasses(appointment);
  const preview = useLandlordVisitPreview(landlordPresentation, appointment._id);
  const visual = scheduleStyle(appointment, useScheduleAudience());
  const place = placeLine(appointment);
  // A tenant's visits carry no place (they only have one home), so the label
  // leads with the issue rather than a placeholder.
  const label = `${timeLabel(start)}, ${place ? `${place}: ` : ''}${appointmentTitle(appointment)} — ${visual.label}`;

  const block = (
    <button
      {...preview.trigger}
      type="button"
      onClick={onOpen}
      aria-label={label}
      data-testid={`schedule-event-${appointment._id}`}
      style={style}
      className={cn(
        'absolute overflow-hidden rounded-lg border-l-[3px] px-2 py-1.5 text-left shadow-sm ring-1 ring-black/[0.04] transition hover:z-20 hover:shadow-md focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]',
        visual.block, tenantVisitClasses(appointment.status).block, 'in-[.lichen-d5]:rounded-md in-[.lichen-d5]:shadow-none in-[.lichen-d5]:hover:shadow-none',
        landlordPresentation && `${roles.block} rounded-md shadow-none ring-0 hover:shadow-none focus-visible:ring-ring motion-reduce:transition-none`
      )}
    >
      <div className={cn('flex items-center gap-1 text-[11px] font-semibold text-slate-700 in-[.lichen-d5]:text-ink', landlordPresentation && 'font-mono text-ink')}>
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', visual.dot, tenantVisitClasses(appointment.status).dot, landlordPresentation && roles.dot)} />
        <span className="truncate">{timeLabel(start)}</span>
      </div>
      <div className={cn('truncate text-xs font-semibold text-slate-900 in-[.lichen-d5]:text-ink', landlordPresentation && 'text-ink')}>{place || appointmentTitle(appointment)}</div>
      {compact ? null : (
        <>
          {place ? <div className={cn('truncate text-xs text-slate-700 in-[.lichen-d5]:text-ink', landlordPresentation && 'text-ink')}>{appointmentTitle(appointment)}</div> : null}
          <div className={cn('truncate text-[11px] text-slate-500 in-[.lichen-d5]:text-meta', landlordPresentation && 'text-meta')}>{appointmentVendorName(appointment)}</div>
          <span className={cn('mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold', visual.pill, tenantVisitClasses(appointment.status).pill, landlordPresentation && roles.pill)}>
            {visual.label}
          </span>
        </>
      )}
    </button>
  );

  if (!compact && !landlordPresentation) return block;
  return (
    <HoverCard {...preview.root} openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>{block}</HoverCardTrigger>
      <HoverCardContent {...preview.content} side={landlordPresentation ? 'bottom' : 'right'} align="start" collisionPadding={landlordPresentation ? 16 : undefined} style={landlordPresentation ? landlordPortalStyle('hover-card') : undefined} className={cn('w-64 p-3',tenantPresentation && `${TENANT_PORTAL} max-w-[calc(100vw-2rem)] shadow-none`, landlordPresentation && LANDLORD_SCHEDULE_PORTAL)}>
        <VisitSummary appointment={appointment} start={start} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** "+N more": the visits a busy slot had no lane left for, listed in full. */
export function OverflowChip({
  items,
  style,
  onOpen,
}: {
  items: { appointment: AppointmentItem; start: Date }[];
  style: CSSProperties;
  onOpen: (appointment: AppointmentItem) => void;
}) {
  const tenantPresentation = useTenantPresentation();
  const landlordPresentation = useLandlordSchedulePresentation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          style={style}
          data-testid="schedule-overflow"
          className={cn('absolute flex items-start justify-center rounded-lg border border-dashed border-slate-300 bg-white/90 px-1 py-1.5 text-[11px] font-semibold text-slate-600 shadow-sm transition hover:border-[#137fec]/40 hover:text-[#137fec] in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-card in-[.lichen-d5]:text-meta in-[.lichen-d5]:hover:border-control-border in-[.lichen-d5]:hover:text-ink in-[.lichen-d5]:shadow-none', landlordPresentation && 'block rounded-md border-control-border bg-card px-0 py-0 text-center leading-[12px] whitespace-normal [overflow-wrap:normal] text-meta shadow-none hover:border-lichen-text hover:text-ink focus-visible:ring-2 focus-visible:ring-ring')}
        >
          +{items.length} more
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={landlordPresentation ? 16 : undefined} style={landlordPresentation ? landlordPortalStyle('popover') : undefined} className={cn('w-72 p-2',tenantPresentation && `${TENANT_PORTAL} max-w-[calc(100vw-2rem)] shadow-none`, landlordPresentation && `${LANDLORD_SCHEDULE_PORTAL} flex flex-col gap-2`)}>
        <div className={cn('px-2 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400 in-[.lichen-d5]:text-meta', landlordPresentation && 'text-meta')}>
          {items.length} visits in this slot
        </div>
        <ul className={cn('max-h-80 space-y-1 overflow-y-auto', landlordPresentation && 'min-h-0 max-h-none flex-1')}>
          {items.map(({ appointment, start }) => (
            <li key={appointment._id}>
              <button
                type="button"
                onClick={() => onOpen(appointment)}
                className={cn(
                  'w-full rounded-lg border-l-[3px] px-3 py-2 transition hover:brightness-[0.97]',
                  scheduleStyle(appointment).block, tenantVisitClasses(appointment.status).block,
                  landlordPresentation && `${landlordVisitClasses(appointment).block} rounded-md text-left hover:brightness-100 hover:outline hover:outline-1 hover:outline-control-border`
                )}
              >
                <VisitSummary appointment={appointment} start={start} />
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
