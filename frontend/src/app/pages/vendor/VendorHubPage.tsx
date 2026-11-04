import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  CreditCard,
  Loader2,
  LogOut,
  MapPin,
  Star,
} from 'lucide-react';
import { toast } from 'sonner';
import { VendorHubAPI } from '../../api/client';
import PayoutsSetUpCard from './PayoutsSetUpCard';
import VendorBusyTimes from './VendorBusyTimes';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';

/**
 * Everything one contractor is working on, across every landlord who hired
 * them. This is what the VendorIdentity split from slice A was for: without a
 * global identity there is no "every landlord" to show.
 *
 * Note what an OFFER row deliberately lacks: an address. The vendor has not
 * accepted it yet, so the server sends the public brief only — city and trade,
 * no street. The hub is the easiest place to widen that boundary by accident,
 * so it is worth seeing that the data simply is not here to render.
 */

/**
 * `awaitingAmount`: the part the manager's balance didn't cover yet. Still owed.
 * `expectedOn`: on a payment waiting for Stripe to clear the manager's money,
 * the day it should go.
 */
type Money = {
  amount: number;
  currency: string;
  status: string;
  awaitingAmount?: number;
  expectedOn?: string | null;
  at: string;
};

type HubData = {
  vendor: {
    name: string;
    email: string | null;
    payouts: { status: string; onboardedAt: string | null };
    completedJobs: number;
    rating: number | null;
    ratingCount: number;
  };
  offers: {
    /** Opaque row reference. The server deliberately never sends raw ids. */
    ref: string;
    jobReference: string;
    title: string;
    trade: string | null;
    city: string;
    urgencyLabel: string;
    manager: { name: string; company?: string | null };
    respondBy: string | null;
    needsEmailLink: boolean;
  }[];
  active: {
    ref: string;
    jobReference: string;
    title: string;
    address: string;
    status: string;
    scheduledFor: string | null;
    submittedAt: string | null;
    completionStatus: string | null;
    canOpen: boolean;
    canReschedule?: boolean;
  }[];
  history: {
    ref: string;
    title: string;
    closedAt: string;
    amount: number | null;
    currency: string;
    rating: number | null;
    payout: Money | null;
  }[];
};

const money = (amount: number | null, currency = 'CAD') =>
  amount === null
    ? '—'
    : new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(amount);

const ACTIVE_LABELS: Record<string, string> = {
  awaiting_tenant: 'Waiting on the tenant to confirm your time',
  scheduled: 'Scheduled',
  work_verifying: 'Submitted — waiting on the tenant',
  in_review: 'Under review by the manager',
  disputed: 'The tenant reported an issue',
};

const PAYOUT_LABELS: Record<string, string> = {
  paid: 'Paid',
  pending: 'Sending',
  pending_manual: 'Manager is paying you directly',
  pending_onboarding: 'Add your bank details to get paid',
  awaiting_funds: 'Coming once your manager adds funds',
  awaiting_clearance: 'On its way',
  failed: 'Payment failed',
  // Direct-pay jobs: the manager pays outside Artrelo and marks it.
  direct_due: 'Your manager pays you directly',
  direct_paid: 'Paid by your manager',
};

const PAYOUT_STYLES: Record<string, string> = {
  paid: 'bg-emerald-100 text-emerald-800',
  pending: 'bg-amber-100 text-amber-800',
  pending_manual: 'bg-amber-100 text-amber-800',
  pending_onboarding: 'bg-sky-100 text-sky-800',
  awaiting_funds: 'bg-slate-100 text-slate-700',
  awaiting_clearance: 'bg-sky-100 text-sky-800',
  failed: 'bg-rose-100 text-rose-800',
  direct_due: 'bg-amber-100 text-amber-800',
  direct_paid: 'bg-emerald-100 text-emerald-800',
};

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
      {children}
    </h2>
  );
}

