import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  DollarSign,
  Loader2,
  Lock,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { ApiError, VendorPortalAPI } from '../../api/client';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { fieldClass, FieldLabel, useLandlordEntrance } from '../../components/landlord/landlordUi';
import VendorBriefCard from './VendorBriefCard';
import VendorRevealedDetails from './VendorRevealedDetails';
import type { VendorCounterOffer, VendorPortalPayload } from './vendorPortalTypes';
import { windowMatchesPreference } from './windowPreference';
import { DURATION_PRESETS, formatDuration } from './durationOnSite';
import { FieldError, invalidFieldClass } from '../../components/ui/FieldError';
import {
  ACCEPT_FIELD_ORDER,
  arrivalOutsideMessage,
  arrivalTimeBounds,
  buildArrivalIso,
  currentWindows,
  isArrivalInsideWindow,
  toDateInputValue,
  validateAcceptForm,
  type AcceptField,
  type AcceptFieldErrors,
} from './acceptForm';
import ItemizationEditor from '../../components/quotes/ItemizationEditor';
import ItemizationBreakdown from '../../components/quotes/ItemizationBreakdown';
import QuoteClarificationView, { isClarificationLink } from './QuoteClarificationView';
import { buildNegotiatedAccept } from './negotiatedProposal';
import {
  buildItemization,
  emptyLine,
  itemizationErrorMessage,
  lineErrorFromServer,
  type DraftLine,
  type LineErrors,
  type PricingMode,
} from '../../lib/itemization';

function formatCounterOfferAmount(counterOffer?: VendorCounterOffer | null) {
  if (!counterOffer || counterOffer.amount == null) return 'the approved amount';
  return `$${Number(counterOffer.amount).toLocaleString()}`;
}

const BRAND = '#137fec';
// How often an open page re-checks its windows against the clock.
const WINDOW_TICK_MS = 60 * 1000;
// Fewer bookable fixed windows than this and the page asks the server for
// more (the server tops up on read); not more than once per REFILL_GAP_MS, so
// a vendor with nothing more to offer isn't polled in a loop.
const MIN_BOOKABLE_WINDOWS = 2;
const REFILL_GAP_MS = 5 * 60 * 1000;

// iOS Safari gives native date/time inputs an intrinsic minimum width that
// ignores `w-full`, so on a phone they overflowed the arrival card. Dropping
// the native appearance and allowing the input (and every grid item above it,
// via min-w-0) to shrink keeps them inside the container.
const nativePickerClass =
  'block min-w-0 max-w-full appearance-none [&::-webkit-date-and-time-value]:min-h-5 [&::-webkit-date-and-time-value]:text-left';


/** Celebration burst. Hand-rolled rather than pulling a library into a public,
 *  unauthenticated page; follows the useLandlordEntrance keyframe-injection
 *  pattern and disappears entirely under prefers-reduced-motion. */
