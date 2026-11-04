import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import {
  FeedController,
  IrisActivityFormatError,
  absoluteTime,
  activityErrorMessage,
  actorLabel,
  eventKey,
  locationLabel,
  mergeByKey,
  parseActivityTime,
  readActivityList,
  readRequestActivity,
  requestKey,
  stageLabel,
  stateLabel,
  type FeedPage,
} from './irisActivity';
import { irisEvent, irisSummary } from './irisActivity.fixtures';
import type { IrisEvent, IrisRequestSummary } from '../types/irisActivity';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const page = <T,>(items: T[], nextCursor: string | null = null): FeedPage<T, null> => ({ items, nextCursor, meta: null });
const ids = (items: { requestId: string }[]) => items.map((item) => item.requestId);

describe('labels', () => {
  it('translates every contract state and stage, and reads unknown values as unknown', () => {
    expect(stateLabel('needs_attention')).toBe('Needs attention');
    expect(stateLabel('failed')).toBe('Failed');
    expect(stateLabel('something_new')).toBe('Status unknown');
    expect(stageLabel('routing')).toBe('Choosing a vendor');
    expect(stageLabel('later_stage')).toBe('Stage unknown');
  });

  it('humanises actors without inventing one', () => {
    expect(actorLabel('vendor_portal')).toBe('Vendor portal');
    expect(actorLabel(null)).toBeNull();
    expect(actorLabel('  ')).toBeNull();
  });

  it('drops placeholder unit labels from the location', () => {
    expect(locationLabel({ propertyLabel: 'North', unitLabel: '-' })).toBe('North');
    expect(locationLabel({ propertyLabel: 'North', unitLabel: 'Unit 2' })).toBe('North · Unit 2');
    expect(locationLabel({ propertyLabel: '', unitLabel: '' })).toBe('');
  });

  it('never turns a missing or invalid timestamp into a time', () => {
    expect(parseActivityTime(null)).toBeNull();
    expect(parseActivityTime('not a date')).toBeNull();
    expect(absoluteTime(null)).toBe('Time not recorded');
  });
});

describe('response checks', () => {
  it('accepts v1 and defaults a missing cursor to null', () => {
    expect(readActivityList({ version: 1, requests: [] })).toEqual({ version: 1, requests: [], nextCursor: null });
    const detail = readRequestActivity({ version: 1, request: irisSummary(), events: [], nextCursor: 'c2' });
    expect(detail.nextCursor).toBe('c2');
  });

  it('rejects another version or a malformed body instead of half-rendering it', () => {
    expect(() => readActivityList({ version: 2, requests: [] })).toThrow(IrisActivityFormatError);
    expect(() => readActivityList(undefined)).toThrow(IrisActivityFormatError);
    expect(() => readRequestActivity({ version: 1, events: [] })).toThrow(IrisActivityFormatError);
  });

  it('words errors for a landlord without echoing the server message', () => {
    expect(activityErrorMessage(new ApiError('Request not found: 64f...', 404, {}))).toBe('This request was not found.');
    expect(activityErrorMessage(new ApiError('stack trace', 500, {}))).toBe('Activity could not be loaded.');
    expect(activityErrorMessage(new Error('ECONNRESET'))).toBe('Activity could not be loaded.');
  });
});

describe('mergeByKey', () => {
  it('keeps the server order, including ties and null timestamps, and each key once', () => {
    const tieA = irisEvent({ id: 'b', at: '2026-10-27T10:00:00.000Z' });
    const tieB = irisEvent({ id: 'a', at: '2026-10-27T10:00:00.000Z' });
    const undated = irisEvent({ id: 'z', at: null });
    const merged = mergeByKey([tieA, tieB], [tieB, undated], eventKey);
    expect(merged.map((event) => event.id)).toEqual(['b', 'a', 'z']);
    expect(merged[2].at).toBeNull();
  });
});

