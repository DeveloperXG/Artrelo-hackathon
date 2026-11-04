import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getStoredUser, TenantAPI } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { useLiveTopic } from '../useLiveTopic';

export type TenantBadgeCounts = {
  /**
   * Everything waiting on the tenant: an arrival time to accept, a first
   * proposal they have not answered, and completed work to confirm.
   */
  schedule: number;
};

const EMPTY: TenantBadgeCounts = { schedule: 0 };

/** The tenant's counts move when a vendor commits to a time or submits proof —
 *  neither of which the tenant is doing — so an open tab still has to notice. */
const POLL_MS = 60 * 1000;

let counts: TenantBadgeCounts = EMPTY;
type BadgeUser = { id?: string; accountId?: string; role?: string };
const accountScope = (user: BadgeUser | null | undefined) => user?.id ? `${user.role || '-'}:${user.accountId || '-'}:${user.id}` : null;
const storedScope = () => accountScope(getStoredUser<BadgeUser>());
let countsScope: string | null = null;
let refreshVersion = 0;
const subscribers = new Set<(next: TenantBadgeCounts) => void>();

function publish(next: TenantBadgeCounts) {
  counts = next;
  subscribers.forEach((notify) => notify(next));
}

/** Refetch now. Called by the schedule page after a confirm, decline, verify or
 *  dispute, so the badge clears with the action rather than a minute later. */
export async function refreshTenantBadges() {
  try {
    const scope = storedScope(), mine = ++refreshVersion;
    if (scope !== countsScope) {
      countsScope = scope;
      publish(EMPTY);
    }
    if (!scope) return;
    const response = await TenantAPI.badgeCounts();
    if (mine !== refreshVersion || scope !== storedScope()) return;
    const data = (response.data || {}) as Partial<TenantBadgeCounts>;
    publish({ schedule: Number(data.schedule) || 0 });
  } catch {
    // Never break navigation over a badge — the last known number stands.
  }
}

/** Drop the badge ahead of the refetch, so answering the last item does not
 *  leave a stale "1" sitting next to the success toast. */
export function adjustTenantBadge(key: keyof TenantBadgeCounts, delta: number) {
  if (!countsScope || storedScope() !== countsScope) return;
  refreshVersion += 1;
  publish({ ...counts, [key]: Math.max(0, counts[key] + delta) });
}

/**
 * Counts for the tenant sidebar badge.
 *
 * Every number is something the tenant owes an answer on, so it clears by
 * answering rather than by opening the page.
 */
export function useTenantBadges() {
  const { user } = useAuth();
  const scope = accountScope(user);
  const [snapshot, setSnapshot] = useState(() => ({ scope: countsScope, value: counts }));
  const location = useLocation();

  useEffect(() => {
    const notify = (value: TenantBadgeCounts) => setSnapshot({ scope: countsScope, value });
    subscribers.add(notify);
    notify(counts);
    return () => {
      subscribers.delete(notify);
    };
  }, []);

  useEffect(() => {
    void refreshTenantBadges();
  }, [location.pathname, scope]);

  useLiveTopic(scope ? ['requests', 'notifications'] : null, () => void refreshTenantBadges());

  useEffect(() => {
    const timer = setInterval(() => void refreshTenantBadges(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return { counts: scope && scope === snapshot.scope ? snapshot.value : EMPTY, reload: refreshTenantBadges };
}
