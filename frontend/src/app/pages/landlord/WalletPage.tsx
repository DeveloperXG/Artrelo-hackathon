import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Clock,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Undo2,
  Wallet,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { LandlordAPI } from '../../api/client';
import { markWalletSeen, useLandlordPaymentMode } from '../../hooks/landlord/useLandlordBadges';
import { useBetaStatus } from '../../hooks/landlord/useBetaStatus';
import { serviceFeeText, type ServiceFeeLine } from '../../lib/serviceFeeText';
import { marketingUrl } from '../../lib/marketingUrl';
import PageHeader from '../../components/landlord/PageHeader';
import StatCard from '../../components/landlord/StatCard';
import FilterChips from '../../components/landlord/FilterChips';
import TablePagination from '../../components/landlord/TablePagination';
import DismissibleBanner from '../../components/landlord/DismissibleBanner';
import DirectPayments, { type DirectPaymentsData } from '../../components/landlord/DirectPayments';
import { MIN_CARD_DEPOSIT, activeCardPilot, type CardPilot, type BankDebitStatus } from '../../lib/walletLimits';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { FieldError, invalidFieldClass } from '../../components/ui/FieldError';
import {
  EmptyState,
  FieldLabel,
  FormDialog,
  LandlordError,
  LandlordLoading,
  PageContainer,
} from '../../components/landlord/landlordUi';
import { useLiveTopic } from '../../hooks/useLiveTopic';
import { JudgeMoneyActions, JudgeWalletNotice } from '../../components/judge/JudgeWalletPresentation';
import { useJudgeSandboxEnabled } from '../../components/judge/JudgeSandboxProvider';

// Loaded only when the top-up dialog opens: it imports @stripe/stripe-js, which
// injects Stripe.js on load. A direct-pay landlord never opens it, so their
// Payments page never loads a payment script.
const WalletDepositForm = lazy(() => import('../../components/landlord/WalletDepositForm'));

/**
 * The landlord's maintenance wallet.
 *
 * One balance, three buckets. `held` is escrow against booked jobs, and it is
 * the number that matters most: it is what the system has already committed on
 * their behalf, days before any vendor invoices.
 *
 * The statement is paged on the server, newest first; the summary above it
 * always describes the whole wallet, whatever page is showing.
 */

type LedgerEntry = {
  id: string;
  type: string;
  /** Plain-language, built server-side so the statement reads the same everywhere. */
  title: string;
  /** in = money arrived, out = money left, neutral = moved between own buckets. */
  direction: 'in' | 'out' | 'neutral';
  amount: number;
  currency: string;
  createdAt: string;
  memo?: string | null;
  jobTitle?: string | null;
  vendorName?: string | null;
  /** On a payout: the unspent part of the reservation that came back. */
  returnedToBalance?: number;
  /** On a payout: Artrelo's service fee on that job. A charged fee is also its
   *  own row; a fee waived during the beta exists ONLY here. */
  serviceFee?: { amount: number; charged: number; waived: string | null; owed: number };
  provider: string;
  providerStatus: string;
  providerRef?: string | null;
  /** On an awaiting_clearance payout: when Stripe expects to have cleared the money. */
  clearsOn?: string | null;
  shortfall: boolean;
  fundingSource?: string;
  /** Available balance right after this entry. Null on rows written before it was recorded. */
  balanceAfter?: { available: number; held: number } | null;
};

type LedgerData = {
  balance: {
    available: number;
    held: number;
    arrears: number;
    lifetimeDeposited: number;
    lifetimeReleased: number;
    currency: string;
  };
  /** Completed work a vendor is still waiting on. Sent automatically by a card top-up. */
  owedToVendors: number;
  /** Booked jobs the balance doesn't cover yet. Nothing is owed until they complete. */
  bookingShortfall: number;
  /** Artrelo service fees the balance didn't cover when a job closed. The next
   *  top-up pays them, after any vendor waiting on funds. */
  unpaidServiceFees?: number;
  /** The one line about the service fee, worded for this landlord. Null when no fee applies. */
  serviceFeeLine?: ServiceFeeLine | null;
  /** The founding offer, as far as the wallet needs to say. Null for an ordinary landlord. */
  foundingFee?: {
    founding: boolean;
    since: string | null;
    declined: boolean;
    /** The beta is over, so the fee is real. Before that the page stays quiet. */
    betaEnded: boolean;
    rate: { flat: number; percent: number; description: string } | null;
    locked: boolean;
  } | null;
  /** This landlord's top-ups that haven't cleared for vendor payouts yet. */
  clearing: { amount: number; paidAt: string; availableOn: string; method?: 'card' | 'bank' }[];
  /** Bank top-ups (pre-authorized debit): whether they are offered, and this landlord's limits. */
  bankDebit?: BankDebitStatus;
  /** Bank top-ups the bank hasn't confirmed yet. Not in the balance until they do. */
  /** expectedFrom..expectedAt is the "3–5 business days" the form promises, as dates. */
  pendingTopUps?: { amount: number; startedAt: string; expectedFrom?: string | null; expectedAt: string | null }[];
  /** The latest bank top-up, when it failed or was reversed and nothing newer has started. */
  bankTopUpFailure?: { kind: 'failed' | 'disputed'; amount: number; at: string; message: string | null } | null;
  /** Owed after a bank top-up was reversed once spent, or a bank fee the balance didn't cover. */
  bankOwed?: number;
  /** Of the wallet balance, how much came from transfers Stripe knows nothing about. */
  externalDeposits: number;
  /** Payouts not yet delivered: sending, waiting on bank details or funds, or to pay by hand. */
  pendingPayouts?: number;
  payoutProvider: string;
  /** False when this server has no Stripe key: no card or bank top-up can work here. */
  onlinePayments?: boolean;
  cardPilot?: CardPilot | null;
  /** How this landlord's vendors are paid. Null if it couldn't be read: show the full wallet. */
  paymentMode?: 'direct' | 'platform' | null;
  /** Jobs paid (or to be paid) by the landlord directly, outside the wallet. */
  directPayments?: DirectPaymentsData;
  /** Available balance against the low-funds threshold. Null if it couldn't be read. */
  lowFunds?: { threshold: number; below: boolean } | null;
  entries: LedgerEntry[];
  pagination?: { page: number; limit: number; total: number; totalPages: number; kind: string };
};

