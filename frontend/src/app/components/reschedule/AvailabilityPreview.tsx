import { D3_FIELD } from '../request-detail/d3Presentation';
import { TENANT_FIELD } from '../tenant/tenantPresentation';
import { useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { BookingAPI } from '../../api/client';
import type { AvailabilityPreview as Preview, TimeWindow } from '../../types/booking';
import { Button } from '../ui/button';
import { FieldError, invalidFieldClass } from '../ui/FieldError';
import { deviceZone, formatSlot, isValidZone } from './rescheduleModel';
import { changeFieldClass, changeHintClass, changeInputClass, changeLabelClass, wrapButtonClass } from './rescheduleUi';

export const SOURCE_LABEL: Record<Preview['source'], string> = {
  local_rules: 'Read by fixed date rules on Artrelo’s server. No AI was used.',
  development_stub: 'Read by a development test stub, not a live AI model.',
};

/** Shows what a preview found, with the zone it was read in. Nothing here is
 * scheduled; the reader must apply it to the form and then send separately. */
export function PreviewResult({ preview, mode, onApply }: {
  preview: Preview; mode: 'windows' | 'start'; onApply?: (windows: TimeWindow[]) => void;
}) {
  const zone = preview.timeZone || 'UTC';
  if (preview.needsClarification || !preview.windows.length) {
    return <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text in-[.lichen-d5]:border-lichen-line in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-lichen-text" data-testid="availability-clarification">
      <p className="font-medium">No times were read from that text.</p>
      <p className="mt-1">{preview.question || 'Try a specific date with both start and end times, or enter exact times below.'}</p>
      {preview.modelStatus === 'unavailable' && <p className="mt-1">{preview.explanation}</p>}
    </div>;
  }
  return <div className="rounded-md border border-slate-300 bg-slate-50 p-3 text-sm in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-well in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-well" data-testid="availability-result">
    <p className="font-medium text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">Review these exact times before using them</p>
    <ol className="mt-2 space-y-2">
      {preview.windows.map((window, index) => <li key={`${window.start}-${index}`} className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words">{formatSlot(window, zone)}</span>
        {mode === 'start' && onApply && <Button type="button" size="sm" variant="outline" onClick={() => onApply([window])}
          data-testid={`availability-use-${index}`}>Use this start time</Button>}
      </li>)}
    </ol>
    <p className={`mt-2 ${changeHintClass} in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta`}>{SOURCE_LABEL[preview.source]}{preview.modelStatus === 'unavailable' && preview.explanation ? ` ${preview.explanation}` : ''}</p>
    {mode === 'windows' && onApply && <Button type="button" variant="outline" className={`mt-3 ${wrapButtonClass}`} onClick={() => onApply(preview.windows)}
      data-testid="availability-apply">Put these times in the form</Button>}
    {onApply && <p className={`mt-2 ${changeHintClass}`}>The exact fields use this device's local clock. Applying these times changes their display, not the instants.</p>}
  </div>;
}

export default function AvailabilityPreview({ target, mode, onApply, label }: {
  target: { requestId: string } | { token: string }; mode: 'windows' | 'start';
  onApply: (windows: TimeWindow[]) => void; label: string;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [zone, setZone] = useState(deviceZone);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [zoneError, setZoneError] = useState('');
  const run = async () => {
    setError(''); setPreview(null);
    if (!isValidZone(zone)) { setZoneError('Enter a time zone such as America/Regina.'); return; }
    setZoneError('');
    if (!text.trim()) { setError('Describe when, for example: tomorrow 2pm to 4pm.'); return; }
    setBusy(true);
    try {
      const result = await BookingAPI.availability(target, { text, timeZone: zone.trim() });
      if (result.data) setPreview(result.data); else setError('The preview is unavailable. Enter exact times below.');
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? `${failure.message} Enter exact times below instead.` : 'The preview is unavailable. Enter exact times below.');
    } finally { setBusy(false); }
  };
  return <div className="space-y-3 rounded-lg border border-slate-200 p-3 sm:p-4 in-[.lichen-d3]:border-border in-[.lichen-d5]:border-border" data-testid="availability-preview">
    <div>
      <label className={`${changeLabelClass} in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink`} htmlFor={`${id}-text`}>{label}</label>
      <p id={`${id}-hint`} className={`${changeHintClass} in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta`}>Examples: “tomorrow 2pm to 4pm”, “Friday from 09:00 to 12:00”, “2026-10-30 between 9am and 11am”. Separate up to three windows with semicolons.</p>
      <textarea id={`${id}-text`} rows={2} maxLength={800} value={text} onChange={event => setText(event.target.value)}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`} aria-invalid={!!error}
        className={[`${changeFieldClass} mt-1 py-2 ${error ? invalidFieldClass : ''}`, D3_FIELD, TENANT_FIELD].join(' ')} data-testid="availability-text" />
      <FieldError id={`${id}-error`} className="mt-1">{error}</FieldError>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1 basis-48">
        <label className={`${changeLabelClass} in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink`} htmlFor={`${id}-zone`}>Preview time zone</label>
        <input id={`${id}-zone`} value={zone} onChange={event => setZone(event.target.value)} autoComplete="off" spellCheck={false}
          aria-invalid={!!zoneError} aria-describedby={zoneError ? `${id}-zone-error` : undefined}
          className={[`${changeInputClass} mt-1 ${zoneError ? invalidFieldClass : ''}`, D3_FIELD, TENANT_FIELD].join(' ')} data-testid="availability-zone" />
        <FieldError id={`${id}-zone-error`} className="mt-1">{zoneError}</FieldError>
        <p className={`mt-1 ${changeHintClass}`}>The preview reads your text in this zone. Exact date and time fields use this device's local clock.</p>
      </div>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void run()} data-testid="availability-run">
        {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}Preview times
      </Button>
    </div>
    <div aria-live="polite">{busy ? <p className={`${changeHintClass} in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta`}>Reading the times…</p> : preview &&
      <PreviewResult preview={preview} mode={mode} onApply={windows => { onApply(windows); }} />}</div>
  </div>;
}
