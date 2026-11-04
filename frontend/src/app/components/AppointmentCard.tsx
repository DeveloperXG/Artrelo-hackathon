import {
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Clock,
  MapPin,
  Star,
  User,
  Wrench,
} from 'lucide-react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { tenantVisitClasses } from './tenant/tenantRoles';
import {
  APPOINTMENT_STATUS_COLORS,
  APPOINTMENT_STATUS_LABELS,
  appointmentTitle,
  appointmentVendor,
  formatAppointmentWhen,
  isAwaitingOutcome,
  needsTenantScheduleAnswer,
  isArrivalPassed,
  type AppointmentItem,
} from '../types/appointment';

/** Response-deadline copy. Silence leads to automatic resolution only when the
 * verification checks allow it; otherwise the manager reviews. No payment
 * outcome is implied either way. */
export function tenantDeadlineCopy(deadline: string, audience: 'tenant' | 'landlord' = 'tenant') {
  const date = new Date(deadline);
  if (!Number.isFinite(date.getTime())) return '';
  const when = date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  return audience === 'tenant'
    ? `Please respond by ${when}. If you do not respond, the repair may be resolved automatically when verification checks allow; otherwise your manager will review it.`
    : `The tenant is asked to respond by ${when}. If they do not, the repair may be resolved automatically when verification checks allow; otherwise it comes to you for review.`;
}

/**
 * One appointment, shared by the landlord and tenant schedule pages.
 *
 * The headline is always the precise arrival time — that is the thing all three
 * parties coordinate on. The original window label is demoted to context.
 */
