import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CalendarClock, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { BookingAPI } from '../../api/client';
import type { RescheduleView, VendorBookingPayload } from '../../types/booking';
import { Button } from '../../components/ui/button';
import { FieldError, invalidFieldClass } from '../../components/ui/FieldError';
import { fieldClass } from '../../components/landlord/landlordUi';
import AvailabilityPreview from '../../components/reschedule/AvailabilityPreview';
import RescheduleCard from '../../components/reschedule/RescheduleCard';
import {
  changeAnnouncement, changeSignature, checkDuration, classifyFailure, deviceZone, formatSlot, fromLocalInput, headline,
  bookedLabel, insideWindows, mergeVendorResponse, receiptMessage, slotMinutes, toLocalInput,
} from '../../components/reschedule/rescheduleModel';
import { changeHintClass, changeInputClass, changeLabelClass } from '../../components/reschedule/rescheduleUi';

/** The vendor's exact answer to a change request: one start and their own
 * on-site duration. Previewing availability fills the start only; it is not a
 * confirmation, and the window length never becomes the labour duration. */
function ConfirmNewTime({ token, change, busy, onConfirm }: {
  token: string; change: RescheduleView; busy: boolean; onConfirm: (start: string, durationMinutes: number) => void;
}) {
  const id = useId();
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState(() => {
    const minutes = slotMinutes(change.original);
    return checkDuration(minutes) ? 120 : minutes;
  });
  const [startError, setStartError] = useState('');
  const [durationError, setDurationError] = useState('');
  const iso = fromLocalInput(start);
  const candidate = iso ? { start: iso, end: new Date(new Date(iso).getTime() + duration * 60000).toISOString() } : null;
  const outside = candidate && !checkDuration(duration) && !insideWindows(candidate, change.windows);
  return <form className="mt-4 space-y-4 border-t border-slate-200 pt-4" noValidate data-testid="vendor-change-confirm-form"
    aria-labelledby={`${id}-title`} onSubmit={event => {
      event.preventDefault();
      const nextStart = !iso ? 'Choose the exact start time.' : new Date(iso).getTime() <= Date.now() ? 'Choose a start time in the future.' : '';
      const nextDuration = checkDuration(duration);
      setStartError(nextStart); setDurationError(nextDuration);
      if (!nextStart && !nextDuration && iso) onConfirm(iso, duration);
    }}>
    <h3 id={`${id}-title`} className="text-base font-semibold text-slate-900">Confirm a new time</h3>
    <AvailabilityPreview target={{ token }} mode="start" label="Describe when you can come (optional)"
      onApply={([window]) => { setStart(toLocalInput(window.start)); setStartError(''); }} />
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <div className="min-w-0">
        <label className={changeLabelClass} htmlFor={`${id}-start`}>Exact arrival ({deviceZone()})</label>
        <input id={`${id}-start`} type="datetime-local" value={start} onChange={event => setStart(event.target.value)}
          aria-invalid={!!startError} aria-describedby={startError ? `${id}-start-error` : undefined}
          className={`${changeInputClass} mt-1 ${startError ? invalidFieldClass : ''}`} data-testid="vendor-change-start" />
        <FieldError id={`${id}-start-error`} className="mt-1">{startError}</FieldError>
      </div>
      <div className="min-w-0">
        <label className={changeLabelClass} htmlFor={`${id}-duration`}>Minutes on site</label>
        <input id={`${id}-duration`} type="number" min={15} max={720} step={15} value={duration}
          onChange={event => setDuration(Number(event.target.value))}
          aria-invalid={!!durationError} aria-describedby={`${id}-duration-hint${durationError ? ` ${id}-duration-error` : ''}`}
          className={`${changeInputClass} mt-1 ${durationError ? invalidFieldClass : ''}`} data-testid="vendor-change-duration" />
        <p id={`${id}-duration-hint`} className={`mt-1 ${changeHintClass}`}>15 to 720 minutes, in steps of 15.</p>
        <FieldError id={`${id}-duration-error`} className="mt-1">{durationError}</FieldError>
      </div>
    </div>
    {candidate && !checkDuration(duration) && <p className="text-sm text-slate-800" data-testid="vendor-change-candidate">
      You are offering {formatSlot(candidate)}.{outside ? ' This is outside the windows the property manager suggested; the tenant still decides.' : ''}</p>}
    <p className={changeHintClass}>Confirming offers this exact time to the tenant. It is not reserved yet, and the original visit stays booked until the tenant confirms. Artrelo checks your calendar first. Choosing an earlier time moves the tenant’s answer deadline to two hours before it.</p>
    <Button type="submit" disabled={busy} data-testid="vendor-change-confirm">
      {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}Confirm this time</Button>
  </form>;
}

