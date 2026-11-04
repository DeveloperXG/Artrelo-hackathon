import { TENANT_FIELD } from './tenant/tenantPresentation';
import { D3_FIELD } from './request-detail/d3Presentation';
import { useState } from 'react';
import { BookingAPI } from '../api/client';
import { Button } from './ui/button';
import { fieldClass } from './landlord/landlordUi';
import { toast } from 'sonner';
export type ClosedOffer = { ref: string; vendorName: string; previousQuote: number | null };
export default function NegotiatedReturnPanel({ requestId, requestStatus, archivedAt, history, onChanged }: {
  requestId: string; requestStatus: string; archivedAt?: string | null; history: ClosedOffer[]; onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState(''), [amount, setAmount] = useState(''), [start, setStart] = useState('');
  const [duration, setDuration] = useState(120), [acknowledged, setAcknowledged] = useState(false);
  if (!history.length || archivedAt || ['completed', 'cancelled', 'rejected'].includes(requestStatus)) return null;
  return <section className="min-w-0 rounded-2xl border bg-white p-5 shadow-sm in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-card in-[.lichen-d3]:shadow-none in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-card in-[.lichen-d5]:shadow-none">
    <h2 className="font-semibold">Return to a previous vendor</h2>
    <p className="mt-1 text-sm text-slate-600 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">If you reached a new agreement, send a fresh offer for the vendor to confirm. An existing booked visit must be cancelled first.</p>
    <Button className="mt-3" variant="outline" onClick={() => setOpen(!open)}>Record a new agreement</Button>
    {open && <form className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2" onSubmit={async event => {
      event.preventDefault(); setBusy(true);
      try { await BookingAPI.returnToVendor(requestId, { outreachRef: offer, amount: Number(amount), start: new Date(start).toISOString(), durationMinutes: duration });
        toast.success('Fresh offer prepared. The vendor must reconfirm before booking.'); setOpen(false); onChanged?.();
      } catch (failure) { toast.error(failure instanceof Error ? failure.message : 'Could not prepare the offer'); }
      finally { setBusy(false); }
    }}>
      <label className="min-w-0 text-sm">Vendor<select required className={[`${fieldClass} mt-1 w-full`, D3_FIELD, TENANT_FIELD].join(' ')} value={offer} onChange={event => {
        setOffer(event.target.value); const previous = history.find(row => row.ref === event.target.value);
        setAmount(previous?.previousQuote == null ? '' : String(previous.previousQuote));
      }}><option value="">Choose a previous vendor</option>{history.map(row => <option key={row.ref} value={row.ref}>{row.vendorName}</option>)}</select></label>
      <label className="text-sm">Agreed total (CAD)<input required type="number" min="0" step="0.01" className={[`${fieldClass} mt-1 w-full`, D3_FIELD, TENANT_FIELD].join(' ')} value={amount} onChange={event => setAmount(event.target.value)} /></label>
      <label className="min-w-0 text-sm">Agreed arrival ({Intl.DateTimeFormat().resolvedOptions().timeZone})<input required type="datetime-local" className={[`${fieldClass} mt-1 w-full min-w-0 max-w-full appearance-none`, D3_FIELD, TENANT_FIELD].join(' ')} value={start} onChange={event => setStart(event.target.value)} /></label>
      <label className="text-sm">Duration (minutes)<input required type="number" min="15" max="720" step="15" className={[`${fieldClass} mt-1 w-full`, D3_FIELD, TENANT_FIELD].join(' ')} value={duration} onChange={event => setDuration(Number(event.target.value))} /></label>
      <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" required checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I authorize this price and understand that any competing unbooked proposal will be withdrawn. The vendor and tenant must confirm the new visit.</label>
      <Button disabled={busy || !acknowledged} type="submit">Send fresh offer</Button>
    </form>}
  </section>;
}
