import { D3_FIELD } from '../request-detail/d3Presentation';
import { D3FormDialog, D3_PORTAL, useD3Presentation } from '../request-detail/d3Presentation';
import { useState } from 'react';
import { CheckCircle2, HandCoins, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { LandlordAPI } from '../../api/client';
import { refreshLandlordBadges } from '../../hooks/landlord/useLandlordBadges';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { EmptyState, FieldLabel } from './landlordUi';
import RequestIdentity from './RequestIdentity';

/**
 * Jobs a direct-pay landlord pays vendors for themselves, and the button that
 * records it.
 *
 * None of this is wallet money. The landlord e-transfers (or cheques) the
 * vendor, then says so here; Artrelo keeps the record so the job, the vendor's
 * jobs page and the reports all agree that it was paid.
 */

export type DirectPayment = {
  appointmentId: string;
  requestId: string;
  issueTitle: string | null;
  property: string | null;
  unit: string | null;
  vendorName: string | null;
  amount: number;
  status: 'due' | 'paid';
  dueSince: string | null;
  paidAt: string | null;
  reference: string | null;
};

export type DirectPaymentsData = { due: DirectPayment[]; paid: DirectPayment[]; dueTotal: number };

const money = (amount: number) =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount || 0);
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

const where = (p: DirectPayment) => [p.property, p.unit ? `Unit ${p.unit}` : null].filter(Boolean).join(' · ');

