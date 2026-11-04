import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const auth = vi.hoisted(() => ({
  value: { user: null as null | { role: string }, isAuthenticated: false, loading: false },
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('../../hooks/landlord/useLandlordBadges', () => ({ useLandlordPaymentMode: () => 'direct' }));
vi.mock('../FeedbackButton', () => ({ default: () => null }));

const { default: LandlordSidebar } = await import('../landlord/LandlordSidebar');
const { ProtectedRoute } = await import('../../auth/ProtectedRoute');
const { default: IrisActivityPage } = await import('../../pages/landlord/IrisActivityPage');

/**
 * The page behind the production guard, as App.tsx mounts it. Static
 * rendering runs no effects, so a redirect shows here as the page NOT
 * rendering; where it lands, and App.tsx's own wiring of /dashboard/activity,
 * are left to the principal's real-browser auth acceptance.
 */
function renderGuarded(session: typeof auth.value) {
  auth.value = session;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/dashboard/activity']}>
      <Routes>
        <Route element={<ProtectedRoute allowedRoles={['landlord']} />}>
          <Route path="/dashboard/activity" element={<IrisActivityPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

const PAGE = 'data-testid="iris-activity-title"';

describe('Iris activity route', () => {
  it('has a sidebar entry that is active on /dashboard/activity', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/dashboard/activity']}>
        <LandlordSidebar userName="Test Landlord" onLogout={() => {}} />
      </MemoryRouter>
    );
    expect(html).toContain('href="/dashboard/activity"');
    const link = (testId: string) => html.match(new RegExp(`<a[^>]*data-testid="${testId}"[^>]*>`))![0];
    expect(link('nav-activity-btn')).toContain('aria-current="page"');
    expect(link('nav-activity-btn')).toContain('bg-hairline');
    // Overview is `end`, so it is not also highlighted.
    expect(link('nav-overview-btn')).not.toContain('aria-current');
    expect(link('nav-overview-btn')).not.toContain('bg-hairline text-ink');
  });

  it('renders the page for landlord-like roles behind the landlord guard', () => {
    for (const role of ['landlord', 'property_manager', 'admin']) {
      expect(renderGuarded({ user: { role }, isAuthenticated: true, loading: false })).toContain(PAGE);
    }
  });

  it('does not render the page for a tenant, a signed-out visitor or an unresolved session', () => {
    expect(renderGuarded({ user: { role: 'tenant' }, isAuthenticated: true, loading: false })).not.toContain(PAGE);
    expect(renderGuarded({ user: null, isAuthenticated: false, loading: false })).not.toContain(PAGE);
    expect(renderGuarded({ user: null, isAuthenticated: false, loading: true })).not.toContain(PAGE);
  });
});
