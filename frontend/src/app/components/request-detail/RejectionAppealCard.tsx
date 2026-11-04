import type { ReactNode } from 'react';
import { Clock, RotateCcw, Scale, XCircle } from 'lucide-react';
import { Button } from '../ui/button';
import type { RequestDetailRecord } from './requestDetailTypes';
import { DetailCard, Eyebrow } from './detailUi';

/** "Thu, Oct 9, 3:15 PM" -- the deadline in the viewer's own timezone. */
const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** "about 31 hours" / "about 40 minutes" -- how long is left. */
const formatLeft = (iso: string, now = Date.now()) => {
  const minutes = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
};

function AppealNote({ note, appealedAt, who }: { note: string; appealedAt: string | null; who: string }) {
  return (
    <div className="mt-4 rounded-xl border border-fuchsia-100 bg-fuchsia-50/60 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-lichen-line in-[.lichen-d5]:bg-lichen-tint" data-testid="detail-appeal-note">
      <Eyebrow>
        {who}
        {appealedAt ? ` · ${formatWhen(appealedAt)}` : ''}
      </Eyebrow>
      <p className="mt-1 whitespace-pre-line text-sm leading-7 text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">{note}</p>
    </div>
  );
}

/**
 * The rejection and where its appeal stands, for both sides. What it offers is
 * decided by the server (request.appeal), never from the window date and the
 * browser's clock.
 */
export default function RejectionAppealCard({
  request,
  isLandlord,
  onAppeal,
  onReopen,
  onDeclineAppeal,
}: {
  request: RequestDetailRecord;
  isLandlord: boolean;
  /** Tenant: open the appeal dialog. */
  onAppeal?: () => void;
  /** Landlord: accept the appeal / withdraw the rejection. */
  onReopen?: () => void;
  /** Landlord: decline the appeal (final). */
  onDeclineAppeal?: () => void;
}) {
  if (request.status !== 'rejected') return null;
  const appeal = request.appeal;
  const state = appeal?.state || 'none';
  const pending = state === 'pending';

  let footer: ReactNode = null;
  if (isLandlord) {
    if (pending) {
      footer = (
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            data-testid="detail-accept-appeal"
            onClick={onReopen}
            className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:text-primary-foreground in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90"
          >
            <RotateCcw className="h-4 w-4" /> Accept &amp; reopen
          </Button>
          <Button
            data-testid="detail-decline-appeal"
            variant="outline"
            onClick={onDeclineAppeal}
            className="gap-1.5 border-rose-200 text-rose-600 hover:bg-rose-50 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:hover:bg-alert-tint in-[.lichen-d5]:border-alert-line in-[.lichen-d5]:text-alert-text in-[.lichen-d5]:hover:bg-alert-tint"
          >
            <XCircle className="h-4 w-4" /> Decline appeal
          </Button>
        </div>
      );
    } else if (state === 'available') {
      footer = (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <p className="flex items-center gap-1.5 text-xs text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">
            <Clock className="h-3.5 w-3.5" />
            The tenant can appeal until {formatWhen(appeal!.windowExpiresAt!)}.
          </p>
          {appeal?.canReopen ? (
            <Button data-testid="detail-withdraw-rejection" variant="outline" size="sm" onClick={onReopen} className="gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" /> Withdraw rejection
            </Button>
          ) : null}
        </div>
      );
    } else if (state === 'expired') {
      footer = (
        <p className="mt-4 text-xs text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">The appeal window closed with no appeal. This request is about to be removed.</p>
      );
    }
  } else if (state === 'available' && appeal?.canAppeal) {
    footer = (
      <div className="mt-5 rounded-xl border border-[#137fec]/20 bg-[#137fec]/5 p-4 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-lichen-tint">
        <p className="text-sm font-medium text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">Think this is a mistake?</p>
        <p className="mt-1 text-sm leading-6 text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">
          You can appeal once, until {formatWhen(appeal.windowExpiresAt!)} ({formatLeft(appeal.windowExpiresAt!)} left).
          If you don&rsquo;t, this request is removed when the window closes.
        </p>
        <Button data-testid="detail-appeal" onClick={onAppeal} className="mt-3 gap-1.5 bg-[#137fec] text-white hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground in-[.lichen-d5]:bg-primary in-[.lichen-d5]:hover:bg-primary/90 in-[.lichen-d5]:text-primary-foreground">
          <Scale className="h-4 w-4" /> Appeal rejection
        </Button>
      </div>
    );
  } else if (pending) {
    footer = (
      <p className="mt-4 text-sm text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta" data-testid="detail-appeal-pending">
        Your property manager is reviewing your appeal. You&rsquo;ll be notified when they decide.
      </p>
    );
  } else if (state === 'expired') {
    footer = (
      <p className="mt-4 text-sm text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">
        The appeal window has closed, so this request will be removed shortly. If the problem continues, you can send a
        new request.
      </p>
    );
  }

  return (
    <DetailCard
      icon={pending ? Scale : XCircle}
      iconColor={pending ? '#c026d3' : '#e11d48'}
      eyebrow={pending ? 'Appeal pending' : 'Rejected'}
      title={pending ? (isLandlord ? 'The tenant appealed' : 'Your appeal is in') : 'Rejection reason'}
      className={pending ? "border-fuchsia-200 in-[.lichen-d3]:border-lichen-line in-[.lichen-d5]:border-lichen-line" : "border-rose-100 in-[.lichen-d3]:border-alert-line in-[.lichen-d5]:border-alert-line"}
      data-testid="detail-rejection"
    >
      {pending ? <Eyebrow>Rejection reason</Eyebrow> : null}
      <p className="text-sm leading-7 text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">{request.rejectionReason || 'No reason was given.'}</p>
      {pending && appeal?.note ? (
        <AppealNote note={appeal.note} appealedAt={appeal.appealedAt} who={isLandlord ? "Tenant's appeal" : 'Your appeal'} />
      ) : null}
      {footer}
    </DetailCard>
  );
}
