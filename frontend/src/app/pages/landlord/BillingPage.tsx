import { useCallback, useEffect, useRef, useState } from 'react';
import { CreditCard, FileText, Loader2, RefreshCw } from 'lucide-react';
import { LandlordAPI } from '../../api/client';
import PageHeader from '../../components/landlord/PageHeader';
import { PageContainer } from '../../components/landlord/landlordUi';
import { Button } from '../../components/ui/button';
import { useLiveTopic } from '../../hooks/useLiveTopic';

type Rate = { flatCents: number; percent: number };
type Billing = {
  hasDisputedInvoice: boolean; enabled: boolean; collectionEnabled: boolean; betaActive: boolean; betaEndsAt: string | null;
  offer: { version: string; rate: Rate; noticeSentAt: string | null; effectiveAt: string | null } | null;
  agreement: { version: string; rate: Rate; acceptedAt: string } | null;
  card: { brand: string; last4: string } | null;
  readiness: { allowed: boolean; reason: string | null }; accruedCents: number; waivedCents: number;
  assessments: { ref: string; jobRef: string | null; source: string; feeCents: number; listCents: number; waivedReason: string | null; closedAt: string }[];
  invoices: { ref: string; period: string; status: string; totalCents: number; subtotalCents: number; disputedCents: number; refundedCents: number; hostedUrl: string | null; pdfUrl: string | null }[];
};
const money = (cents: number) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(cents / 100);
const day = (value: string | null) => value ? new Date(value).toLocaleDateString('en-CA', { dateStyle: 'medium', timeZone: 'UTC' }) : 'not scheduled';
const rateLabel = (rate: Rate) => [rate.flatCents > 0 ? money(rate.flatCents) : '', rate.percent > 0 ? `${rate.percent}% of the final vendor amount` : ''].filter(Boolean).join(' + ');
const reasons: Record<string, string> = {
  billing_setup_required: 'Accept your pricing and save a billing card before starting new paid bookings.',
  billing_notice_period: 'Your fee notice period is still running. Paid bookings open on the effective date below.',
  billing_past_due: 'Your invoice has been unpaid for at least 14 days. New non-emergency bookings and outreach are paused. Pay your invoice or update your billing card to resume.',
  billing_configuration_pending: 'Artrelo is finishing billing setup. Contact support before starting new paid bookings.',
};
const waiverLabels: Record<string, string> = { beta: 'Waived during beta', pre_activation: 'Waived: booked before paid billing', billing_disabled: 'Waived: billing was not active' };
export default function BillingPage() {
  const [data, setData] = useState<Billing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const attempt = useRef(crypto.randomUUID());
  const load = useCallback(async () => {
    try { const result = await LandlordAPI.billing(); setData(result.data as Billing); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load billing.'); }
  }, []);
  useEffect(() => {
    void (async () => {
      if (new URLSearchParams(window.location.search).get('setup') === 'complete') {
        try { await LandlordAPI.refreshBilling(); } catch { /* A webhook or poll can finish the update. */ }
      }
      await load();
    })();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);
  useLiveTopic('billing', () => void load());
  const saveCard = async () => {
    if (!data) return;
    setBusy(true); setError('');
    try {
      if (!data.agreement && data.offer) await LandlordAPI.acceptBilling(data.offer.version);
      const result = await LandlordAPI.setupBillingCard(attempt.current);
      const url = (result.data as { url: string }).url;
      window.location.assign(url);
    } catch (err) {
      attempt.current = crypto.randomUUID();
      await load();
      setError(err instanceof Error ? err.message : 'Could not open billing setup.');
    } finally { setBusy(false); }
  };
  return (
    <PageContainer className="lichen-remainder min-w-0 [overflow-wrap:anywhere]">
      <PageHeader title="Artrelo billing" description="Service fees for verified completed jobs, collected in one monthly bill."
        actions={<Button variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>} />
      {error ? <p role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900 lichen:rounded-lg lichen:border-alert-line lichen:bg-alert-tint lichen:text-alert-text">{error}</p> : null}
      {!data ? <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading billing" /> : <>
        <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 lichen:rounded-lg lichen:border-hairline lichen:bg-card">
          <p className="font-semibold text-slate-900 lichen:text-ink">Vendor payments and Artrelo fees</p>
          <p className="mt-2 text-sm leading-6 text-slate-600 lichen:text-meta">Your Artrelo fee is assessed when work is verified complete. It applies whether you pay the vendor directly or use platform payouts. Marking a vendor paid updates their payment record; it does not start or delay your Artrelo fee.</p>
          <p className="mt-2 text-sm text-slate-600 lichen:text-meta">There is no subscription or monthly minimum. We bill completed-job fees on the first of the following month. A month without chargeable jobs has no new job fees.</p>
        </div>
        {data.betaActive ? <p className="mb-5 rounded-xl bg-blue-50 p-4 text-sm text-blue-900 lichen:rounded-lg lichen:bg-chip lichen:text-lichen-text">Your beta is free until {day(data.betaEndsAt)}. No card is required during beta, and beta bookings keep their waiver when they finish later.</p> : null}
        {!data.collectionEnabled ? <p className="mb-5 rounded-xl bg-slate-100 p-4 text-sm text-slate-700 lichen:rounded-lg lichen:bg-chip lichen:text-ink">Automatic invoice collection has not started. Your pricing acceptance and saved card do not create a charge by themselves.</p> : null}
        {!data.readiness.allowed ? <p className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900 lichen:rounded-lg lichen:border-lichen-line lichen:bg-lichen-tint lichen:text-lichen-text">{reasons[data.readiness.reason || ''] || 'Billing needs your attention.'} Existing jobs, vendor payments, account access and emergency alerts remain available.</p> : null}
        {data.hasDisputedInvoice ? <p className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 lichen:rounded-lg lichen:border-lichen-line lichen:bg-lichen-tint lichen:text-lichen-text">A disputed invoice needs review with Artrelo support. We do not automatically charge the disputed amount again; updating your card retries other unpaid invoices.</p> : null}
        <div className="mb-6 grid gap-4 md:grid-cols-2">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 lichen:rounded-lg lichen:border-hairline lichen:bg-card">
            <h3 className="font-semibold">Your pricing and billing card</h3>
            {data.offer ? <>
              <p className="mt-2 text-lg font-semibold">{rateLabel(data.agreement?.rate || data.offer.rate)} per verified completed job</p>
              <p className="mt-1 text-sm text-slate-500 lichen:text-meta">Plus applicable tax. Earliest paid start: {day(data.offer.effectiveAt)}, after your beta and billing authorization.</p>
            </> : <p className="mt-2 text-sm text-slate-600 lichen:text-meta">We will send your exact fee at least 30 days before paid use begins. Your existing founding-rate commitments remain in place.</p>}
            {data.card ? <p className="mt-4 flex items-center gap-2 text-sm"><CreditCard className="h-4 w-4" />{data.card.brand} ending in {data.card.last4}</p> : <p className="mt-4 text-sm text-slate-500 lichen:text-meta">No billing card saved.</p>}
            {data.enabled && !data.betaActive && data.offer?.noticeSentAt ? <>
              {!data.agreement ? <label className="mt-4 flex items-start gap-2 text-sm leading-6 text-slate-700 lichen:text-ink">
                <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} className="mt-1.5" />
                <span>I accept the pricing above and authorize monthly charges to my saved card and retries of unpaid invoices, including after a card update. After 14 days unpaid, new non-emergency bookings and outreach pause.</span>
              </label> : <p className="mt-3 text-xs text-slate-500 lichen:text-meta">Pricing accepted on {day(data.agreement.acceptedAt)}. Updating your card can retry outstanding invoices.</p>}
              <Button className="mt-4" disabled={busy || (!data.agreement && !accepted)} onClick={() => void saveCard()}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}
                {data.card ? 'Update billing card' : 'Accept pricing and save card'}
              </Button>
            </> : null}
          </section>
          <section className="rounded-2xl border border-slate-200 bg-white p-5 lichen:rounded-lg lichen:border-hairline lichen:bg-card">
            <h3 className="font-semibold">Not yet invoiced</h3>
            <p className="mt-3 text-3xl font-bold">{money(data.accruedCents)}</p>
            <p className="mt-2 text-sm text-slate-500 lichen:text-meta">Approved fees waiting for a monthly invoice. Small balances below the payment minimum carry forward.</p>
            <p className="mt-3 text-sm text-slate-600 lichen:text-meta">Waived fees in this list: {money(data.waivedCents)}</p>
          </section>
        </div>
        <section className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 lichen:rounded-lg lichen:border-hairline lichen:bg-card">
          <h3 className="mb-3 flex items-center gap-2 font-semibold"><FileText className="h-4 w-4" />Invoices</h3>
          {data.invoices.length ? <div className="divide-y">{data.invoices.map((invoice) => <div key={invoice.ref} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <div><p className="font-medium">{invoice.period} · {invoice.status}</p><p className="text-slate-500 lichen:text-meta">{money(invoice.status === 'creating' ? invoice.subtotalCents : invoice.totalCents)}{invoice.refundedCents > 0 ? ` · ${money(invoice.refundedCents)} refunded` : ''}</p></div>
            <div className="flex gap-4">{invoice.hostedUrl ? <a href={invoice.hostedUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-700 underline lichen:text-lichen-text">{invoice.status === 'open' ? 'Pay or view invoice' : 'View invoice'}</a> : null}{invoice.pdfUrl ? <a href={invoice.pdfUrl} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline lichen:text-lichen-text">PDF</a> : null}</div>
          </div>)}</div> : <p className="text-sm text-slate-500 lichen:text-meta">No invoices yet.</p>}
        </section>
        <section className="rounded-2xl border border-slate-200 bg-white p-5 lichen:rounded-lg lichen:border-hairline lichen:bg-card">
          <h3 className="mb-3 font-semibold">Completed-job fees awaiting invoicing</h3>
          {data.assessments.length ? <div className="divide-y">{data.assessments.map((fee) => <div key={fee.ref} className="flex flex-wrap justify-between gap-2 py-3 text-sm">
            <span>{fee.source === 'legacy' ? 'Previously outstanding service fees' : `Job ${fee.jobRef}`} <span className="text-slate-500 lichen:text-meta">· {day(fee.closedAt)}</span></span>
            <span>{fee.waivedReason ? (waiverLabels[fee.waivedReason] || 'Fee waived') : money(fee.feeCents)}</span>
          </div>)}</div> : <p className="text-sm text-slate-500 lichen:text-meta">Verified completions will appear here.</p>}
        </section>
      </>}
    </PageContainer>
  );
}