export default function VendorHubPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<HubData | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const [openingRef, setOpeningRef] = useState('');
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [businessWebsite, setBusinessWebsite] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await VendorHubAPI.me();
      setData(res.data as HubData);
    } catch {
      // Any auth failure lands here; the server never distinguishes expired
      // from revoked from forged, so neither does this.
      navigate('/vendor-hub/sign-in', { replace: true });
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fetched on click rather than preloaded: the raw token is unrecoverable
  // after minting, so a link can only be produced by rotating, and rotating on
  // every page load would silently kill the vendor's emailed link each time
  // they glanced at this page.
  const openJob = async (ref: string) => {
    setOpeningRef(ref);
    try {
      const res = await VendorHubAPI.issueJobLink(ref);
      const url = (res.data as { jobUrl: string }).jobUrl;
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open that job.");
      setOpeningRef('');
    }
  };

  const startPayouts = async () => {
    setPayoutBusy(true);
    try {
      const res = await VendorHubAPI.startPayouts(businessWebsite.trim() || undefined);
      const data = res.data as { onboardingUrl: string | null; message?: string };
      if (data?.onboardingUrl) {
        window.location.href = data.onboardingUrl;
        return;
      }
      toast.message(data?.message || 'Your property manager will pay you directly.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start payout setup.");
    } finally {
      setPayoutBusy(false);
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await VendorHubAPI.signOut();
    } finally {
      navigate('/vendor-hub/sign-in', { replace: true });
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="h-6 w-6 animate-spin text-[#137fec]" aria-hidden="true" />
      </main>
    );
  }
  if (!data) return null;

  const { vendor, offers, active, history } = data;
  const needsPayoutSetup = vendor.payouts.status !== 'enabled';
  const nothingAtAll = !offers.length && !active.length && !history.length;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-slate-900">{vendor.name}</h1>
              {vendor.email ? (
                <p className="mt-0.5 truncate text-sm text-slate-500">{vendor.email}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
                <span>
                  {vendor.completedJobs} job{vendor.completedJobs === 1 ? '' : 's'} completed
                </span>
                {vendor.rating ? (
                  <span className="flex items-center gap-1">
                    <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" aria-hidden="true" />
                    {vendor.rating} · {vendor.ratingCount} rating
                    {vendor.ratingCount === 1 ? '' : 's'}
                  </span>
                ) : null}
              </div>
            </div>
            <Button
              variant="ghost"
              onClick={() => void signOut()}
              disabled={signingOut}
              className="gap-1.5 text-slate-500 hover:text-slate-800"
              data-testid="hub-sign-out"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </header>
        <VendorBusyTimes />

        {needsPayoutSetup ? (
          <div
            className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"
            data-testid="hub-payout-notice"
          >
            <CreditCard className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p>
                Your bank details aren&rsquo;t set up yet. Anything you&rsquo;ve earned is held
                safely and pays out automatically once they are.
              </p>
              <p className="mt-2 text-xs">Stripe will verify your business and bank details. If it asks for a website, use your real business website; contact us if you do not have one.</p>
              <label className="mt-3 block text-xs font-medium" htmlFor="vendor-business-website">Business website (optional)</label>
              <input id="vendor-business-website" type="url" placeholder="https://your-business.ca" value={businessWebsite} onChange={(event) => setBusinessWebsite(event.target.value)} className="mt-1 w-full rounded border bg-white px-3 py-2 text-sm" />
              <Button
                onClick={() => void startPayouts()}
                disabled={payoutBusy}
                className="mt-3 h-8 gap-1.5 bg-[#137fec] text-xs hover:bg-[#137fec]/90"
                data-testid="hub-start-payouts"
              >
                {payoutBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : null}
                Add bank details
              </Button>
            </div>
          </div>
        ) : (
          <PayoutsSetUpCard
            testId="hub-payouts-set-up"
            note="Every job you finish, for any property manager on Artrelo, pays out to this account."
            getUpdateUrl={async () => {
              const res = await VendorHubAPI.payoutUpdateLink();
              return (res.data as { url?: string } | undefined)?.url || null;
            }}
          />
        )}

        {nothingAtAll ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
            <ClipboardCheck className="mx-auto h-8 w-8 text-slate-300" aria-hidden="true" />
            <p className="mt-3 text-sm text-slate-500">
              Nothing here yet. Jobs you&rsquo;re offered will show up automatically.
            </p>
          </div>
        ) : null}

        {offers.length ? (
          <section>
            <SectionHeading>Waiting on your answer</SectionHeading>
            <div className="space-y-2">
              {offers.map((offer) => (
                <article
                  key={offer.ref}
                  className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm"
                  data-testid={`hub-offer-${offer.ref}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">{offer.title}</span>
                    <Badge className="border-transparent bg-amber-100 text-amber-800">
                      {offer.urgencyLabel}
                    </Badge>
                  </div>
                  {/* City only — an unaccepted job has no address to show. */}
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                      {offer.city || 'Location on acceptance'}
                    </span>
                    {offer.trade ? <span>{offer.trade}</span> : null}
                    <span>{offer.manager.company || offer.manager.name}</span>
                  </div>
                  {offer.respondBy ? (
                    <div className="mt-2 flex items-center gap-1 text-xs text-amber-700">
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      Reply by {new Date(offer.respondBy).toLocaleString(undefined, {
                        weekday: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </div>
                  ) : null}
                  <p className="mt-2 text-xs text-slate-400">
                    Open the link we emailed you to accept or decline this one.
                  </p>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {active.length ? (
          <section>
            <SectionHeading>In progress</SectionHeading>
            <div className="space-y-2">
              {active.map((job) => (
                <article
                  key={job.ref}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                  data-testid={`hub-active-${job.ref}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-900">{job.title}</span>
                    <span className="text-xs text-slate-400">{job.jobReference}</span>
                  </div>
                  {job.address ? (
                    <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                      <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {job.address}
                    </div>
                  ) : null}
                  {job.scheduledFor ? (
                    <div className="mt-1 flex items-center gap-1 text-xs text-slate-600">
                      <CalendarClock className="h-3.5 w-3.5 shrink-0 text-[#137fec]" aria-hidden="true" />
                      {new Date(job.scheduledFor).toLocaleString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </div>
                  ) : null}
                  <p className="mt-2 text-xs text-slate-500">
                    {ACTIVE_LABELS[job.status] || job.status}
                  </p>
                  {job.canReschedule && <Button variant="outline" className="mt-3 mr-2" disabled={!!openingRef} onClick={async () => {
                    setOpeningRef(job.ref); try { const result = await VendorHubAPI.schedulingLink(job.ref);
                      if (result.data?.url) window.location.href = result.data.url;
                    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not open scheduling'); }
                    finally { setOpeningRef(''); }
                  }}>Arrange visit time</Button>}
                  {job.canOpen ? (
                    <Button
                      onClick={() => void openJob(job.ref)}
                      disabled={openingRef === job.ref}
                      className="mt-3 h-8 gap-1 bg-[#137fec] text-xs hover:bg-[#137fec]/90"
                      data-testid={`hub-open-${job.ref}`}
                    >
                      {openingRef === job.ref ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      ) : null}
                      Open job
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  ) : job.status === 'awaiting_tenant' ? (
                    // Not openable until the tenant confirms; say what happens next
                    // rather than offering a button that can only fail.
                    <p
                      className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800"
                      data-testid={`hub-awaiting-tenant-${job.ref}`}
                    >
                      We&rsquo;ll email your job link as soon as the tenant confirms your time.
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {history.length ? (
          <section>
            <SectionHeading>Completed</SectionHeading>
            <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
              {history.map((job) => (
                <div
                  key={job.ref}
                  className="flex items-start gap-3 px-4 py-3"
                  data-testid={`hub-history-${job.ref}`}
                >
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-900">{job.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                      <span>{new Date(job.closedAt).toLocaleDateString()}</span>
                      {job.rating ? (
                        <span className="flex items-center gap-0.5">
                          <Star className="h-3 w-3 fill-amber-400 text-amber-400" aria-hidden="true" />
                          {job.rating}
                        </span>
                      ) : null}
                      {job.payout && PAYOUT_LABELS[job.payout.status] ? (
                        <Badge
                          className={`border-transparent ${
                            PAYOUT_STYLES[job.payout.status] || 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {PAYOUT_LABELS[job.payout.status]}
                        </Badge>
                      ) : null}
                    </div>
                    {job.payout?.status === 'awaiting_clearance' ? (
                      <div className="mt-1 text-xs text-slate-500" data-testid="hub-payout-clearing">
                        Paid for. Your manager&rsquo;s payment is still clearing with Stripe, so it&rsquo;s sent to
                        your payout account{' '}
                        {job.payout.expectedOn
                          ? `around ${new Date(job.payout.expectedOn).toLocaleDateString(undefined, {
                              weekday: 'short',
                              month: 'short',
                              day: 'numeric',
                              // Stripe dates cleared money to 00:00 UTC; local
                              // time would show the evening before.
                              timeZone: 'UTC',
                            })}`
                          : 'in a few business days'}
                        . Nothing to do.
                      </div>
                    ) : null}
                    {/* Split payment: part sent, part still coming. Shown only
                        when some was sent — a wholly waiting job's badge says it. */}
                    {job.payout?.awaitingAmount && job.payout.status !== 'awaiting_funds' ? (
                      <div className="mt-1 text-xs text-slate-500">
                        {money(job.payout.awaitingAmount, job.payout.currency)} more is coming once your
                        manager adds funds.
                      </div>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                    {money(job.amount, job.currency)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
