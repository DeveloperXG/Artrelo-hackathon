import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Building2, CreditCard, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, LandlordAPI } from '../../api/client';
import { Button } from '../ui/button';
import { MIN_CARD_DEPOSIT, activeCardPilot, validCardAmount, type CardPilot, type BankDebitStatus } from '../../lib/walletLimits';

export { MIN_CARD_DEPOSIT, type BankDebitStatus };

type Method = 'bank' | 'card';

/** The split the server computed: what the wallet gets, the fee, the total charged. */
type Breakdown = { walletAmount: number; processingFee: number; chargeAmount: number };

const dollars = (value: number) =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(value || 0);
const cents = (value: number | undefined) => dollars((value || 0) / 100);

/**
 * Top-up for the maintenance wallet: from a bank account (a pre-authorized
 * debit) or by card.
 *
 * Both are three-legged:
 *
 *   1. the server mints a PaymentIntent and returns its client_secret
 *   2. Stripe Elements collects the card or the bank account, in an iframe we
 *      never see into (a SAVED bank account skips this: the server confirms it)
 *   3. Stripe's webhook credits the ledger
 *
 * The balance does NOT move when this form succeeds. That is the point — a
 * confirmed payment is not the same as settled money, and crediting on the
 * client's say-so is how a wallet ends up reading money it does not have. A
 * card settles in seconds; a bank debit takes days, and the Wallet shows it as
 * "processing" until it does.
 *
 * BANK IS THE DEFAULT when it is offered: no fee on top. Card stays as the
 * option that reaches the balance right away -- vendor payouts still wait about
 * 3 business days for Stripe to settle it -- with its processing fee shown
 * before paying.
 *
 * Every attempt carries a token the server uses as Stripe's idempotency key,
 * so a double-click — or a retry after a dropped response — never starts a
 * second payment. A new token is minted for a new amount or method.
 */

const publishableKey =
  (import.meta as { env: { VITE_STRIPE_PUBLISHABLE_KEY?: string } }).env
    .VITE_STRIPE_PUBLISHABLE_KEY || '';

// loadStripe must be called once, outside render, or every keystroke re-fetches
// Stripe.js.
let stripePromise: Promise<Stripe | null> | null = null;
function getStripePromise() {
  if (!stripePromise && publishableKey) stripePromise = loadStripe(publishableKey);
  return stripePromise;
}

function newToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Not a secure context: fall through.
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** One token per attempt: the same until the amount or method changes, or it is used up. */
function useAttemptToken(...deps: unknown[]) {
  const token = useRef(newToken());
  useEffect(() => {
    token.current = newToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return {
    get: () => token.current,
    renew: () => {
      token.current = newToken();
    },
  };
}

const elementsOptions = (clientSecret: string) => ({
  clientSecret,
  appearance: {
    theme: 'stripe' as const,
    variables: { colorPrimary: '#137fec', borderRadius: '8px' },
  },
});

/**
 * Contains Stripe failures to the payment form.
 *
 * Stripe validates Element options at create() time and THROWS on anything it
 * doesn't recognise. React has no default recovery for a throw during render,
 * so without a boundary here a single bad option (a `layout: 'tab'` typo, as it
 * happens) unmounted the entire dashboard and left a white screen.
 *
 * A payment widget failing should cost the landlord the payment widget, not the
 * page they were on.
 */
class PaymentErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; message: string }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { failed: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { failed: true, message: error?.message || 'Payments are unavailable.' };
  }

  componentDidCatch(error: Error) {
    // Still surfaced for whoever has the console open — swallowing it entirely
    // would make the next integration error invisible instead of merely
    // survivable.
    console.error('[WalletDepositForm] Stripe payment element failed:', error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 in-[.lichen-wallet]:border-lichen-line in-[.lichen-wallet]:bg-lichen-tint in-[.lichen-wallet]:px-[min(0.75rem,12px)] in-[.lichen-wallet]:text-lichen-text">
          <b>Payments aren&rsquo;t working right now.</b> Try again shortly.
          <div className="mt-1 font-mono text-[11px] text-amber-800/80 in-[.lichen-wallet]:text-xs in-[.lichen-wallet]:text-lichen-pill">{this.state.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Put an amount problem beside the field; anything else in the form. */
function routeError(err: unknown, onAmountError: (m: string) => void, setError: (m: string) => void, fallback: string) {
  const field = err instanceof ApiError ? (err.payload as { field?: string } | null)?.field : undefined;
  const message = err instanceof Error ? err.message : fallback;
  if (field === 'amount') onAmountError(message);
  else setError(message);
}

const BANK_STARTED = (amount: number) =>
  `${dollars(amount)} bank top-up started. It's added to your balance once your bank confirms, usually within 3–5 business days.`;

/* ------------------------------------------------------------------ *
 * Card
 * ------------------------------------------------------------------ */

function CardFields({ breakdown, onDone }: { breakdown: Breakdown; onDone: () => void }) {
  const amount = breakdown.walletAmount;
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements) return;

    setBusy(true);
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
    });
    setBusy(false);

    if (error) {
      toast.error(error.message || 'That card was declined.');
      return;
    }

    if (paymentIntent?.status === 'succeeded') {
      // Deliberately not "added to your balance" — the webhook has not
      // necessarily landed yet, and card funds take days to clear into a
      // balance Stripe can actually send from.
      toast.success(`${dollars(amount)} top-up accepted. It'll appear in your balance shortly.`);
      onDone();
      return;
    }

    toast.message('Payment is processing. Your balance will update when it settles.');
    onDone();
  };

  return (
    <form onSubmit={submit}>
      {/* Before the card, not after: the landlord sees exactly what the card is
          charged and what reaches the wallet. */}
      <dl
        className="mb-4 space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm in-[.lichen-wallet]:border-control-border in-[.lichen-wallet]:bg-well in-[.lichen-wallet]:px-[min(0.75rem,12px)]"
        data-testid="wallet-card-breakdown"
      >
        <div className="flex justify-between text-slate-600 in-[.lichen-wallet]:text-meta in-[.lichen-wallet]:flex-wrap">
          <dt>Added to your wallet</dt>
          <dd className="tabular-nums">{dollars(breakdown.walletAmount)}</dd>
        </div>
        <div className="flex justify-between text-slate-600 in-[.lichen-wallet]:text-meta in-[.lichen-wallet]:flex-wrap">
          <dt>Card processing</dt>
          <dd className="tabular-nums">{dollars(breakdown.processingFee)}</dd>
        </div>
        <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold text-slate-900 in-[.lichen-wallet]:border-control-border in-[.lichen-wallet]:text-ink in-[.lichen-wallet]:flex-wrap">
          <dt>Charged to your card</dt>
          <dd className="tabular-nums">{dollars(breakdown.chargeAmount)}</dd>
        </div>
      </dl>
      {/* 'tabs', not 'tab'. Stripe validates this at create() time and throws an
          IntegrationError, which took the whole dashboard down — see the error
          boundary. */}
      <PaymentElement options={{ layout: 'tabs' }} />
      <Button
        type="submit"
        disabled={!stripe || busy}
        className="mt-4 w-full gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-wallet]:bg-primary in-[.lichen-wallet]:hover:bg-primary/90 in-[.lichen-wallet]:text-primary-foreground"
        data-testid="wallet-card-pay"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : (
          <CreditCard className="h-4 w-4" aria-hidden="true" />
        )}
        Pay {dollars(breakdown.chargeAmount)}
      </Button>
    </form>
  );
}

