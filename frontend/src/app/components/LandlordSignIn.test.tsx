import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ loginLandlord: vi.fn(), loginTenant: vi.fn() }),
}));

const { default: LandlordSignIn } = await import('./LandlordSignIn');

const render = (path = '/login') =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <LandlordSignIn />
    </MemoryRouter>
  );

describe('LandlordSignIn (Lichen)', () => {
  it('renders as its own Lichen scope with no gradient, glow or legacy blue', () => {
    const html = render();
    expect(html).toMatch(/^<div class="lichen /);
    expect(html).not.toMatch(/gradient|backdrop-blur|shadow-|#137fec|#a855f7/);
  });

  it('keeps every test ID the end-to-end checks drive', () => {
    const html = render();
    for (const id of ['signin-toggle-landlord', 'signin-toggle-tenant', 'signin-email-input', 'signin-password-input', 'signin-submit-btn']) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  it('labels both fields with real <label for> elements', () => {
    const html = render();
    expect(html).toMatch(/<label for="signin-email"[^>]*>Email address<\/label>/);
    expect(html).toMatch(/<input[^>]*id="signin-email"/);
    expect(html).toMatch(/<label for="signin-password"[^>]*>Password<\/label>/);
    expect(html).toMatch(/<input[^>]*id="signin-password"/);
  });

  it('names the password visibility control and reports its state', () => {
    const toggle = render().match(/<button[^>]*data-testid="signin-password-toggle"[^>]*>/)![0];
    expect(toggle).toContain('aria-label="Show password"');
    expect(toggle).toContain('aria-pressed="false"');
    expect(toggle).toContain('aria-controls="signin-password"');
  });

  it('exposes the role toggle state, preselected from ?role=tenant', () => {
    const landlord = render();
    expect(landlord).toMatch(/aria-pressed="true"[^>]*data-testid="signin-toggle-landlord"|data-testid="signin-toggle-landlord"[^>]*aria-pressed="true"/);
    const tenant = render('/login?role=tenant');
    expect(tenant).toMatch(/data-testid="signin-toggle-tenant"[^>]*aria-pressed="true"/);
    expect(tenant).toContain('Enter your invite code');
  });
});
