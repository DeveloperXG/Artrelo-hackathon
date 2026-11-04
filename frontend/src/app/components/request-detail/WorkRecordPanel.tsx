import { useEffect, useRef, useState } from 'react';
import { HackathonBadge, SimulatedVendorBadge } from '../judge/JudgeBadges';
import { ClipboardList, MapPin, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import { LandlordAPI } from '../../api/client';
import { useLiveTopic } from '../../hooks/useLiveTopic';
import { DetailCard } from './detailUi';
import { Button } from '../ui/button';
import type { PresenceStamp, WorkRecord, WorkVisit } from './workRecordTypes';
import ItemizationBreakdown from '../quotes/ItemizationBreakdown';
import { reviewStateLabel } from '../../lib/costReview';

const when = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not recorded';
const money = (value: number | null, currency = 'CAD') => value == null ? 'Not recorded' :
  new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(value);
const label = (value: string) => value.replace(/_/g, ' ');

function Presence({ title, stamp }: { title: string; stamp: PresenceStamp | null }) {
  return <div className="rounded-xl bg-slate-50 p-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-well">
    <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 in-[.lichen-d3]:text-ink"><MapPin className="h-4 w-4" />{title}</h4>
    <p className="mt-1 text-sm text-slate-600 in-[.lichen-d3]:text-meta">{when(stamp?.at || null)}</p>
    <p className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">{stamp?.source === 'client_reported' ? 'Location reported by vendor; not independent proof of presence.' :
      stamp?.source === 'denied' ? 'Location permission declined.' : 'Location not recorded.'}</p>
    {stamp?.source === 'client_reported' && <details className="mt-2 text-xs text-slate-600 in-[.lichen-d3]:text-meta"><summary className="cursor-pointer">Location details</summary>
      <p className="mt-1">{stamp.lat != null && stamp.lng != null ? `${stamp.lat.toFixed(5)}, ${stamp.lng.toFixed(5)}` : 'Coordinates unavailable'}</p>
      <p>Accuracy: {stamp.accuracyMeters == null ? 'Unknown' : `±${Math.round(stamp.accuracyMeters)} m`}</p>
      <p>Distance from property: {stamp.distanceMeters == null ? 'Unknown' : `${Math.round(stamp.distanceMeters)} m`}</p>
    </details>}
  </div>;
}

