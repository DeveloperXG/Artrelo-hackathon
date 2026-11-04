import { useEffect, useMemo, useRef } from 'react';
import { createBackgroundRefresh } from '../lib/backgroundRefresh';
import { useLiveTopic } from './useLiveTopic';

/** Fallback for a dropped live stream; nudges normally arrive first. */
const POLL_MS = 60_000;

/**
 * Keep a page's data fresh without a loading flash: refetch silently on a live
 * nudge for `topics`, on a resync (stream reconnect or the tab returning) and
 * on a visible-tab poll. Skipped while `isBusy()` is true.
 */
export function useBackgroundRefresh(
  topics: string | string[] | null,
  run: () => Promise<unknown>,
  isBusy: () => boolean = () => false
) {
  const runRef = useRef(run);
  const busyRef = useRef(isBusy);
  useEffect(() => {
    runRef.current = run;
    busyRef.current = isBusy;
  });

  const trigger = useMemo(
    () => createBackgroundRefresh(() => runRef.current(), () => busyRef.current()),
    []
  );

  useLiveTopic(topics, () => void trigger());

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void trigger();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [trigger]);

  return trigger;
}
