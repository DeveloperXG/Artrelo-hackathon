import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { VendorHubAPI } from '../../api/client';
import type { BusyTime } from '../../types/booking';
import { Button } from '../../components/ui/button';
import { fieldClass } from '../../components/landlord/landlordUi';
export default function VendorBusyTimes() {
  const [rows, setRows] = useState<BusyTime[]>([]);
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = useCallback(async () => {
    try { const result = await VendorHubAPI.busyTimes(); setRows(result.data || []); setError(''); }
    catch { setError('Your unavailable periods could not be loaded.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="vendor-busy-title">
    <div><h2 id="vendor-busy-title" className="text-lg font-semibold">Unavailable periods</h2><p className="mt-1 text-sm text-slate-500">Block time for jobs outside Artrelo. This applies across your Artrelo jobs; customers see only that the time is unavailable.</p></div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <form className="space-y-3" onSubmit={async event => {
      event.preventDefault(); setBusy(true);
      try { await VendorHubAPI.addBusyTime({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), note });
        setStart(''); setEnd(''); setNote(''); await load(); toast.success('Time marked unavailable.'); }
      catch (failure) { toast.error(failure instanceof Error ? failure.message : 'Could not block this time'); }
      finally { setBusy(false); }
    }}>
      <p className="text-xs text-slate-500">Times use your device time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-sm">From<input aria-label="Unavailable from" required type="datetime-local" value={start} onChange={event => setStart(event.target.value)} className={`${fieldClass} mt-1 min-w-0 max-w-full appearance-none`} /></label>
        <label className="min-w-0 text-sm">Until<input aria-label="Unavailable until" required type="datetime-local" value={end} onChange={event => setEnd(event.target.value)} className={`${fieldClass} mt-1 min-w-0 max-w-full appearance-none`} /></label>
      </div>
      <label className="block text-sm">Private note (optional)<input maxLength={200} className={`${fieldClass} mt-1`} value={note} onChange={event => setNote(event.target.value)} /></label>
      <Button disabled={busy}>Block time</Button>
    </form>
    <ul className="space-y-2">{rows.map(row => <li key={row.ref} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 text-sm"><div className="min-w-0 break-words"><p>{new Date(row.start).toLocaleString()} – {new Date(row.end).toLocaleString()}</p>{row.note && <p className="mt-1 text-slate-500">{row.note}</p>}</div><Button variant="outline" disabled={busy} onClick={async () => {
      setBusy(true); try { await VendorHubAPI.removeBusyTime(row.ref); await load(); }
      catch (failure) { toast.error(failure instanceof Error ? failure.message : 'Could not remove this period'); } finally { setBusy(false); }
    }}>Remove period</Button></li>)}</ul>
  </section>;
}
