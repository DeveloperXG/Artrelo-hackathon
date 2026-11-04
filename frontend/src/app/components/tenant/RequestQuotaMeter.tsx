import { useEffect, useState } from 'react';
import { Gauge, Info } from 'lucide-react';
import type { QuotaWindow, RequestQuota } from '../../api/client';
import { cn } from '../ui/utils';

/** "Tue 4:12 PM" -- when the tenant can send again, in their own timezone. */
export const formatNextAvailable = (iso: string) => {
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: 'numeric',
    minute: '2-digit',
  });
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * Daily: "Resets in 5 hours". The windows are rolling (requestQuota.service):
 * `resetsAt` is when the oldest counted request stops counting, so it is the
 * moment the tenant next gets a request back. Rounded up, so "in 5 hours"
 * never arrives early; under an hour it counts minutes.
 */
export function dailyResetHint(w: QuotaWindow, now: Date = new Date()) {
  if (!w.used || !w.resetsAt) return 'Full limit available';
  const ms = new Date(w.resetsAt).getTime() - now.getTime();
  if (ms <= 0) return 'Resetting now';
  if (ms < HOUR_MS) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    return `Resets in ${minutes} min`;
  }
  const hours = Math.ceil(ms / HOUR_MS);
  return `Resets in ${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Weekly: "Resets Tue at 4:12 p.m." -- a day and time in the tenant's zone. */
export function weeklyResetHint(w: QuotaWindow, now: Date = new Date()) {
  if (!w.used || !w.resetsAt) return 'Full limit available';
  const at = new Date(w.resetsAt);
  if (at.getTime() <= now.getTime()) return 'Resetting now';
  const day = at.toDateString() === now.toDateString() ? 'today' : at.toLocaleDateString(undefined, { weekday: 'short' });
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `Resets ${day} at ${time}`;
}

function WindowBar({ label, window: w, hint }: { label: string; window: QuotaWindow; hint: string }) {
  const full = w.used >= w.limit;
  const pct = Math.min(100, Math.round((w.used / Math.max(1, w.limit)) * 100));
  return (
    <div className="min-w-0 flex-1 in-[.lichen-d5]:basis-40">
      <div className="flex items-baseline justify-between gap-2 text-xs in-[.lichen-d5]:flex-wrap">
        <span className="font-medium text-slate-600 in-[.lichen-d5]:text-meta">{label}</span>
        <span className={cn('tabular-nums font-semibold in-[.lichen-d5]:font-mono', full ? 'text-rose-600 in-[.lichen-d5]:text-alert-text' : "text-slate-900 in-[.lichen-d5]:text-ink")}>
          {w.used} of {w.limit}
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 in-[.lichen-d5]:bg-chip"
        role="progressbar"
        aria-label={`${label}: ${w.used} of ${w.limit} requests used`}
        aria-valuemin={0}
        aria-valuemax={w.limit}
        aria-valuenow={w.used}
      >
        <div
          className={cn('h-full rounded-full transition-all', full ? 'bg-rose-500 in-[.lichen-d5]:bg-alert-text' : pct >= 66 ? 'bg-amber-500 in-[.lichen-d5]:bg-lichen-icon' : 'bg-[#137fec] in-[.lichen-d5]:bg-lichen-icon')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] leading-4 text-slate-400 in-[.lichen-d5]:text-meta" data-testid={`request-quota-${label.split(' ')[0].toLowerCase()}-reset`}>
        {hint}
      </p>
    </div>
  );
}

/**
 * Where the tenant stands against their request limits. Shown before they
 * start a request so the limit is never a surprise at the end of one.
 */
export default function RequestQuotaMeter({ quota, className }: { quota: RequestQuota | null; className?: string }) {
  // The hints count down; re-render each minute so "in 5 hours" stays true
  // on a page left open.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (!quota) return null;
  const blocked = quota.blocked && quota.nextAvailableAt;
  return (
    <div
      className={cn(
        "rounded-2xl border bg-white px-5 py-4 shadow-sm in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-card in-[.lichen-d5]:shadow-none",
        blocked ? 'border-rose-200 in-[.lichen-d5]:border-alert-line' : "border-slate-100 in-[.lichen-d5]:border-border",
        className
      )}
      data-testid="request-quota-meter"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5 sm:w-48 in-[.lichen-d5]:min-w-0">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#137fec]/10 text-[#137fec] in-[.lichen-d5]:rounded-md in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-chip-icon">
            <Gauge className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold text-slate-900 in-[.lichen-d5]:text-ink">Your request limits</span>
        </div>
        <div className="flex flex-1 gap-5 in-[.lichen-d5]:min-w-0 in-[.lichen-d5]:flex-wrap">
          <WindowBar label="Daily limit" window={quota.daily} hint={dailyResetHint(quota.daily, now)} />
          <WindowBar label="Weekly limit" window={quota.weekly} hint={weeklyResetHint(quota.weekly, now)} />
        </div>
      </div>
      {blocked ? (
        <p className="mt-3 text-sm text-rose-700 in-[.lichen-d5]:text-alert-text" data-testid="request-quota-blocked">
          You&rsquo;ve reached your {quota.blockedBy === 'weekly' ? 'weekly' : 'daily'} limit. You can send your next
          request at {formatNextAvailable(quota.nextAvailableAt!)}. Emergencies can always be reported.
        </p>
      ) : (
        <p className="mt-3 flex items-start gap-1.5 text-xs leading-5 text-slate-500 in-[.lichen-d5]:text-meta">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Each request you send counts once, even if it&rsquo;s later rejected. Emergencies never count, and a request
          your property manager reopens doesn&rsquo;t count again.
        </p>
      )}
    </div>
  );
}
