import { useCallback, useEffect, useRef, useState } from 'react';
import { TenantAPI, type RequestQuota } from '../../api/client';
import { creationGate } from '../../lib/requestWorkflow';
import { useLiveTopic } from '../useLiveTopic';

/** setTimeout's ceiling; a later reset is re-armed by the next refresh. */
const MAX_TIMER_MS = 2_147_000_000;

/**
 * The tenant's standing against the daily / weekly request limits, and the
 * server's verdict on whether a normal request may start. `loadState` lets the
 * New Request buttons stay grey until that verdict has loaded, and offer Retry
 * when it fails: the meter can hide itself, but the gate must not guess.
 *
 * The verdict is kept current without a reload: a request opening or closing
 * (live `requests` nudge), the tab regaining focus (resync), and the limit's
 * own `nextAvailableAt` passing all refetch it quietly.
 */
export function useRequestQuota(enabled = true) {
  const [quota, setQuota] = useState<RequestQuota | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const loadedRef = useRef(false);

  const reload = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!enabled) return;
      // A background refresh keeps the last verdict on screen, so the button
      // doesn't flicker grey every time the tab regains focus.
      if (!silent || !loadedRef.current) setLoadState('loading');
      try {
        setQuota(await TenantAPI.getQuota());
        loadedRef.current = true;
        setLoadState('ready');
      } catch {
        if (silent && loadedRef.current) return;
        setQuota(null);
        setLoadState('error');
      }
    },
    [enabled]
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useLiveTopic(enabled ? 'requests' : null, () => void reload({ silent: true }));

  const nextAvailableAt = quota?.creationEligibility?.nextAvailableAt ?? null;
  const blocked = quota?.creationEligibility ? !quota.creationEligibility.allowed : false;
  useEffect(() => {
    if (!enabled || !blocked || !nextAvailableAt) return undefined;
    const at = new Date(nextAvailableAt).getTime();
    if (Number.isNaN(at)) return undefined;
    // A second of slack so the server's window has definitely rolled over.
    const delay = Math.min(Math.max(at - Date.now(), 0) + 1000, MAX_TIMER_MS);
    const timer = setTimeout(() => void reload({ silent: true }), delay);
    return () => clearTimeout(timer);
  }, [enabled, blocked, nextAvailableAt, reload]);

  const manualReload = useCallback(() => reload(), [reload]);
  return { quota, reload: manualReload, setQuota, loadState, gate: creationGate(quota, loadState) };
}
