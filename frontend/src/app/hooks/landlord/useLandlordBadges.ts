import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getStoredUser, LandlordAPI } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { useLiveTopic } from '../useLiveTopic';

export type LandlordBadgeCounts = {
  /** Pending ApprovalRequests — the same set the Decisions page lists. */
  decisions: number;
  /** Appointments needing the manager that have changed since the schedule was
   *  last opened. Unread rather than work — that page has no controls. */
  schedule: number;
  /** Live requests raised since the tab was last opened. */
  requests: number;
  /** Money stuck, plus ledger activity since the wallet was last opened. */
  wallet: number;
};

const EMPTY: LandlordBadgeCounts = { decisions: 0, schedule: 0, requests: 0, wallet: 0 };

/**
 * How often the sidebar re-checks while the manager sits on one page.
 *
 * These counts move because of things happening elsewhere — a vendor declining,
 * a tenant disputing a completion, a Stripe webhook landing — so a page that
 * never navigates still has to notice. Anything the manager does themselves is
 * pushed through refreshLandlordBadges instead of waiting for this.
 */
const POLL_MS = 60 * 1000;

/** Where the client records the last time these tabs were actually opened. The
 *  server cannot observe that, so it asks for it. */
const WALLET_SEEN_KEY = 'artrelo:walletSeenAt';
const REQUESTS_SEEN_KEY = 'artrelo:requestsSeenAt';
const SCHEDULE_SEEN_KEY = 'artrelo:scheduleSeenAt';