// Local content/portal scope; no financial or payment eligibility behavior.
const WALLET_PAGE = 'lichen lichen-light lichen-wallet @container/page min-w-0 font-sans text-ink [overflow-wrap:anywhere] [&_[data-slot=button]]:h-auto [&_[data-slot=button]]:min-h-9 [&_[data-slot=button]]:max-w-full [&_[data-slot=button]]:whitespace-normal [&_[data-slot=button]]:rounded-md [&_[data-slot=badge]]:max-w-full [&_[data-slot=badge]]:whitespace-normal [&_:is(button,a,input)]:focus-visible:outline-2 [&_:is(button,a,input)]:focus-visible:outline-solid [&_:is(button,a,input)]:focus-visible:outline-offset-2 [&_:is(button,a,input)]:focus-visible:outline-ring';
const WALLET_PORTAL = WALLET_PAGE + ' max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain p-[min(1.5rem,24px)] [&_[data-slot=dialog-header]>div]:flex-wrap [&_[data-slot=dialog-header]>div>div:last-child]:min-w-0 [&_[data-slot=dialog-header]_.h-10]:rounded-md [&_[data-slot=dialog-header]_.h-10]:bg-chip! [&_[data-slot=dialog-header]_.h-10]:text-chip-icon!';

const PAGE_SIZE = 20;

const KINDS = [
  { key: 'all', label: 'All' },
  { key: 'added', label: 'Funds added' },
  { key: 'held', label: 'Held' },
  // Wire key stays `paid`; the rows include payments still pending, and each one shows its own status.
  { key: 'paid', label: 'Vendor payments' },
  { key: 'refunded', label: 'Refunded' },
] as const;
type Kind = (typeof KINDS)[number]['key'];

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Stripe dates cleared money to 00:00 UTC. Read in local time, every Canadian
// zone lands on the evening before and shows a day earlier than Stripe does.
const clearingDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

const money = (amount: number, currency = 'CAD') =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(amount || 0);

const STATUS_STYLES: Record<string, string> = {
  paid: 'bg-mist-tint text-mist-text',
  pending: 'bg-lichen-tint text-lichen-pill',
  pending_manual: 'bg-lichen-tint text-lichen-pill',
  pending_onboarding: 'bg-pill-neutral text-chip-icon',
  awaiting_funds: 'bg-alert-tint text-alert-text',
  awaiting_clearance: 'bg-pill-neutral text-chip-icon',
  failed: 'bg-alert-tint text-alert-text',
  none: 'bg-chip text-meta',
};

const STATUS_LABELS: Record<string, string> = {
  paid: 'Paid',
  pending: 'Sending',
  pending_manual: 'Pay manually',
  pending_onboarding: 'Vendor setting up payouts',
  awaiting_funds: 'Waiting on your top-up',
  awaiting_clearance: 'Clearing at Stripe',
  failed: 'Failed',
  none: '',
};

// One glyph per kind of movement, so the column scans without being read.
const TYPE_ICONS: Record<string, typeof ArrowDownLeft> = {
  deposit: Plus,
  payout: ArrowUpRight,
  payout_reversal: ArrowDownLeft,
  arrears_settlement: ArrowUpRight,
  hold: Lock,
  hold_void: Undo2,
  hold_release: Undo2,
  refund: RefreshCw,
  fee: ArrowUpRight,
  adjustment: RefreshCw,
};

const DIRECTION_STYLES: Record<string, string> = {
  in: 'text-mist-text',
  out: 'text-ink',
  // A reservation is the landlord's own money moving between their own
  // buckets. Colouring it like a payment would make every booked job look
  // like a charge.
  neutral: 'text-meta',
};

function signedAmount(entry: LedgerEntry, currency: string) {
  const value = money(entry.amount, currency);
  if (entry.direction === 'in') return `+${value}`;
  if (entry.direction === 'out') return `−${value}`;
  return value;
}

