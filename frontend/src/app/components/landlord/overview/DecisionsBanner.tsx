import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, X } from 'lucide-react';

const DISMISSED_KEY = 'artrelo:decisionsBannerDismissedCount';

function readDismissed(): number | null {
  try {
    const raw = window.sessionStorage.getItem(DISMISSED_KEY);
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

function writeDismissed(count: number) {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, String(count));
  } catch {
    // Without storage the banner simply comes back on the next visit.
  }
}

/**
 * "N decisions need your review" above the Overview.
 *
 * Dismissing hides it for this browser session at the CURRENT count, so it
 * comes back as soon as something new needs a decision — a dismissed banner
 * must never hide work that arrived afterwards. The sidebar's Decisions badge
 * still shows the count regardless.
 */
export default function DecisionsBanner({ total, onReview }: { total: number; onReview: () => void }) {
  const [dismissedAt, setDismissedAt] = useState<number | null>(readDismissed);

  // Work got done since the dismissal: lower the mark, so the next decision
  // to arrive brings the banner back even if the total ends up where it was.
  useEffect(() => {
    if (dismissedAt !== null && total < dismissedAt) {
      writeDismissed(total);
      setDismissedAt(total);
    }
  }, [total, dismissedAt]);

  if (total <= 0 || (dismissedAt !== null && total <= dismissedAt)) return null;

  return (
    // The owner's decisions banner: Lichen wash and line, an attention icon and
    // a literal count, so "needs your review" never rests on colour alone.
    <section
      aria-label="Decisions needing review"
      className="ll-fade-up mb-6 flex flex-col gap-3 rounded-lg border border-lichen-line bg-lichen-wash px-5 py-4 sm:flex-row sm:items-center"
      data-testid="overview-decisions-banner"
    >
      <AlertTriangle className="hidden h-6 w-6 shrink-0 text-lichen-icon sm:block" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-ink">
          <span className="font-mono">{total}</span> {total === 1 ? 'decision needs your review' : 'decisions need your review'}
        </div>
        <p className="mt-0.5 text-sm text-meta">
          Approvals stay manager-controlled. Review pending routing decisions and approvals on the decisions page.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onReview}
          data-testid="overview-review-decisions"
          className="inline-flex items-center gap-1.5 rounded-md bg-lichen px-4 py-2 text-sm font-semibold text-on-lichen transition-colors hover:bg-lichen/90 forced-colors:border forced-colors:border-[ButtonText] motion-reduce:transition-none"
        >
          Review all decisions
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            writeDismissed(total);
            setDismissedAt(total);
          }}
          className="rounded-md p-2 text-meta transition-colors hover:bg-lichen-tint hover:text-ink motion-reduce:transition-none"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </section>
  );
}