function PaymentRow({ payment, onMark }: { payment: DirectPayment; onMark?: (p: DirectPayment) => void }) {
  const vendor = payment.vendorName || 'the vendor';
  return (
    <div
      className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between in-[.lichen-wallet]:flex-wrap in-[.lichen-wallet]:[overflow-wrap:anywhere] in-[.lichen-wallet]:px-[min(1.25rem,20px)]"
      data-testid={`direct-payment-${payment.appointmentId}`}
    >
      <div className="min-w-0 in-[.lichen-wallet]:flex-[1_1_10rem]">
        <Link
          to={`/dashboard/requests/${payment.requestId}`}
          className="block truncate font-medium text-slate-900 hover:text-[#137fec] in-[.lichen-d3]:text-ink in-[.lichen-d3]:hover:text-lichen-text in-[.lichen-wallet]:whitespace-normal in-[.lichen-wallet]:overflow-visible in-[.lichen-wallet]:text-clip in-[.lichen-wallet]:text-ink in-[.lichen-wallet]:hover:text-lichen-text"
        >
          {payment.issueTitle || 'Maintenance job'}
        </Link>
        <RequestIdentity id={payment.requestId} />
        <p className="mt-0.5 truncate text-sm text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-wallet]:whitespace-normal in-[.lichen-wallet]:overflow-visible in-[.lichen-wallet]:text-clip in-[.lichen-wallet]:text-meta">
          {vendor}
          {where(payment) ? ` · ${where(payment)}` : ''}
        </p>
        <p className="mt-0.5 text-xs text-slate-400 in-[.lichen-d3]:text-meta in-[.lichen-wallet]:text-meta">
          {payment.status === 'due'
            ? `Completed ${day(payment.dueSince)}`
            : `Paid ${day(payment.paidAt)}${payment.reference ? ` · ${payment.reference}` : ''}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3 sm:justify-end in-[.lichen-wallet]:max-w-full in-[.lichen-wallet]:flex-wrap in-[.lichen-wallet]:shrink in-[.lichen-wallet]:[overflow-wrap:anywhere]">
        <span className="font-semibold tabular-nums text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-wallet]:text-ink">{money(payment.amount)}</span>
        {payment.status === 'due' && onMark ? (
          <Button
            size="sm"
            onClick={() => onMark(payment)}
            className="bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground in-[.lichen-wallet]:bg-primary in-[.lichen-wallet]:hover:bg-primary/90 in-[.lichen-wallet]:text-primary-foreground"
            data-testid={`direct-payment-mark-${payment.appointmentId}`}
          >
            Mark paid
          </Button>
        ) : (
          <Badge variant="outline" className="gap-1 border-emerald-200 bg-emerald-50 text-emerald-700 in-[.lichen-d3]:border-mist-line in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text in-[.lichen-wallet]:border-mist-line in-[.lichen-wallet]:bg-mist-tint in-[.lichen-wallet]:text-mist-text">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            Paid
          </Badge>
        )}
      </div>
    </div>
  );
}

/** What the Mark paid dialog needs to know about a payment. */
export type MarkablePayment = Pick<DirectPayment, 'appointmentId' | 'amount' | 'vendorName' | 'issueTitle'>;

/**
 * "I paid the vendor": an optional reference, then one call. Shared by the
 * Payments page and the request page so both say the same thing.
 */
export function MarkDirectPaidDialog({
  payment,
  onClose,
  onMarked,
  presentation = false,
}: {
  /** Open while set. */
  payment: MarkablePayment | null;
  onClose: () => void;
  onMarked: () => void;
  presentation?: boolean;
}) {
  const d3 = useD3Presentation();
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!payment) return;
    setBusy(true);
    try {
      await LandlordAPI.markDirectPaymentPaid(payment.appointmentId, reference.trim());
      toast.success(`Marked ${money(payment.amount)} to ${payment.vendorName || 'the vendor'} as paid.`);
      setReference('');
      onClose();
      void refreshLandlordBadges();
      onMarked();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not mark that payment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <D3FormDialog
      open={Boolean(payment)}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setReference('');
          onClose();
        }
      }}
      icon={HandCoins}
      className={d3 ? `${D3_PORTAL} [&_[data-slot=dialog-header]_.h-10]:rounded-md [&_[data-slot=dialog-header]_.h-10]:bg-chip! [&_[data-slot=dialog-header]_.h-10]:text-chip-icon!` : presentation ? 'lichen lichen-light lichen-wallet font-sans text-ink max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain p-[min(1.5rem,24px)] [overflow-wrap:anywhere] [&_[data-slot=dialog-header]>div]:flex-wrap [&_[data-slot=dialog-header]>div>div:last-child]:min-w-0 [&_[data-slot=dialog-header]_.h-10]:rounded-md [&_[data-slot=dialog-header]_.h-10]:bg-chip! [&_[data-slot=dialog-header]_.h-10]:text-chip-icon! [&_[data-slot=button]]:h-auto [&_[data-slot=button]]:min-h-9 [&_[data-slot=button]]:whitespace-normal [&_[data-slot=button]]:max-w-full [&_:is(button,a,input)]:focus-visible:outline-solid [&_:is(button,a,input)]:focus-visible:outline-2 [&_:is(button,a,input)]:focus-visible:outline-offset-2 [&_:is(button,a,input)]:focus-visible:outline-ring' : undefined}
      title={payment ? `Mark ${money(payment.amount)} as paid` : 'Mark as paid'}
      description={
        payment
          ? `Confirm you've paid ${payment.vendorName || 'the vendor'} for "${payment.issueTitle || 'this job'}". Artrelo doesn't move this money; this only records it.`
          : undefined
      }
    >
      <FieldLabel className="in-[.lichen-d3]:text-meta in-[.lichen-wallet]:text-meta in-[.lichen-wallet]:text-xs in-[.lichen-wallet]:tracking-normal">Reference (optional)</FieldLabel>
      <Input
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        aria-label="Reference (optional)"
        maxLength={120}
        placeholder="e-transfer #4471"
        className={["mt-1.5 border-slate-200 bg-white in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card", D3_FIELD, presentation && 'border-border bg-card text-ink placeholder:text-meta rounded-md'].filter(Boolean).join(' ')}
        data-testid="direct-payment-reference"
      />
      <Button
        onClick={() => void confirm()}
        disabled={busy}
        className="mt-4 w-full gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground in-[.lichen-wallet]:bg-primary in-[.lichen-wallet]:hover:bg-primary/90 in-[.lichen-wallet]:text-primary-foreground"
        data-testid="direct-payment-confirm"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Mark paid
      </Button>
    </D3FormDialog>
  );
}

export default function DirectPayments({
  data,
  onChanged,
  showEmpty = true,
  presentation = false,
}: {
  data: DirectPaymentsData;
  /** Called after a payment is marked, so the page re-reads. */
  onChanged: () => void;
  /** A direct-pay landlord sees an empty state; a platform one sees nothing. */
  showEmpty?: boolean;
  /** Opt-in from Wallet only; existing request-detail callers are unchanged. */
  presentation?: boolean;
}) {
  const [marking, setMarking] = useState<MarkablePayment | null>(null);
  const openMark = (payment: DirectPayment) => setMarking(payment);

  const empty = data.due.length === 0 && data.paid.length === 0;
  if (empty && !showEmpty) return null;

  return (
    <>
      <Card className={`${presentation ? "" : "ll-fade-up "}mt-5 gap-0 overflow-hidden border border-slate-200/70 p-0 shadow-sm in-[.lichen-d3]:border-border in-[.lichen-d3]:shadow-none in-[.lichen-wallet]:border-border in-[.lichen-wallet]:shadow-none`} data-testid="direct-payments">
        <div className="px-5 pb-3 pt-5">
          <h3 className="text-lg font-semibold text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-wallet]:text-ink">To pay</h3>
          <p className="text-sm text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-wallet]:text-meta">
            {data.due.length
              ? `${data.due.length} finished ${data.due.length === 1 ? 'job' : 'jobs'}, ${money(data.dueTotal)} in total. Pay the vendor your usual way, then mark it paid.`
              : 'Nothing to pay right now. Finished jobs appear here with what you owe the vendor.'}
          </p>
        </div>
        {data.due.length ? (
          <div className="divide-y divide-slate-100 border-t border-slate-100 in-[.lichen-d3]:divide-hairline in-[.lichen-d3]:border-hairline in-[.lichen-wallet]:divide-hairline in-[.lichen-wallet]:border-hairline">
            {data.due.map((payment) => (
              <PaymentRow key={payment.appointmentId} payment={payment} onMark={openMark} />
            ))}
          </div>
        ) : empty ? (
          <div className="px-5 pb-5">
            <EmptyState
              icon={HandCoins}
              title="No payments yet"
              description="When a vendor finishes a job and your tenant confirms it, the amount you owe them shows up here."
              testId="direct-payments-empty"
            />
          </div>
        ) : null}
      </Card>

      {data.paid.length ? (
        <Card className={`${presentation ? "" : "ll-fade-up "}mt-4 gap-0 overflow-hidden border border-slate-200/70 p-0 shadow-sm in-[.lichen-d3]:border-border in-[.lichen-d3]:shadow-none in-[.lichen-wallet]:border-border in-[.lichen-wallet]:shadow-none`} data-testid="direct-payments-paid">
          <div className="px-5 pb-3 pt-5">
            <h3 className="text-lg font-semibold text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-wallet]:text-ink">Paid</h3>
            <p className="text-sm text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-wallet]:text-meta">Payments you&rsquo;ve marked as made, newest first.</p>
          </div>
          <div className="divide-y divide-slate-100 border-t border-slate-100 in-[.lichen-d3]:divide-hairline in-[.lichen-d3]:border-hairline in-[.lichen-wallet]:divide-hairline in-[.lichen-wallet]:border-hairline">
            {data.paid.map((payment) => (
              <PaymentRow key={payment.appointmentId} payment={payment} />
            ))}
          </div>
        </Card>
      ) : null}

      <MarkDirectPaidDialog presentation={presentation} payment={marking} onClose={() => setMarking(null)} onMarked={onChanged} />
    </>
  );
}
