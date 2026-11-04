import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { NotificationFeed as RealFeed } from './notificationFeed';
import NotificationBell from './NotificationBell';
const state = vi.hoisted(() => ({
  api: { list: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn() },
  feed: null as RealFeed | null,
  topics: null as string | null, nudge: (() => {}) as () => void,
}));
vi.mock('../../api/client', () => ({ NotificationsAPI: state.api }));
vi.mock('../judge/JudgeSandboxProvider', () => ({ useJudgeSandboxEnabled: () => false }));
vi.mock('../../hooks/useLiveTopic', () => ({ useLiveTopic: (topics: string, handler: () => void) => { state.topics = topics; state.nudge = handler; } }));
vi.mock('./notificationFeed', async importOriginal => {
  const actual = await importOriginal<typeof import('./notificationFeed')>();
  // Static-render bridge retains the real feed across explicit rerenders. No DOM, real Auth or transport.
  return { ...actual, NotificationFeed: class {
    constructor() { state.feed ??= new actual.NotificationFeed(state.api); }
    getView = () => state.feed!.getView();
    subscribe = (listener: () => void) => state.feed!.subscribe(listener);
    load = () => state.feed!.load();
    markRead = (...args: Parameters<RealFeed['markRead']>) => state.feed!.markRead(...args);
    markAllRead = () => state.feed!.markAllRead();
  } };
});
const row = (id: string, type = 'work_order_created', read = false) => ({ _id: id, type, title: 'Synthetic notification', message: 'Synthetic domain event', read, createdAt: '2026-11-04T00:00:00Z' });
const shown = (path: string) => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><NotificationBell resolveTarget={() => null} emptyHint="Synthetic empty" /></MemoryRouter>);
beforeEach(() => {
  state.feed = null;
  state.api.list.mockReset().mockResolvedValue({ notifications: [], unreadCount: 0 });
  state.api.markRead.mockReset().mockResolvedValue({}); state.api.markAllRead.mockReset().mockResolvedValue({});
});

describe('both topbar bells use authoritative live unread state', () => {
  it.each(['/dashboard/policy', '/portal'])('updates creation and read clearing without navigating from %s', async path => {
    expect(shown(path)).not.toContain('notification-bell-count');
    expect(state.topics).toBe('notifications');
    state.api.list.mockResolvedValue({ notifications: [row('new')], unreadCount: 1 });
    state.nudge(); await vi.waitFor(() => expect(state.feed!.view.unread).toBe(1));
    expect(shown(path)).toContain('Notifications, 1 unread');
    expect(shown(path)).toContain('notification-bell-count');
    state.feed!.markRead(state.feed!.view.items[0]);
    expect(shown(path)).not.toContain('notification-bell-count');
    // Another tab's read-clearing nudge is an authoritative zero, not a guessed local delta.
    state.api.list.mockResolvedValue({ notifications: [row('new', 'work_order_created', true)], unreadCount: 0 });
    state.nudge(); await state.feed!.load();
    expect(shown(path)).not.toContain('notification-bell-count');
    expect(state.api.markRead).toHaveBeenCalledTimes(1);
  });

  it('includes billing notices in the same unread source and never turns pinned rows into unread', async () => {
    shown('/dashboard/billing');
    state.api.list.mockResolvedValue({ notifications: [row('bill', 'billing_invoice_issued'), row('request')], unreadCount: 2 });
    state.nudge(); await vi.waitFor(() => expect(state.feed!.view.unread).toBe(2));
    expect(shown('/dashboard/billing')).toContain('Notifications, 2 unread');
    await state.feed!.markAllRead();
    expect(shown('/dashboard/billing')).not.toContain('notification-bell-count');
    expect(state.api.markAllRead).toHaveBeenCalledTimes(1);
    const pinned = renderToStaticMarkup(<MemoryRouter><NotificationBell resolveTarget={() => null} emptyHint="Synthetic empty" pinned={[{ id: 'offer', title: 'Synthetic founding offer', message: 'Recorded offer', onSelect: vi.fn() }]} /></MemoryRouter>);
    expect(pinned).not.toContain('notification-bell-count');
  });

  it('does not surface a departing identity feed after close and a fresh feed begins empty', async () => {
    let resolve!: (value: { notifications: ReturnType<typeof row>[]; unreadCount: number }) => void;
    shown('/dashboard'); const previous = state.feed!;
    state.api.list.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const late = previous.load(); previous.close();
    state.feed = null; expect(shown('/portal')).not.toContain('notification-bell-count');
    resolve({ notifications: [row('old_identity_only')], unreadCount: 8 }); await late;
    expect(shown('/portal')).not.toContain('notification-bell-count');
    expect(state.feed!.view.items).toEqual([]);
  });
});