// localStorage throws outright in some privacy modes. A badge is never worth
// breaking navigation over, so every access is guarded.
function readSeenAt(key: string): string {
  try {
    return window.localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function markSeen(key: string) {
  try {
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Without a mark the unread count for that tab stays at 0 forever. The
    // wallet's stuck half — failed payouts, arrears — still works, and that is
    // the half that actually blocks the landlord.
  }
  void refreshLandlordBadges();
}

/**
 * Mark wallet activity as seen, as of now.
 *
 * Called when the wallet page opens. Until this has run once there is no mark
 * at all, and the server counts nothing as unread rather than badging the
 * landlord's entire ledger history on first login.
 */
export function markWalletSeen() {
  markSeen(WALLET_SEEN_KEY);
}

/** Same, for requests. Opening the list IS reading what arrived. */
export function markRequestsSeen() {
  markSeen(REQUESTS_SEEN_KEY);
}

/** Same, for the schedule. The manager cannot act from that page — the only
 *  thing opening it can mean is that they have seen what changed. */
export function markScheduleSeen() {
  markSeen(SCHEDULE_SEEN_KEY);
}

/* ------------------------------------------------------------------ *
 * A one-file store.
 *
 * Any component can push the badges without the sidebar having to be its
 * parent, which is what lets a decision on the Decisions page clear its own
 * badge instantly instead of waiting for the poll.
 * ------------------------------------------------------------------ */

let counts: LandlordBadgeCounts = EMPTY;
type BadgeUser = { id?: string; accountId?: string; role?: string };
const accountScope = (user: BadgeUser | null | undefined) => user?.id ? `${user.role || '-'}:${user.accountId || '-'}:${user.id}` : null;
const storedScope = () => accountScope(getStoredUser<BadgeUser>());
let countsScope: string | null = null;
let refreshVersion = 0;
const subscribers = new Set<(next: LandlordBadgeCounts) => void>();

// How this landlord's vendors are paid, which arrives with the counts. Kept out
// of LandlordBadgeCounts on purpose: every key there is a number with a badge
// label, and this is neither. Unknown mode keeps wallet-only controls hidden.
export type LandlordPaymentMode = 'direct' | 'platform';
let paymentMode: LandlordPaymentMode | null = null;
let modeAccountId: string | null = null;
const modeSubscribers = new Set<(next: LandlordPaymentMode | null) => void>();

function publish(next: LandlordBadgeCounts) {
  counts = next;
  subscribers.forEach((notify) => notify(next));
}

/** Refetch now. Await it when the number should be settled before moving on;
 *  fire-and-forget is fine everywhere else. */
export async function refreshLandlordBadges() {
  try {
    const accountId = getStoredUser<BadgeUser>()?.id || null;
    const scope = storedScope();
    const mine = ++refreshVersion;
    if (scope !== countsScope) {
      countsScope = scope;
      paymentMode = null;
      modeAccountId = null;
      publish(EMPTY);
      modeSubscribers.forEach(notify => notify(null));
    }
    if (!scope) return;
    const response = await LandlordAPI.badgeCounts({
      walletSeenAt: readSeenAt(WALLET_SEEN_KEY),
      requestsSeenAt: readSeenAt(REQUESTS_SEEN_KEY),
      scheduleSeenAt: readSeenAt(SCHEDULE_SEEN_KEY),
    });
    const data = (response.data || {}) as Partial<LandlordBadgeCounts> & { paymentMode?: string };
    if (mine !== refreshVersion || scope !== storedScope()) return;
    const nextMode = data.paymentMode === 'direct' || data.paymentMode === 'platform' ? data.paymentMode : null;
    if (nextMode !== paymentMode || accountId !== modeAccountId) {
      paymentMode = nextMode;
      modeAccountId = accountId;
      modeSubscribers.forEach((notify) => notify(nextMode));
    }
    publish({
      decisions: Number(data.decisions) || 0,
      schedule: Number(data.schedule) || 0,
      requests: Number(data.requests) || 0,
      wallet: Number(data.wallet) || 0,
    });
  } catch {
    // A failed count must never break navigation or blank the sidebar. The last
    // known numbers stay until the next successful read.
  }
}

/**
 * Drop a badge by `delta` right now, ahead of the refetch.
 *
 * Deciding an approval is the case that needs this: the round trip is short,
 * but a badge still reading "1" after the toast says the decision went through
 * looks like the app did not notice. Pairing it with a refetch is what keeps it
 * safe — an optimistic number can only be wrong for a single tick.
 */
/** The landlord's payment mode, as last reported with the badge counts. */
export function useLandlordPaymentMode(): LandlordPaymentMode | null {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState(() => ({ scope: countsScope, value: paymentMode }));
  useEffect(() => {
    const notify = (value: LandlordPaymentMode | null) => setSnapshot({ scope: countsScope, value });
    modeSubscribers.add(notify);
    notify(paymentMode);
    return () => {
      modeSubscribers.delete(notify);
    };
  }, []);
  return user?.id && user.id === modeAccountId && accountScope(user) === snapshot.scope ? snapshot.value : null;
}

export function adjustLandlordBadge(key: keyof LandlordBadgeCounts, delta: number) {
  if (!countsScope || storedScope() !== countsScope) return;
  refreshVersion += 1; // A read started before this local decision is obsolete.
  publish({ ...counts, [key]: Math.max(0, counts[key] + delta) });
}

/**
 * Counts for the landlord sidebar badges.
 *
 * Refetched on every navigation, and pushed directly by the pages that resolve
 * what a badge counts.
 *
 * Work counts (decisions, schedule) clear by the work being done, never by the
 * page being opened — so a badge can't show 0 over three decisions that are
 * still pending. The wallet's unread half is the deliberate exception: money
 * moving is news rather than a task, and news is cleared by reading it.
 */
export function useLandlordBadges() {
  const { user } = useAuth();
  const scope = accountScope(user);
  const [snapshot, setSnapshot] = useState(() => ({ scope: countsScope, value: counts }));
  const location = useLocation();

  useEffect(() => {
    const notify = (value: LandlordBadgeCounts) => setSnapshot({ scope: countsScope, value });
    subscribers.add(notify);
    // Adopt whatever the store already holds, so a remount does not flash zeros.
    notify(counts);
    return () => {
      subscribers.delete(notify);
    };
  }, []);

  useEffect(() => {
    void refreshLandlordBadges();
  }, [location.pathname, scope]);

  // Existing domain events invalidate counts; they never supply guessed deltas.
  useLiveTopic(scope ? ['requests', 'notifications', 'wallet'] : null, () => void refreshLandlordBadges());

  useEffect(() => {
    const timer = setInterval(() => void refreshLandlordBadges(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return { counts: scope && scope === snapshot.scope ? snapshot.value : EMPTY, reload: refreshLandlordBadges };
}