export default function VendorSchedulingPage() {
  const { token = '' } = useParams();
  const [data, setData] = useState<VendorBookingPayload | null>(null);
  const [error, setError] = useState('');
  const [start, setStart] = useState('');
  const [duration, setDuration] = useState(120);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'status' | 'alert'; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const signature = useRef<string | null>(null);
  const zone = deviceZone();
  const accept = useCallback((next: VendorBookingPayload | null) => {
    setAnnouncement(changeAnnouncement(signature.current, next?.reschedules));
    signature.current = changeSignature(next?.reschedules);
    setData(next);
  }, []);
  const load = useCallback(async () => {
    try { const result = await BookingAPI.vendorGet(token); accept(result.data || null); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'This scheduling link could not be opened.'); }
  }, [token, accept]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (submitted) return;
    const refresh = () => { void load(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [load, submitted]);
  const change = async (body: Parameters<typeof BookingAPI.vendorChangeVisit>[1]) => {
    setBusy(true); setNotice(null);
    try {
      const result = await BookingAPI.vendorChangeVisit(token, body);
      const merged = mergeVendorResponse(result.data, data);
      if (merged) accept(merged); else await load();
      const receipt = result.data?.receipt;
      const latest = result.data?.reschedules?.find(item => item.ref === receipt?.proposalRef);
      setNotice(receipt ? { tone: ['conflict', 'invalidated', 'expired'].includes(receipt.status) ? 'alert' : 'status',
        text: receiptMessage(receipt, latest?.proposed) } : { tone: 'alert', text: 'No receipt came back. Refreshed to show the current state.' });
      if (!receipt) await load();
    } catch (failure) {
      setNotice({ tone: 'alert', text: classifyFailure(failure).message });
      await load();
    } finally { setBusy(false); }
  };
  const coordination = data?.coordination;
  const capabilities = coordination?.capabilities;
  const active = data?.reschedules?.find(item => item.active) || null;
  const past = (data?.reschedules || []).filter(item => item !== active);
  const booked = coordination?.arrivalAt && coordination.durationMinutes ? { start: coordination.arrivalAt,
    end: new Date(new Date(coordination.arrivalAt).getTime() + coordination.durationMinutes * 60000).toISOString() } : null;
  return <main className="min-h-screen bg-slate-50 px-4 py-8"><div className="mx-auto max-w-xl space-y-5">
    <header className="flex items-center justify-between gap-3"><strong className="text-xl text-slate-900">Artrelo</strong><span className="flex items-center gap-1 text-xs text-slate-600"><ShieldCheck className="h-4 w-4" aria-hidden="true" />Secure scheduling link</span></header>
    {submitted ? <section role="status" className="rounded-2xl border bg-white p-6"><h1 className="text-lg font-semibold">Proposed arrival sent</h1><p className="mt-2 text-sm">We have asked the tenant to confirm your proposed time. Please do not attend until the visit is confirmed. This scheduling link has now been used.</p></section> : error ? <section role="alert" className="rounded-2xl border bg-white p-6"><h1 className="text-lg font-semibold">Scheduling unavailable</h1><p className="mt-2 text-sm">{error}</p></section> : !data ? <Loader2 aria-label="Loading scheduling" className="mx-auto animate-spin motion-reduce:animate-none" /> : !coordination ? <section role="status" className="rounded-2xl border bg-white p-6"><h1 className="text-lg font-semibold">Nothing to schedule</h1><p className="mt-2 text-sm">This job has no visit to arrange right now.</p></section> : <section className="min-w-0 space-y-5 rounded-2xl border bg-white p-5 shadow-sm sm:p-6">
      <div><CalendarClock className="mb-3 h-6 w-6 text-slate-500" aria-hidden="true" /><h1 className="text-xl font-semibold">Arrange the visit</h1><h2 className="mt-2 font-medium">{data.brief.shortTitle}</h2><p className="mt-1 text-sm text-slate-600">{data.brief.summary}</p></div>
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="vendor-booking-state">
        <p className="font-medium text-slate-900">{headline(coordination.phase, capabilities)}</p>
        {booked && <p className="mt-1 break-words text-slate-700">{bookedLabel(capabilities?.state)}: {formatSlot(booked)}</p>}
        {active && <p className="mt-1 font-medium text-slate-800">This visit stays booked unless you and the tenant both confirm the new time below.</p>}
        {!capabilities && <p className="mt-1 text-slate-700" data-testid="vendor-legacy">Visit actions are unavailable for this link right now. Refresh to load its current state.</p>}
        {capabilities?.state === 'awaiting_confirmation' && coordination.phase === 'awaiting_tenant' && <p className="mt-1 text-slate-700">Waiting for the tenant to confirm your proposed time. Please do not attend until the visit is confirmed.</p>}
      </div>
      <div aria-live="polite" className="sr-only">{announcement}</div>
      {notice && <p role={notice.tone} className={`rounded-md border p-3 text-sm ${notice.tone === 'alert' ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-slate-300 bg-slate-50 text-slate-800'}`} data-testid="visit-change-notice">{notice.text}</p>}
      {active && <RescheduleCard change={active} audience="vendor" busy={busy}
        onAct={() => void change({ action: 'decline_reschedule', proposalRef: active.ref, expectedRevision: active.revision })}>
        {active.canVendorConfirm && <ConfirmNewTime key={`${active.ref}-${active.revision}`} token={token} change={active} busy={busy}
          onConfirm={(startAt, minutes) => void change({ action: 'confirm_reschedule', proposalRef: active.ref,
            expectedRevision: active.revision, start: startAt, durationMinutes: minutes })} />}
      </RescheduleCard>}
      {!!coordination.proposals.length && capabilities?.canProposeInitialTime && <div><h3 className="text-sm font-semibold">Tenant’s suggested windows</h3><ul className="mt-2 space-y-2 text-sm">{coordination.proposals.map((window, index) => <li key={index} className="rounded-lg border p-3">{formatSlot(window)}</li>)}</ul></div>}
      {capabilities?.canProposeInitialTime && <form className="space-y-4" onSubmit={async event => {
        event.preventDefault(); setBusy(true);
        try { await BookingAPI.vendorTime(token, { revision: coordination.revision, start: new Date(start).toISOString(), durationMinutes: duration });
          setSubmitted(true); toast.success('Your proposed arrival has been sent for confirmation.'); }
        catch (failure) { toast.error(failure instanceof Error ? failure.message : 'Could not propose this time'); await load(); }
        finally { setBusy(false); }
      }}>
        <p className="text-sm text-slate-700">The previous time is not booked. Choose an arrival time for the tenant to confirm.</p>
        <label className="block min-w-0 text-sm font-medium">Arrival time ({zone})<input required type="datetime-local" className={`${fieldClass} mt-1 min-w-0 max-w-full appearance-none`} value={start} onChange={event => setStart(event.target.value)} /></label>
        <label className="block text-sm font-medium">Minutes on site<input required type="number" min={15} max={720} step={15} className={`${fieldClass} mt-1`} value={duration} onChange={event => setDuration(Number(event.target.value))} /></label>
        <p className="text-xs text-slate-500">Artrelo checks your other visits and busy periods, including time between visits. Proposing a time does not confirm it.</p>
        <Button type="submit" disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />}Propose arrival</Button>
      </form>}
      {!!past.length && <details className="text-sm"><summary className="cursor-pointer rounded-sm font-medium text-slate-800 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900">Earlier change requests ({past.length})</summary>
        <div className="mt-3 space-y-3">{past.map(item => <RescheduleCard key={item.ref} change={item} audience="vendor" compact />)}</div>
      </details>}
    </section>}
  </div></main>;
}
