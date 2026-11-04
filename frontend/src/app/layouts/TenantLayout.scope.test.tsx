import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useOutletContext } from 'react-router-dom';
import type { ReactNode } from 'react';
import TenantLayout from './TenantLayout';
import { useTenantPresentation } from '../components/tenant/tenantPresentation';
import { tenantNotificationTarget } from '../components/tenant/tenantNotificationTarget';

const state = vi.hoisted(() => ({ enabled: undefined as boolean | undefined, desktop: false, logout: vi.fn(), live: vi.fn(), badges: vi.fn(), moveOut: vi.fn(), bell: vi.fn(), banner: vi.fn(), judge: vi.fn(), reload: vi.fn() }));
vi.mock('../lib/lichenRoutes', async importOriginal => {
  const original = await importOriginal<typeof import('../lib/lichenRoutes')>();
  return { ...original, isLichenTenantPath: (path: string) => original.isLichenTenantPath(path, state.enabled) };
});
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'tenant_fixture', role: 'tenant', name: 'Synthetic Tenant' }, logout: state.logout }) }));
vi.mock('../hooks/useLiveTopic', () => ({ useLiveConnection: state.live }));
vi.mock('../hooks/tenant/useTenantBadges', () => ({ useTenantBadges: () => { state.badges(); return { counts: { schedule: 1234 } }; } }));
vi.mock('../hooks/tenant/useTenantMoveOut', () => ({ useTenantMoveOutState: () => { state.moveOut(); return { status: null, reload: state.reload }; } }));
vi.mock('../hooks/useMediaQuery', () => ({ DESKTOP_QUERY: '(min-width: 1024px)', useMediaQuery: () => state.desktop }));
vi.mock('../components/FeedbackButton', () => ({ default: ({ variant }: { variant: string }) => <button data-feedback-variant={variant}>Send feedback</button> }));
vi.mock('../components/notifications/NotificationBell', () => ({ default: (props: unknown) => { state.bell(props); return <button aria-label="Notifications">Notifications</button>; } }));
vi.mock('../components/tenant/TenantMoveOutBanner', () => ({ default: (props: unknown) => { state.banner(props); return <div data-testid="move-out-banner" />; } }));
vi.mock('../components/judge/JudgeSandboxProvider', () => ({
  judgeIdentity: () => 'tenant:tenant_fixture',
  JudgeSandboxProvider: ({ identity, children }: { identity: string; children: ReactNode }) => { state.judge(identity); return children; },
}));
vi.mock('../components/judge/JudgeViews', () => ({ JudgeBanner: () => <div data-testid="judge-banner" /> }));

function Probe() {
  const active = useTenantPresentation();
  const moveOut = useOutletContext<{ reload: () => void }>();
  return <div data-tenant-active={active} data-shared-move-out={moveOut.reload === state.reload}>Child page</div>;
}
function render(path = '/portal') {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><Routes><Route element={<TenantLayout />}><Route path="*" element={<Probe />} /></Route></Routes></MemoryRouter>);
}
beforeEach(() => { vi.clearAllMocks(); state.enabled = undefined; state.desktop = false; });
describe('serialized tenant shell presentation scope', () => {
  it('keeps explicit-OFF and unknown/landlord routes legacy with the child context disabled', () => {
    for (const enabled of [false, true]) {
      state.enabled = enabled;
      for (const path of enabled ? ['/portal/unknown', '/dashboard', '/dashboard/guided-demo'] : ['/portal', '/portal/new', '/portal/safety', '/portal/schedule', '/portal/settings', '/portal/requests/owned']) {
        const html = render(path);
        expect(html, path).toContain('data-tenant-active="false"');
        expect(html, path).toContain('linear-gradient');
        expect(html, path).not.toContain('lichen-d5');
        expect(html, path).toContain('border-slate-200 bg-white');
        expect(state.bell.mock.calls.at(-1)![0]).toMatchObject({ panel: undefined, tenantPresentation: false });
      }
    }
  });
  it('scopes all six default-enabled pages while keeping the real sidebar in its separate dark scope', () => {
    for (const path of ['/portal', '/portal/new', '/portal/safety', '/portal/schedule', '/portal/settings', '/portal/requests/owned']) {
    const html = render(path);
    const main = html.match(/<main[^>]*class="([^"]*)"/)![1].split(/\s+/);
    const aside = html.match(/<aside class="([^"]*)"/)![1].split(/\s+/);
    expect(main).toEqual(expect.arrayContaining(['lichen', 'lichen-light', 'lichen-d5', 'font-sans']));
    expect(aside).toContain('lichen'); expect(aside).not.toContain('lichen-light'); expect(aside).not.toContain('lichen-d5');
    expect(html.indexOf('<aside')).toBeLessThan(html.indexOf('<main'));
    expect(html).not.toContain('linear-gradient');
    expect(html).toContain('data-tenant-active="true"');
    expect(html).toContain('data-shared-move-out="true"');
    expect(html).toContain('tabindex="-1" aria-label="Tenant portal"');
    expect(main).toContain('[&amp;_h1]:focus:outline-ring');
    }
  });
  it('mounts one bell and one move-out/live/badge source at each breakpoint without altering provider identity', () => {
    state.enabled = true;
    for (const desktop of [false, true]) {
      vi.clearAllMocks(); state.desktop = desktop;
      const html = render();
      expect((html.match(/aria-label="Notifications"/g) || []).length).toBe(1);
      expect(state.live).toHaveBeenCalledTimes(1); expect(state.badges).toHaveBeenCalledTimes(1); expect(state.moveOut).toHaveBeenCalledTimes(1);
      expect(state.bell).toHaveBeenCalledTimes(1); expect(state.bell.mock.calls[0][0]).toMatchObject({ resolveTarget: tenantNotificationTarget, panel: 'light', tenantPresentation: true, emptyHint: 'Updates on your requests, visits and appeals will show up here.' });
      expect(state.banner).toHaveBeenCalledExactlyOnceWith({ status: null, onChanged: state.reload });
      expect(state.judge).toHaveBeenCalledExactlyOnceWith('tenant:tenant_fixture');
      for (const text of ['Requests', 'Schedule', 'Settings', 'Tenant Portal', 'Send feedback', 'Logout']) expect(html).toContain(text);
      expect(html).toContain('aria-label="1234 waiting on you"'); expect(html).toContain('9+');
      expect(html).not.toMatch(/Ask Iris|Payments|Wallet|Decisions Needed|Policy/);
    }
  });
});
