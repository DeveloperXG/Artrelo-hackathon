import {
  AlertTriangle,
  ArrowUpRight,
  CalendarCheck,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Loader2,
  Mail,
  MailX,
  RotateCw,
  XCircle,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import type { CandidateOutreachState } from './requestDetailTypes';
import { formatDuration } from '../../pages/vendor/durationOnSite';

const STATUS_META: Record<
  string,
  { label: string; chip: string; Icon: typeof Mail; tone: string }
> = {
  sent: {
    label: 'Email sent — awaiting response',
    chip: "bg-indigo-100 text-indigo-700 in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink",
    Icon: Mail,
    tone: "border-indigo-100 bg-indigo-50 text-indigo-800 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink",
  },
  viewed: {
    label: 'Vendor opened the request',
    chip: "bg-sky-100 text-sky-700 in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink",
    Icon: Mail,
    tone: "border-sky-100 bg-sky-50 text-sky-800 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink",
  },
  delivery_failed: {
    label: 'Email could not be delivered',
    chip: "bg-rose-100 text-rose-700 in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text",
    Icon: MailX,
    tone: "border-rose-100 bg-rose-50 text-rose-800 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text",
  },
  accepted: {
    label: 'Vendor accepted',
    chip: "bg-emerald-100 text-emerald-700 in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text",
    Icon: CheckCircle2,
    tone: "border-emerald-100 bg-emerald-50 text-emerald-800 in-[.lichen-d3]:border-mist-line in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text",
  },
  declined: {
    label: 'Vendor declined',
    chip: "bg-rose-100 text-rose-700 in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text",
    Icon: XCircle,
    tone: "border-rose-100 bg-rose-50 text-rose-800 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text",
  },
  expired: {
    label: 'No response within the window',
    chip: "bg-amber-100 text-amber-700 in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text",
    Icon: Clock,
    tone: "border-amber-100 bg-amber-50 text-amber-800 in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text",
  },
  superseded: {
    label: 'Replaced by a newer attempt',
    chip: 'bg-slate-200 text-slate-700',
    Icon: RotateCw,
    tone: 'border-slate-200 bg-slate-50 text-slate-700',
  },
  revoked: {
    label: 'Link revoked',
    chip: 'bg-slate-200 text-slate-700',
    Icon: XCircle,
    tone: 'border-slate-200 bg-slate-50 text-slate-700',
  },
};

const RESENDABLE = ['sent', 'viewed', 'delivery_failed', 'expired'];
// Mirrors MAX_ATTEMPTS in backend/services/vendor/vendorOutreach.service.js.
// Past it the server refuses a resend, so the button isn't offered.
const MAX_OUTREACH_ATTEMPTS = 3;

function formatMoney(amount?: number | null) {
  if (amount === null || amount === undefined) return null;
  return `$${Number(amount).toLocaleString()}`;
}

function formatDeadline(iso?: string | null) {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  const diffMs = target - Date.now();
  const absMinutes = Math.round(Math.abs(diffMs) / 60000);

  let relative: string;
  if (absMinutes < 60) relative = `${absMinutes}m`;
  else if (absMinutes < 60 * 24) relative = `${Math.round(absMinutes / 60)}h`;
  else relative = `${Math.round(absMinutes / (60 * 24))}d`;

  return diffMs >= 0 ? `due in ${relative}` : `overdue by ${relative}`;
}

export default function VendorOutreachStatus({
  outreach,
  vendorName,
  busy = false,
  onResend,
  onDismissResponse,
  onCancelScheduled,
}: {
  outreach?: CandidateOutreachState;
  vendorName: string;
  busy?: boolean;
  onResend?: () => void;
  onDismissResponse?: () => void;
  onCancelScheduled?: () => void;
}) {
  const navigate = useNavigate();
  const { id: requestId } = useParams<{ id: string }>();
  const status = outreach?.status || 'not_sent';

  // Waiting for the vendor's opening. Nothing has gone out, so the only thing
  // to do is wait or cancel — the request stays locked meanwhile.
  if (status === 'scheduled') {
    const when = outreach?.scheduledFor
      ? new Date(outreach.scheduledFor).toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : 'their next opening';
    return (
      <div
        className="w-full rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-violet-900 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text"
        data-testid="outreach-status-scheduled"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
            Outreach scheduled · sends {when}
          </div>
          {onCancelScheduled ? (
            <Button
              variant="outline"
              className="h-auto border-violet-200 bg-white px-3 py-1.5 text-xs text-violet-700 hover:bg-violet-100 in-[.lichen-d3]:bg-card in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:text-lichen-text in-[.lichen-d3]:hover:bg-lichen-tint"
              onClick={onCancelScheduled}
              disabled={busy}
              data-testid="outreach-cancel-scheduled"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Cancel scheduled send
            </Button>
          ) : null}
        </div>
        <div className="mt-1.5 text-xs opacity-90">
          {vendorName} is closed right now. The email goes out when they open, and their response time
          starts then.
        </div>
      </div>
    );
  }

  // Approved but nothing sent. This is a recoverable failure state (mail outage,
  // missing address at approval time), so it needs an action rather than a
  // status line — without one the request is stranded.
  if (status === 'not_sent') {
    return (
      <div
        className="w-full rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text"
        data-testid="outreach-status-not_sent"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <MailX className="h-4 w-4 shrink-0" aria-hidden="true" />
            Contact approved, but no outreach has been sent
          </div>
          {onResend ? (
            <Button
              className="h-auto gap-1.5 bg-[#137fec] px-3 py-1.5 text-xs hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
              onClick={onResend}
              disabled={busy}
              data-testid="outreach-send-now"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Mail className="h-3.5 w-3.5" />
              )}
              Send outreach
            </Button>
          ) : null}
        </div>
        <div className="mt-1.5 text-xs opacity-90">
          The vendor hasn&rsquo;t been emailed yet. Sending will deliver the approved draft.
        </div>
      </div>
    );
  }

  const meta = STATUS_META[status];
  if (!meta) return null;
  const { Icon } = meta;

  const decision = outreach?.decision;
  const quota = outreach?.quotaCheck;
  const counterOffer = outreach?.counterOffer;
  const deadline = formatDeadline(outreach?.responseDeadlineAt);
  const attemptsLeft = (outreach?.attempt || 1) < MAX_OUTREACH_ATTEMPTS;
  const canResend = Boolean(onResend) && RESENDABLE.includes(status) && attemptsLeft;
  const failed = status === 'delivery_failed';

  return (
    <div
      className={`w-full rounded-xl border px-4 py-3 in-[.lichen-d3]:rounded-lg ${meta.tone}`}
      data-testid={`outreach-status-${status}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          {meta.label}
        </div>
        <div className="flex items-center gap-2">
          {outreach?.attempt && outreach.attempt > 1 ? (
            <Badge className="border-transparent bg-white/70 text-[11px] text-slate-600 in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-meta">
              Attempt {outreach.attempt}
            </Badge>
          ) : null}
          {canResend ? (
            <Button
              variant="ghost"
              className="h-auto gap-1.5 px-2 py-1 text-xs hover:bg-white/60 in-[.lichen-d3]:hover:bg-card"
              onClick={onResend}
              disabled={busy}
              data-testid="outreach-resend"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
              Resend
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mt-1.5 text-xs opacity-90">
        {outreach?.toEmailMasked ? <>Sent to {outreach.toEmailMasked}</> : null}
        {deadline && ['sent', 'viewed'].includes(status) ? <> · Response {deadline}</> : null}
        {outreach?.firstViewedAt && status === 'viewed' ? <> · Opened</> : null}
      </div>

      {outreach?.deliveryError ? (
        <div className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs in-[.lichen-d3]:bg-card" data-testid="outreach-delivery-error">
          <span className="font-semibold">Why: </span>
          {outreach.deliveryError}
        </div>
      ) : null}

      {/* The way out of a failed delivery. Without it, once the resends ran out
          the request had no action left: Regenerate and manual assignment stay
          locked while this vendor counts as "being contacted". */}
      {failed && onDismissResponse ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="h-auto border-rose-200 bg-white px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-50 in-[.lichen-d3]:bg-card in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:hover:bg-alert-tint"
            onClick={onDismissResponse}
            disabled={busy}
            data-testid="outreach-skip-vendor"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Try the next vendor
          </Button>
          {!attemptsLeft ? (
            <span className="text-xs opacity-80">
              All {MAX_OUTREACH_ATTEMPTS} attempts to email {vendorName} failed.
            </span>
          ) : null}
        </div>
      ) : null}

      {decision?.outcome === 'declined' && decision.declineReason ? (
        <div className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs in-[.lichen-d3]:bg-card">
          “{decision.declineReason}”
        </div>
      ) : null}

      {decision?.outcome === 'accepted' ? (
        <div className="mt-3 space-y-2 rounded-lg bg-white/70 px-3 py-2.5 in-[.lichen-d3]:bg-card">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-semibold text-slate-900 in-[.lichen-d3]:text-ink">
              {formatMoney(decision.quoteLow)} – {formatMoney(decision.quoteHigh)}
            </span>
            {quota ? (
              <Badge
                className={`border-transparent text-[11px] ${
                  quota.overQuota
                    ? "bg-amber-100 text-amber-800 in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text"
                    : "bg-emerald-100 text-emerald-800 in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text"
                }`}
              >
                {quota.limit === null || quota.limit === undefined
                  ? 'No quota set'
                  : quota.overQuota
                    ? `Over $${quota.limit} limit`
                    : `Within $${quota.limit} limit`}
              </Badge>
            ) : null}
          </div>

          {decision.scheduledArrivalAt ? (
            <div className="flex items-center gap-1.5 text-xs text-slate-700 in-[.lichen-d3]:text-ink">
              <CalendarCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Arriving{' '}
              {new Date(decision.scheduledArrivalAt).toLocaleString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
              {decision.durationMinutes ? ` · ~${formatDuration(decision.durationMinutes)} on site` : ''}
            </div>
          ) : decision.selectedWindowLabel ? (
            <div className="flex items-center gap-1.5 text-xs text-slate-700 in-[.lichen-d3]:text-ink">
              <CalendarCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {decision.selectedWindowLabel}
            </div>
          ) : null}

          {decision.quoteNotes ? (
            <p className="whitespace-pre-line text-xs leading-5 text-slate-600 in-[.lichen-d3]:text-meta">
              {decision.quoteNotes}
            </p>
          ) : null}

          {counterOffer?.status === 'pending' ? (
            // Already authorized — the ball is in the vendor's court, so this must
            // NOT keep showing "waiting on your approval".
            <div
              className="flex items-start gap-1.5 rounded-lg border border-sky-200 bg-sky-50/80 px-2.5 py-2 text-xs text-sky-900 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink"
              data-testid="outreach-counter-offer-pending"
            >
              <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                You authorized {formatMoney(counterOffer.amount)} — waiting for{' '}
                {vendorName} to confirm they can do it for that.
                {counterOffer.deadlineAt
                  ? ` If they don't answer by ${new Date(
                      counterOffer.deadlineAt
                    ).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}, we'll try the next vendor.`
                  : ''}
              </span>
            </div>
          ) : counterOffer?.status === 'confirmed' ? (
            <div
              className="flex items-start gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50/80 px-2.5 py-2 text-xs text-emerald-900 in-[.lichen-d3]:border-mist-line in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text"
              data-testid="outreach-counter-offer-confirmed"
            >
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                {vendorName} agreed to {formatMoney(counterOffer.amount)} — booked at that
                price, not their quoted maximum.
              </span>
            </div>
          ) : quota?.overQuota ? (
            <div
              className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-2.5 py-2 in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint"
              data-testid="outreach-over-quota"
            >
              <div className="flex items-start gap-1.5 text-xs text-amber-900 in-[.lichen-d3]:text-lichen-text">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {quota.limit === null || quota.limit === undefined ? (
                    <>
                      You haven&rsquo;t set a spending quota, so this{' '}
                      {formatMoney(decision.quoteHigh)} quote needs your approval. Authorize an
                      amount to book it — nothing is scheduled until you do.
                    </>
                  ) : (
                    <>
                      {formatMoney(decision.quoteHigh)} is above your{' '}
                      {formatMoney(quota.limit)} limit for this request. Authorize an amount to
                      book it — nothing is scheduled until you do.
                    </>
                  )}
                </span>
              </div>
              <Button
                variant="ghost"
                className="h-auto self-start gap-1.5 px-2 py-1 text-xs font-semibold text-[#137fec] hover:bg-[#137fec]/10 in-[.lichen-d3]:text-lichen-text in-[.lichen-d3]:hover:bg-lichen-tint"
                onClick={() =>
                  navigate(
                    requestId ? `/dashboard/decisions?request=${requestId}` : '/dashboard/decisions'
                  )
                }
                data-testid="outreach-open-decisions"
              >
                <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Review in Decisions
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Button>
            </div>
          ) : null}

          {onDismissResponse ? (
            <Button
              variant="ghost"
              className="h-auto px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:hover:bg-alert-tint"
              onClick={onDismissResponse}
              disabled={busy}
              data-testid="outreach-dismiss-response"
            >
              Dismiss this quote
            </Button>
          ) : null}
        </div>
      ) : null}

      <span className="sr-only">{vendorName}</span>
    </div>
  );
}