export default function AppointmentCard({
  appointment,
  audience,
  busy = false,
  rating,
  onConfirm,
  onDecline,
  onVerify,
  onDispute,
  onRatingChange,
  onOpenRequest,
  onReportNoShow,
  hideCompletionDispute = false,
}: {
  appointment: AppointmentItem;
  audience: 'landlord' | 'tenant';
  busy?: boolean;
  /** Currently selected star rating, owned by the page. */
  rating?: number | null;
  onConfirm?: () => void;
  onDecline?: () => void;
  onVerify?: () => void;
  onDispute?: () => void;
  onRatingChange?: (value: number) => void;
  onOpenRequest?: () => void;
  /** Tenant only: "the vendor never came". Shown when the server allows it. */
  onReportNoShow?: () => void;
  /** Trusted judge-tenant presentation only; ordinary dispute handling stays intact. */
  hideCompletionDispute?: boolean;
}) {
  const vendor = appointmentVendor(appointment);
  // Shared with the tenant badge query rather than re-tested here. This used to
  // check `awaiting_tenant` alone, so a `proposed` appointment — the state a
  // manually proposed one is BORN in, and one the server happily accepts a
  // confirmation for — rendered with no buttons at all. The tenant was being
  // asked about their own access with nothing to click, and the badge counting
  // it could never clear.
  const needsTenantAction = needsTenantScheduleAnswer(appointment);
  const completion = appointment.completion || null;
  // The landlord sees the same panel read-only, so they can tell at a glance
  // what the tenant is being asked and what the vendor actually submitted.
  const showVerification = isAwaitingOutcome(appointment) || Boolean(completion?.confirmation);
  const statusLabel = APPOINTMENT_STATUS_LABELS[appointment.status] || appointment.status;
  const statusColor = APPOINTMENT_STATUS_COLORS[appointment.status] || 'bg-slate-100 text-slate-700';
  const windowLabel = appointment.proposedWindows?.[0];
  const CompletionHeading = audience === 'tenant' ? 'h4' : 'div';
  const photoLinks = completion?.photos?.map((photo) => (
    <a
      key={photo.url}
      href={photo.url}
      target="_blank"
      rel="noreferrer"
      className={'block h-16 w-16 overflow-hidden rounded-lg border border-slate-200 bg-white in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card' + (audience === 'tenant' ? ' max-w-full' : '')}
    >
      <img src={photo.url} alt={photo.label || 'Completed work'} className="h-full w-full object-cover" loading="lazy" />
    </a>
  ));

  return (
    <article
      className={`rounded-xl border bg-white p-5 shadow-sm transition in-[.lichen-d5]:min-w-0 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-card in-[.lichen-d5]:shadow-none in-[.lichen-d5]:[overflow-wrap:anywhere] ${
        needsTenantAction ? 'border-amber-200 in-[.lichen-d5]:border-lichen-line' : "border-slate-200 in-[.lichen-d5]:border-border"
      }`}
      data-testid={`appointment-${appointment._id}`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900 in-[.lichen-d5]:text-ink">
              {appointmentTitle(appointment)}
            </h3>
            <Badge className={`border-transparent ${statusColor} ${tenantVisitClasses(appointment.status).pill}`}>{statusLabel}</Badge>
          </div>

          <div className="mt-2 flex items-center gap-1.5 text-sm font-medium text-slate-900 in-[.lichen-d5]:text-ink">
            <CalendarClock className="h-4 w-4 shrink-0 text-[#137fec] in-[.lichen-d5]:text-chip-icon" aria-hidden="true" />
            <span data-testid="appointment-when">{formatAppointmentWhen(appointment)}</span>
          </div>

          {windowLabel && appointment.confirmedStart ? (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-400 in-[.lichen-d5]:text-meta">
              <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {/* The offer window is history: a confirmed change can move the visit outside it. */}
              Originally offered in the {windowLabel} window
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 in-[.lichen-d5]:text-meta">
            {vendor?.name ? (
              <span className="flex items-center gap-1.5">
                <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
                {vendor.name}
              </span>
            ) : null}
            {/* The tenant-facing contact is `in_app` and carries no phone (see
                RelayContact) — so this renders the LABEL, which tells the tenant
                to message in the request thread. The `phone` branch is kept for
                the vendor-facing `relay` shape; rendering a proxy number to a
                tenant would hand them a line that drops their messages. */}
            {audience === 'tenant' && appointment.vendorContact?.available ? (
              <span className="flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" aria-hidden="true" />
                {appointment.vendorContact.channel === 'in_app'
                  ? appointment.vendorContact.label
                  : appointment.vendorContact.phone}
              </span>
            ) : null}
            {audience === 'landlord' && appointment.tenantConfirmation?.accepted ? (
              <span className="flex items-center gap-1.5 text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                Tenant confirmed
              </span>
            ) : null}
          </div>

          {appointment.accessNotes ? (
            <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 in-[.lichen-d5]:bg-well in-[.lichen-d5]:text-meta">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {appointment.accessNotes}
            </div>
          ) : null}

          {appointment.status === 'proposed' && appointment.tenantConfirmation?.note ? (
            <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-lichen-text">
              Tenant couldn&rsquo;t make it: &ldquo;{appointment.tenantConfirmation.note}&rdquo;
            </div>
          ) : null}

          {appointment.noShowReport?.status === 'reported' ? (
            <div
              className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-800 in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text"
              data-testid={`appointment-no-show-reported-${appointment._id}`}
            >
              {audience === 'tenant'
                ? 'You reported that the vendor didn’t arrive. Your property manager will follow up.'
                : 'The tenant reported that the vendor didn’t arrive.'}
            </div>
          ) : null}

          {completion && showVerification ? (
            <div
              className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-4 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-lichen-line in-[.lichen-d5]:bg-lichen-tint"
              data-testid={`appointment-completion-${appointment._id}`}
            >
              <CompletionHeading className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 in-[.lichen-d5]:text-ink">
                <ClipboardCheck className="h-4 w-4 shrink-0 text-[#137fec] in-[.lichen-d5]:text-chip-icon" aria-hidden="true" />
                {audience === 'tenant' ? 'Was this fixed?' : 'Awaiting tenant confirmation'}
              </CompletionHeading>

              {completion.workPerformed ? (
                audience === 'tenant' ? <section aria-label="Work notes" className="mt-3 min-w-0 border-t border-slate-200 pt-3 in-[.lichen-d5]:border-hairline">
                  <h5 className="text-sm font-semibold text-slate-900 in-[.lichen-d5]:text-ink">Work notes</h5>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700 in-[.lichen-d5]:text-ink">{completion.workPerformed}</p>
                </section> : <p className="mt-2 text-sm leading-6 text-slate-700 in-[.lichen-d5]:text-ink">{completion.workPerformed}</p>
              ) : null}

              {/* Projected to the tenant all along but never rendered. It matters
                  now: the tenant's judgement is the only one this job gets, so
                  everything the vendor told us has to reach them. */}
              {completion.partsUsed ? (
                <p className="mt-1 text-sm leading-6 text-slate-500 in-[.lichen-d5]:text-meta">
                  Parts used: {completion.partsUsed}
                </p>
              ) : null}

              {completion.photos?.length ? (
                <div className={audience === 'tenant' ? 'mt-3 min-w-0 border-t border-slate-200 pt-3 in-[.lichen-d5]:border-hairline' : 'mt-3 flex flex-wrap gap-2'}>
                  {audience === 'tenant' && <h5 className="mb-2 text-sm font-semibold text-slate-900 in-[.lichen-d5]:text-ink">Photos supplied</h5>}
                  {audience === 'tenant' ? <div className="flex min-w-0 flex-wrap gap-2">{photoLinks}</div> : photoLinks}
                </div>
              ) : null}

              {completion.followUpNeeded ? (
                <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs text-slate-600 in-[.lichen-d5]:bg-card in-[.lichen-d5]:text-meta">
                  Follow-up needed: {completion.followUpNotes || 'the vendor flagged more work.'}
                </p>
              ) : null}

              {/* The deadline is announced, never a surprise. Silence does not
                  always close the repair: automatic resolution needs the
                  verification checks to allow it, which the tenant view does not
                  expose, so the copy names both outcomes. */}
              {completion.autoConfirmAt && completion.needsVerification ? (
                <p className="mt-3 text-xs text-slate-600 in-[.lichen-d5]:text-meta" data-testid="appointment-response-deadline">
                  {tenantDeadlineCopy(completion.autoConfirmAt, audience)}
                </p>
              ) : null}

              {audience === 'tenant' && completion.needsVerification ? (
                <div className="mt-4">
                  <div className="flex items-center gap-1 in-[.lichen-d5]:flex-wrap" role="group" aria-label="Rate this job">
                    {[1, 2, 3, 4, 5].map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => onRatingChange?.(value)}
                        aria-label={`${value} star${value > 1 ? 's' : ''}`}
                        aria-pressed={rating === value}
                        className="rounded p-0.5 transition hover:scale-110 in-[.lichen-d5]:flex in-[.lichen-d5]:min-h-[40px] in-[.lichen-d5]:min-w-[40px] in-[.lichen-d5]:items-center in-[.lichen-d5]:justify-center in-[.lichen-d5]:hover:scale-100"
                        data-testid={`appointment-rate-${value}`}
                      >
                        <Star
                          className={`h-5 w-5 in-[.lichen-d5]:h-[20px] in-[.lichen-d5]:w-[20px] ${
                            rating && value <= rating
                              ? 'fill-amber-400 text-amber-400 in-[.lichen-d5]:fill-lichen-icon in-[.lichen-d5]:text-lichen-icon'
                              : "text-slate-300 in-[.lichen-d5]:text-meta"
                          }`}
                          aria-hidden="true"
                        />
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      onClick={onVerify}
                      disabled={busy}
                      className="gap-1.5 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90"
                      data-testid={`appointment-verify-${appointment._id}`}
                    >
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      Yes, it&rsquo;s fixed
                    </Button>
                    {!hideCompletionDispute ? <Button
                      variant="outline"
                      onClick={onDispute}
                      disabled={busy}
                      className="border-rose-200 text-rose-700 hover:bg-rose-50 in-[.lichen-d5]:border-alert-text in-[.lichen-d5]:text-alert-text in-[.lichen-d5]:hover:bg-alert-tint"
                      data-testid={`appointment-dispute-${appointment._id}`}
                    >
                      No, still broken
                    </Button> : null}
                  </div>
                </div>
              ) : null}

              {completion.confirmation ? (
                <p className="mt-3 text-xs text-slate-500 in-[.lichen-d5]:text-meta">
                  {completion.confirmation.autoConfirmed
                    ? 'Automatically confirmed after the review window.'
                    : `Confirmed by the tenant${
                        completion.confirmation.rating
                          ? ` · ${completion.confirmation.rating}/5`
                          : ''
                      }.`}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          {audience === 'tenant' && needsTenantAction && isArrivalPassed(appointment) ? (
            // The time went by before anyone confirmed it. Confirming would
            // book the past (the server refuses); the manager re-arranges it.
            <p className="max-w-[16rem] text-xs leading-5 text-slate-500 sm:text-right in-[.lichen-d5]:text-meta" data-testid={`appointment-passed-${appointment._id}`}>
              This time has passed without being confirmed. Your property manager will arrange a new visit.
            </p>
          ) : audience === 'tenant' && needsTenantAction ? (
            <>
              <Button
                onClick={onConfirm}
                disabled={busy}
                className="gap-1.5 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90"
                data-testid={`appointment-confirm-${appointment._id}`}
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                This works
              </Button>
              <Button
                variant="outline"
                onClick={onDecline}
                disabled={busy}
                className="border-slate-200 text-slate-600 in-[.lichen-d5]:border-border in-[.lichen-d5]:text-meta"
                data-testid={`appointment-decline-${appointment._id}`}
              >
                Request another time
              </Button>
            </>
          ) : null}

          {audience === 'tenant' && appointment.canReportNoShow && onReportNoShow ? (
            <Button
              variant="outline"
              onClick={onReportNoShow}
              disabled={busy}
              className="border-rose-200 text-rose-700 hover:bg-rose-50 in-[.lichen-d5]:border-alert-text in-[.lichen-d5]:text-alert-text in-[.lichen-d5]:hover:bg-alert-tint"
              data-testid={`appointment-report-no-show-${appointment._id}`}
            >
              Vendor didn&rsquo;t arrive
            </Button>
          ) : null}

          {onOpenRequest ? (
            <Button
              variant="ghost"
              onClick={onOpenRequest}
              className="gap-1 text-slate-500 hover:text-[#137fec] in-[.lichen-d5]:text-meta in-[.lichen-d5]:hover:text-ink"
            >
              View request
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
