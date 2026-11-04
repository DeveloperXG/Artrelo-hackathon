import { useEffect, useRef } from 'react';
import { onLiveEvent, RESYNC_TOPIC, startLiveEvents } from '../lib/liveEvents';

/** Bursts (a policy save re-evaluating ten requests) collapse into one refetch. */
const DEBOUNCE_MS = 300;

/** Hold the shared live connection open while the mounting layout is. */
export function useLiveConnection() {
  useEffect(() => startLiveEvents(), []);
}

/**
 * Run `handler` when any of `topics` is nudged, and on a resync (the stream
 * reconnected, or the tab came back) unless `resync: false`.
 */
export function useLiveTopic(
  topics: string | string[] | null,
  handler: () => void,
  { resync = true }: { resync?: boolean } = {}
) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  const key = topics === null ? '' : (Array.isArray(topics) ? topics : [topics]).join('|');

  useEffect(() => {
    if (!key) return undefined;
    const wanted = new Set(key.split('|'));
    if (resync) wanted.add(RESYNC_TOPIC);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = onLiveEvent((topic) => {
      if (!wanted.has(topic)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        handlerRef.current();
      }, DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [key, resync]);
}
