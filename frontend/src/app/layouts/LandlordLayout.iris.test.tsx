import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

const media = vi.hoisted(() => ({ desktop: true }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Lena Landlord', role: 'landlord' }, logout: () => {} }) }));
vi.mock('../hooks/useLiveTopic', () => ({ useLiveConnection: () => {}, useLiveTopic: () => {} }));
vi.mock('../hooks/landlord/useLandlordBadges', () => ({
  useLandlordBadges: () => ({ counts: { decisions: 0, requests: 0, schedule: 0, wallet: 0 } }),
  useLandlordPaymentMode: () => 'direct',
}));
vi.mock('../hooks/useMediaQuery', () => ({ DESKTOP_QUERY: '(min-width: 1024px)', useMediaQuery: () => media.desktop }));
vi.mock('../components/FeedbackButton', () => ({ default: () => null }));
// A live Iris, as after the provider's effect has created its controller.
vi.mock('../components/iris/IrisProvider', async () => {
  const { IrisController } = await import('../components/iris/irisController');
  const state = new IrisController({} as never).getState();
  return {
  IrisProvider: ({ children }: { children: ReactNode }) => children,
  useIris: () => ({
    state,
    openPanel: () => {},
    closePanel: () => {},
    follow: () => {},
    takeCloseFocus: () => 'launcher',
    controller: {},
    dock: { docked: false, width: 384, min: 320, max: 560 },
    setPanelWidth: () => {},
    mainRef: { current: null },
    draft: { current: '' },
  }),
  };
});

const { default: LandlordLayout } = await import('./LandlordLayout');

function render(path: string, desktop = true) {
  media.desktop = desktop;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<LandlordLayout />}>
          <Route path="/dashboard/*" element={<p data-testid="page">page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

const launchers = (html: string) => html.match(/data-iris-launcher/g) || [];

// Every landlord route form from App.tsx, including the dynamic ones.
const ROUTES = [
  '/dashboard',
  '/dashboard/requests',
  '/dashboard/requests/6ae2bfbed3d03df77beb5eee',
  '/dashboard/properties',
  '/dashboard/properties/6ae2bfbed3d03df77beb5ee1',
  '/dashboard/tenants',
  '/dashboard/vendors',
  '/dashboard/schedule',
  '/dashboard/wallet',
  '/dashboard/billing',
  '/dashboard/reports',
  '/dashboard/policy',
  '/dashboard/decisions',
  '/dashboard/activity',
];

describe('Ask Iris launcher in the landlord shell', () => {
  it('mounts exactly one launcher on every landlord route, desktop and phone', () => {
    for (const path of ROUTES) {
      expect(launchers(render(path, true)), `${path} desktop`).toHaveLength(1);
      expect(launchers(render(path, false)), `${path} phone`).toHaveLength(1);
    }
  });

  it('gives the desktop launcher its own light scope on legacy pages, and nothing else', () => {
    for (const path of ['/dashboard/reports', '/dashboard/billing']) {
      const html = render(path);
      // The only light scope on a legacy page is the launcher's own subtree.
      expect((html.match(/lichen-light/g) || []).length, path).toBe(1);
      expect(html, path).toMatch(/<span class="lichen lichen-light contents" data-iris-scope="true"><button[^>]*data-iris-launcher/);
      expect(html, path).toMatch(/^<div class="min-h-screen bg-slate-50">/);
      expect(html.match(/<main class="([^"]*)"/)![1].split(/\s+/), path).not.toContain('lichen');
    }
  });

  it('uses the page scope on migrated pages and the dark bar on a phone', () => {
    for (const path of ['/dashboard', '/dashboard/activity', '/dashboard/policy', '/dashboard/guided-demo', '/dashboard/requests', '/dashboard/requests/owned', '/dashboard/decisions', '/dashboard/wallet', '/dashboard/schedule']) {
      const lichen = render(path);
      expect((lichen.match(/lichen-light/g) || []).length, path).toBe(1); // main only
      expect(lichen, path).not.toContain('data-iris-scope');
      expect(lichen.match(/<main class="([^"]*)"/)![1].split(/\s+/), path).toContain('lichen-light');
    }
    const phone = render('/dashboard/billing', false);
    expect(phone).not.toContain('lichen-light');
    expect(phone).toMatch(/<div class="lichen border-b[^"]*lg:hidden">[\s\S]*data-testid="iris-launcher-phone"/);
    const migratedPhone = render('/dashboard/requests', false);
    expect(migratedPhone).toMatch(/<div class="lichen border-b[^"]*lg:hidden">[\s\S]*data-testid="iris-launcher-phone"/);
    expect(migratedPhone.match(/<main class="([^"]*)"/)![1].split(/\s+/)).toContain('lichen-light');
  });
});

describe('Desktop toolbar spacing', () => {
  it('keeps 16px between the launcher row and the beta banner, with no negative overlap', () => {
    const html = render('/dashboard/requests', true);
    expect(html).toContain('class="mb-4 flex items-center justify-end gap-2"');
    expect(html).not.toContain('-mb-2 flex items-center justify-end');
  });
});


describe('Page column container', () => {
  it('makes the page column the named container page grids follow, so docked Iris narrows them', () => {
    const html = render('/dashboard', true);
    expect(html).toContain('class="@container/page mx-auto w-full max-w-[1600px]"');
  });
});