function CardTopUp({
  amount,
  pilot,
  onDone,
  onAmountError,
}: {
  amount: number;
  pilot?: CardPilot | null;
  onDone: () => void;
  onAmountError: (message: string) => void;
}) {
  const [clientSecret, setClientSecret] = useState('');
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const token = useAttemptToken(amount);

  // The intent was minted for one amount. Editing the amount afterwards must
  // not leave a card form that would charge the old one.
  useEffect(() => {
    setClientSecret('');
    setBreakdown(null);
  }, [amount]);

  const start = async () => {
    if (!validCardAmount(amount, pilot)) {
      onAmountError(activeCardPilot(pilot) ? `This pilot permits exactly $1. Other card top-ups start at ${dollars(MIN_CARD_DEPOSIT)}.` : `Card top-ups start at ${dollars(MIN_CARD_DEPOSIT)}.`);
      return;
    }
    setStarting(true);
    setError('');
    try {
      const res = await LandlordAPI.createDepositIntent({ amount, method: 'card', clientToken: token.get() });
      const data = res.data as { clientSecret: string } & Breakdown;
      setBreakdown({
        walletAmount: data.walletAmount,
        processingFee: data.processingFee,
        chargeAmount: data.chargeAmount,
      });
      setClientSecret(data.clientSecret);
    } catch (err) {
      routeError(err, onAmountError, setError, 'Could not start the top-up.');
    } finally {
      setStarting(false);
    }
  };

  const options = useMemo(() => elementsOptions(clientSecret), [clientSecret]);

  if (!clientSecret || !breakdown) {
    return (
      <div>
        {error ? <p className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-900 in-[.lichen-wallet]:bg-alert-tint in-[.lichen-wallet]:px-[min(0.75rem,12px)] in-[.lichen-wallet]:text-alert-text">{error}</p> : null}
        <Button
          onClick={() => void start()}
          disabled={starting || !(amount > 0)}
          className="w-full gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-wallet]:bg-primary in-[.lichen-wallet]:hover:bg-primary/90 in-[.lichen-wallet]:text-primary-foreground"
          data-testid="wallet-card-start"
        >
          {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : (
            <CreditCard className="h-4 w-4" aria-hidden="true" />
          )}
          Pay by card
        </Button>
      </div>
    );
  }

  return (
    <PaymentErrorBoundary>
      <Elements stripe={getStripePromise()} options={options}>
        <CardFields
          breakdown={breakdown}
          onDone={() => {
            token.renew();
            onDone();
          }}
        />
      </Elements>
    </PaymentErrorBoundary>
  );
}

/* ------------------------------------------------------------------ *
 * Bank
 * ------------------------------------------------------------------ */

function BankFields({ amount, onDone }: { amount: number; onDone: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements) return;

    setBusy(true);
    setError('');
    // Stripe collects the account (instant verification, or two small deposits)
    // and shows the pre-authorized debit agreement before it confirms.
    const { error: failure, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
    });
    setBusy(false);

    if (failure) {
      setError(failure.message || 'That bank account could not be used.');
      return;
    }
    if (paymentIntent?.status === 'requires_action') {
      // Verification by micro-deposits: nothing is debited until they confirm.
      toast.message(
        'Almost done: Stripe will send two small deposits to that account within 1–2 business days and email you a link to confirm them. Your top-up starts once you do.'
      );
      onDone();
      return;
    }
    toast.success(BANK_STARTED(amount));
    onDone();
  };

  return (
    <form onSubmit={submit}>
      <PaymentElement options={{ layout: 'tabs' }} />
      {error ? <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-900 in-[.lichen-wallet]:bg-alert-tint in-[.lichen-wallet]:px-[min(0.75rem,12px)] in-[.lichen-wallet]:text-alert-text">{error}</p> : null}
      <Button
        type="submit"
        disabled={!stripe || busy}
        className="mt-4 w-full gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-wallet]:bg-primary in-[.lichen-wallet]:hover:bg-primary/90 in-[.lichen-wallet]:text-primary-foreground"
        data-testid="wallet-bank-confirm"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : (
          <Building2 className="h-4 w-4" aria-hidden="true" />
        )}
        Top up {dollars(amount)} from this account
      </Button>
    </form>
  );
}

