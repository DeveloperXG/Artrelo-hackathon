import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { dismissBanner, isBannerDismissed } from '../../lib/dismissedBanners';

/**
 * A page banner the reader can dismiss once they have read it.
 *
 * Dismissed for the state it describes, not for good: `signature` is built
 * from what the banner says (an amount, a date), and a new signature shows the
 * banner again. See lib/dismissedBanners.ts.
 */
export default function DismissibleBanner({
  id,
  signature,
  className,
  testId,
  icon,
  children,
}: {
  /** Stable per kind of banner, e.g. "wallet:bank-owed". */
  id: string;
  /** What it currently says, in a form that changes when the news does. */
  signature: string;
  /** Border, background and text colour; layout is handled here. */
  className: string;
  testId?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const { user } = useAuth();
  const userId = user?.id;
  const [hidden, setHidden] = useState(() => isBannerDismissed(userId, id, signature));

  // A new amount, a different account: decide again.
  useEffect(() => {
    setHidden(isBannerDismissed(userId, id, signature));
  }, [userId, id, signature]);

  if (hidden) return null;

  return (
    <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${className}`} data-testid={testId}>
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        aria-label="Dismiss"
        data-testid={testId ? `${testId}-dismiss` : undefined}
        onClick={() => {
          dismissBanner(userId, id, signature);
          setHidden(true);
        }}
        className="-m-1 shrink-0 rounded-md p-1 opacity-60 transition hover:bg-black/5 hover:opacity-100"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