describe('FeedController', () => {
  it('loads two independent requests and keeps them separate', async () => {
    const controller = new FeedController<IrisRequestSummary, null>(
      async () => page([irisSummary({ requestId: 'req-a' }), irisSummary({ requestId: 'req-b', state: 'failed' })]),
      requestKey, 'reset'
    );
    await controller.start();
    const state = controller.getState();
    expect(state.loading).toBe(false);
    expect(ids(state.items)).toEqual(['req-a', 'req-b']);
    expect(state.items[1].state).toBe('failed');
  });

  it('pages with the opaque cursor and de-duplicates rows repeated across pages', async () => {
    const fetchPage = vi.fn(async (cursor: string | null) =>
      cursor === null
        ? page([irisSummary({ requestId: 'a' }), irisSummary({ requestId: 'b' })], 'opaque==1')
        : page([irisSummary({ requestId: 'b' }), irisSummary({ requestId: 'c' })], null)
    );
    const controller = new FeedController(fetchPage, requestKey, 'reset');
    await controller.start();
    await controller.loadMore();
    expect(fetchPage).toHaveBeenLastCalledWith('opaque==1');
    expect(ids(controller.getState().items)).toEqual(['a', 'b', 'c']);
    expect(controller.getState().nextCursor).toBeNull();
    await controller.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('a list refresh drops older pages, so a request that left the active list is not shown as active', async () => {
    // Server truth, active only: page 1 [a, b], page 2 [c]. Then c completes.
    let active = ['a', 'b', 'c'];
    const fetchPage = vi.fn(async (cursor: string | null) => {
      const rows = active.map((requestId) => irisSummary({ requestId, state: 'waiting' }));
      return cursor === null ? page(rows.slice(0, 2), rows.length > 2 ? 'p2' : null) : page(rows.slice(2), null);
    });
    const controller = new FeedController<IrisRequestSummary, null>(fetchPage, requestKey, 'reset');
    await controller.start();
    await controller.loadMore();
    expect(ids(controller.getState().items)).toEqual(['a', 'b', 'c']);
    active = ['a', 'b'];
    await controller.refresh();
    expect(ids(controller.getState().items)).toEqual(['a', 'b']);
    expect(controller.getState().nextCursor).toBeNull();
    // Paging restarts from the fresh first page's cursor.
    active = ['a', 'b', 'd'];
    await controller.refresh();
    expect(controller.getState().nextCursor).toBe('p2');
    await controller.loadMore();
    expect(fetchPage).toHaveBeenLastCalledWith('p2');
    expect(ids(controller.getState().items)).toEqual(['a', 'b', 'd']);
  });

  it('a list refresh also replaces a first-page row whose state changed', async () => {
    let first = [irisSummary({ requestId: 'a' }), irisSummary({ requestId: 'b' })];
    const controller = new FeedController<IrisRequestSummary, null>(
      async (cursor) => (cursor === null ? page(first, 'p2') : page([irisSummary({ requestId: 'c' })], 'p3')),
      requestKey,
      'reset'
    );
    await controller.start();
    await controller.loadMore();
    first = [irisSummary({ requestId: 'c', state: 'needs_attention' }), irisSummary({ requestId: 'a' })];
    await controller.refresh();
    const state = controller.getState();
    expect(ids(state.items)).toEqual(['c', 'a']);
    expect(state.items[0].state).toBe('needs_attention');
    expect(state.nextCursor).toBe('p2');
  });

  it('a detail refresh keeps older recorded events and their cursor', async () => {
    let first = [irisEvent({ id: 'e3' }), irisEvent({ id: 'e2' })];
    const controller = new FeedController<IrisEvent, null>(
      async (cursor) => (cursor === null ? page(first, 'p2') : page([irisEvent({ id: 'e1' })], 'p3')),
      eventKey,
      'retain'
    );
    await controller.start();
    await controller.loadMore();
    first = [irisEvent({ id: 'e4' }), irisEvent({ id: 'e3' })];
    await controller.refresh();
    // e2 slid off the first page by position only; it is still history, so it
    // stays in order between the fresh page and the older page, with no gap.
    expect(controller.getState().items.map((event) => event.id)).toEqual(['e4', 'e3', 'e2', 'e1']);
    expect(controller.getState().nextCursor).toBe('p3');
  });

  it('ignores an obsolete load-more completely while a newer one is running', async () => {
    const loads: ReturnType<typeof deferred<FeedPage<IrisRequestSummary, null>>>[] = [];
    const controller = new FeedController<IrisRequestSummary, null>(
      (cursor) => {
        if (cursor === null) return Promise.resolve(page([irisSummary({ requestId: 'a' })], 'p2'));
        const next = deferred<FeedPage<IrisRequestSummary, null>>();
        loads.push(next);
        return next.promise;
      },
      requestKey,
      'reset'
    );
    await controller.start();
    void controller.loadMore(); // A, about to be made obsolete
    controller.stop();
    await controller.start();
    void controller.loadMore(); // B, current
    expect(loads).toHaveLength(2);
    const listener = vi.fn();
    controller.subscribe(listener);
    loads[0].resolve(page([irisSummary({ requestId: 'stale' })], 'stale-cursor'));
    await new Promise((done) => setTimeout(done, 0));
    expect(listener).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({ loadingMore: true, nextCursor: 'p2' });
    expect(ids(controller.getState().items)).toEqual(['a']);
    loads[1].resolve(page([irisSummary({ requestId: 'b' })], null));
    await new Promise((done) => setTimeout(done, 0));
    expect(controller.getState()).toMatchObject({ loadingMore: false, nextCursor: null });
    expect(ids(controller.getState().items)).toEqual(['a', 'b']);
  });

  it('ignores an obsolete load-more failure too', async () => {
    const loads: ReturnType<typeof deferred<FeedPage<IrisRequestSummary, null>>>[] = [];
    const controller = new FeedController<IrisRequestSummary, null>(
      (cursor) => {
        if (cursor === null) return Promise.resolve(page([irisSummary({ requestId: 'a' })], 'p2'));
        const next = deferred<FeedPage<IrisRequestSummary, null>>();
        loads.push(next);
        return next.promise;
      },
      requestKey,
      'reset'
    );
    await controller.start();
    void controller.loadMore();
    await controller.refresh(); // replaces the cursor: the load above is obsolete
    void controller.loadMore();
    loads[0].reject(new Error('offline'));
    await new Promise((done) => setTimeout(done, 0));
    expect(controller.getState()).toMatchObject({ loadingMore: true, loadMoreError: '' });
  });

  it('coalesces overlapping refreshes into one in flight plus one queued', async () => {
    const pending: ReturnType<typeof deferred<FeedPage<IrisRequestSummary, null>>>[] = [];
    const fetchPage = vi.fn(() => {
      const next = deferred<FeedPage<IrisRequestSummary, null>>();
      pending.push(next);
      return next.promise;
    });
    const controller = new FeedController(fetchPage, requestKey, 'reset');
    void controller.start();
    void controller.refresh();
    void controller.refresh();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    pending[0].resolve(page([irisSummary({ requestId: 'a' })]));
    await pending[0].promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    pending[1].resolve(page([irisSummary({ requestId: 'b' })]));
    await new Promise((done) => setTimeout(done, 0));
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(ids(controller.getState().items)).toEqual(['b']);
  });

  it('ignores a response that arrives after stop (navigated to another request)', async () => {
    const slow = deferred<FeedPage<IrisEvent, null>>();
    const controller = new FeedController<IrisEvent, null>(() => slow.promise, eventKey, 'retain');
    const listener = vi.fn();
    controller.subscribe(listener);
    void controller.start();
    controller.stop();
    slow.resolve(page([irisEvent({ requestId: 'other-request' })]));
    await new Promise((done) => setTimeout(done, 0));
    expect(controller.getState().items).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('resumes after a StrictMode stop/start cycle', async () => {
    const controller = new FeedController<IrisEvent, null>(async () => page([irisEvent()]), eventKey, 'retain');
    void controller.start();
    controller.stop();
    await controller.start();
    expect(controller.getState().items.map((event) => event.id)).toEqual(['evt-1']);
  });

  it('shows a first-load failure as an error and recovers on retry', async () => {
    let fail = true;
    const controller = new FeedController<IrisEvent, null>(async () => {
      if (fail) throw new ApiError('nope', 500, {});
      return page([irisEvent()]);
    }, eventKey, 'retain');
    await controller.start();
    expect(controller.getState()).toMatchObject({ loading: false, error: 'Activity could not be loaded.' });
    fail = false;
    const retry = controller.refresh();
    expect(controller.getState()).toMatchObject({ loading: true, error: '' });
    await retry;
    expect(controller.getState()).toMatchObject({ loading: false, error: '' });
  });

  it('keeps the shown rows when a background refresh fails', async () => {
    let fail = false;
    const controller = new FeedController<IrisEvent, null>(async () => {
      if (fail) throw new Error('offline');
      return page([irisEvent()]);
    }, eventKey, 'retain');
    await controller.start();
    fail = true;
    await controller.refresh();
    const state = controller.getState();
    expect(state.items).toHaveLength(1);
    expect(state.error).toBe('');
    expect(state.refreshError).toMatch(/last activity loaded/);
  });

  it('reports a failed page load beside the button and keeps the cursor for a retry', async () => {
    let fail = true;
    const controller = new FeedController<IrisEvent, null>(async (cursor) => {
      if (cursor && fail) throw new Error('offline');
      return cursor ? page([irisEvent({ id: 'older' })]) : page([irisEvent()], 'c1');
    }, eventKey, 'retain');
    await controller.start();
    await controller.loadMore();
    expect(controller.getState()).toMatchObject({ loadingMore: false, loadMoreError: 'Activity could not be loaded.', nextCursor: 'c1' });
    fail = false;
    await controller.loadMore();
    expect(controller.getState().items.map((event) => event.id)).toEqual(['evt-1', 'older']);
  });

  it('passes the request summary through as meta, newest summary winning', async () => {
    let summary = irisSummary({ state: 'waiting' });
    const controller = new FeedController<IrisEvent, IrisRequestSummary>(
      async () => ({ items: [irisEvent()], nextCursor: null, meta: summary }),
      eventKey, 'retain'
    );
    await controller.start();
    expect(controller.getState().meta?.state).toBe('waiting');
    summary = irisSummary({ state: 'completed', stage: 'closed', waitingFor: null });
    await controller.refresh();
    expect(controller.getState().meta).toMatchObject({ state: 'completed', stage: 'closed', waitingFor: null });
  });
});

describe('Iris state colours in the Lichen scope', () => {
  const lichenHalf = (classes: string) => classes.split(' ').filter((c) => c.startsWith('lichen:')).join(' ');
  const legacyHalf = (classes: string) => classes.split(' ').filter((c) => !c.startsWith('lichen:')).join(' ');

  it('follows the owner pill table and never animates', async () => {
    const { IRIS_STATE_TONES, IRIS_STATE_DOTS } = await import('./irisActivity');
    expect(lichenHalf(IRIS_STATE_TONES.in_progress)).toContain('lichen:bg-lichen-tint lichen:text-lichen-pill');
    expect(lichenHalf(IRIS_STATE_TONES.needs_attention)).toContain('lichen:bg-lichen-tint lichen:text-lichen-pill');
    expect(lichenHalf(IRIS_STATE_TONES.waiting)).toContain('lichen:bg-pill-neutral lichen:text-chip-icon');
    expect(lichenHalf(IRIS_STATE_TONES.completed)).toContain('lichen:bg-chip lichen:text-meta');
    expect(lichenHalf(IRIS_STATE_TONES.failed)).toContain('lichen:bg-alert-tint lichen:text-alert-text');
    for (const classes of [...Object.values(IRIS_STATE_TONES), ...Object.values(IRIS_STATE_DOTS)]) {
      expect(classes).not.toMatch(/animate-|pulse|spin/);
    }
  });

  it('keeps the un-migrated request-detail half exactly as before', async () => {
    const { IRIS_STATE_TONES } = await import('./irisActivity');
    expect(legacyHalf(IRIS_STATE_TONES.in_progress)).toBe('bg-blue-50 text-blue-700 ring-blue-200');
    expect(legacyHalf(IRIS_STATE_TONES.needs_attention)).toBe('bg-rose-50 text-rose-700 ring-rose-200');
  });

  it('tells In progress and Needs attention apart by their words, not their shared pill', async () => {
    const { stateLabel } = await import('./irisActivity');
    expect(stateLabel('in_progress')).not.toBe(stateLabel('needs_attention'));
  });
});