function BankTopUp({
  amount,
  bank,
  onDone,
  onAmountError,
  onUseCard,
}: {
  amount: number;
  bank: BankDebitStatus;
  onDone: () => void;
  onAmountError: (message: string) => void;
  /** Switch this dialog to the card option. */
  onUseCard: () => void;
}) {
  const [clientSecret, setClientSecret] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [useNewAccount, setUseNewAccount] = useState(!bank.saved);
  const [transactionType, setTransactionType] = useState<'' | 'personal' | 'business'>('');
  const token = useAttemptToken(amount, useNewAccount, transactionType);
  const minimum = (bank.minCents ?? 10000) / 100;
  // One top-up still at the bank and not yet trusted: say so BEFORE the click,
  // in the server's words (which top-up, until when, what lifts the rule). The
  // banner that said it may have been dismissed days ago.
  const waiting = Boolean(bank.reason) && !bank.blocked;

  useEffect(() => {
    setClientSecret('');
    setError('');
  }, [amount, useNewAccount, transactionType]);

  const start = async (useSaved: boolean) => {
    if (!useSaved && !transactionType) { setError('Choose whether this is a personal or business bank account.'); return; }
    if (amount < minimum) {
      onAmountError(`Bank top-ups start at ${dollars(minimum)}.`);
      return;
    }
    if (bank.capCents && amount * 100 > bank.capCents) {
      onAmountError(
        `Each bank top-up can be up to ${cents(bank.capCents)} until ${bank.trustedAfter ?? 3} of your bank top-ups have cleared (${
          bank.cleared ?? 0
        } so far). Top up a larger amount by card.`
      );
      return;
    }
    setStarting(true);
    setError('');
    try {
      const res = await LandlordAPI.createDepositIntent({ amount, method: 'bank', clientToken: token.get(), useSaved, transactionType: transactionType || undefined });
      const data = res.data as { clientSecret: string | null; status: string };
      if (useSaved) {
        token.renew();
        toast.success(BANK_STARTED(amount));
        onDone();
        return;
      }
      if (data.clientSecret) setClientSecret(data.clientSecret);
    } catch (err) {
      routeError(err, onAmountError, setError, 'Could not start the bank top-up.');
    } finally {
      setStarting(false);
    }
  };

  const options = useMemo(() => elementsOptions(clientSecret), [clientSecret]);

  return (
    <div>
      <p
        className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600 in-[.lichen-wallet]:border-control-border in-[.lichen-wallet]:bg-well in-[.lichen-wallet]:px-[min(0.75rem,12px)] in-[.lichen-wallet]:text-meta"
        data-testid="wallet-bank-terms"
      >
        <b className="text-slate-800 in-[.lichen-wallet]:text-ink">No fee.</b> It&rsquo;s added to your balance once your bank confirms, usually
        within 3–5 business days. If your bank refuses the debit, a {cents(bank.failureFeeCents)} fee applies; if a
        top-up is later reversed at your bank, it&rsquo;s taken back out of your wallet with a{' '}
        {cents(bank.disputeFeeCents)} fee. From {dollars(minimum)}
        {bank.capCents
          ? `, up to ${cents(bank.capCents)} per top-up until ${bank.trustedAfter ?? 3} of your bank top-ups have cleared (${
              bank.cleared ?? 0
            } so far)`
          : ''}.
      </p>

      {waiting ? (
        <div
          className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-900 in-[.lichen-wallet]:border-lichen-line in-[.lichen-wallet]:bg-lichen-tint in-[.lichen-wallet]:px-[min(0.75rem,12px)] in-[.lichen-wallet]:text-lichen-text"
          data-testid="wallet-bank-waiting"
        >
          {bank.reason}
          <button
            type="button"
            onClick={onUseCard}
            className="mt-1.5 block font-semibold underline underline-offset-2"
            data-testid="wallet-bank-use-card"
          >
            Pay by card instead
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="mb-2 rounded-lg bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-900 in-[.lichen-wallet]:bg-alert-tint in-[.lichen-wallet]:px-[min(0.75rem,12px)] in-[.lichen-wallet]:text-alert-text" data-testid="wallet-bank-error">
          {error}
          <button type="button" onClick={onUseCard} className="mt-1 block font-semibold underline underline-offset-2">
            Pay by card instead
          </button>
        </div>
      ) : null}

      {useNewAccount && !clientSecret ? (
        <label className="mb-3 block text-sm font-medium">
          Bank account type
          <select aria-label="Bank account type" value={transactionType} onChange={(event) => setTransactionType(event.target.value as '' | 'personal' | 'business')} className="mt-1 block w-full rounded border border-slate-200 bg-white p-2 in-[.lichen-wallet]:rounded-md in-[.lichen-wallet]:border-control-border in-[.lichen-wallet]:bg-card">
            <option value="">Choose your account type</option>
            <option value="personal">Personal bank account</option>
            <option value="business">Business bank account</option>
          </select>
        </label>
      ) : null}

      {/* Which account: the saved one, or another. Either way round, any time
          before paying; the other choice is never more than a click away. */}
      {bank.saved && !waiting ? (
        <div className="mb-3 flex flex-col gap-1.5 in-[.lichen-wallet]:flex-wrap" role="radiogroup" aria-label="Which bank account">
          {[
            {
              value: false,
              label: `${bank.saved.institution || 'Saved account'} ••${bank.saved.last4 || '····'}`,
              detail: 'Saved · one click, no form',
              testId: 'wallet-bank-account-saved',
            },
            {
              value: true,
              label: 'A different bank account',
              detail: 'Enter or verify another account',
              testId: 'wallet-bank-account-new',
            },
          ].map((option) => {
            const selected = useNewAccount === option.value;
            return (
              <button
                key={option.testId}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setUseNewAccount(option.value)}
                data-testid={option.testId}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition  in-[.lichen-wallet]:px-[min(0.75rem,12px)] in-[.lichen-wallet]:flex-wrap ${
                  selected ? "border-[#137fec] bg-[#137fec]/5 in-[.lichen-wallet]:border-lichen-line in-[.lichen-wallet]:bg-lichen-tint" : "border-slate-200 bg-white hover:border-slate-300 in-[.lichen-wallet]:border-control-border in-[.lichen-wallet]:bg-card in-[.lichen-wallet]:hover:border-lichen-line"
                }`}
              >
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border  in-[.lichen-wallet]:flex-wrap ${
                    selected ? "border-[#137fec] in-[.lichen-wallet]:border-lichen-line" : "border-slate-300 in-[.lichen-wallet]:border-control-border"
                  }`}
                  aria-hidden="true"
                >
                  {selected ? <span className="h-2 w-2 rounded-full bg-[#137fec] in-[.lichen-wallet]:bg-primary in-[.lichen-wallet]:text-primary-foreground" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-900 in-[.lichen-wallet]:text-ink">{option.label}</span>
                  <span className="block text-xs text-slate-500 in-[.lichen-wallet]:text-meta">{option.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {waiting ? null : clientSecret ? (
        <PaymentErrorBoundary>
          <Elements stripe={getStripePromise()} options={options}>
            <BankFields
              amount={amount}
              onDone={() => {
                token.renew();
                onDone();
              }}
            />
          </Elements>
        </PaymentErrorBoundary>
      ) : bank.saved && !useNewAccount ? (
        <Button
          onClick={() => void start(true)}
          disabled={starting || !(amount > 0)}
          className="w-full gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-wallet]:bg-primary in-[.lichen-wallet]:hover:bg-primary/90 in-[.lichen-wallet]:text-primary-foreground"
          data-testid="wallet-bank-saved-pay"
        >
          {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : (
            <Building2 className="h-4 w-4" aria-hidden="true" />
          )}
          Top up {amount > 0 ? dollars(amount) : ''} from {bank.saved.institution || 'bank'} ••{bank.saved.last4 || '····'}
        </Button>
      ) : (
        <Button
          onClick={() => void start(false)}
          disabled={starting || !(amount > 0)}
          className="w-full gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-wallet]:bg-primary in-[.lichen-wallet]:hover:bg-primary/90 in-[.lichen-wallet]:text-primary-foreground"
          data-testid="wallet-bank-start"
        >
          {starting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : (
            <Building2 className="h-4 w-4" aria-hidden="true" />
          )}
          Continue with bank account
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The picker
 * ------------------------------------------------------------------ */

function MethodOption({
  selected,
  onSelect,
  icon,
  title,
  detail,
  testId,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: string;
  detail: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={testId}
      className={`flex min-w-0 flex-1 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition  in-[.lichen-wallet]:px-[min(0.75rem,12px)] in-[.lichen-wallet]:flex-wrap ${
        selected ? "border-[#137fec] bg-[#137fec]/5 ring-1 ring-[#137fec] in-[.lichen-wallet]:border-lichen-line in-[.lichen-wallet]:bg-lichen-tint in-[.lichen-wallet]:ring-lichen" : "border-slate-200 bg-white hover:border-slate-300 in-[.lichen-wallet]:border-control-border in-[.lichen-wallet]:bg-card in-[.lichen-wallet]:hover:border-lichen-line"
      }`}
    >
      <span className={`mt-0.5 shrink-0 ${selected ? "text-[#137fec] in-[.lichen-wallet]:text-lichen-text" : "text-slate-400 in-[.lichen-wallet]:text-meta"}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-slate-900 in-[.lichen-wallet]:text-ink">{title}</span>
        <span className="block text-xs text-slate-500 in-[.lichen-wallet]:text-meta">{detail}</span>
      </span>
    </button>
  );
}

export default function WalletDepositForm({
  amount,
  initialMethod,
  bank,
  onlinePayments = true,
  cardPilot,
  onDone,
  onAmountError,
}: {
  amount: number;
  /** Open on this method (a "Top up by card" link). Default: bank when offered. */
  initialMethod?: Method;
  /** False when the server has no Stripe key: nothing can be charged, so say that instead of offering a form. */
  onlinePayments?: boolean;
  cardPilot?: CardPilot | null;
  /** Bank top-ups for this landlord; absent or disabled = card only, as before. */
  bank?: BankDebitStatus | null;
  onDone: () => void;
  /** Puts an amount problem beside the amount field rather than in this form. */
  onAmountError: (message: string) => void;
}) {
  const bankOffered = Boolean(bank?.enabled);
  const bankUsable = bankOffered && !bank?.blocked;
  const [method, setMethod] = useState<Method>(initialMethod === 'card' || !bankUsable ? 'card' : 'bank');

  // The status arrives with the wallet; follow it if it changes underneath.
  useEffect(() => {
    if (!bankUsable && method === 'bank') setMethod('card');
  }, [bankUsable, method]);

  // Either half missing means no payment can complete. Say which, plainly,
  // before the landlord types a card number into a form that can only fail.
  if (!onlinePayments || !publishableKey) {
    return (
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 in-[.lichen-wallet]:bg-lichen-tint in-[.lichen-wallet]:px-[min(0.75rem,12px)] in-[.lichen-wallet]:text-lichen-text" data-testid="wallet-payments-off">
        Card and bank top-ups aren&rsquo;t set up on this server: it isn&rsquo;t connected to Stripe
        {onlinePayments ? ' (no publishable key in the app)' : ''}, so nothing can be charged here.
      </p>
    );
  }

  return (
    <div>
      {bankOffered ? (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row in-[.lichen-wallet]:flex-wrap" role="radiogroup" aria-label="How to pay">
          {bankUsable ? (
            <MethodOption
              selected={method === 'bank'}
              onSelect={() => setMethod('bank')}
              icon={<Building2 className="h-4 w-4" aria-hidden="true" />}
              title="Bank account"
              detail="No fee · 3–5 business days"
              testId="wallet-method-bank"
            />
          ) : null}
          <MethodOption
            selected={method === 'card'}
            onSelect={() => setMethod('card')}
            icon={<CreditCard className="h-4 w-4" aria-hidden="true" />}
            title="Card"
            // "Instant" was true for the landlord's balance only: Stripe holds
            // Canadian card money about 3 business days before a vendor
            // payout can draw on it (7 calendar days on a new account).
            detail="In your balance right away · vendor payouts can use it in about 3 business days"
            testId="wallet-method-card"
          />
        </div>
      ) : null}
      {bankOffered && bank?.blocked ? (
        <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600 in-[.lichen-wallet]:bg-well in-[.lichen-wallet]:px-[min(0.75rem,12px)] in-[.lichen-wallet]:text-meta" data-testid="wallet-bank-paused">
          {bank?.reason ||
            'Bank top-ups are paused on your account after a reversed debit. You can still top up by card, or contact support to resume them.'}
        </p>
      ) : null}

      {method === 'bank' && bank ? (
        <BankTopUp
          amount={amount}
          bank={bank}
          onDone={onDone}
          onAmountError={onAmountError}
          onUseCard={() => setMethod('card')}
        />
      ) : (
        <CardTopUp pilot={cardPilot} amount={amount} onDone={onDone} onAmountError={onAmountError} />
      )}
    </div>
  );
}
