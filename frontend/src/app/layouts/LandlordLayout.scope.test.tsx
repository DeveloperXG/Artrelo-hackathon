import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const media = vi.hoisted(() => ({ desktop: true }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { name: 'Lena Landlord', role: 'landlord' }, logout: () => {} }) }));
vi.mock('../hooks/useLiveTopic', () => ({ useLiveConnection: () => {}, useLiveTopic: () => {} }));
vi.mock('../hooks/landlord/useLandlordBadges', () => ({
  useLandlordBadges: () => ({ counts: { decisions: 0, requests: 0, schedule: 0, wallet: 0 } }),
  useLandlordPaymentMode: () => 'direct',
}));
vi.mock('../hooks/useMediaQuery', () => ({ DESKTOP_QUERY: '(min-width: 1024px)', useMediaQuery: () => media.desktop }));
vi.mock('../components/FeedbackButton', () => ({ default: () => null }));

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

const mainClass = (html: string) => html.match(/<main class="([^"]*)"/)![1].split(/\s+/);
const asideClass = (html: string) => html.match(/<aside class="([^"]*)"/)![1].split(/\s+/);

describe('LandlordLayout scopes (Lichen light content, dark chrome)', () => {
  it('puts only the page column of a migrated route in the light scope', () => {
    for (const path of ['/dashboard', '/dashboard/activity', '/dashboard/requests', '/dashboard/requests/owned', '/dashboard/decisions', '/dashboard/wallet', '/dashboard/schedule', '/dashboard/guided-demo', '/dashboard/properties', '/dashboard/properties/owned', '/dashboard/tenants', '/dashboard/vendors', '/dashboard/billing', '/dashboard/reports']) {
      const html = render(path);
      expect(mainClass(html), path).toEqual(expect.arrayContaining(['lichen', 'lichen-light']));
      // The sidebar stays its own dark scope, outside the light column.
      expect(asideClass(html), path).toContain('lichen');
      expect(asideClass(html), path).not.toContain('lichen-light');
      // No page-wide flip: the outer wrapper is no scope at all.
      expect(html, path).toMatch(/^<div class="min-h-screen bg-white">/);
      expect((html.match(/lichen-light/g) || []).length, path).toBe(1);
    }
  });

  it('keeps the phone bar dark on a migrated route', () => {
    const html = render('/dashboard', false);
    expect(html).toMatch(/<div class="lichen border-b border-hairline bg-sidebar[^"]*lg:hidden">/);
    expect(html).toContain('text-sidebar-sub">Landlord Portal');
  });

  it('leaves an un-migrated route legacy: no light scope and no Lichen page column', () => {
    for (const path of ['/dashboard/vendors/unknown', '/dashboard/reports/unknown', '/dashboard/billing/unknown']) {
      const html = render(path);
      expect(html, path).not.toContain('lichen-light');
      expect(mainClass(html), path).not.toContain('lichen');
      expect(html, path).toMatch(/^<div class="min-h-screen bg-slate-50">/);
    }
  });
});
