import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import NotificationBell from './NotificationBell';
const fixture = vi.hoisted(() => ({
  view: { loaded: true, unread: 1, items: [{ _id: 'mock', type: 'appointment_confirmed', title: 'Averylongunbrokentenantnotificationtitle', message: 'Complete synthetic message with final sentinel END.', read: false, createdAt: '2026-11-01T00:00:00Z', metadata: {} }] },
  api: { list: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn() },
}));
vi.mock('../../api/client', () => ({ NotificationsAPI: fixture.api }));
vi.mock('../judge/JudgeSandboxProvider', () => ({ useJudgeSandboxEnabled: () => true }));
vi.mock('../../hooks/useLiveTopic', () => ({ useLiveTopic: vi.fn() }));
vi.mock('./notificationFeed', () => ({
  bellPollMs: () => 5000, visiblePoll: vi.fn(),
  NotificationFeed: class { getView = () => fixture.view; subscribe = () => () => {}; },
}));
// Deliberately render the closed portal's children for static class/copy
// checks. Real Radix interaction/layout is verified only in the own MOCK.
vi.mock('../ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children, className }: { children: ReactNode; className: string }) => <div data-testid="static-panel" className={className}>{children}</div>,
}));
const render = (tenantPresentation?: boolean) => renderToStaticMarkup(<MemoryRouter><NotificationBell resolveTarget={() => '/portal/requests/mock'} emptyHint="Synthetic empty hint" panel="light" tenantPresentation={tenantPresentation} /></MemoryRouter>);
describe('explicit tenant-only bell presentation', () => {
  it('makes absent and false presentation identical without adding the tenant wrap classes', () => {
    // Radix is replaced, so there are no generated portal ids to normalize.
    expect(render()).toBe(render(false));
    expect(render()).not.toContain('overflow-wrap:anywhere');
    expect(render()).not.toContain('gap-x-3 gap-y-2');
    expect(render()).not.toContain('motion-reduce:');
  });
  it('adds scoped header/title/message/footer wrapping while preserving full text, badge and actions', () => {
    const markup = render(true);
    expect(markup).toContain('min-w-0 shrink-0 flex-wrap gap-x-3 gap-y-2');
    expect(markup).toContain('min-w-0 max-w-full flex-wrap text-left');
    expect(markup).toContain('overflow-wrap:anywhere');
    expect(markup).toContain('min-w-0 flex-wrap');
    for (const text of ['Notifications', 'Mark all read', fixture.view.items[0].title, fixture.view.items[0].message, 'notification-bell-count']) expect(markup).toContain(text);
    expect(markup).toContain('w-[min(24rem,calc(100vw-2rem))] p-0');
    expect(markup).toContain('lichen-light');
    expect(markup).toContain('flex-wrap sm:flex-nowrap');
    expect(markup).toContain('basis-full sm:basis-0');
    expect(markup).toContain('max-h-[var(--radix-popover-content-available-height,calc(100dvh-2rem))]');
    expect(markup).toContain('max-h-[26rem] overflow-y-auto min-h-0');
    expect(markup).toContain('motion-reduce:animate-none!');
    expect(markup).toContain('motion-reduce:transition-none!');
    expect(markup).toContain('[&amp;_*]:motion-reduce:animate-none!');
    expect(fixture.api.list).not.toHaveBeenCalled(); expect(fixture.api.markRead).not.toHaveBeenCalled(); expect(fixture.api.markAllRead).not.toHaveBeenCalled();
  });
});
