import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import TenantLayout from './TenantLayout';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'tenant_1', role: 'tenant', name: 'Synthetic Tenant' }, logout: vi.fn() }) }));
vi.mock('../hooks/useLiveTopic', () => ({ useLiveConnection: () => {}, useLiveTopic: () => {} }));
vi.mock('../hooks/tenant/useTenantBadges', () => ({ useTenantBadges: () => ({ counts: {} }) }));
vi.mock('../hooks/tenant/useTenantMoveOut', () => ({ useTenantMoveOutState: () => ({ status: null, reload: vi.fn() }) }));
vi.mock('../hooks/useMediaQuery', () => ({ DESKTOP_QUERY: '(min-width: 1024px)', useMediaQuery: () => false }));
vi.mock('../components/FeedbackButton', () => ({ default: () => null }));
vi.mock('../components/notifications/NotificationBell', () => ({ default: () => <button aria-label="Notifications">Notifications</button> }));

describe('tenant mobile header reflow', () => {
  it('keeps the brand, bell and Menu while allowing action groups to wrap', () => {
    const html = renderToStaticMarkup(<MemoryRouter><TenantLayout /></MemoryRouter>);
    expect(html).toContain('flex flex-wrap items-center justify-between gap-3');
    expect(html).toContain('flex min-w-min flex-1 basis-0 items-center gap-2');
    expect(html).toContain('ml-auto flex flex-wrap items-center justify-end gap-1');
    expect(html).toContain('aria-label="Notifications"');
    expect(html).toContain('aria-label="Menu"');
    expect(html).toContain('Tenant Portal');
  });
});