/** "Today" / "Yesterday" / "Oct 12, 2026" — statements group by day, not timestamp. */
function dayLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function groupByDay(entries: LedgerEntry[]) {
  const groups: { day: string; rows: LedgerEntry[] }[] = [];
  for (const entry of entries) {
    const day = dayLabel(entry.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(entry);
    else groups.push({ day, rows: [entry] });
  }
  return groups;
}

/** The second line of a row: the job, or the reference that identifies a top-up. */
function rowSubtitle(entry: LedgerEntry) {
  const parts: string[] = [];
  if (entry.jobTitle && !entry.title.includes(entry.jobTitle)) parts.push(entry.jobTitle);
  if (entry.providerRef) parts.push(`Ref: ${entry.providerRef}`);
  if (entry.type === 'deposit' && entry.fundingSource === 'external') parts.push('not available for payouts');
  return parts.join(' · ');
}

export default function WalletPage() {
  const sandboxWallet = useJudgeSandboxEnabled();
  const paymentPageLabel = useLandlordPaymentMode() === 'platform' ? 'Wallet' : 'Payments';
  const { beta, openOffer } = useBetaStatus();
  // Whether the offer is declined, as the app knows it RIGHT NOW. The ledger
  // payload below was read when the page loaded; accepting or declining from the
  // dialog changes this at once, and the page must never say "you declined"
  // beside a sidebar that says "Founding Landlord".
  const [data, setData] = useState<LedgerData | null>(null);
  const declinedOffer = beta ? beta.offer === 'declined' : Boolean(data?.foundingFee?.declined);
  const [loading, setLoading] = useState(true);
  // A page or filter change keeps the old rows on screen, dimmed, until the
  // new ones arrive — the summary above never flickers back to a spinner.
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [depositOpen, setDepositOpen] = useState(false);
  // Which payment method the dialog opens on. Undefined = the form's default
  // (bank, when offered); a "Top up by card" link opens it on card.
  const [depositMethod, setDepositMethod] = useState<'card' | 'bank' | undefined>(undefined);
  const openDeposit = (method?: 'card' | 'bank') => {
    setDepositMethod(method);
    setAmountError('');
    setDepositOpen(true);
  };
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [page, setPage] = useState(1);
  const tableRef = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await LandlordAPI.getLedger({ page, limit: PAGE_SIZE, kind });
        const next = res.data as LedgerData;
        setData(next);
        // The server clamps a page past the end; follow it so the control agrees.
        if (next.pagination && next.pagination.page !== page) setPage(next.pagination.page);
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load your wallet');
      } finally {
        setLoading(false);
        setPaging(false);
      }
    },
    [page, kind]
  );

  // The first load shows the page spinner; page and filter changes reload quietly.
  const loadedOnce = useRef(false);
  useEffect(() => {
    void load(loadedOnce.current);
    loadedOnce.current = true;
  }, [load]);

  // A card top-up is credited by Stripe's webhook seconds after the form says
  // "accepted", and payouts move on their own; the server nudges `wallet` when
  // the ledger changes so the balance updates without a reload.
  useLiveTopic('wallet', () => void load(true));

  // The founding line is a function of the offer's state, which can change while
  // this page is open (the dialog accepts or declines). Re-read the ledger quietly
  // when it does, so the fee line appears or goes with the sidebar label. Skipped
  // for the first answer (undefined -> a value): that is just the page loading.
  const offer = beta?.offer;
  const lastOffer = useRef(offer);
  useEffect(() => {
    const previous = lastOffer.current;
    lastOffer.current = offer;
    if (previous !== undefined && previous !== offer && loadedOnce.current) void load(true);
  }, [offer, load]);

  // Opening the wallet IS reading the ledger activity, so the unread half of
  // the wallet badge clears here. The stuck half — failed payouts, arrears —
  // deliberately does not: those are still true after you have looked at them.
  useEffect(() => {
    markWalletSeen();
    // And again on the way out: whatever changed while the wallet was open was
    // seen here, so it must not badge the tab the moment you leave.
    return () => markWalletSeen();
  }, []);

  const goToPage = (next: number) => {
    setPaging(true);
    setPage(next);
    tableRef.current?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  };

  const changeKind = (next: Kind) => {
    if (next === kind) return;
    setPaging(true);
    setKind(next);
    setPage(1);
  };

  const markPaid = async (entry: LedgerEntry) => {
    setBusyId(entry.id);
    try {
      await LandlordAPI.markPayoutPaid(entry.id);
      await load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update that payout');
    } finally {
      setBusyId('');
    }
  };

  const retry = async (entry: LedgerEntry) => {
    setBusyId(entry.id);
    try {
      await LandlordAPI.retryPayout(entry.id);
      await load(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not retry that payout');
    } finally {
      setBusyId('');
    }
  };

  if (loading) return <PageContainer className={WALLET_PAGE}><LandlordLoading label={`Loading ${paymentPageLabel.toLowerCase()}...`} /></PageContainer>;
  if (error || !data) {
    return <PageContainer className={WALLET_PAGE + ' [&_[role=alert]]:p-[16px] [&_[role=alert]>div]:min-w-0'}><LandlordError title={`${paymentPageLabel} unavailable`} message={error} onRetry={() => void load()} /></PageContainer>;
  }

  const { balance, entries } = data;
  const currency = balance.currency;
  const pagination = data.pagination;
  const total = pagination?.total ?? entries.length;
  const from = total ? ((pagination?.page ?? 1) - 1) * (pagination?.limit ?? PAGE_SIZE) + 1 : 0;
  const to = entries.length ? from + entries.length - 1 : 0;
  // How cash reaches Stripe for this landlord: a card, or their bank as well
  // (not while bank top-ups are paused for them after a reversal).
  const bankOn = Boolean(data.bankDebit?.enabled) && !data.bankDebit?.blocked;
  const payBy = bankOn ? 'by card or from your bank' : 'by card';
  const directPayments = data.directPayments || { due: [], paid: [], dueTotal: 0 };

  // Direct pay: the landlord pays vendors themselves, so this page is a list of
  // what they owe and have paid. No balance, no top-up, no Stripe.
  if (data.paymentMode === 'direct') {
    return (
      <PageContainer className={WALLET_PAGE}>
        <PageHeader
          title="Payments"
          description="You pay vendors directly for finished jobs. Mark each one paid here so the job and the vendor's records agree."
          titleTestId="wallet-title"
        />
        {data.serviceFeeLine || declinedOffer ? (
          <p className="mb-1 text-xs text-meta">
            {data.serviceFeeLine ? <span data-testid="wallet-fee-line">{serviceFeeText(data.serviceFeeLine)}</span> : null}
            {declinedOffer ? (
              <span data-testid="wallet-founding-declined">
                {data.serviceFeeLine ? ' · ' : ''}You declined the founding offer.{' '}
                <button type="button" onClick={openOffer} className="font-medium text-lichen-text hover:underline">
                  Review it
                </button>
              </span>
            ) : null}
          </p>
        ) : null}
        <DirectPayments presentation data={directPayments} onChanged={() => void load(true)} />
        <p className="mt-5 text-sm text-meta" data-testid="payments-platform-offer">
          Want Artrelo to pay vendors for you once the tenant confirms the work?{' '}
          <a href={marketingUrl('/contact')} className="font-medium text-lichen-text hover:underline">
            Contact us
          </a>{' '}
          and we&rsquo;ll switch it on.
        </p>
      </PageContainer>
    );
  }

  return (
    <PageContainer className={WALLET_PAGE}>
      <PageHeader
        title="Wallet"
        description="Funds for maintenance jobs. Money is held when a vendor is booked. When the tenant confirms the work, the vendor's cost is recorded as payable."
        titleTestId="wallet-title"
      />
      <JudgeWalletNotice />

      <p className="mb-4 text-sm text-meta">Your wallet funds vendor payments. Each transaction shows whether its payment has been sent, is pending or needs you. <Link to="/dashboard/billing" className="font-semibold text-lichen-text underline">View Artrelo service fees and monthly invoices</Link>.</p>
      {/* Every banner below can be dismissed once read -- for the state it
          describes (DismissibleBanner's `signature`), so a changed amount or a
          new failure shows it again.

          Two different situations that used to share one "you owe" banner. Only
          completed work is owed; a booked job that outruns the balance is a
          warning about the future. */}
      {data.owedToVendors > 0 ? (
        <DismissibleBanner
          id="wallet:arrears"
          signature={String(data.owedToVendors)}
          className="mb-4 rounded-lg! border-alert-line bg-alert-tint text-alert-text"
          testId="wallet-arrears"
          icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
        >
          Vendors are waiting on {money(data.owedToVendors, currency)} for completed work. Add funds {payBy}{' '}
          and it&rsquo;s sent to them automatically.
        </DismissibleBanner>
      ) : null}
      {/* Below the landlord's own threshold, with nothing more specific above:
          the arrears banners already say "add funds", and a third would only
          repeat them. This is the standing version of the low-funds email. */}
      {data.lowFunds?.below && !(data.owedToVendors > 0) && !(data.bookingShortfall > 0) ? (
        <DismissibleBanner
          id="wallet:low-funds"
          // The balance moving (either way) is news; so is a new threshold.
          signature={`${data.lowFunds.threshold}:${balance.available}`}
          className="mb-4 rounded-lg! border-lichen-line bg-lichen-tint text-lichen-text"
          testId="wallet-low-funds"
          icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
        >
          Your available balance is below your low-funds threshold of{' '}
          {money(data.lowFunds.threshold, currency)}. Top up so the next booked job can be paid when
          it&rsquo;s done.{' '}
          <Link to="/dashboard/policy" className="font-semibold underline underline-offset-2">
            Change threshold
          </Link>
        </DismissibleBanner>
      ) : null}
      {/* Owed to Artrelo, not to a vendor -- quieter than the vendor banner on
          purpose, and said plainly so it is never a surprise on the next top-up. */}
      {(data.unpaidServiceFees || 0) > 0 ? (
        <DismissibleBanner
          id="wallet:unpaid-fees"
          signature={String(data.unpaidServiceFees)}
          className="mb-4 rounded-lg! border-border bg-well text-slate-700"
          testId="wallet-unpaid-fees"
          icon={<AlertTriangle className="h-4 w-4 text-meta" aria-hidden="true" />}
        >
          {money(data.unpaidServiceFees || 0, currency)} in Artrelo service fees wasn&rsquo;t covered by your
          balance. Your next top-up pays it, after any vendor still waiting on funds.
        </DismissibleBanner>
      ) : null}
      {/* A bank top-up that didn't go through, or was reversed. Shown until the
          next one starts (so trying again clears it), or until dismissed. */}
      {data.bankTopUpFailure ? (
        <DismissibleBanner
          id="wallet:bank-failure"
          signature={`${data.bankTopUpFailure.kind}:${data.bankTopUpFailure.at}`}
          className="mb-4 rounded-lg! border-alert-line bg-alert-tint text-alert-text"
          testId="wallet-bank-failure"
          icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
        >
          <span>
            {data.bankTopUpFailure.kind === 'disputed'
              ? `Your bank reversed a ${money(data.bankTopUpFailure.amount, currency)} top-up, so it was taken back out of your wallet. Bank top-ups are paused; you can still top up by card.`
              : `Your ${money(data.bankTopUpFailure.amount, currency)} bank top-up on ${shortDate(data.bankTopUpFailure.at)} didn't go through${
                  // Already in the landlord's words (bankTopUp.service.failureReason).
                  data.bankTopUpFailure.message ? `: ${data.bankTopUpFailure.message}` : ''
                }. Nothing was added to your balance.`}
          </span>
        </DismissibleBanner>
      ) : null}
      {/* bank_owed: a reversed bank top-up that was already spent, or a bank fee
          (refused or disputed debit) the balance didn't cover. The next cash
          top-up pays it, right after any vendor waiting on funds. */}
      {(data.bankOwed || 0) > 0 ? (
        <DismissibleBanner
          id="wallet:bank-owed"
          signature={String(data.bankOwed)}
          className="mb-4 rounded-lg! border-lichen-line bg-lichen-tint text-lichen-text"
          testId="wallet-bank-owed"
          icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
        >
          You owe {money(data.bankOwed || 0, currency)} from reversed top-ups or bank fees: your balance
          didn&rsquo;t cover, or a reversed top-up that was already spent. Your next top-up {payBy} pays it,
          after any vendor still waiting on funds.
        </DismissibleBanner>
      ) : null}
      {data.bookingShortfall > 0 ? (
        <DismissibleBanner
          id="wallet:booking-shortfall"
          signature={String(data.bookingShortfall)}
          className="mb-4 rounded-lg! border-lichen-line bg-lichen-tint text-lichen-text"
          testId="wallet-booking-shortfall"
          icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
        >
          Your booked jobs need {money(data.bookingShortfall, currency)} more than your balance. Add funds
          before they&rsquo;re completed so vendors are paid on time.
        </DismissibleBanner>
      ) : null}

      {/* Columns follow the width this row really has, measured in the current text
          size (a container query), not the viewport: at 200% text a viewport-wide
          four-up row squeezed the figures. */}
      <div className="@container">
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-4">
        <StatCard
          entrance={false}
          icon={Wallet}
          tone="blue"
          label="Available balance"
          wrap
          value={<span data-testid="wallet-available">{money(balance.available, currency)}</span>}
        />
        <StatCard
          entrance={false}
          icon={Lock}
          tone="blue"
          label="Held for booked work"
          wrap
          value={<span data-testid="wallet-held">{money(balance.held, currency)}</span>}
        />
        <StatCard
          entrance={false}
          icon={ArrowUpRight}
          tone="blue"
          // lifetimeReleased is the journal's allocation to vendors, pending payments
          // included, so it is labelled as costs, not as money delivered. The tile label is
          // kept as short as the old one, since tile labels truncate at 1024-1300px.
          label="Vendor costs"
          wrap
          value={<span data-testid="wallet-vendor-costs">{money(balance.lifetimeReleased, currency)}</span>}
        />
        <StatCard
          entrance={false}
          icon={Clock}
          tone="blue"
          label="Pending payouts"
          wrap
          value={<span data-testid="wallet-pending-payouts">{money(data.pendingPayouts ?? 0, currency)}</span>}
        />
      </div>
      </div>

      {/* Outside the tile: a tile note is one truncated line, and this must stay readable at every width. */}
      <p className={`mt-3 text-xs text-meta ${data.serviceFeeLine || declinedOffer ? '' : 'mb-4'}`} data-testid="wallet-vendor-costs-note">
        Vendor costs include payments still pending.
      </p>

      {/* What the service fee is for THIS landlord, and -- for someone who said
          no to the founding offer -- the way back, which stays reversible. */}
      {data.serviceFeeLine || declinedOffer ? (
        <p className="mb-4 mt-1 text-xs text-meta">
          {data.serviceFeeLine ? <span data-testid="wallet-fee-line">{serviceFeeText(data.serviceFeeLine)}</span> : null}
          {declinedOffer ? (
            <span data-testid="wallet-founding-declined">
              {data.serviceFeeLine ? ' · ' : ''}You declined the founding offer.{' '}
              <button type="button" onClick={openOffer} className="font-medium text-lichen-text hover:underline">
                Review it
              </button>
            </span>
          ) : null}
        </p>
      ) : null}

      {/* Bank top-ups still at the bank: not in the balance, and not spendable,
          until the bank confirms. Saying so is the whole difference between a
          bank top-up and a card one. */}
      {(data.pendingTopUps || []).map((item) => (
        <DismissibleBanner
          key={`pending-${item.startedAt}-${item.amount}`}
          id="wallet:bank-pending"
          signature={`${item.startedAt}:${item.amount}`}
          className="mt-3 rounded-lg! border-hairline bg-well text-ink"
          testId="wallet-bank-pending"
          icon={<Clock className="h-4 w-4" aria-hidden="true" />}
        >
          <span>
            {money(item.amount, currency)} from your bank is processing
            {item.expectedAt
              ? item.expectedFrom
                ? `, expected between ${clearingDate(item.expectedFrom)} and ${clearingDate(item.expectedAt)} (3–5 business days)`
                : `, expected by ${clearingDate(item.expectedAt)}`
              : ''}
            . It&rsquo;s added to your
            balance once your bank confirms. Need funds sooner?{' '}
            <JudgeMoneyActions><button
              type="button"
              onClick={() => openDeposit('card')}
              className="font-semibold underline underline-offset-2"
            >
              Top up by card
            </button></JudgeMoneyActions>
          </span>
        </DismissibleBanner>
      ))}

      {/* This landlord's own top-ups that haven't cleared, at the amount their
          wallet received. A vendor payout can only draw on cleared funds, so a
          payout that waits a day or two needs this to make sense. */}
      {data.clearing.map((item) => (
        <DismissibleBanner
          key={`${item.paidAt}-${item.amount}`}
          id="wallet:clearing"
          signature={`${item.paidAt}:${item.amount}`}
          className="mt-3 rounded-lg! border-hairline bg-well text-ink"
          testId="wallet-clearing"
          icon={<Clock className="h-4 w-4" aria-hidden="true" />}
        >
          {money(item.amount, currency)} from your {item.method === 'bank' ? 'bank ' : ''}top-up on{' '}
          {shortDate(item.paidAt)} is available for vendor payouts around {clearingDate(item.availableOn)}.
        </DismissibleBanner>
      ))}

      {/* Money the ledger counts but Stripe cannot send. Silent, this is exactly
          how a payout fails for insufficient funds against a healthy-looking
          balance. */}
      {data.payoutProvider === 'stripe_connect' && data.externalDeposits > 0 ? (
        <DismissibleBanner
          id="wallet:unbacked"
          signature={String(data.externalDeposits)}
          className="mt-3 rounded-lg! border-lichen-line bg-lichen-tint text-lichen-text"
          testId="wallet-unbacked"
          icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
        >
          {money(data.externalDeposits, currency)} of your balance came from external transfers.
          Vendor payouts draw on {bankOn ? 'card and bank' : 'card'} top-ups, so those may fail until you pay {payBy}.
        </DismissibleBanner>
      ) : null}

      <JudgeMoneyActions><div className="mt-5">
        <Button
          onClick={() => {
            openDeposit();
          }}
          className="h-11 gap-1.5 bg-primary text-primary-foreground px-[min(1.25rem,20px)] hover:bg-primary/90"
          data-testid="wallet-add-funds"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add funds
        </Button>
      </div></JudgeMoneyActions>

      {/* Jobs booked while this landlord paid vendors directly, before the
          switch to platform payouts. Nothing shows when there are none. */}
      <DirectPayments presentation data={directPayments} onChanged={() => void load(true)} showEmpty={false} />

      <Card className="mt-5 border border-border p-4 shadow-none">
        <FilterChips presentation options={KINDS} value={kind} onChange={changeKind} testIdPrefix="wallet-filter" />
      </Card>

      <div ref={tableRef} className="scroll-mt-6">
        <Card className="mt-4 gap-0 overflow-hidden border border-border p-0 shadow-none">
          <div className="px-[min(1.25rem,20px)] pb-3 pt-5">
            <h3 className="text-lg font-semibold text-ink">Transactions</h3>
            <p className="text-sm text-meta">A complete history of your wallet activity.</p>
          </div>

          {entries.length === 0 ? (
            <div className="px-[min(1.25rem,20px)] pb-5">
              <EmptyState
                icon={Wallet}
                title={kind === 'all' ? 'Nothing yet' : 'No transactions of this kind'}
                description={
                  kind === 'all'
                    ? 'Top up your balance, and every hold and payout will be listed here.'
                    : 'Try another filter, or All.'
                }
                testId="wallet-empty"
              />
            </div>
          ) : (
            <div className={`@container transition-opacity ${paging ? 'pointer-events-none opacity-50' : ''}`} aria-busy={paging}>
              {/* Column headings. Columns follow this table's own width in the current text
                  size (container queries), so 200% text gets the narrow layout instead of
                  overflowing. minmax(0,1fr) lets the description shrink and wrap. The balance
                  column becomes a line under the amount below 42rem, and is dropped only on
                  phone-width tables (under 24rem), as before. */}
              <div className="hidden min-w-0 @min-[28rem]:grid @min-[28rem]:grid-cols-[4.5rem_minmax(0,1fr)_auto] @min-[48rem]:grid-cols-[5rem_2.25rem_minmax(0,1fr)_minmax(0,9rem)_minmax(0,8rem)] items-center gap-3 border-y border-hairline px-[min(1.25rem,20px)] py-2.5 text-xs font-semibold tracking-normal text-meta">
                <span>Date</span>
                <span className="hidden @min-[48rem]:block" />
                <span>Description</span>
                <span className="text-right">Amount</span>
                <span className="hidden text-right @min-[48rem]:block">Balance</span>
              </div>

              {groupByDay(entries).map((group) => (
                <div key={group.day}>
                  <div className="bg-well px-[min(1.25rem,20px)] py-2 text-xs font-semibold tracking-normal text-meta">
                    {group.day}
                  </div>
                  <div className="divide-y divide-hairline">
                    {group.rows.map((entry) => {
                      const Icon = TYPE_ICONS[entry.type] || RefreshCw;
                      const isPayout = entry.type === 'payout';
                      // pending_onboarding is deliberately NOT here. The vendor
                      // has not said where to send the money, so there is nothing
                      // a human could truthfully be confirming — and marking it
                      // paid recorded a delivery that could not have happened.
                      const needsAction = isPayout && ['pending_manual', 'failed'].includes(entry.providerStatus);
                      const awaitingVendorSetup = isPayout && entry.providerStatus === 'pending_onboarding';
                      const awaitingFunds = isPayout && entry.providerStatus === 'awaiting_funds';
                      const awaitingClearance = isPayout && entry.providerStatus === 'awaiting_clearance';
                      const subtitle = rowSubtitle(entry);
                      return (
                        <div
                          key={entry.id}
                          className="grid min-w-0 grid-cols-[minmax(0,1fr)] @min-[28rem]:grid-cols-[4.5rem_minmax(0,1fr)_auto] @min-[48rem]:grid-cols-[5rem_2.25rem_minmax(0,1fr)_minmax(0,9rem)_minmax(0,8rem)] items-start gap-3 px-[min(1.25rem,20px)] py-3.5"
                          data-testid={`wallet-entry-${entry.id}`}
                        >
                          <span className="pt-1.5 text-xs text-meta tabular-nums">
                            {new Date(entry.createdAt).toLocaleTimeString(undefined, {
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </span>

                          <span
                            className={`hidden h-8 w-8 items-center justify-center rounded-full @min-[48rem]:flex ${
                              entry.direction === 'in'
                                ? 'bg-mist-tint text-mist-text'
                                : entry.direction === 'out'
                                  ? 'bg-chip text-meta'
                                  : 'bg-well text-meta'
                            }`}
                          >
                            <Icon className="h-4 w-4" aria-hidden="true" />
                          </span>

                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="min-w-0 text-sm font-medium text-ink [overflow-wrap:anywhere]">{entry.title}</span>
                              {isPayout && STATUS_LABELS[entry.providerStatus] ? (
                                <Badge
                                  className={`border-transparent ${
                                    STATUS_STYLES[entry.providerStatus] || STATUS_STYLES.none
                                  } ${sandboxWallet ? 'max-w-full whitespace-normal [overflow-wrap:anywhere]' : ''}`}
                                >
                                  {STATUS_LABELS[entry.providerStatus]}
                                </Badge>
                              ) : null}
                              {/* The status badge already says it on a waiting payout. */}
                              {entry.shortfall && !awaitingFunds ? (
                                <Badge className="border-transparent bg-alert-tint text-alert-text">Not covered</Badge>
                              ) : null}
                            </div>

                            {subtitle ? <div className="mt-0.5 text-xs text-meta [overflow-wrap:anywhere]">{subtitle}</div> : null}

                            {entry.returnedToBalance ? (
                              <div className="mt-0.5 text-xs text-meta">
                                {money(entry.returnedToBalance, entry.currency)} of the reservation returned to your
                                balance
                              </div>
                            ) : null}

                            {entry.serviceFee ? (
                              <div className="mt-0.5 text-xs text-meta" data-testid="wallet-service-fee">
                                {entry.serviceFee.waived === 'beta'
                                  ? `Artrelo service fee ${money(entry.serviceFee.amount, entry.currency)} — waived during your beta`
                                  : entry.serviceFee.owed > 0
                                    ? `Artrelo service fee ${money(entry.serviceFee.charged, entry.currency)} — ${money(entry.serviceFee.owed, entry.currency)} wasn't covered by your balance and will be paid from your next top-up`
                                    : `Artrelo service fee ${money(entry.serviceFee.amount, entry.currency)}`}
                              </div>
                            ) : null}

                            {awaitingVendorSetup ? (
                              <p className="mt-1 text-xs text-meta">
                                Waiting on the vendor to add bank details. It sends automatically once they do.
                              </p>
                            ) : null}

                            {awaitingClearance ? (
                              <p className="mt-1 text-xs text-meta" data-testid="wallet-awaiting-clearance">
                                Paid for. Your top-up is still clearing at Stripe, so this sends to the vendor
                                automatically{' '}
                                {entry.clearsOn ? `around ${clearingDate(entry.clearsOn)}` : 'in a few business days'}.
                                Nothing to do.
                              </p>
                            ) : null}

                            {awaitingFunds ? (
                              <p className="mt-1 text-xs text-meta">
                                Your balance didn&rsquo;t cover this part. Add funds {payBy} and it sends to the vendor
                                automatically.
                              </p>
                            ) : null}

                            {needsAction ? (<JudgeMoneyActions>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {entry.providerStatus === 'failed' ? (
                                  <Button
                                    variant="outline"
                                    onClick={() => void retry(entry)}
                                    disabled={busyId === entry.id}
                                    className="h-8 gap-1 border-border text-xs"
                                  >
                                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                                    Retry
                                  </Button>
                                ) : null}
                                <Button
                                  variant="outline"
                                  onClick={() => void markPaid(entry)}
                                  disabled={busyId === entry.id}
                                  className="h-8 gap-1 border-border text-xs"
                                  data-testid={`wallet-mark-paid-${entry.id}`}
                                >
                                  {busyId === entry.id ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                  ) : (
                                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                  )}
                                  Mark paid
                                </Button>
                              </div></JudgeMoneyActions>
                            ) : null}
                          </div>

                          <span
                            className={`min-w-0 pt-1.5 text-left @min-[28rem]:text-right text-sm font-semibold font-mono tabular-nums ${
                              DIRECTION_STYLES[entry.direction] || DIRECTION_STYLES.neutral
                            }`}
                          >
                            {signedAmount(entry, entry.currency)}
                            {entry.balanceAfter ? (
                              <span className="mt-0.5 block text-xs font-normal text-meta @min-[48rem]:hidden">
                                Balance {money(entry.balanceAfter.available, entry.currency)}
                              </span>
                            ) : null}
                          </span>

                          <span className="hidden min-w-0 pt-1.5 text-right text-sm text-meta font-mono tabular-nums @min-[48rem]:block">
                            {entry.balanceAfter ? money(entry.balanceAfter.available, entry.currency) : '—'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {pagination && pagination.totalPages > 1 ? (
            <div className="border-t border-hairline px-[min(1.25rem,20px)] py-3">
              <TablePagination
                presentation
                page={pagination.page}
                totalPages={pagination.totalPages}
                total={total}
                from={from}
                to={to}
                noun="transactions"
                onPageChange={goToPage}
                testId="wallet-pagination"
              />
            </div>
          ) : null}
        </Card>
      </div>

      <JudgeMoneyActions><FormDialog
        className={WALLET_PORTAL}
        open={depositOpen}
        onOpenChange={setDepositOpen}
        icon={Wallet}
        title="Add funds"
        description={
          data.onlinePayments === false
            ? "Card and bank top-ups aren't set up on this server."
            : bankOn
            ? 'Top up from your bank (no fee) or by card so vendor payouts can draw on it.'
            : 'Pay by card so vendor payouts can draw on it.'
        }
      >
        <div>
          {activeCardPilot(data.cardPilot) ? <p className="mb-3 text-sm text-meta">A single $1 pilot top-up is available until {new Date(data.cardPilot.expiresAt).toLocaleString()}. The processing fee is shown before payment. Other card top-ups start at $20.</p> : null}
          <FieldLabel className="text-xs tracking-normal text-meta">Amount ({currency})</FieldLabel>
          <Input
            aria-label={`Amount (${currency})`}
            type="number"
            min={activeCardPilot(data.cardPilot) ? 1 : bankOn ? Math.min(MIN_CARD_DEPOSIT, (data.bankDebit?.minCents ?? 0) / 100) : MIN_CARD_DEPOSIT}
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setAmountError('');
            }}
            placeholder="1000"
            aria-invalid={Boolean(amountError)}
            aria-describedby={amountError ? 'wallet-deposit-amount-error' : undefined}
            className={`mt-1.5 border-border bg-card ${amountError ? invalidFieldClass : ''}`}
            data-testid="wallet-deposit-amount"
          />
          <FieldError id="wallet-deposit-amount-error" className="mt-1.5">
            {amountError}
          </FieldError>
        </div>

        {/* Bank (when offered) and card are the primary paths: the only ones
            that put money somewhere Stripe can pay a vendor from. */}
        <div className="mt-4">
          <Suspense
            fallback={
              <div className="flex justify-center py-6 text-meta">
                <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading payment form" />
              </div>
            }
          >
            <WalletDepositForm
              // Remounted per opening, so it starts on the method it was opened for.
              key={depositOpen ? `open:${depositMethod || 'default'}` : 'closed'}
              initialMethod={depositMethod}
              amount={Number(amount) || 0}
              bank={data.bankDebit}
              cardPilot={data.cardPilot}
              onlinePayments={data.onlinePayments !== false}
              onAmountError={setAmountError}
              onDone={() => {
                setDepositOpen(false);
                setAmount('');
                void load(true);
              }}
            />
          </Suspense>
        </div>

      </FormDialog></JudgeMoneyActions>
    </PageContainer>
  );
}
