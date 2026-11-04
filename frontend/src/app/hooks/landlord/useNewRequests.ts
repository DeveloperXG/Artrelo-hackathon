import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { isNewRequest } from '../../lib/requestIdentity';
import type { RequestItem } from '../../types/landlord';

const EVENT = 'artrelo:request-opened';
const keyFor = (accountId: string) => `artrelo:requestsOpened:${accountId}`;
function readOpened(accountId: string): Record<string, number> {
  try {
    const value = JSON.parse(window.localStorage.getItem(keyFor(accountId)) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function markRequestOpened(accountId: string, requestId: string) {
  if (!accountId || !requestId) return;
  const now = Date.now();
  const entries = Object.entries({ ...readOpened(accountId), [requestId]: now })
    .filter(([, at]) => typeof at === 'number' && at > now - 30 * 86400000)
    .sort(([, a], [, b]) => b - a).slice(0, 1000);
  try { window.localStorage.setItem(keyFor(accountId), JSON.stringify(Object.fromEntries(entries))); }
  catch { /* A blocked store must never prevent opening a request. */ }
  window.dispatchEvent(new Event(EVENT));
}

/** New = unopened on this browser, submitted in the last 24h, and still open. */
export function useNewRequestIds(requests: RequestItem[]) {
  const { user } = useAuth();
  const accountId = user?.id || '';
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const refresh = () => setTick(value => value + 1);
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    const timer = setInterval(refresh, 60000);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh); clearInterval(timer); };
  }, []);
  return useMemo(() => {
    const opened = accountId ? readOpened(accountId) : {};
    return new Set(accountId ? requests.filter(request => isNewRequest(request, opened)).map(request => request._id) : []);
  }, [requests, accountId, tick]);
}
