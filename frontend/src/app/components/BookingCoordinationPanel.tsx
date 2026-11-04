import { TENANT_FIELD, useTenantPresentation } from './tenant/tenantPresentation';
import { D3_FIELD } from './request-detail/d3Presentation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SimulatedVendorBadge } from './judge/JudgeBadges';
import { Link } from 'react-router-dom';
import { CalendarClock, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { BookingAPI } from '../api/client';
import type { BookingPayload, BookingPhase, RescheduleView } from '../types/booking';
import { useLiveTopic } from '../hooks/useLiveTopic';
import { Button } from './ui/button';
import { fieldClass } from './landlord/landlordUi';
import NegotiatedReturnPanel from './NegotiatedReturnPanel';
import RescheduleCard, { type ChangeAction } from './reschedule/RescheduleCard';
import RescheduleRequestForm from './reschedule/RescheduleRequestForm';
import {
  changeAnnouncement, changeSignature, classifyFailure, headline, panelControls, partyActionBody, receiptMessage, requestBlockedReason,
} from './reschedule/rescheduleModel';

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
export function VisitSchedule({ phase, arrivalAt, durationMinutes }: {
  phase: BookingPhase; arrivalAt?: string | null; durationMinutes?: number | null;
}) {
  const arrival = arrivalAt ? new Date(arrivalAt) : null;
  if (!arrival || !Number.isFinite(arrival.getTime())) return null;
  const label = ['closed', 'expired'].includes(phase) ? 'Previous arrival' : phase === 'scheduled' ? 'Confirmed arrival' : 'Proposed arrival';
  const hours = durationMinutes ? Math.floor(durationMinutes / 60) : 0;
  const minutes = durationMinutes ? durationMinutes % 60 : 0;
  const duration = [hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '', minutes ? `${minutes} minutes` : ''].filter(Boolean).join(' ');
  return <div className="mt-2 space-y-1 text-sm text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">
    <p>{label}: <time dateTime={arrival.toISOString()}>{arrival.toLocaleString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    })}</time></p>
    {duration && <p>Duration: {duration}</p>}
  </div>;
}
export default function BookingCoordinationPanel({ requestId, requestStatus, archivedAt, audience, onChanged }: {
  requestId: string; requestStatus: string; archivedAt?: string | null; audience: 'tenant' | 'landlord'; onChanged?: () => void;
}) {
  const [data, setData] = useState<BookingPayload | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [showChangeForm, setShowChangeForm] = useState(false);
  const [accessConfirmed, setAccessConfirmed] = useState(false);
  const [windows, setWindows] = useState([{ start: '', end: '' }]);
  // One message at a time: the receipt of the user's own action, or a refusal.
  const [notice, setNotice] = useState<{ tone: 'status' | 'alert'; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const tenantPresentation = useTenantPresentation();
  const panel = useRef<HTMLElement>(null);
  const focusIntent = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!tenantPresentation || !focusIntent.current) return;
    const frame = requestAnimationFrame(() => {
      const current = document.activeElement;
      if (!document.querySelector('[role=dialog],[role=alertdialog]') &&
          (current === panel.current || [document.body, document.documentElement].includes(current as HTMLElement))) {
        const original = focusIntent.current;
        const destination = busy ? panel.current : original?.isConnected && !original.disabled ? original :
          panel.current?.querySelector<HTMLElement>('[data-testid=visit-change-open]');
        destination?.focus();
      }
      if (!busy) focusIntent.current = null;
    });
    const cancel = () => { focusIntent.current = null; };
    if (busy) for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, cancel, true);
    return () => {
      cancelAnimationFrame(frame);
      for (const type of ['pointerdown', 'keydown']) document.removeEventListener(type, cancel, true);
    };
  }, [tenantPresentation, busy, data, showChangeForm]);
  const signature = useRef<string | null>(null);
  const accept = useCallback((next: BookingPayload | null) => {
    setAnnouncement(changeAnnouncement(signature.current, next?.reschedules));
    signature.current = changeSignature(next?.reschedules);
    setData(next);
  }, []);
  const load = useCallback(async () => {
    try { const result = await BookingAPI.get(requestId); accept(result.data || null); setError(''); }
    catch { setError('Visit coordination could not be loaded. Refresh to try again.'); }
  }, [requestId, accept]);
  useEffect(() => { void load(); }, [load]);
  useLiveTopic(`request:${requestId}`, () => { void load(); });
  const submit = async (action: 'confirm' | 'alternatives') => {
    if (!data?.coordination) return;
    setBusy(true);
    try {
      const result = await BookingAPI.respond(requestId, { action, revision: data.coordination.revision,
        accessConfirmed, ...(action === 'alternatives' ? { windows: windows.map(window => ({
          start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() })) } : {}) });
      accept(result.data || null); setShowAlternatives(false); setAccessConfirmed(false);
      toast.success(action === 'confirm' ? 'Visit confirmed.' : 'Your alternatives have been sent to the vendor.');
      onChanged?.();
    } catch (failure) { toast.error(failure instanceof Error ? failure.message : 'Could not update this visit'); await load(); }
    finally { setBusy(false); }
  };
  const act = async (change: RescheduleView, action: ChangeAction) => {
    const body = partyActionBody(change, action);
    if (!body) return;
    setBusy(true); setNotice(null);
    try {
      const result = await BookingAPI.changeVisit(requestId, body);
      accept(result.data || null);
      const receipt = result.data?.receipt;
      const latest = result.data?.reschedules?.find(item => item.ref === receipt?.proposalRef);
      // HTTP 200 alone proves nothing: the receipt says what actually happened.
      setNotice(receipt ? { tone: ['conflict', 'invalidated', 'expired'].includes(receipt.status) ? 'alert' : 'status',
        text: receiptMessage(receipt, latest?.proposed) } : { tone: 'alert', text: 'No receipt came back. Refreshed to show the current state.' });
      if (!receipt) await load();
      onChanged?.();
    } catch (failure) {
      setNotice({ tone: 'alert', text: classifyFailure(failure).message });
      await load();
    } finally { setBusy(false); }
  };
  if (!data && !error) return null;
  if (error && !data) return <div role="alert" className="rounded-2xl border bg-white p-5 text-sm in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-card in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-card">{error} <Button variant="outline" onClick={() => void load()}>Refresh</Button></div>;
  if (!data) return null;
  const history = audience === 'landlord' ? <NegotiatedReturnPanel requestId={requestId} requestStatus={requestStatus} archivedAt={archivedAt} history={data.history || []} onChanged={() => { void load(); onChanged?.(); }} /> : null;
  if (!data.coordination) return history;
  const state = data.coordination;
  const controls = panelControls(data, audience);
  const pending = controls.active;
  const capability = state.capabilities?.state;
  return <div className="space-y-4"><section ref={panel} tabIndex={tenantPresentation ? -1 : undefined} aria-busy={tenantPresentation && busy ? true : undefined} onClickCapture={tenantPresentation ? event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (button instanceof HTMLButtonElement) focusIntent.current = button;
  } : undefined} id="visit-coordination" aria-labelledby="visit-coordination-title" className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:shadow-none in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card in-[.lichen-d5]:shadow-none" data-testid="booking-coordination" data-state={capability || 'legacy'}>
    {/* The icon moves above the text only when not even its longest word fits beside it. */}
    <div className="flex flex-wrap items-start gap-3"><CalendarClock className="mt-1 h-5 w-5 shrink-0 text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta" aria-hidden="true" /><div className="min-w-0 flex-1 basis-[min-content] in-[.lichen-d5]:basis-56">
      <h2 id="visit-coordination-title" className="break-words text-lg font-semibold">Visit coordination</h2>
      <p className="mt-1 font-medium" data-testid="booking-headline">{headline(state.phase, state.capabilities)}</p>
      <VisitSchedule phase={state.phase} arrivalAt={state.arrivalAt} durationMinutes={state.durationMinutes} />
      {pending && <p className="mt-1 text-sm font-medium text-slate-800 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink" data-testid="booking-original-kept">This visit stays booked while the change request below is open.</p>}
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta"><span className="min-w-0">{data.vendorName}</span><SimulatedVendorBadge vendorId={data.vendorId} /></p>
    </div></div>
    {controls.legacyReadOnly && <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-well in-[.lichen-d5]:text-ink" data-testid="booking-legacy">Visit actions are unavailable for this record right now. Refresh to load its current state.</p>}
    {audience === 'landlord' && state.phase === 'awaiting_funds' && <div className="mt-3 rounded-xl bg-amber-50 p-4 text-sm in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-lichen-tint">
      <p>{state.reasonCode === 'insufficient_funds' ? `Add $${Number(state.shortfall || 0).toFixed(2)} to reserve the agreed amount. The visit is not booked yet.` : 'Your wallet needs attention before a new platform-paid booking can be confirmed.'}</p>
      <Link to="/dashboard/wallet" className="mt-2 inline-block font-semibold text-blue-700 underline in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">Open Payments</Link>
    </div>}
    {capability === 'awaiting_confirmation' && ['awaiting_vendor', 'awaiting_tenant'].includes(state.phase) && <p className="mt-3 text-sm text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">{state.phase === 'awaiting_vendor' ? 'The previous time is not booked. We will ask you to confirm the vendor’s next proposal.' : 'Confirm this exact arrival time, or suggest alternatives. The vendor will be told once the visit is confirmed.'}</p>}
    {audience === 'landlord' && controls.canConfirmInitial && <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={accessConfirmed} onChange={event => setAccessConfirmed(event.target.checked)} />I have confirmed the tenant’s permission for this visit.</label>}
    <div className="mt-4 flex flex-wrap gap-2">
      {controls.canConfirmInitial && <Button disabled={busy || (audience === 'landlord' && !accessConfirmed)} onClick={() => void submit('confirm')}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />}Confirm visit</Button>}
      {controls.canSuggestInitialAlternatives && <Button variant="outline" disabled={busy} onClick={() => setShowAlternatives(value => !value)}>Suggest another time</Button>}
      {controls.canRequestReschedule && !showChangeForm && <Button variant="outline" disabled={busy} onClick={() => { setShowChangeForm(true); setNotice(null); }} data-testid="visit-change-open">Request a different time</Button>}
    </div>
    {!pending && requestBlockedReason(state.capabilities, audience) && <p className="mt-3 text-sm text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink" data-testid="visit-change-closed">{requestBlockedReason(state.capabilities, audience)}</p>}
    {showAlternatives && controls.canSuggestInitialAlternatives && <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); void submit('alternatives'); }}>
      <p className="text-sm text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">Choose up to three windows in your device time zone ({localZone}). We will coordinate with the vendor; you will confirm their exact arrival.</p>
      {windows.map((window, index) => <fieldset key={index} className="grid min-w-0 gap-3 sm:grid-cols-2"><legend className="mb-2 text-sm font-medium">Alternative {index + 1}</legend>
        {(['start', 'end'] as const).map(field => <label key={field} className="min-w-0 text-sm">{field === 'start' ? 'From' : 'Until'}
          <input aria-label={`Alternative ${index + 1} ${field}`} required type="datetime-local" className={[`${fieldClass} mt-1 min-w-0 max-w-full appearance-none`, D3_FIELD, TENANT_FIELD].join(' ')} value={window[field]}
            onChange={event => setWindows(rows => rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: event.target.value } : row))} />
        </label>)}
      </fieldset>)}
      <div className="flex flex-wrap gap-2">{windows.length < 3 && <Button type="button" variant="outline" onClick={() => setWindows(rows => [...rows, { start: '', end: '' }])}>Add another window</Button>}
        <Button type="submit" disabled={busy}>Send alternatives</Button></div>
    </form>}
    {showChangeForm && controls.canRequestReschedule && <RescheduleRequestForm requestId={requestId} revision={state.revision}
      onSent={next => { accept(next); setShowChangeForm(false);
        if (next.receipt) setNotice({ tone: 'status', text: receiptMessage(next.receipt) }); onChanged?.(); }}
      onReconcile={load} onCancel={() => setShowChangeForm(false)} />}
    <div aria-live="polite" className="sr-only" data-testid="visit-change-announcement">{announcement}</div>
    {notice && <p role={notice.tone} className={`mt-4 rounded-md border p-3 text-sm ${notice.tone === 'alert' ? "border-amber-300 bg-amber-50 text-amber-950 in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text in-[.lichen-d5]:border-lichen-line in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-lichen-text" : "border-slate-300 bg-slate-50 text-slate-800 in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-well in-[.lichen-d5]:text-ink"}`} data-testid="visit-change-notice">{notice.text}</p>}
    {pending && <div className="mt-4"><RescheduleCard change={pending} audience={audience} busy={busy} onAct={action => void act(pending, action)} /></div>}
    {!!controls.past.length && <details className="mt-4 text-sm"><summary className="cursor-pointer rounded-sm font-medium text-slate-800 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">Earlier change requests ({controls.past.length})</summary>
      <div className="mt-3 space-y-3">{controls.past.map(change => <RescheduleCard key={change.ref} change={change} audience={audience} compact />)}</div>
    </details>}
    {data.deliveryIssues?.map(issue => <div key={issue.ref} role="alert" className="mt-3 rounded-xl bg-amber-50 p-3 text-sm in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-lichen-tint">
      The {issue.audience} update could not be confirmed. <Button variant="outline" disabled={busy} onClick={async () => {
        setBusy(true); try { await BookingAPI.retryNotice(requestId, issue.ref); toast.success('Update queued for resend.'); await load(); }
        catch (failure) { toast.error(failure instanceof Error ? failure.message : 'Could not resend'); } finally { setBusy(false); }
      }}>Resend {issue.audience} update</Button>
    </div>)}
  </section>{history}</div>;
}
