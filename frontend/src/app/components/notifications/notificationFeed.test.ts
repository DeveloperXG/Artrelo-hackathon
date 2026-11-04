import { describe, expect, it, vi } from 'vitest';
import type { AppNotification } from '../../api/client';
import {
  BELL_POLL_MS,
  JUDGE_BELL_POLL_MS,
  NotificationFeed,
  bellPollMs,
  visiblePoll,
  type NotificationApi,
  type PollEnv,
} from './notificationFeed';

const row = (id: string, read = false): AppNotification => ({
  _id: id,
  type: 'work_order_created',
  title: 'Sandbox: new request',
  message: 'A request was submitted.',
  read,
  createdAt: '2026-10-31T06:00:00.000Z',
});

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

function setup(over: Partial<NotificationApi> = {}) {
  const api: NotificationApi = {
    list: vi.fn(async () => ({ notifications: [row('n1'), row('n2'), row('n3', true)], unreadCount: 2 })),
    markRead: vi.fn(async () => ({})),
    markAllRead: vi.fn(async () => ({})),
    ...over,
  };
  return { api, feed: new NotificationFeed(api, 15) };
}

describe('notification feed: the ordinary bell API', () => {
  it('does not reinflate unread when a fresh event/poll overlaps an unsettled read mutation', async () => {
    const marking = deferred<unknown>();
    const { feed, api } = setup({ markRead: vi.fn(() => marking.promise) });
    await feed.load();
    feed.markRead(feed.view.items[0]);
    expect(feed.view.unread).toBe(1);
    const refresh = feed.load(), resync = feed.load(); // Wait for the existing marker, not its stale server view.
    expect(feed.view.unread).toBe(1);
    expect(api.list).toHaveBeenCalledTimes(1);
    (api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ notifications: [row('n1', true), row('n2')], unreadCount: 1 });
    marking.resolve({});
    await Promise.all([refresh, resync]);
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(feed.view.unread).toBe(1);
    expect(api.markRead).toHaveBeenCalledTimes(1);
  });

  it('does not count a rapid second activation of the same stale row as another unread item', async () => {
    const marking = deferred<unknown>();
    const { feed, api } = setup({ markRead: vi.fn(() => marking.promise) });
    await feed.load();
    const itemBeforeRender = feed.view.items[0];
    feed.markRead(itemBeforeRender); feed.markRead(itemBeforeRender);
    expect(feed.view.unread).toBe(1);
    expect(api.markRead).toHaveBeenCalledTimes(1);
    marking.resolve({});
  });

  it('loads the newest rows and the unread count the server reports', async () => {
    const { api, feed } = setup();
    expect(feed.view).toEqual({ items: [], unread: 0, loaded: false });
    await feed.load();
    expect(api.list).toHaveBeenCalledWith(15);
    expect(feed.view.unread).toBe(2);
    expect(feed.view.items.map((n) => n._id)).toEqual(['n1', 'n2', 'n3']);
    expect(feed.view.loaded).toBe(true);
  });

  it('marks one row read once, optimistically, and ignores a row already read', async () => {
    const { api, feed } = setup();
    await feed.load();
    feed.markRead(feed.view.items[0]);
    expect(api.markRead).toHaveBeenCalledTimes(1);
    expect(api.markRead).toHaveBeenCalledWith('n1');
    expect(feed.view.unread).toBe(1);
    expect(feed.view.items[0].read).toBe(true);
    feed.markRead(feed.view.items[0]);
    feed.markRead(feed.view.items[2]);
    expect(api.markRead).toHaveBeenCalledTimes(1);
    expect(feed.view.unread).toBe(1);
  });

  it('a failed mark-one is not retried; the next load reconciles', async () => {
    const { api, feed } = setup({ markRead: vi.fn(async () => Promise.reject(new Error('offline'))) });
    await feed.load();
    feed.markRead(feed.view.items[0]);
    await Promise.resolve();
    expect(api.markRead).toHaveBeenCalledTimes(1);
    await feed.load();
    expect(feed.view.unread).toBe(2);
  });

  it('marks all read in one call and puts the list back if it fails', async () => {
    const ok = setup();
    await ok.feed.load();
    await ok.feed.markAllRead();
    expect(ok.api.markAllRead).toHaveBeenCalledTimes(1);
    expect(ok.feed.view.unread).toBe(0);
    expect(ok.feed.view.items.every((n) => n.read)).toBe(true);

    const failing = setup({ markAllRead: vi.fn(async () => Promise.reject(new Error('offline'))) });
    await failing.feed.load();
    await failing.feed.markAllRead();
    expect(failing.api.markAllRead).toHaveBeenCalledTimes(1);
    expect(failing.feed.view.unread).toBe(2);
    expect(failing.feed.view.items.filter((n) => !n.read)).toHaveLength(2);
  });

  it('does not undo a newer list when a slow mark-all fails', async () => {
    const pending = deferred<unknown>();
    const { feed, api } = setup({ markAllRead: vi.fn(() => pending.promise) });
    await feed.load();
    const marking = feed.markAllRead();
    (api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ notifications: [row('n9')], unreadCount: 1 });
    const loading = feed.load();
    pending.reject(new Error('offline'));
    await Promise.all([marking, loading]);
    expect(feed.view.items.map((n) => n._id)).toEqual(['n9']);
    expect(feed.view.unread).toBe(1);
  });

  it('drops a load answer that a newer load has overtaken', async () => {
    const slow = deferred<{ notifications: AppNotification[]; unreadCount: number }>();
    const list = vi
      .fn()
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce({ notifications: [row('new')], unreadCount: 1 });
    const { feed } = setup({ list });
    const first = feed.load();
    await feed.load();
    slow.resolve({ notifications: [row('old1'), row('old2')], unreadCount: 2 });
    await first;
    expect(feed.view.items.map((n) => n._id)).toEqual(['new']);
    expect(feed.view.unread).toBe(1);
  });

  it('preserves newly arrived unread records after a mark-all snapshot settles', async () => {
    const pending = deferred<unknown>();
    const { feed, api } = setup({ markAllRead: vi.fn(() => pending.promise) });
    await feed.load();
    const marking = feed.markAllRead();
    const refresh = feed.load();
    expect(feed.view.unread).toBe(0);
    (api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ notifications: [row('arrived_after_mark'), row('n1', true)], unreadCount: 1 });
    pending.resolve({}); await Promise.all([marking, refresh]);
    expect(feed.view.unread).toBe(1);
    expect(feed.view.items[0]).toMatchObject({ _id: 'arrived_after_mark', read: false });
    expect(api.markAllRead).toHaveBeenCalledTimes(1);
  });

  it('drops queued mutation readback after close/account departure', async () => {
    const pending = deferred<unknown>();
    const { feed, api } = setup({ markRead: vi.fn(() => pending.promise) });
    await feed.load(); feed.markRead(feed.view.items[0]);
    const refresh = feed.load(); feed.close();
    const seen = vi.fn(); feed.subscribe(seen);
    pending.resolve({}); await refresh;
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(seen).not.toHaveBeenCalled();
  });

  it('does not revive old queued/error callbacks after close then open in a new generation', async () => {
    const pending = deferred<unknown>();
    const { feed, api } = setup({ markRead: vi.fn(() => pending.promise) });
    await feed.load(); feed.markRead(feed.view.items[0]);
    const oldQueued = feed.load(); feed.close(); feed.open();
    (api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ notifications: [row('fresh_generation')], unreadCount: 1 });
    await feed.load();
    pending.reject(new Error('old read-marker failed'));
    await oldQueued; await Promise.resolve();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(feed.view.items.map(item => item._id)).toEqual(['fresh_generation']);
    expect(feed.view.unread).toBe(1);
  });

  it.each(['success', 'failure'])('isolates late mark-all %s and its queued read from a reopened generation', async outcome => {
    const pending = deferred<unknown>();
    const { feed, api } = setup({ markAllRead: vi.fn(() => pending.promise) });
    await feed.load();
    const marking = feed.markAllRead(), queued = feed.load();
    feed.close(); feed.open();
    (api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ notifications: [row('current_generation')], unreadCount: 1 });
    await feed.load();
    if (outcome === 'success') pending.resolve({}); else pending.reject(new Error('old mutation failed'));
    await Promise.all([marking, queued]);
    expect(feed.view.items.map(item => item._id)).toEqual(['current_generation']);
    expect(feed.view.unread).toBe(1); expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('after close (sign-out or another identity) drops late answers and sends nothing', async () => {
    const slow = deferred<{ notifications: AppNotification[]; unreadCount: number }>();
    const { feed, api } = setup({ list: vi.fn(() => slow.promise) });
    const seen = vi.fn();
    feed.subscribe(seen);
    const pending = feed.load();
    feed.close();
    slow.resolve({ notifications: [row('a_private')], unreadCount: 1 });
    await pending;
    expect(feed.view.items).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
    await feed.load();
    await feed.markAllRead();
    feed.markRead(row('x'));
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.markAllRead).not.toHaveBeenCalled();
    expect(api.markRead).not.toHaveBeenCalled();
    // React re-runs effect setup on the same feed (StrictMode): open() resumes.
    feed.open();
    (api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ notifications: [row('b1')], unreadCount: 1 });
    await feed.load();
    expect(feed.view.items.map((n) => n._id)).toEqual(['b1']);
  });
});

