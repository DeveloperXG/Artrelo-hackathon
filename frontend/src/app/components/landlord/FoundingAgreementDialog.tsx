import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import { ApiError, LandlordAPI, type BetaView } from '../../api/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { useLandlordPaymentMode } from '../../hooks/landlord/useLandlordBadges';

// The founding-landlord offer: what Artrelo has done so far, what the offer is,
// and one button to accept it -- or, quietly, to decline it.
//
// THE PAGE RENDERS WHAT THE SERVER SENDS. The wording, the numbers and the
// version all come from GET /landlords/beta; nothing about the offer lives in
// this file. That is what lets the server record exactly what was shown, and
// why accepting sends back the version this dialog displayed: if the offer
// changed meanwhile the server answers 409 and we show the new one instead of
// binding the landlord to terms they never read.
//
// ACCEPTING IS NON-BINDING ON PAYMENT. The text says so; it must stay true.
//
// DECLINING IS EXPLICIT AND REVERSIBLE. It is a small text button, away from
// the primary action, and needs a second confirming click that says what is
// given up. It is not "close the window": closing ("Not now") changes nothing
// and the offer stays open; only "Decline" answers it. A landlord who declines
// can still reopen the offer from their Wallet page and accept.
//
// A founding landlord sees no decline at all -- giving up locked terms is not
// something to offer as a button.

function formatMinutes(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} minutes`;
  return `${Math.round((minutes / 60) * 10) / 10} hours`;
}

function highlightLines(h: NonNullable<BetaView['highlights']>): string[] {
  const lines: string[] = [];
  if (h.requests > 0) lines.push(`${h.requests} maintenance request${h.requests === 1 ? '' : 's'} handled`);
  if (h.medianMinutesToBook != null && h.bookedRequests > 0) {
    lines.push(`A vendor booked in a median of ${formatMinutes(h.medianMinutesToBook)}`);
  }
  if (h.autopilotRequests > 0) {
    lines.push(`${h.autopilotRequests} job${h.autopilotRequests === 1 ? '' : 's'} that needed nothing from you`);
  }
  return lines;
}

const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'long' });

export default function FoundingAgreementDialog({
  open,
  onOpenChange,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the server's new state after an accept or a decline. */
  onChange: (view: BetaView) => void;
}) {
  const paymentsLabel = useLandlordPaymentMode() === 'platform' ? 'Wallet' : 'Payments';
  const [view, setView] = useState<BetaView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDecline, setConfirmingDecline] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setView(await LandlordAPI.getBeta(true));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the offer');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setConfirmingDecline(false);
      void load();
    }
  }, [open]);

  const accept = async () => {
    if (!view?.agreement) return;
    setSubmitting(true);
    setError('');
    try {
      onChange(await LandlordAPI.acceptFoundingAgreement(view.agreement.version));
      onOpenChange(false);
    } catch (err) {
      const payload = err instanceof ApiError ? (err.payload as { code?: string }) : null;
      if (payload?.code === 'agreement_changed') {
        // The offer moved while this was open. Show the new one; accepting is a
        // fresh decision about different terms.
        setError('The offer was just updated. Please review the latest version below.');
        await load();
      } else {
        setError(err instanceof Error ? err.message : 'Could not accept the offer');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const decline = async () => {
    setSubmitting(true);
    setError('');
    try {
      onChange(await LandlordAPI.declineFoundingOffer());
      onOpenChange(false);
    } catch (err) {
      const payload = err instanceof ApiError ? (err.payload as { code?: string }) : null;
      if (payload?.code === 'already_accepted') {
        // Accepted from another tab or device while this was open.
        setConfirmingDecline(false);
        setError('You’ve already accepted the founding offer.');
        await load();
      } else {
        setError(err instanceof Error ? err.message : 'Could not decline the offer');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const lines = view?.highlights ? highlightLines(view.highlights) : [];
  const founding = Boolean(view?.founding);
  const declined = view?.offer === 'declined';

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent
        className="flex max-h-[85vh] max-w-lg flex-col gap-0 overflow-hidden p-0"
        data-testid="founding-dialog"
      >
        <div className="h-1 w-full shrink-0 bg-gradient-to-r from-[#137fec] to-purple-500" />
        <DialogHeader className="shrink-0 px-6 pt-6">
          <div className="flex items-start gap-3 text-left">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#137fec]/10 text-[#137fec]">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-slate-900">Founding landlord offer</DialogTitle>
              <DialogDescription className="mt-1 text-slate-500">
                Thank you for being one of the first to use Artrelo. Here’s what that earns you.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loading && !view ? (
            <div className="flex items-center justify-center py-10 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : null}

          {error ? (
            <div
              data-testid="founding-error"
              className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </div>
          ) : null}

          {declined && view?.declinedAt ? (
            <div
              data-testid="founding-declined-note"
              className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600"
            >
              You declined this offer on {longDate(view.declinedAt)}. You can still accept it.
            </div>
          ) : null}

          {lines.length > 0 ? (
            <div className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4" data-testid="founding-highlights">
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Your beta so far</div>
              <ul className="space-y-1.5 text-sm text-slate-700">
                {lines.map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {view?.agreement ? (
            <div className="space-y-4">
              {view.agreement.sections.map((section) => (
                <div key={section.heading}>
                  <div className="text-sm font-semibold text-slate-900">{section.heading}</div>
                  <p className="mt-0.5 text-sm leading-relaxed text-slate-600">{section.body}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {confirmingDecline ? (
          <div className="shrink-0 border-t border-slate-100 px-6 py-4" data-testid="founding-decline-confirm-panel">
            <p className="text-sm font-semibold text-slate-900">Decline the founding offer?</p>
            <p className="mt-1 text-sm text-slate-600">
              You’ll give up your locked rate and the Founding Landlord label. You can change your mind later from
              your {paymentsLabel} page.
            </p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmingDecline(false)} disabled={submitting}>
                Keep offer
              </Button>
              <Button
                data-testid="founding-decline-confirm"
                onClick={decline}
                disabled={submitting}
                className="bg-slate-800 text-white hover:bg-slate-700"
              >
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Yes, decline
              </Button>
            </div>
          </div>
        ) : (
          <DialogFooter className="shrink-0 items-center gap-2 border-t border-slate-100 px-6 py-4 sm:justify-between">
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                {founding ? 'Close' : 'Not now'}
              </Button>
              {!founding && !declined ? (
                <button
                  type="button"
                  data-testid="founding-decline"
                  onClick={() => setConfirmingDecline(true)}
                  disabled={submitting || loading || !view}
                  className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline disabled:opacity-50"
                >
                  Decline offer
                </button>
              ) : null}
            </div>
            {founding ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                <CheckCircle2 className="h-4 w-4" /> You’ve accepted this offer
              </span>
            ) : (
              <Button
                data-testid="founding-accept"
                onClick={accept}
                disabled={submitting || loading || !view?.agreement}
                className="bg-[#137fec] text-white hover:bg-[#137fec]/90"
              >
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Accept founding offer
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