export function WorkVisitCard({ visit, number }: { visit: WorkVisit; number: number }) {
  const report = visit.report;
  return <li className="relative min-w-0 pl-7 sm:pl-10">
    <span className="absolute left-0 top-0 flex h-7 w-7 items-center justify-center rounded-full border-4 border-white bg-blue-600 text-xs font-bold text-white in-[.lichen-d3]:border-card in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-chip-icon in-[.lichen-d3]:font-mono">{number}</span>
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 bg-slate-50/60 p-4 sm:p-5 in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-well">
        <div className="min-w-0"><h3 className="flex flex-wrap items-center gap-2 break-words font-semibold text-slate-900 in-[.lichen-d3]:text-ink"><span className="min-w-0">Visit {number} · {visit.vendorName}</span><SimulatedVendorBadge vendorId={visit.vendorId} /></h3>
          <p className="mt-1 text-sm text-slate-500 in-[.lichen-d3]:text-meta">{visit.scheduledStart ? when(visit.scheduledStart) : 'Visit time not recorded'}{visit.scheduledEnd ? ` – ${new Date(visit.scheduledEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</p>
          <p className="mt-1 text-xs text-slate-400 in-[.lichen-d3]:text-meta">Visit ref {visit.id.slice(-8).toUpperCase()}</p></div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold capitalize text-slate-700 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-ink">{label(visit.status)}</span>
      </header>
      <div className="space-y-5 p-4 sm:p-5">
        {visit.noShow && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text">No-show {label(visit.noShow.status)} · {when(visit.noShow.reportedAt)}{visit.noShow.note && <p className="mt-1 whitespace-pre-wrap">{visit.noShow.note}</p>}</div>}
        {visit.failureReason && <p className="text-sm text-amber-800 in-[.lichen-d3]:text-alert-text">Visit ended: {label(visit.failureReason)}</p>}
        <div className="grid gap-3 sm:grid-cols-2"><Presence title="Arrival" stamp={report?.checkIn || null} /><Presence title="Departure" stamp={report?.checkOut || null} /></div>
        {report ? <>
          {report.needsReview && <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text">Completion or payment records need review. Contact Artrelo support before attempting another payment.</p>}
          <div className={`rounded-xl border p-3 text-sm in-[.lichen-d3]:rounded-lg ${report.evidenceVerdict === 'pass' ? "border-emerald-100 bg-emerald-50 text-emerald-800 in-[.lichen-d3]:border-mist-line in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text" : "border-amber-200 bg-amber-50 text-amber-900 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text"}`}>
            <div className="flex items-center gap-2 font-semibold">{report.evidenceVerdict === 'pass' ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}Evidence checks: {label(report.evidenceVerdict)}</div>
            {report.evidenceReasons.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5">{report.evidenceReasons.map(reason => <li key={reason}>{label(reason)}</li>)}</ul>}
            {report.evidenceReviewedAt && <p className="mt-2 text-xs">Reviewed by landlord {when(report.evidenceReviewedAt)}. Original evidence warnings retained.</p>}
          </div>
          <section><h4 className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">Work notes</h4><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600 in-[.lichen-d3]:text-meta">{report.workPerformed || 'No work notes recorded.'}</p>
            <p className="mt-2 text-xs text-slate-400 in-[.lichen-d3]:text-meta">{report.source === 'landlord_manual' ? 'Recorded by landlord' : 'Vendor report'} · {label(report.status)} · Submitted {when(report.submittedAt)}</p></section>
          {(report.completedAt || report.closedAt) && <dl className="grid gap-2 text-xs text-slate-500 sm:grid-cols-2 in-[.lichen-d3]:text-meta"><div><dt>Reported finished</dt><dd>{when(report.completedAt)}</dd></div><div><dt>Job closed</dt><dd>{when(report.closedAt)}</dd></div></dl>}
          {report.partsUsed && <section><h4 className="text-sm font-semibold">Parts used</h4><p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-600 in-[.lichen-d3]:text-meta">{report.partsUsed}</p></section>}
          {report.followUpNeeded && <section className="rounded-xl bg-blue-50 p-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-well"><h4 className="text-sm font-semibold text-blue-900 in-[.lichen-d3]:text-ink">Follow-up recommended</h4><p className="mt-1 whitespace-pre-wrap break-words text-sm text-blue-800 in-[.lichen-d3]:text-ink">{report.followUpNotes || 'Vendor indicated more work is needed.'}</p></section>}
          <section><h4 className="text-sm font-semibold">Photos & videos</h4>
            {report.photos.length ? <div className="mt-3 grid gap-3 sm:grid-cols-2">{report.photos.map((photo, index) => <figure key={`${photo.url}-${index}`} className="overflow-hidden rounded-xl border border-slate-200 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border">
              {photo.type === 'video' ? <video className="aspect-video w-full bg-slate-100 in-[.lichen-d3]:bg-chip" src={photo.url} controls preload="metadata" /> :
                <a href={photo.url} target="_blank" rel="noopener noreferrer"><img className="aspect-video w-full object-cover" src={photo.url} alt={photo.label || `${photo.stage} photo ${index + 1}`} loading="lazy" /></a>}
              <figcaption className="space-y-1 p-3 text-xs text-slate-500 in-[.lichen-d3]:text-meta"><p className="font-semibold capitalize text-slate-700 in-[.lichen-d3]:text-ink">{photo.stage}{photo.label ? ` · ${photo.label}` : ''}</p>
                <p>Uploaded {when(photo.receivedAt)}</p>{photo.exifTakenAt && <p>Image timestamp {when(photo.exifTakenAt)}</p>}
                <a className="inline-flex items-center gap-1 text-blue-600 underline in-[.lichen-d3]:text-ink" href={photo.url} target="_blank" rel="noopener noreferrer">Open original <ExternalLink className="h-3 w-3" /></a></figcaption>
            </figure>)}</div> : <p className="mt-2 rounded-xl border border-dashed border-amber-200 bg-amber-50/40 p-3 text-sm text-amber-800 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text">No photos or videos recorded for this visit.</p>}</section>
          <section className="rounded-xl bg-slate-50 p-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-well"><h4 className="text-sm font-semibold">Tenant review</h4>
            {report.confirmation ? <><p className="mt-1 text-sm capitalize text-slate-700 in-[.lichen-d3]:text-ink">{report.confirmation.autoConfirmed ? 'Automatically confirmed after review window' : label(report.confirmation.outcome)} · {when(report.confirmation.respondedAt)}</p>
              {report.confirmation.rating != null && <p className="mt-1 text-sm">Rating: {report.confirmation.rating}/5</p>}
              {report.confirmation.comment && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-600 in-[.lichen-d3]:text-meta">{report.confirmation.comment}</p>}</> : <p className="mt-1 text-sm text-slate-500 in-[.lichen-d3]:text-meta">No tenant response recorded.</p>}</section>
          <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-slate-500 in-[.lichen-d3]:text-meta">Reported cost</dt><dd className="mt-1 font-semibold">{money(report.reportedCost, report.currency)}</dd></div>
            <div><dt className="text-slate-500 in-[.lichen-d3]:text-meta">Final payable</dt><dd className="mt-1 font-semibold">{report.finalCost == null ? report.status === 'void' ? 'Superseded report' : 'Not yet verified' : money(report.finalCost, report.currency)}</dd></div>
            <div><dt className="text-slate-500 in-[.lichen-d3]:text-meta">Approved booking cap</dt><dd className="mt-1 font-semibold">{money(report.approvedCeiling, report.currency)}</dd></div>
            {report.approvedOverage != null && <div><dt className="text-slate-500 in-[.lichen-d3]:text-meta">Approved overage amount</dt><dd className="mt-1 font-semibold">{money(report.approvedOverage, report.currency)}</dd></div>}</dl>
          {report.itemization && <section className="min-w-0 space-y-2"><HackathonBadge /><ItemizationBreakdown itemization={report.itemization} title="Final statement"
            caption={`${report.invoiceReference ? `Invoice ${report.invoiceReference} · ` : ''}as submitted · cost review: ${reviewStateLabel(report.invoiceReviewState).label.toLowerCase()}`}
            testId="work-record-final-statement" /></section>}
          {report.originalQuote && <details className="text-sm"><summary className="cursor-pointer font-medium text-slate-700 in-[.lichen-d3]:text-ink">Agreed quote breakdown</summary>
            <div className="mt-2"><ItemizationBreakdown itemization={report.originalQuote} testId="work-record-original-quote" /></div></details>}
        </> : <p className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:text-meta">No vendor work report has been recorded for this visit.</p>}
        <section className="border-t border-slate-100 pt-4 in-[.lichen-d3]:border-hairline"><h4 className="text-sm font-semibold">Vendor payment · {visit.payment.mode === 'direct' ? 'Direct pay' : 'Platform payout'}</h4>
          {visit.payment.mode === 'direct' ? <p className="mt-2 text-sm text-slate-600 in-[.lichen-d3]:text-meta">{visit.payment.status === 'paid' ? `Marked paid by landlord · ${when(visit.payment.paidAt)}` : visit.payment.status === 'due' ? 'Payment due to vendor' : 'No payment recorded'}{visit.payment.amountCents != null ? ` · ${money(visit.payment.amountCents / 100)}` : ''}</p> :
            <><p className="mt-2 text-xs text-slate-500 in-[.lichen-d3]:text-meta">Ledger status describes the platform transfer. Bank receipt needs separate confirmation.</p>
              {visit.payment.payouts.length ? visit.payment.payouts.map(payout => <p key={payout.id} className="mt-2 text-sm capitalize text-slate-600 in-[.lichen-d3]:text-meta">{money(payout.amountCents / 100)} · {label(payout.status)}{payout.clearsOn ? ` · Expected clearance ${when(payout.clearsOn)}` : ''}</p>) : <p className="mt-2 text-sm text-slate-500 in-[.lichen-d3]:text-meta">No payout recorded.</p>}</>}
        </section>
      </div>
    </article>
  </li>;
}

export default function WorkRecordPanel({ requestId, revision }: { requestId: string; revision?: string }) {
  const [record, setRecord] = useState<WorkRecord | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const loadedRequest = useRef<string | null>(null);
  const visibleRecord = record?.requestId === requestId ? record : null;
  useLiveTopic(`request:${requestId}`, () => setRetry(value => value + 1));
  useEffect(() => {
    const timer = window.setInterval(() => setRetry(value => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [requestId]);
  useEffect(() => {
    let current = true;
    // Refresh in place so reviewing a video is not interrupted every minute.
    if (loadedRequest.current !== requestId) { setLoading(true); setRecord(null); }
    setError('');
    LandlordAPI.getWorkRecord(requestId).then(response => {
      if (current) { loadedRequest.current = requestId; setRecord(response.data as WorkRecord); }
    }).catch(() => { if (current) setError('The work record could not be loaded.'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [requestId, revision, retry]);
  return <DetailCard icon={ClipboardList} iconColor="#137fec" title="Work record" description="Every visit, vendor report and evidence record, retained after completion and archiving."
    id="request-detail-tab-work" role="tabpanel" aria-labelledby="request-detail-tab-button-work">
    {loading ? <p className="py-6 text-sm text-slate-500 in-[.lichen-d3]:text-meta" role="status">Loading work record…</p> : error ? <div role="alert"><p className="text-sm text-rose-700 in-[.lichen-d3]:text-alert-text">{error}</p><Button variant="outline" className="mt-3" onClick={() => setRetry(value => value + 1)}>Try again</Button></div> : visibleRecord && <>
      {visibleRecord.finalCost != null && <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-emerald-50 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-mist-tint"><span className="text-sm text-emerald-800 in-[.lichen-d3]:text-mist-text">Final request cost</span><strong className="text-emerald-900 in-[.lichen-d3]:text-mist-text">{money(visibleRecord.finalCost)}</strong></div>}
      {visibleRecord.visits.length ? <ol className="relative space-y-6 before:absolute before:bottom-5 before:left-3 before:top-3 before:w-px before:bg-slate-200">{visibleRecord.visits.map((visit, index) => <WorkVisitCard key={visit.id} visit={visit} number={index + 1} />)}</ol> :
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-control-border in-[.lichen-d3]:text-meta">No visits recorded yet. Arrival records, photos and vendor notes will appear here as work progresses.</p>}
    </>}
  </DetailCard>;
}
