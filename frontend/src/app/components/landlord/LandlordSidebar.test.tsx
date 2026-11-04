import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../hooks/landlord/useLandlordBadges', () => ({ useLandlordPaymentMode: () => 'direct' }));
vi.mock('../FeedbackButton', () => ({ default: () => null }));

const { default: LandlordSidebar } = await import('./LandlordSidebar');

function render(path: string, badges = { decisions: 3, requests: 12, schedule: 0, wallet: 0 }) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <LandlordSidebar userName="Lena Landlord" onLogout={() => {}} badges={badges} />
    </MemoryRouter>
  );
}

describe('LandlordSidebar (Lichen shell)', () => {
  it('is always its own Lichen scope, labelled as landlord navigation', () => {
    const html = render('/dashboard/vendors');
    expect(html).toMatch(/^<aside class="lichen /);
    expect(html).toContain('<nav aria-label="Landlord"');
  });

  it('keeps the owner dark chrome: 2px inset active bar, hairline avatar, sub-label token, never light', () => {
    const html = render('/dashboard');
    expect(html).not.toContain('lichen-light');
    const active = html.match(/<a[^>]*aria-current="page"[^>]*>/)![0];
    expect(active).toContain('before:w-0.5');
    expect(active).toContain('before:inset-y-0');
    expect(active).toContain('bg-hairline text-ink');
    expect(html).toContain('text-sidebar-sub">Landlord Portal');
    expect(html).toMatch(/rounded-full text-sm font-semibold bg-hairline text-chip-icon/);
  });

  it('leaves the logo to the phone bar in the mobile copy', () => {
    const mobile = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/dashboard']}>
        <LandlordSidebar userName="Lena Landlord" onLogout={() => {}} mobile />
      </MemoryRouter>
    );
    expect(mobile).not.toContain('<h1');
    expect(render('/dashboard')).toContain('<h1');
  });

  it('gives each item exactly one tab stop: the link, with no focusable wrapper', () => {
    const html = render('/dashboard');
    expect(html).not.toContain('tabindex');
    expect((html.match(/<a /g) || []).length).toBe(12);
  });

  it('marks the current page with aria-current and a non-colour edge rule, even on un-migrated pages', () => {
    const html = render('/dashboard/requests');
    const current = html.match(/<a[^>]*aria-current="page"[^>]*>/g) || [];
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('data-testid="nav-requests-btn"');
    expect(current[0]).toContain('before:bg-lichen');
  });

  it('keeps the badge meanings: a spoken quantity, hidden on its own tab', () => {
    const html = render('/dashboard/requests');
    expect(html).toContain('aria-label="3 needing a decision"');
    // Requests is the current tab, so its unread badge is not shown.
    expect(html).not.toContain('nav-requests-btn-badge');
    const onOverview = render('/dashboard');
    expect(onOverview).toContain('aria-label="12 new since you last looked"');
    expect(onOverview).toMatch(/data-testid="nav-requests-btn-badge"[^>]*>9\+</);
  });
});
