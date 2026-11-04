import { TENANT_FIELD } from '../tenant/tenantPresentation';
import { HackathonBadge } from '../judge/JudgeBadges';
import { D3_FIELD } from '../request-detail/d3Presentation';
import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { BookingAPI } from '../../api/client';
import type { BookingPayload, TimeWindow } from '../../types/booking';
import { Button } from '../ui/button';
import { FieldError, invalidFieldClass } from '../ui/FieldError';
import AvailabilityPreview from './AvailabilityPreview';
import DemoVisitChangeExamples from './DemoVisitChangeExamples';
import { emptyDemoWindows } from './demoReschedulePrefill';
import {
  actionKeyFor, checkReason, checkWindows, classifyFailure, deviceWallClockLabel, toLocalInput, type ActionKey, type Failure, type WindowRow,
} from './rescheduleModel';
import { changeFieldClass, changeHintClass, changeInputClass, changeLabelClass } from './rescheduleUi';

/** The property manager's reasoned request to move a confirmed visit. Sending
 * it opens a request only: the booked visit stays until the vendor and the
 * tenant each confirm one exact new time. */
export default function RescheduleRequestForm({ requestId, revision, onSent, onReconcile, onCancel }: {
  requestId: string; revision: number; onSent: (data: BookingPayload) => void;
  onReconcile: () => Promise<void>; onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [rows, setRows] = useState<WindowRow[]>([{ start: '', end: '' }]);
  const [reasonError, setReasonError] = useState('');
  const [rowErrors, setRowErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [actionKey, setActionKey] = useState<ActionKey>(null);
  const zone = deviceWallClockLabel();
  const apply = (windows: TimeWindow[]) => {
    setRows(windows.slice(0, 3).map(window => ({ start: toLocalInput(window.start), end: toLocalInput(window.end) })));
    setRowErrors([]);
  };
  const submit = async () => {
    const reasonProblem = checkReason(reason);
    const checked = checkWindows(rows);
    setReasonError(reasonProblem); setRowErrors(checked.errors);
    if (reasonProblem || checked.summary) return;
    const body = { action: 'request_reschedule' as const, revision, reason, windows: checked.windows };
    // Same body, same key: a retry after an unknown outcome cannot open a second request.
    const key = actionKeyFor(actionKey, JSON.stringify({ revision, reason, windows: checked.windows }));
    setActionKey(key); setBusy(true); setFailure(null);
    try {
      const result = await BookingAPI.changeVisit(requestId, { ...body, clientActionId: key.key });
      setActionKey(null);
      if (result.data) onSent(result.data);
    } catch (error) {
      const classified = classifyFailure(error);
      if (classified.kind !== 'unknown') setActionKey(null);
      setFailure(classified);
      await onReconcile();
    } finally { setBusy(false); }
  };
  return <form className="mt-4 space-y-4 rounded-lg border border-slate-300 p-4 in-[.lichen-d3]:border-control-border in-[.lichen-d5]:border-control-border" noValidate data-testid="visit-change-form"
    aria-labelledby={`${id}-title`} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div>
      <h3 id={`${id}-title`} className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink"><span>Request a different visit time</span><HackathonBadge /></h3>
      <p className={`mt-1 ${changeHintClass} in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta`}>The booked visit stays in place until the vendor and the tenant each confirm one exact new time. If either declines, or they have not both confirmed in time, the original visit is kept. Answers close two hours before the booked visit or the proposed time, whichever is earlier.</p>
    </div>
    <DemoVisitChangeExamples requestId={requestId} revision={revision} reason={reason} rows={rows} disabled={busy}
      onReason={example => setReason(current => current.length === 0 ? example : current)}
      onWindows={examples => setRows(current => emptyDemoWindows(current) ? examples : current)} />
    <div>
      <label className={`${changeLabelClass} in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink`} htmlFor={`${id}-reason`}>Why does the visit need to move?</label>
      <p id={`${id}-reason-hint`} className={`${changeHintClass} in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta`}>The vendor and the tenant will see this. {reason.length}/800 characters.</p>
      <textarea id={`${id}-reason`} rows={3} maxLength={800} value={reason} onChange={event => setReason(event.target.value)}
        aria-invalid={!!reasonError} aria-describedby={`${id}-reason-hint${reasonError ? ` ${id}-reason-error` : ''}`}
        className={[`${changeFieldClass} mt-1 py-2 ${reasonError ? invalidFieldClass : ''}`, D3_FIELD, TENANT_FIELD].join(' ')} data-testid="visit-change-reason-input" />
      <FieldError id={`${id}-reason-error`} className="mt-1">{reasonError}</FieldError>
    </div>
    <AvailabilityPreview target={{ requestId }} mode="windows" onApply={apply}
      label="Describe when the new visit could happen (optional)" />
    <fieldset className="min-w-0 space-y-3">
      <legend className="text-sm font-medium text-slate-800 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">Suggested windows, in this device’s time zone ({zone})</legend>
      <p className={`${changeHintClass} in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta`}>Enter one to three windows. They start in the future, last at least 15 minutes and end within 60 days. A window is when the visit could start or happen, not how long the work takes.</p>
      {rows.map((row, index) => <div key={index} className="min-w-0 rounded-md border border-slate-200 p-3 in-[.lichen-d3]:border-border in-[.lichen-d5]:border-border">
        <p className="text-sm font-medium text-slate-800 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">Window {index + 1}</p>
        <div className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2">
          {(['start', 'end'] as const).map(field => <div key={field} className="min-w-0">
            <label className={`${changeLabelClass} in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink`} htmlFor={`${id}-w${index}-${field}`}>{field === 'start' ? 'From' : 'Until'}</label>
            <input id={`${id}-w${index}-${field}`} type="datetime-local" value={row[field]}
              aria-invalid={!!rowErrors[index]} aria-describedby={rowErrors[index] ? `${id}-w${index}-error` : undefined}
              onChange={event => setRows(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: event.target.value } : item))}
              className={[`${changeInputClass} mt-1 ${rowErrors[index] ? invalidFieldClass : ''}`, D3_FIELD, TENANT_FIELD].join(' ')} data-testid={`visit-change-window-${index}-${field}`} />
          </div>)}
        </div>
        <FieldError id={`${id}-w${index}-error`} className="mt-2">{rowErrors[index]}</FieldError>
        {rows.length > 1 && <Button type="button" variant="ghost" size="sm" className="mt-2"
          onClick={() => { setRows(current => current.filter((_, itemIndex) => itemIndex !== index)); setRowErrors([]); }}>Remove window {index + 1}</Button>}
      </div>)}
      {rows.length < 3 && <Button type="button" variant="outline" onClick={() => setRows(current => [...current, { start: '', end: '' }])}>Add another window</Button>}
    </fieldset>
    {failure && <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text in-[.lichen-d5]:border-lichen-line in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-lichen-text" data-testid="visit-change-form-failure">
      {failure.message}{failure.kind === 'unknown' && ' Sending the same request again is safe; it will not create a second one.'}
    </div>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={busy} data-testid="visit-change-send">
        {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}Send change request</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Keep the current visit</Button>
    </div>
  </form>;
}
