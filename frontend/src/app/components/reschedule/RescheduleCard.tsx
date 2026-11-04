import { useId, type ReactNode } from 'react';
import { HackathonBadge } from '../judge/JudgeBadges';
import type { RescheduleView } from '../../types/booking';
import { Button } from '../ui/button';
import {
  ACTOR_LABEL, CUTOFF_COPY, RESPONSE_LABEL, STATUS_LABEL, deliveryLabel, eventLabel, formatInstant, formatSlot, type Audience,
} from './rescheduleModel';
import { changeHintClass, wrapButtonClass } from './rescheduleUi';

export type ChangeAction = 'accept' | 'keep_original' | 'decline' | 'withdraw';

const AUDIENCE_LABEL = { landlord: 'Property manager', tenant: 'Tenant', vendor: 'Vendor' } as const;

/** One visit-change request. The original visit is listed first and called
 * booked, because until the server reports `committed` it is the real visit. */
export default function RescheduleCard({ change, audience, busy = false, onAct, children, compact = false }: {
  change: RescheduleView; audience: Audience; busy?: boolean; onAct?: (action: ChangeAction) => void;
  children?: ReactNode; compact?: boolean;
}) {
  const headingId = useId();
  const tenant = audience === 'tenant';
  const committed = change.status === 'committed';
  const canAnswer = audience === 'tenant' && change.canTenantRespond && !!change.proposed && !!change.slotKey;
  return <section aria-labelledby={headingId} className={'min-w-0 rounded-lg border border-slate-300 bg-white p-4 in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-card in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-card' + (tenant ? ' [overflow-wrap:anywhere]' : '')}
    data-testid={change.active ? 'visit-change-active' : 'visit-change-past'} data-status={change.status}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 id={headingId} className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink"><span>{change.active ? 'Visit change request' : 'Earlier change request'}</span><HackathonBadge /></h3>
      <p className="text-sm font-medium text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink" data-testid="visit-change-status">{STATUS_LABEL[change.status]}</p>
    </div>
    <div className="mt-3">
      <p className="text-sm font-medium text-slate-800 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">Reason from the property manager</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink" data-testid="visit-change-reason">{change.reason}</p>
    </div>
    {tenant && <h4 className="mt-4 border-t border-slate-200 pt-4 text-sm font-semibold text-slate-900 in-[.lichen-d5]:border-hairline in-[.lichen-d5]:text-ink">Visit times</h4>}
    <dl aria-label={tenant ? 'Visit times' : undefined} className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
      <div className="min-w-0 rounded-md border border-slate-200 p-3 in-[.lichen-d3]:border-border in-[.lichen-d5]:border-border">
        <dt className="font-medium text-slate-800 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">{committed ? 'Previous visit' : change.active ? 'Booked visit (unchanged for now)' : 'Visit at the time'}</dt>
        <dd className="mt-1 break-words text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink" data-testid="visit-change-original">{formatSlot(change.original)}</dd>
      </div>
      <div className="min-w-0 rounded-md border border-slate-200 p-3 in-[.lichen-d3]:border-border in-[.lichen-d5]:border-border">
        <dt className="font-medium text-slate-800 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">{committed ? 'New visit' : 'Proposed new time'}</dt>
        <dd className="mt-1 break-words text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink" data-testid="visit-change-proposed">{change.proposed ? formatSlot(change.proposed) : 'No new time proposed yet'}</dd>
        {change.proposed && change.outsideSuggestedWindows && <dd className="mt-1 text-xs font-medium text-amber-900 in-[.lichen-d3]:text-lichen-text in-[.lichen-d5]:text-lichen-text" data-testid="visit-change-outside">
          Outside the windows the property manager suggested.</dd>}
      </div>
    </dl>
    {!compact && !!change.windows.length && <div className="mt-3 text-sm">
      <p className="font-medium text-slate-800 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">Windows the property manager suggested</p>
      <ul className="mt-1 space-y-1 text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">{change.windows.map(window => <li key={window.start} className="break-words">{formatSlot(window)}</li>)}</ul>
    </div>}
    {tenant && <h4 className="mt-4 border-t border-slate-200 pt-4 text-sm font-semibold text-slate-900 in-[.lichen-d5]:border-hairline in-[.lichen-d5]:text-ink">Responses and deadline</h4>}
    <dl aria-label={tenant ? 'Responses and deadline' : undefined} className={'mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]' + (tenant ? ' [&>dd]:min-w-0' : '')}>
      <dt className="text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">Vendor</dt><dd className="text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink" data-testid="visit-change-vendor-response">{RESPONSE_LABEL[change.vendorResponse]}</dd>
      <dt className="text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">Tenant</dt><dd className="text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink" data-testid="visit-change-tenant-response">{RESPONSE_LABEL[change.tenantResponse]}</dd>
      {change.active && <><dt className="text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">Answer by</dt><dd className="text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">{formatInstant(change.expiresAt)}. {CUTOFF_COPY} If the vendor and the tenant have not both confirmed by then, this change request expires and the original visit is kept.</dd></>}
    </dl>

    {canAnswer && <div className="mt-4 space-y-2" role="group" aria-label="Your answer to the new time">
      <p className="text-sm text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">Only you can confirm this time. Accepting moves the visit to the new time above once Artrelo checks it is still free.</p>
      <div className="flex flex-wrap gap-2">
        <Button className={wrapButtonClass} disabled={busy} onClick={() => onAct?.('accept')} data-testid="visit-change-accept">Accept new time</Button>
        <Button variant="outline" className={wrapButtonClass} disabled={busy} onClick={() => onAct?.('keep_original')} data-testid="visit-change-keep">Keep the original time</Button>
      </div>
    </div>}
    {audience === 'tenant' && !canAnswer && change.canDecline && <div className="mt-4 space-y-2">
      <p className={`${changeHintClass} in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta`}>The vendor has not proposed a new time yet. You can decline the change now; the original visit stays booked.</p>
      <Button variant="outline" className={wrapButtonClass} disabled={busy} onClick={() => onAct?.('decline')} data-testid="visit-change-decline">Decline this change</Button>
    </div>}
    {audience === 'vendor' && change.canDecline && <div className="mt-4">
      <Button variant="outline" className={wrapButtonClass} disabled={busy} onClick={() => onAct?.('decline')} data-testid="visit-change-decline">Decline the change and keep the original visit</Button>
    </div>}
    {audience === 'landlord' && change.active && <div className="mt-4 space-y-2">
      <p className={`${changeHintClass} in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta`}>The vendor and the tenant each confirm the new time themselves. You cannot confirm it for the tenant.</p>
      {change.canDecline && <>
        <Button variant="outline" className={wrapButtonClass} disabled={busy} onClick={() => onAct?.('withdraw')} data-testid="visit-change-withdraw">Withdraw change request</Button>
        <p className={`${changeHintClass} in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta`}>Withdrawing keeps the original visit. It does not cancel the visit.</p>
      </>}
    </div>}
    {children}

    {audience === 'landlord' && !!change.delivery.length && <div className="mt-4 text-sm">
      <p className="font-medium text-slate-800 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">Notices for this update</p>
      <ul className="mt-1 space-y-1 text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink" data-testid="visit-change-delivery">{change.delivery.map(item =>
        <li key={item.audience}>{AUDIENCE_LABEL[item.audience] || 'Recipient'}: {deliveryLabel(item.status, item.inAppRecorded, item.audience)}</li>)}</ul>
    </div>}
    {!!change.events.length && <details className="mt-4 text-sm">
      <summary className="cursor-pointer rounded-sm font-medium text-slate-800 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">History ({change.events.length})</summary>
      <ol className="mt-2 space-y-2 border-l border-slate-200 pl-3 in-[.lichen-d3]:border-border in-[.lichen-d5]:border-border" data-testid="visit-change-history">{change.events.map(event =>
        <li key={`${event.revision}-${event.type}`} className="break-words">
          <span className="font-medium text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">{eventLabel(event.type)}</span>
          <span className="text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta"> · {ACTOR_LABEL[event.actor] || 'Unknown'} · {formatInstant(event.at)}</span>
          {event.proposed && ['vendor_confirmed_slot', 'committed'].includes(event.type) && <span className="block text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">New time: {formatSlot(event.proposed)}</span>}
          {event.type === 'response_deadline_shortened' && event.deadlineAt && <span className="block text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">
            Answer by {formatInstant(event.deadlineAt)}{event.previousDeadlineAt ? ` (was ${formatInstant(event.previousDeadlineAt)})` : ''}.</span>}
        </li>)}</ol>
    </details>}
  </section>;
}