function ConfettiBurst() {
  useEffect(() => {
    if (document.getElementById('vendor-confetti-styles')) return;
    const style = document.createElement('style');
    style.id = 'vendor-confetti-styles';
    style.textContent = `
      @keyframes vcFall {
        0%   { opacity: 0; transform: translate3d(0, -10vh, 0) rotate(0deg); }
        10%  { opacity: 1; }
        100% { opacity: 0; transform: translate3d(var(--vc-x), 90vh, 0) rotate(var(--vc-r)); }
      }
      .vc-piece { animation: vcFall 2.4s cubic-bezier(0.2, 0.6, 0.4, 1) forwards; }
      @media (prefers-reduced-motion: reduce) { .vc-wrap { display: none !important; } }
    `;
    document.head.appendChild(style);
  }, []);

  const colors = ['#137fec', '#a855f7', '#10b981', '#f59e0b', '#ef4444'];
  const pieces = Array.from({ length: 16 }, (_, i) => ({
    left: `${6 + i * 6}%`,
    drift: `${(i % 2 === 0 ? 1 : -1) * (10 + (i % 5) * 14)}px`,
    rotate: `${(i % 2 === 0 ? 1 : -1) * (240 + i * 25)}deg`,
    delay: `${(i % 6) * 90}ms`,
    color: colors[i % colors.length],
    size: i % 3 === 0 ? 10 : 7,
  }));

  return (
    <div
      className="vc-wrap pointer-events-none fixed inset-0 z-50 overflow-hidden"
      aria-hidden="true"
      data-testid="vendor-confetti"
    >
      {pieces.map((p, i) => (
        <span
          key={i}
          className="vc-piece absolute top-0 block"
          style={
            {
              left: p.left,
              width: p.size,
              height: p.size * 1.6,
              backgroundColor: p.color,
              borderRadius: 2,
              animationDelay: p.delay,
              '--vc-x': p.drift,
              '--vc-r': p.rotate,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  // This route lives outside LandlordLayout / TenantLayout (it is public), so it
  // renders its own minimal chrome.
  return (
    <div
      className="min-h-screen bg-slate-50"
      style={{
        backgroundImage:
          'linear-gradient(to right, rgba(15, 23, 42, 0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(15, 23, 42, 0.04) 1px, transparent 1px)',
        backgroundSize: '48px 48px',
      }}
    >
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <span className="text-xl font-bold tracking-tight" style={{ color: BRAND }}>
            Artrelo
          </span>
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Secure job link
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">{children}</main>
      <footer className="mx-auto max-w-3xl px-4 pb-10 text-center text-xs text-slate-400 sm:px-6">
        Artrelo coordinates maintenance on behalf of property managers.
      </footer>
    </div>
  );
}

function StatusCard({
  tone,
  icon: Icon,
  title,
  id,
  children,
}: {
  tone: 'good' | 'bad' | 'muted';
  icon: typeof CheckCircle2;
  title: string;
  id?: string;
  children?: React.ReactNode;
}) {
  const tones = {
    good: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    bad: 'border-rose-200 bg-rose-50 text-rose-900',
    muted: 'border-slate-200 bg-white text-slate-800',
  };
  return (
    <section id={id} className={`scroll-mt-6 rounded-2xl border p-6 text-center ${tones[tone]}`}>
      <Icon className="mx-auto h-9 w-9" aria-hidden="true" />
      <h1 className="mt-3 text-lg font-bold">{title}</h1>
      {children ? <div className="mt-2 text-sm leading-6">{children}</div> : null}
    </section>
  );
}

/**
 * One route, two capabilities. A follow-up link (?mode=quote-clarification, or
 * a qc_ token) opens only the clarification surface; it never reads the
 * original brief or reaches the single-use /respond.
 */
export default function VendorResponsePage() {
  const { token = '' } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  if (isClarificationLink(token, searchParams.get('mode'))) {
    return (
      <PageShell>
        <QuoteClarificationView token={token} />
      </PageShell>
    );
  }
  return <VendorOutreachResponse token={token} />;
}

function VendorOutreachResponse({ token }: { token: string }) {
  useLandlordEntrance();

  const [payload, setPayload] = useState<VendorPortalPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ code?: string; message: string } | null>(null);

  const [selectedSlotId, setSelectedSlotId] = useState('');
  const [quoteLow, setQuoteLow] = useState('');
  const [quoteHigh, setQuoteHigh] = useState('');
  const [arrivalTime, setArrivalTime] = useState('');
  const [arrivalDate, setArrivalDate] = useState('');
  // A preset ('30', '120', …) or 'custom', which reveals hours + minutes.
  const [durationMinutes, setDurationMinutes] = useState('120');
  const [customHours, setCustomHours] = useState('');
  const [customMinutes, setCustomMinutes] = useState('0');
  // Shown beside each field, never as a toast. Editing a field clears its own.
  const [fieldErrors, setFieldErrors] = useState<AcceptFieldErrors>({});
  const clearFieldError = (field: AcceptField) =>
    setFieldErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  // Itemized outreach (quote contract v2): lines instead of a low/high pair.
  const [pricingMode, setPricingMode] = useState<PricingMode>('fixed');
  const [quoteLines, setQuoteLines] = useState<DraftLine[]>(() => [emptyLine()]);
  const [lineErrors, setLineErrors] = useState<Record<string, LineErrors>>({});
  const clearLineError = (key: string, field: keyof LineErrors) => {
    setLineErrors((current) => (current[key]?.[field] ? { ...current, [key]: { ...current[key], [field]: undefined } } : current));
    clearFieldError('quote');
  };
  const [quoteNotes, setQuoteNotes] = useState('');
  const [declineReason, setDeclineReason] = useState('');
  const [showDecline, setShowDecline] = useState(false);
  const [submitting, setSubmitting] = useState<'accepted' | 'declined' | null>(null);
  const [justAccepted, setJustAccepted] = useState(false);
  const [counterDeclineReason, setCounterDeclineReason] = useState('');
  const [showCounterDecline, setShowCounterDecline] = useState(false);
  const [counterSubmitting, setCounterSubmitting] = useState<'confirmed' | 'declined' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await VendorPortalAPI.getBrief(token);
      setPayload(res.data as VendorPortalPayload);
    } catch (err) {
      const apiError = err as ApiError;
      const body = apiError.payload as { code?: string; message?: string } | undefined;
      setLoadError({
        code: body?.code,
        message: body?.message || apiError.message || 'This link could not be opened.',
      });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // The vendor may sit on this page past the start of a window, or open it
  // hours after it was sent. The server drops and tops up windows whenever the
  // page is read or submitted; this keeps an OPEN page honest in between.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), WINDOW_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const windows = useMemo(
    () => (payload ? currentWindows(payload.brief.offeredWindows, now) : []),
    [payload, now]
  );

  // The chosen window ran out while the form was open.
  useEffect(() => {
    if (!selectedSlotId || !payload || payload.alreadyResponded) return;
    if (windows.some((slot) => slot.slotId === selectedSlotId)) return;
    setSelectedSlotId('');
    setFieldErrors((current) => ({ ...current, window: 'That window has passed. Pick another time.', arrival: undefined }));
  }, [windows, selectedSlotId, payload]);

  // Too few left to choose from: re-read, which makes the server top up.
  // Silent -- no spinner over a form the vendor may be halfway through.
  const lastRefill = useRef(0);
  useEffect(() => {
    if (!payload || payload.alreadyResponded) return;
    const bookable = windows.filter((slot) => slot.kind !== 'flexible').length;
    if (bookable >= MIN_BOOKABLE_WINDOWS || Date.now() - lastRefill.current < REFILL_GAP_MS) return;
    lastRefill.current = Date.now();
    VendorPortalAPI.getBrief(token)
      .then((res) => setPayload(res.data as VendorPortalPayload))
      .catch(() => {
        // The next tick or a submit will try again; the page keeps what it has.
      });
  }, [windows, payload, token]);

  useEffect(() => {
    document.title = 'Job request · Artrelo';
  }, []);

  /**
   * Answer a price confirmation. Note what is NOT sent: the amount. The server
   * reads that from the outreach record, so nothing typed or tampered with here
   * can change what the job books at.
   */
  const submitCounterOffer = async (decision: 'confirmed' | 'declined') => {
    setCounterSubmitting(decision);
    try {
      const res = await VendorPortalAPI.respondToCounterOffer(token, {
        decision,
        declineReason: decision === 'declined' ? counterDeclineReason.trim() || undefined : undefined,
      });
      // No toast: the question is replaced in place by "Price confirmed" or
      // "This job went to another provider".
      setPayload(res.data as VendorPortalPayload);
    } catch (err) {
      const apiError = err as ApiError;
      const body = apiError.payload as
        | { code?: string; message?: string; data?: VendorPortalPayload }
        | undefined;
      // Same 409 contract as the offer round: the server echoes the state that
      // did land, so show it rather than an error.
      if (apiError.status === 409 && body?.data) {
        setPayload(body.data);
        toast.info(body.message || 'This price request has already been answered.');
      } else {
        toast.error(body?.message || apiError.message || 'Could not send your answer.');
      }
    } finally {
      setCounterSubmitting(null);
    }
  };

  const showResponseStatus = () =>
    window.requestAnimationFrame(() =>
      document
        .getElementById('vendor-response-status')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    );

  const itemized = payload?.brief.quoteContractVersion === 2;

  const submit = async (outcome: 'accepted' | 'declined') => {
    let arrivalIso = '';
    let onSiteMinutes = 0;
    let itemizedQuote: ReturnType<typeof buildItemization> | null = null;

    if (outcome === 'accepted') {
      const checked = validateAcceptForm({
        slot: windows.find((slot) => slot.slotId === selectedSlotId),
        quoteLow,
        quoteHigh,
        arrivalDate,
        arrivalTime,
        durationMinutes,
        customHours,
        customMinutes,
        itemized,
      });
      if (itemized) {
        itemizedQuote = buildItemization(pricingMode, quoteLines);
        setLineErrors(itemizedQuote.ok ? {} : itemizedQuote.lineErrors);
      }
      const quoteError = itemizedQuote && !itemizedQuote.ok ? itemizedQuote.message : undefined;
      if (checked.errors || quoteError) {
        const errors = { ...(checked.errors || {}), ...(quoteError ? { quote: quoteError } : {}) };
        setFieldErrors(errors);
        // Take the vendor to the first problem: on a phone the Accept button
        // is a long scroll below the window list. A frame later, so the
        // messages and aria-invalid are on the page first.
        const first = ACCEPT_FIELD_ORDER.find((field) => errors[field]);
        window.requestAnimationFrame(() => {
          const target = first ? document.getElementById(`vendor-field-${first}`) : null;
          target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // The invalid control itself when marked (the custom hours box rather
          // than the preset select above it), else the field's first control.
          const control =
            target?.querySelector<HTMLElement>('[aria-invalid="true"]') ||
            target?.querySelector<HTMLElement>('input, select, button');
          control?.focus({ preventScroll: true });
        });
        return;
      }
      if (checked.errors) return; // Narrowing only; handled above.
      setFieldErrors({});
      arrivalIso = checked.arrivalIso;
      onSiteMinutes = checked.onSiteMinutes;
    }

    setSubmitting(outcome);
    try {
      const res = await VendorPortalAPI.respond(
        token,
        outcome === 'accepted'
          ? {
              outcome,
              selectedSlotId,
              // Itemized: the lines are the price. The server derives the
              // low/high projection from them, so none is sent to disagree.
              ...(itemizedQuote?.ok
                ? { itemization: itemizedQuote.itemization, expectedRevision: 0 as const, quoteContractVersion: 2 as const }
                : { quoteLow: Number(quoteLow), quoteHigh: Number(quoteHigh) }),
              scheduledArrivalAt: arrivalIso,
              durationMinutes: onSiteMinutes,
              quoteNotes: quoteNotes.trim() || undefined,
            }
          : { outcome, declineReason: declineReason.trim() || undefined }
      );
      setPayload(res.data as VendorPortalPayload);
      // Only a fresh accept celebrates — reopening the link must not re-fire.
      if (outcome === 'accepted') setJustAccepted(true);
      // No toast: the form is replaced by "You accepted / declined this job".
      // The vendor pressed the button at the bottom of a long page, so bring
      // that card into view rather than leave them looking at the footer.
      showResponseStatus();
    } catch (err) {
      const apiError = err as ApiError;
      const body = apiError.payload as
        | { code?: string; message?: string; data?: VendorPortalPayload }
        | undefined;
      // The window ran out between filling the form and pressing Accept. The
      // server sends the fresh list; swap it in and ask for another pick. Not
      // counted against the vendor (see vendorPortal.controller).
      if (body?.code === 'window_expired') {
        const fresh = (body.data as { offeredWindows?: VendorPortalPayload['brief']['offeredWindows'] } | undefined)
          ?.offeredWindows;
        if (fresh) setPayload((current) => (current ? { ...current, brief: { ...current.brief, offeredWindows: fresh } } : current));
        setSelectedSlotId('');
        setFieldErrors({ window: body.message || 'That window has passed. Pick another time.' });
        window.requestAnimationFrame(() =>
          document.getElementById('vendor-field-window')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        );
        return;
      }
      if (body?.code === 'arrival_past') {
        setFieldErrors({ arrival: body.message || 'That arrival time has already passed.' });
        return;
      }
      // An itemization the server refused: put it beside the line it names.
      // Everything typed stays on the form.
      const itemizationError = body as { code?: string; field?: string } | undefined;
      if (itemized && apiError.status === 400 && itemizationError?.code) {
        const target = lineErrorFromServer(itemizationError.field, quoteLines, pricingMode);
        const message = itemizationErrorMessage(itemizationError.code);
        if (target) setLineErrors({ [target.key]: { [target.field]: message } });
        setFieldErrors({ quote: message });
        window.requestAnimationFrame(() =>
          document.getElementById('vendor-field-quote')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        );
        return;
      }
      // 409 means someone/something already closed this outreach. The server
      // echoes the decision that did land, so show that rather than an error.
      if (apiError.status === 409 && body?.data) {
        setPayload(body.data);
        toast.info(body.message || 'This job request has already been answered.');
      } else {
        toast.error(body?.message || apiError.message || 'Could not send your response.');
      }
    } finally {
      setSubmitting(null);
    }
  };

  if (loading) {
    return (
      <PageShell>
        <div className="flex min-h-[40vh] items-center justify-center text-slate-500">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
          Loading job request…
        </div>
      </PageShell>
    );
  }

  if (loadError) {
    const expired = loadError.code === 'outreach_expired';
    return (
      <PageShell>
        <StatusCard
          tone="muted"
          icon={expired ? CalendarClock : Lock}
          title={expired ? 'This job has moved on' : 'This link is not valid'}
        >
          {loadError.message}
          {expired ? (
            <p className="mt-2 text-slate-500">
              No action is needed. We&rsquo;ll be in touch about the next job.
            </p>
          ) : null}
        </StatusCard>
      </PageShell>
    );
  }

  if (!payload) return null;
  if (payload.negotiatedProposal && !payload.alreadyResponded) {
    const proposal = payload.negotiatedProposal;
    return <PageShell><div className="space-y-5"><VendorBriefCard brief={payload.brief} />
      <section className="rounded-2xl border bg-white p-5 shadow-sm"><h1 className="text-xl font-semibold">Confirm the new agreement</h1>
        <p className="mt-3 font-semibold">${proposal.amount.toFixed(2)} CAD · {proposal.durationMinutes} minutes</p>
        <p className="mt-2 text-sm">{new Date(proposal.start).toLocaleString()} ({Intl.DateTimeFormat().resolvedOptions().timeZone})</p>
        {proposal.note && <p className="mt-2 text-sm">{proposal.note}</p>}
        <p className="mt-3 text-sm text-slate-600">This is a fresh offer. Confirm the exact price and time, or decline. The visit is booked only after tenant access and any required funding are confirmed.</p>
        {itemized ? (
          <div className="mt-4">
            <p className="text-sm text-slate-600">
              Itemize the agreed amount: list each charge on its own line. The lines must add up to exactly ${proposal.amount.toFixed(2)} CAD.
            </p>
            <div className="mt-3 scroll-mt-24" id="vendor-field-quote">
              <ItemizationEditor
                idPrefix="vendor-proposal"
                mode="fixed"
                lines={quoteLines}
                onLinesChange={(lines) => {
                  setQuoteLines(lines);
                  clearFieldError('quote');
                }}
                lineErrors={lineErrors}
                onClearError={clearLineError}
                disabled={submitting !== null}
                totalLabel="Itemized total"
              />
            </div>
            <FieldError id="vendor-proposal-error" className="mt-2">
              {fieldErrors.quote}
            </FieldError>
          </div>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-3">{(['accepted', 'declined'] as const).map(outcome => <Button key={outcome} data-testid={`vendor-proposal-${outcome}`} disabled={!!submitting} variant={outcome === 'accepted' ? 'default' : 'outline'} onClick={async () => {
          let body: Parameters<typeof VendorPortalAPI.respond>[1] = { outcome, declineReason: 'The new agreement does not work for me' };
          if (outcome === 'accepted') {
            const check = buildNegotiatedAccept(proposal, itemized, quoteLines);
            if (!check.ok) {
              setLineErrors(check.lineErrors);
              setFieldErrors({ quote: check.message });
              return;
            }
            body = check.body;
          }
          setSubmitting(outcome); try { const result = await VendorPortalAPI.respond(token, body);
            setPayload(result.data as VendorPortalPayload);
          } catch (error) {
            // A refused itemization stays on the form, beside the line it names.
            const refused = error instanceof ApiError ? (error.payload as { code?: string; field?: string } | undefined) : undefined;
            if (itemized && error instanceof ApiError && error.status === 400 && refused?.code) {
              const target = lineErrorFromServer(refused.field, quoteLines, 'fixed');
              const message = itemizationErrorMessage(refused.code);
              if (target) setLineErrors({ [target.key]: { [target.field]: message } });
              setFieldErrors({ quote: message });
            } else toast.error(error instanceof Error ? error.message : 'Could not respond');
          }
          finally { setSubmitting(null); }
        }}>{outcome === 'accepted' ? 'Confirm price and time' : 'Decline proposal'}</Button>)}</div>
      </section></div></PageShell>;
  }

  const { brief, revealed, counterOffer } = payload;
  const accepted = payload.decision === 'accepted';
  const declined = payload.decision === 'declined';
  const responded = payload.alreadyResponded;
  const selectedSlot = windows.find((slot) => slot.slotId === selectedSlotId);
  const timeBounds = arrivalTimeBounds(selectedSlot);
  const arrivalDraft = buildArrivalIso(selectedSlot, arrivalDate, arrivalTime);
  const arrivalOutOfRange = Boolean(arrivalDraft) && !isArrivalInsideWindow(selectedSlot, arrivalDraft);
  // Out-of-window shows as soon as it's typed; a missing time only on Accept.
  const arrivalError =
    fieldErrors.arrival || (arrivalOutOfRange && selectedSlot ? arrivalOutsideMessage(selectedSlot) : '');

  return (
    <PageShell>
      {justAccepted ? <ConfettiBurst /> : null}
      <div className="ll-fade-up space-y-5">
        <VendorBriefCard brief={brief} />

        {/* Property manager — shown before accepting, contact details after. */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <FieldLabel>Requested by</FieldLabel>
          <div className="mt-2 flex items-center gap-3">
            <div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white"
              style={{ background: `linear-gradient(135deg, ${BRAND}, #a855f7)` }}
            >
              {brief.manager.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">{brief.manager.name}</div>
              {brief.manager.company ? (
                <div className="text-sm text-slate-500">{brief.manager.company}</div>
              ) : null}
            </div>
          </div>
        </section>

        {declined ? (
          <StatusCard tone="bad" icon={XCircle} title="You declined this job" id="vendor-response-status">
            {payload.declineReason ? <>Reason recorded: “{payload.declineReason}”</> : null}
            <p className="mt-2">Thanks for letting us know — we&rsquo;ve passed it to another provider.</p>
          </StatusCard>
        ) : null}

        {accepted ? (
          <>
            <StatusCard
              tone="good"
              icon={CheckCircle2}
              title="You accepted this job"
              id="vendor-response-status"
            >
              {payload.quote?.itemization ? null : payload.quote?.high ? (
                <div>
                  Your quote: <strong>${payload.quote.low}–${payload.quote.high}</strong>
                </div>
              ) : null}
              {payload.scheduledArrivalAt ? (
                <div className="mt-1" data-testid="vendor-accepted-arrival">
                  Arriving{' '}
                  <strong>
                    {new Date(payload.scheduledArrivalAt).toLocaleString(undefined, {
                      timeZone: brief.offeredWindows.find(window => window.timeZone)?.timeZone || undefined,
                      timeZoneName: 'short',
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </strong>
                  {payload.durationMinutes ? ` · about ${formatDuration(payload.durationMinutes)} on site` : ''}
                </div>
              ) : null}
            </StatusCard>

            {/* What was sent, exactly as stored. It can't be edited from here:
                the response is single-use, and a change only ever arrives as a
                separate follow-up the property manager asks for. */}
            {payload.quote?.itemization ? (
              <section className="rounded-lg border border-slate-200 bg-white p-5" data-testid="vendor-submitted-quote">
                <ItemizationBreakdown
                  itemization={payload.quote.itemization}
                  title="Your itemized quote"
                  caption={`Revision ${payload.quote.revision ?? 1} · as sent, can’t be changed here`}
                  testId="vendor-submitted-quote-breakdown"
                />
              </section>
            ) : null}

            {/* The price-confirmation round. Sits between the acceptance receipt
                and the job details, because it is the one thing still asked of
                them — and they need the address above it to judge the price. */}
            {counterOffer?.status === 'pending' ? (
              <section
                className="rounded-2xl border border-amber-300 bg-amber-50 p-5 shadow-sm sm:p-6"
                data-testid="vendor-counter-offer"
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
                  <h2 className="text-base font-semibold text-slate-900">
                    Can you do it for {formatCounterOfferAmount(counterOffer)}?
                  </h2>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-700">
                  The property manager approved{' '}
                  <strong>{formatCounterOfferAmount(counterOffer)}</strong> for this job
                  {counterOffer.originalQuote?.low != null &&
                  counterOffer.originalQuote?.high != null ? (
                    <>
                      , against your quote of ${counterOffer.originalQuote.low}–$
                      {counterOffer.originalQuote.high}
                    </>
                  ) : null}
                  . Nothing is booked until you answer.
                </p>
                {counterOffer.note ? (
                  <p className="mt-2 whitespace-pre-line rounded-lg bg-white/70 px-3 py-2 text-sm leading-6 text-slate-700">
                    {counterOffer.note}
                  </p>
                ) : null}
                {counterOffer.deadlineAt ? (
                  <p className="mt-2 text-xs text-slate-600">
                    Please answer by{' '}
                    {new Date(counterOffer.deadlineAt).toLocaleString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                    .
                  </p>
                ) : null}

                {showCounterDecline ? (
                  <div className="mt-4">
                    <label
                      className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                      htmlFor="counter-decline-reason"
                    >
                      Why not? (optional)
                    </label>
                    <textarea
                      id="counter-decline-reason"
                      value={counterDeclineReason}
                      onChange={(event) => setCounterDeclineReason(event.target.value)}
                      maxLength={500}
                      rows={3}
                      className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-400"
                      placeholder="e.g. parts alone cost more than that"
                      data-testid="vendor-counter-decline-reason"
                    />
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void submitCounterOffer('confirmed')}
                    disabled={counterSubmitting !== null}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                    data-testid="vendor-counter-confirm"
                  >
                    {counterSubmitting === 'confirmed' ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    )}
                    Yes, I can do it for {formatCounterOfferAmount(counterOffer)}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      showCounterDecline
                        ? void submitCounterOffer('declined')
                        : setShowCounterDecline(true)
                    }
                    disabled={counterSubmitting !== null}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                    data-testid="vendor-counter-decline"
                  >
                    {counterSubmitting === 'declined' ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : null}
                    {showCounterDecline ? 'Send decline' : "No, I can't"}
                  </button>
                </div>
              </section>
            ) : counterOffer?.status === 'confirmed' ? (
              <StatusCard tone="good" icon={CheckCircle2} title="Price confirmed">
                You&rsquo;re booked at <strong>{formatCounterOfferAmount(counterOffer)}</strong>.
              </StatusCard>
            ) : counterOffer && ['declined', 'expired', 'withdrawn'].includes(counterOffer.status) ? (
              <StatusCard tone="bad" icon={XCircle} title="This job went to another provider">
                {counterOffer.status === 'declined'
                  ? `You declined ${formatCounterOfferAmount(counterOffer)}.`
                  : 'The price request closed before it was answered.'}
              </StatusCard>
            ) : null}

            {revealed ? <VendorRevealedDetails revealed={revealed} /> : null}
          </>
        ) : null}

        {!responded ? (
          <>
            {/* Availability */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4" style={{ color: BRAND }} aria-hidden="true" />
                <h2 className="text-base font-semibold text-slate-900">
                  Which window works for you?
                </h2>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                These options reflect how urgent the tenant&rsquo;s issue is.
              </p>
              {/* Shown BEFORE accepting, so the vendor can choose the window
                  closest to what the tenant asked for. It used to appear only
                  after they had already committed to a time. */}
              {brief.preferredTimes?.length ? (
                <div
                  className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-4 py-2.5 text-sm text-amber-900"
                  data-testid="vendor-tenant-preference"
                >
                  <span className="font-semibold">Tenant prefers:</span> {brief.preferredTimes.join(', ')}
                </div>
              ) : null}

              <div
                className="mt-4 scroll-mt-24 space-y-2"
                id="vendor-field-window"
                role="group"
                aria-label="Offered time windows"
                aria-describedby={fieldErrors.window ? 'vendor-window-error' : undefined}
              >
                {windows.map((slot) => {
                  const active = selectedSlotId === slot.slotId;
                  const preferred = windowMatchesPreference(slot.label, brief.preferredTimes);
                  return (
                    <button
                      key={slot.slotId}
                      type="button"
                      onClick={() => {
                        setSelectedSlotId(slot.slotId);
                        clearFieldError('window');
                        // The arrival is judged against the window; a new one
                        // makes the old verdict stale.
                        clearFieldError('arrival');
                      }}
                      data-testid={`vendor-window-${slot.slotId}`}
                      aria-pressed={active}
                      className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition ${
                        active
                          ? 'border-[#137fec] bg-[#137fec]/5 text-slate-900 ring-2 ring-[#137fec]/15'
                          : fieldErrors.window
                            ? 'border-rose-300 bg-white text-slate-700 hover:border-[#137fec]/40'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-[#137fec]/40'
                      }`}
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="font-medium">{slot.label}</span>
                        {preferred ? (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                            Matches tenant preference
                          </span>
                        ) : null}
                      </span>
                      <span
                        className={`ml-3 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                          active ? 'border-[#137fec] bg-[#137fec]' : 'border-slate-300'
                        }`}
                      >
                        {active ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              <FieldError id="vendor-window-error" className="mt-2">
                {fieldErrors.window}
              </FieldError>

              {/* The window is what you CAN do; this is when you'll actually
                  turn up. The tenant plans their day around it. */}
              {selectedSlot ? (
                <div className="mt-5 rounded-xl border border-[#137fec]/25 bg-[#137fec]/5 p-4">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4" style={{ color: BRAND }} aria-hidden="true" />
                    <h3 className="text-sm font-semibold text-slate-900">
                      What time will you arrive?
                    </h3>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    The tenant needs to be home to let you in, so give them a specific time rather
                    than the whole window.
                  </p>

                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {selectedSlot.kind === 'flexible' ? (
                      <label className="block min-w-0">
                        <FieldLabel>Date</FieldLabel>
                        <input
                          type="date"
                          value={arrivalDate}
                          min={toDateInputValue(now, selectedSlot.timeZone)}
                          onChange={(event) => {
                            setArrivalDate(event.target.value);
                            clearFieldError('arrival');
                          }}
                          className={`${fieldClass} ${nativePickerClass} mt-1.5 ${arrivalError ? invalidFieldClass : ''}`}
                          aria-invalid={Boolean(arrivalError)}
                          aria-describedby={arrivalError ? 'vendor-arrival-error' : undefined}
                          data-testid="vendor-arrival-date"
                        />
                      </label>
                    ) : null}
                    <div className="min-w-0 scroll-mt-24" id="vendor-field-arrival">
                      <label className="block min-w-0">
                        <FieldLabel>Arrival time</FieldLabel>
                        <input
                          type="time"
                          value={arrivalTime}
                          min={timeBounds.min}
                          max={timeBounds.max}
                          onChange={(event) => {
                            setArrivalTime(event.target.value);
                            clearFieldError('arrival');
                          }}
                          className={`${fieldClass} ${nativePickerClass} mt-1.5 ${arrivalError ? invalidFieldClass : ''}`}
                          aria-invalid={Boolean(arrivalError)}
                          aria-describedby={arrivalError ? 'vendor-arrival-error' : undefined}
                          data-testid="vendor-arrival-time"
                        />
                      </label>
                      <FieldError id="vendor-arrival-error" className="mt-1.5">
                        {arrivalError}
                      </FieldError>
                    </div>
                    <div className="min-w-0 scroll-mt-24" id="vendor-field-duration">
                      <label className="block">
                        <FieldLabel>Time on site</FieldLabel>
                        <select
                          value={durationMinutes}
                          onChange={(event) => {
                            setDurationMinutes(event.target.value);
                            clearFieldError('duration');
                          }}
                          className={`${fieldClass} mt-1.5`}
                          data-testid="vendor-duration"
                        >
                          {DURATION_PRESETS.map((option) => (
                            <option key={option.value} value={String(option.value)}>
                              {option.label}
                            </option>
                          ))}
                          <option value="custom">Custom…</option>
                        </select>
                      </label>
                      {/* Any length from 15 minutes to 12 hours, in 15-minute
                          steps -- the four presets didn't fit most real jobs. */}
                      {durationMinutes === 'custom' ? (
                        <div className="mt-2 flex items-center gap-2">
                          <input
                            type="number"
                            min={0}
                            max={12}
                            inputMode="numeric"
                            value={customHours}
                            onChange={(event) => {
                              setCustomHours(event.target.value);
                              clearFieldError('duration');
                            }}
                            className={`${fieldClass} w-20 ${fieldErrors.duration ? invalidFieldClass : ''}`}
                            aria-label="Hours on site"
                            aria-invalid={Boolean(fieldErrors.duration)}
                            aria-describedby={fieldErrors.duration ? 'vendor-duration-error' : undefined}
                            data-testid="vendor-duration-hours"
                            placeholder="0"
                          />
                          <span className="text-sm text-slate-500">h</span>
                          <select
                            value={customMinutes}
                            onChange={(event) => {
                              setCustomMinutes(event.target.value);
                              clearFieldError('duration');
                            }}
                            className={`${fieldClass} w-24 ${fieldErrors.duration ? invalidFieldClass : ''}`}
                            aria-label="Minutes on site"
                            data-testid="vendor-duration-minutes"
                          >
                            {['0', '15', '30', '45'].map((value) => (
                              <option key={value} value={value}>
                                {value} min
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : null}
                      <FieldError id="vendor-duration-error" className="mt-1.5">
                        {fieldErrors.duration}
                      </FieldError>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>

            {/* Quote */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4" style={{ color: BRAND }} aria-hidden="true" />
                <h2 className="text-base font-semibold text-slate-900">Your estimate</h2>
              </div>
              {itemized ? (
                <>
                  <p className="mt-1 text-sm text-slate-500">
                    List each charge on its own line, in CAD. Use price ranges where you can&rsquo;t be exact
                    yet. The property manager reviews the costs before anything is booked.
                  </p>
                  <div className="mt-4 scroll-mt-24" id="vendor-field-quote">
                    <ItemizationEditor
                      idPrefix="vendor-quote"
                      mode={pricingMode}
                      onModeChange={(mode) => {
                        setPricingMode(mode);
                        setLineErrors({});
                        clearFieldError('quote');
                      }}
                      lines={quoteLines}
                      onLinesChange={(lines) => {
                        setQuoteLines(lines);
                        clearFieldError('quote');
                      }}
                      lineErrors={lineErrors}
                      onClearError={clearLineError}
                      disabled={submitting !== null}
                      totalLabel="Quote total"
                    />
                  </div>
                  <FieldError id="vendor-quote-error" className="mt-2">
                    {fieldErrors.quote}
                  </FieldError>
                </>
              ) : (
              <>
              <p className="mt-1 text-sm text-slate-500">
                A range is fine — the property manager approves the cost before work starts.
              </p>

              <div className="mt-4 grid scroll-mt-24 gap-4 sm:grid-cols-2" id="vendor-field-quote">
                <label className="block">
                  <FieldLabel>Low ({brief.quoteCurrency})</FieldLabel>
                  <input
                    type="number"
                    min={0}
                    inputMode="decimal"
                    value={quoteLow}
                    onChange={(event) => {
                      setQuoteLow(event.target.value);
                      clearFieldError('quote');
                    }}
                    placeholder="120"
                    className={`${fieldClass} mt-1.5 ${fieldErrors.quote ? invalidFieldClass : ''}`}
                    aria-invalid={Boolean(fieldErrors.quote)}
                    aria-describedby={fieldErrors.quote ? 'vendor-quote-error' : undefined}
                    data-testid="vendor-quote-low"
                  />
                </label>
                <label className="block">
                  <FieldLabel>High ({brief.quoteCurrency})</FieldLabel>
                  <input
                    type="number"
                    min={0}
                    inputMode="decimal"
                    value={quoteHigh}
                    onChange={(event) => {
                      setQuoteHigh(event.target.value);
                      clearFieldError('quote');
                    }}
                    placeholder="260"
                    className={`${fieldClass} mt-1.5 ${fieldErrors.quote ? invalidFieldClass : ''}`}
                    aria-invalid={Boolean(fieldErrors.quote)}
                    aria-describedby={fieldErrors.quote ? 'vendor-quote-error' : undefined}
                    data-testid="vendor-quote-high"
                  />
                </label>
              </div>
              <FieldError id="vendor-quote-error" className="mt-1.5">
                {fieldErrors.quote}
              </FieldError>
              <p className="mt-2 text-xs text-slate-400">
                Include everything — travel and diagnosis time too. The manager sees one number, so
                a separate call-out charge only makes your quote look more expensive.
              </p>
              </>
              )}

              <label className="mt-4 block">
                <FieldLabel>Scope notes</FieldLabel>
                <Textarea
                  value={quoteNotes}
                  onChange={(event) => setQuoteNotes(event.target.value)}
                  maxLength={1000}
                  rows={3}
                  placeholder="What's included, parts you'd need to source, anything you'd want confirmed first…"
                  className="mt-1.5 border-slate-200 bg-white"
                  data-testid="vendor-quote-notes"
                />
                <div className="mt-1 text-right text-[11px] text-slate-400">
                  {quoteNotes.length}/1000
                </div>
              </label>
            </section>

            {/* Locked details */}
            <section className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center">
              <Lock className="mx-auto h-6 w-6 text-slate-400" aria-hidden="true" />
              <h2 className="mt-2 text-sm font-semibold text-slate-700">Unit &amp; access details</h2>
              <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
                The exact address, unit number, tenant contact and entry instructions are revealed as
                soon as you accept.
              </p>
            </section>

            {/* Decision */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              {/* flex-1 is applied only from `sm` up. This container is
                  flex-col on mobile, where flex-1 governs the vertical axis and
                  would fight h-12, shrinking the tap target below 48px. */}
              <div className="flex flex-col gap-3 sm:flex-row-reverse">
                <Button
                  onClick={() => void submit('accepted')}
                  disabled={submitting !== null}
                  className="h-12 gap-2 bg-[#137fec] text-base font-semibold hover:bg-[#137fec]/90 sm:flex-1"
                  data-testid="vendor-accept"
                >
                  {submitting === 'accepted' ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  )}
                  Accept job
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowDecline((open) => !open)}
                  disabled={submitting !== null}
                  className="h-12 border-slate-200 bg-white text-base text-slate-700 sm:flex-1"
                  data-testid="vendor-decline"
                >
                  Decline
                </Button>
              </div>

              {showDecline ? (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <FieldLabel>Reason (optional)</FieldLabel>
                  <Textarea
                    value={declineReason}
                    onChange={(event) => setDeclineReason(event.target.value)}
                    maxLength={500}
                    rows={3}
                    placeholder="Fully booked this week, outside my service area, not my trade…"
                    className="mt-1.5 border-slate-200 bg-white"
                    data-testid="vendor-decline-reason"
                  />
                  <Button
                    onClick={() => void submit('declined')}
                    disabled={submitting !== null}
                    className="mt-3 gap-2 bg-rose-600 text-white hover:bg-rose-700"
                    data-testid="vendor-decline-confirm"
                  >
                    {submitting === 'declined' ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <XCircle className="h-4 w-4" aria-hidden="true" />
                    )}
                    Confirm decline
                  </Button>
                </div>
              ) : null}

              {brief.responseDeadlineAt ? (
                <p className="mt-4 text-center text-xs text-slate-400">
                  Please respond by{' '}
                  {new Date(brief.responseDeadlineAt).toLocaleString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                  .
                </p>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </PageShell>
  );
}
