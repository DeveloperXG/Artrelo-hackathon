import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { LandlordAPI } from '../../api/client';
import { useLiveTopic } from '../useLiveTopic';
import {
  FeedController,
  eventKey,
  readActivityList,
  readRequestActivity,
  requestKey,
  type FeedState,
} from '../../lib/irisActivity';
import type { IrisEvent, IrisRequestSummary } from '../../types/irisActivity';

/** Fallback for a dropped live stream; nudges normally arrive first. */
const POLL_MS = 60_000;

/**
 * Subscribe a controller to React, live nudges and a visible-tab poll. One
 * controller per key: a new key (another request, another filter) stops the
 * old one, so its late responses land nowhere.
 */
function useFeed<T, M>(controller: FeedController<T, M> | null, topics: string | string[] | null) {
  useEffect(() => {
    if (!controller) return undefined;
    void controller.start();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void controller.refresh();
    }, POLL_MS);
    return () => {
      window.clearInterval(timer);
      controller.stop();
    };
  }, [controller]);

  // A resync fires when the stream reconnects or the tab comes back into view,
  // which covers refetch-on-focus. refresh() coalesces with the poll above.
  useLiveTopic(controller ? topics : null, () => void controller?.refresh());

  const empty = useMemo(() => new FeedController<T, M>(() => Promise.reject(new Error('idle')), () => '', 'reset'), []);
  const active = controller || empty;
  const state = useSyncExternalStore(active.subscribe, active.getState, active.getState);
  return {
    ...(state as FeedState<T, M>),
    loadMore: () => void controller?.loadMore(),
    refresh: () => void controller?.refresh(),
  };
}

/** Requests grouped once each, newest meaningful activity first. */
export function useIrisActivityList({ limit = 20, activeOnly = false }: { limit?: number; activeOnly?: boolean } = {}) {
  const controller = useMemo(
    () =>
      new FeedController<IrisRequestSummary, null>(async (cursor) => {
        const response = await LandlordAPI.listIrisActivity({ limit, cursor, activeOnly });
        const data = readActivityList(response.data);
        return { items: data.requests, nextCursor: data.nextCursor, meta: null };
      }, requestKey, 'reset'),
    [limit, activeOnly]
  );
  const feed = useFeed(controller, 'requests');
  return { ...feed, requests: feed.items };
}

/** One request's activity; `meta` is its current summary. */
export function useRequestIrisActivity(requestId: string | undefined, { limit = 50 }: { limit?: number } = {}) {
  const controller = useMemo(
    () =>
      requestId
        ? new FeedController<IrisEvent, IrisRequestSummary>(async (cursor) => {
            const response = await LandlordAPI.getRequestIrisActivity(requestId, { limit, cursor });
            const data = readRequestActivity(response.data);
            return { items: data.events, nextCursor: data.nextCursor, meta: data.request };
          }, eventKey, 'retain')
        : null,
    [requestId, limit]
  );
  const feed = useFeed(controller, requestId ? `request:${requestId}` : null);
  return { ...feed, events: feed.items, summary: feed.meta };
}