describe('bell fallback cadence', () => {
  it('keeps 60 s by default and uses 5 s only for an enabled judge sandbox', () => {
    expect(BELL_POLL_MS).toBe(60_000);
    expect(JUDGE_BELL_POLL_MS).toBe(5_000);
    expect(bellPollMs(false)).toBe(60_000);
    expect(bellPollMs(true)).toBe(5_000);
  });

  function fakeEnv(visible: boolean) {
    const state = { visible, listeners: new Set<() => void>(), timers: new Map<number, { fn: () => void; ms: number }>(), next: 0 };
    const env: PollEnv = {
      isVisible: () => state.visible,
      onVisibilityChange: (l) => {
        state.listeners.add(l);
        return () => state.listeners.delete(l);
      },
      setInterval: (fn, ms) => {
        state.next += 1;
        state.timers.set(state.next, { fn, ms });
        return state.next;
      },
      clearInterval: (h) => {
        state.timers.delete(h as number);
      },
    };
    const flip = (v: boolean) => {
      state.visible = v;
      for (const l of state.listeners) l();
    };
    return { env, state, flip };
  }

  it('holds no timer while the tab is hidden and restarts when it is shown', () => {
    const { env, state, flip } = fakeEnv(false);
    const fn = vi.fn();
    const stop = visiblePoll(fn, bellPollMs(true), env);
    expect(state.timers.size).toBe(0);
    flip(true);
    expect([...state.timers.values()].map((t) => t.ms)).toEqual([5_000]);
    flip(true);
    expect(state.timers.size).toBe(1);
    flip(false);
    expect(state.timers.size).toBe(0);
    flip(true);
    stop();
    expect(state.timers.size).toBe(0);
    expect(state.listeners.size).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs at the default cadence outside a judge sandbox', () => {
    const { env, state } = fakeEnv(true);
    const fn = vi.fn();
    const stop = visiblePoll(fn, bellPollMs(false), env);
    const [timer] = [...state.timers.values()];
    expect(timer.ms).toBe(60_000);
    timer.fn();
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });
});
