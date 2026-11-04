import { useEffect, useRef, useState } from 'react';
import { BookingAPI } from '../../api/client';
import { useJudgeSandbox } from '../judge/JudgeSandboxProvider';
import { Button } from '../ui/button';
import { toLocalInput, type WindowRow } from './rescheduleModel';
import { applyDemoReason, demoDraftKey, demoRescheduleScope, emptyDemoWindows, readDemoWindows } from './demoReschedulePrefill';

/** Only editable, unsent examples. Normal request/consent handlers are separate. */
export default function DemoVisitChangeExamples({ requestId, revision, reason, rows, disabled = false, onReason, onWindows }: {
  requestId: string; revision: number; reason: string; rows: WindowRow[];
  onReason: (reason: string) => void; onWindows: (rows: WindowRow[]) => void;
  disabled?: boolean;
}) {
  const { view } = useJudgeSandbox();
  const latest = useRef({ view, requestId, revision, reason, rows, disabled });
  latest.current = { view, requestId, revision, reason, rows, disabled };
  const active = useRef(true), reading = useRef(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  if (!demoRescheduleScope(latest.current)) return null;
  const load = async () => {
    if (reading.current) return;
    reading.current = true; setBusy(true); setMessage('');
    const result = await readDemoWindows({ current: () => latest.current, read: BookingAPI.get });
    reading.current = false;
    if (!active.current) return;
    setBusy(false);
    if (result.kind === 'ready' && demoRescheduleScope(latest.current) === result.scope && demoDraftKey(latest.current) === result.draftKey) {
      onWindows(result.windows.map(window => ({ start: toLocalInput(window.start), end: toLocalInput(window.end) })));
      setMessage('Loaded previously suggested server windows as editable candidates only. Calendar availability is not verified. Review them before sending; nothing was submitted or consented.');
    } else setMessage(result.kind === 'error' ? 'Demo windows could not be loaded. Your input is unchanged; enter exact times manually.' :
      result.kind === 'changed' || result.kind === 'ready' ? 'The request, input or current timing changed. Your input is unchanged; review it and enter times manually.' :
      'No current usable demo window was returned. Your input is unchanged; enter exact times manually. No date or availability has been invented.');
  };
  return <section className="lichen lichen-light space-y-2 rounded-lg border border-hairline bg-well p-3 font-sans text-sm text-ink" aria-label="Synthetic demo examples">
    <p className="text-meta">Demo examples are editable and unsent. A suggested window is not a free-calendar check; the ordinary server checks and both parties’ exact consent still apply.</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" className="h-auto min-h-9 max-w-full whitespace-normal text-left" disabled={busy || reason.length > 0} onClick={() => applyDemoReason(() => latest.current, onReason)}>Use synthetic demo reason</Button>
      <Button type="button" variant="outline" size="sm" className="h-auto min-h-9 max-w-full whitespace-normal text-left" disabled={busy || !emptyDemoWindows(rows)} aria-busy={busy} onClick={() => void load()}>
        {busy ? 'Reading current windows…' : 'Load current demo windows'}
      </Button>
    </div>
    <p role="status" className="text-meta empty:hidden">{message}</p>
  </section>;
}
