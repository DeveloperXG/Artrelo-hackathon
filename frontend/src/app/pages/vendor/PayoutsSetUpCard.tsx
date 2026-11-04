import { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';

/**
 * For a vendor whose payouts are already set up (on any landlord's job --
 * payout details live on the vendor, not the job). The section used to vanish
 * entirely once set up, so a returning vendor got no reminder and had no way
 * to change their bank account.
 *
 * `getUpdateUrl` returns a Stripe-hosted page; bank details never pass through
 * Artrelo.
 */
export default function PayoutsSetUpCard({
  getUpdateUrl,
  note,
  testId = 'vendor-payouts-set-up',
}: {
  getUpdateUrl: () => Promise<string | null>;
  note?: string;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);

  const openUpdate = async () => {
    setBusy(true);
    try {
      const url = await getUpdateUrl();
      if (url) {
        window.location.href = url;
        return;
      }
      toast.error("Couldn't open payout settings. Please try again shortly.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open payout settings.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid={testId}
    >
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" />
        <div className="text-sm">
          <div className="font-semibold text-emerald-900">Payouts are set up</div>
          <div className="mt-0.5 text-emerald-800">
            {note || 'Payment for your work goes to the account you set up before.'}
          </div>
        </div>
      </div>
      <Button
        variant="outline"
        className="shrink-0 border-emerald-200 bg-white text-emerald-800 hover:bg-emerald-100"
        onClick={() => void openUpdate()}
        disabled={busy}
        data-testid={`${testId}-update`}
      >
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        Update payout details
      </Button>
    </section>
  );
}
