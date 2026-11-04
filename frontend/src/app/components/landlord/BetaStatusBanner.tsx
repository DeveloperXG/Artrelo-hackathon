import { useState } from 'react';
import { Gift, Sparkles, X } from 'lucide-react';
import { useBetaStatus } from '../../hooks/landlord/useBetaStatus';

// The landlord's free-beta status, above every landlord page.
//
// The state and the dialog live in BetaStatusProvider (hooks/landlord/
// useBetaStatus), shared with the sidebar label, the pinned bell row and the
// Wallet page. This component only decides what to show.
//
// WHAT IT SHOWS (the server decides the phase and the offer; this only renders):
//   offer pending, plenty of time   a slim line
//   offer pending, the end is close loud, with a button
//   offer pending, beta already over  loud: the terms can still be claimed
//   accepted, beta running           a thank-you line
//   accepted/declined, beta over     nothing
//   declined, beta running           nothing -- they answered; the Wallet page
//                                    keeps a quiet link if they change their mind
//   no beta                          nothing
//
// AN OPEN OFFER CANNOT BE WAVED AWAY. While the offer is pending there is no X:
// the banner stays until the landlord accepts or explicitly declines. The
// previous per-day dismissal let someone make it disappear every morning and
// then forget it existed; a decision that carries a locked rate and a fee should
// be answered, not hidden. Once it is answered, the (purely informational)
// thank-you line can be dismissed for the day.
//
// Dismissal, where it exists, is per day and per browser. Storage can be missing
// or throw (private windows), so every access is wrapped and the banner simply
// reappears.

const DISMISS_KEY = 'artrelo:betaBannerDismissedOn';

const today = () => new Date().toISOString().slice(0, 10);

function dismissedToday(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === today();
  } catch {
    return false;
  }
}

function dismissForToday() {
  try {
    window.localStorage.setItem(DISMISS_KEY, today());
  } catch {
    // Without storage it comes back on the next page, which is acceptable.
  }
}

export default function BetaStatusBanner() {
  const { beta, openOffer } = useBetaStatus();
  const [dismissed, setDismissed] = useState(dismissedToday);

  if (!beta || beta.phase === 'none') return null;
  if (beta.offer === 'declined') return null;
  // Over, and nothing left to ask: a founding landlord has the sidebar label and
  // the Wallet line; there is no banner to show.
  if (beta.phase === 'ended' && beta.offer !== 'pending') return null;

  const pending = beta.offer === 'pending';
  // Only an answered offer's informational line can be dismissed.
  if (!pending && dismissed) return null;

  const days = beta.daysLeft ?? 0;
  const daysText = days === 1 ? '1 day' : `${days} days`;
  const loud = beta.phase === 'prominent' || beta.phase === 'ended';

  const text =
    beta.phase === 'ended'
      ? 'Your free beta has ended. You can still claim the founding-landlord terms.'
      : beta.phase === 'accepted'
        ? `You’re a founding landlord — your terms are locked in. Free beta: ${daysText} left.`
        : beta.phase === 'prominent'
          ? `Your free beta ends in ${daysText}. Access doesn’t switch off — review the founding offer to lock in your terms.`
          : `Free beta · ${daysText} left. Founding landlords get locked-in terms.`;

  return (
    <div
      data-testid="beta-banner"
      data-phase={beta.phase}
      data-offer={beta.offer}
      // Stacks on a phone, one row from `sm` up -- the same pattern as
      // DecisionsBanner. Side by side at 400px the copy was squeezed into a
      // sliver next to a full-size button.
      className={
        loud
          ? // lichen: variants apply on migrated pages only (the banner sits
            // above every landlord page). The founding offer is a decision for
            // the landlord, so Lichen; nothing here approves billing.
            'll-fade-up mb-6 flex flex-col gap-3 rounded-2xl border border-[#137fec]/30 bg-[#137fec]/10 px-5 py-4 sm:flex-row sm:items-center lichen:rounded-lg lichen:border-lichen-line lichen:bg-lichen-wash'
          : 'mb-4 flex flex-col gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3 lichen:rounded-lg lichen:border-border lichen:bg-card'
      }
    >
      {loud ? (
        <Gift className="hidden h-6 w-6 shrink-0 text-[#137fec] sm:block lichen:text-lichen-icon" aria-hidden />
      ) : (
        <Sparkles className="hidden h-4 w-4 shrink-0 text-[#137fec] sm:block lichen:text-lichen-icon" aria-hidden />
      )}
      <p className={`min-w-0 flex-1 ${loud ? 'font-medium text-slate-900 lichen:text-ink' : 'text-sm text-slate-600 lichen:text-meta'}`}>{text}</p>
      <div className="flex shrink-0 items-center gap-2">
        {pending ? (
          <button
            type="button"
            data-testid="beta-banner-review"
            onClick={openOffer}
            className={
              loud
                ? 'rounded-lg bg-[#137fec] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 lichen:rounded-md lichen:bg-lichen lichen:text-on-lichen lichen:shadow-none forced-colors:border forced-colors:border-[ButtonText]'
                : 'rounded-sm text-sm font-semibold text-[#137fec] hover:underline lichen:text-lichen-text'
            }
          >
            Review founding offer
          </button>
        ) : (
          <button
            type="button"
            data-testid="beta-banner-dismiss"
            aria-label="Dismiss for today"
            onClick={() => {
              dismissForToday();
              setDismissed(true);
            }}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 lichen:text-meta lichen:hover:bg-hairline lichen:hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
