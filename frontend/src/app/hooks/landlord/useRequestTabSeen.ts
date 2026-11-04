import { useCallback, useEffect, useState } from 'react';
import type { ActivityTab, TabSeen } from '../../components/request-detail/requestTabActivity';

// One key for every request, like the sidebar's artrelo:*SeenAt marks: per
// browser, by design. A landlord on two devices sees the dots on each; moving
// this server-side would mean a schema change, which nothing justifies yet.
const STORAGE_KEY = 'artrelo:requestTabsSeen';
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 300;

type Entry = TabSeen & { touchedAt: number };
type Store = Record<string, Entry>;

function readStore(): Store {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

// Old requests drop off so the key can't grow without bound: anything not
// opened in 90 days, then the least recently opened past 300.
function writeStore(store: Store) {
  const now = Date.now();
  const kept = Object.entries(store)
    .filter(([, entry]) => now - (entry.touchedAt || 0) < MAX_AGE_MS)
    .sort(([, left], [, right]) => (right.touchedAt || 0) - (left.touchedAt || 0))
    .slice(0, MAX_ENTRIES);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Private mode or a full quota: the dots just won't remember.
  }
}

/**
 * When the landlord last opened each tab of one request. A request opened
 * for the first time is seeded as seen now, so it doesn't arrive covered in
 * dots for history they are about to read anyway.
 */
export function useRequestTabSeen(requestId: string | undefined, enabled = true) {
  const [seen, setSeen] = useState<TabSeen | null>(null);

  useEffect(() => {
    if (!enabled || !requestId) {
      setSeen(null);
      return;
    }
    const store = readStore();
    const now = Date.now();
    const entry: Entry = store[requestId] || { routing: now, messages: now, activity: now, touchedAt: now };
    store[requestId] = { ...entry, touchedAt: now };
    writeStore(store);
    setSeen({ routing: entry.routing, messages: entry.messages, activity: entry.activity });
  }, [requestId, enabled]);

  const markSeen = useCallback(
    (tab: ActivityTab, at: number) => {
      if (!enabled || !requestId) return;
      setSeen((current) => {
        if (!current || current[tab] >= at) return current;
        const next = { ...current, [tab]: at };
        const store = readStore();
        store[requestId] = { ...next, touchedAt: Date.now() };
        writeStore(store);
        return next;
      });
    },
    [requestId, enabled]
  );

  return { seen, markSeen };
}
