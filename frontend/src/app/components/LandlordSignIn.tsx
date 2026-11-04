import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import AstreloLogo from './AstreloLogo';
import { marketingUrl } from '../lib/marketingUrl';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { signedInHome } from './judge/JudgeEntryDestination';

export default function LandlordSignIn() {
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // ?role=tenant preselects the toggle. Set by /login/reset when the account has
  // exactly one role, so somebody who just reset their password does not then
  // have to guess which side of a toggle they belong on.
  const [searchParams] = useSearchParams();
  const [tenantMode, setTenantMode] = useState(searchParams.get('role') === 'tenant');
  const { loginLandlord, loginTenant } = useAuth();
  const navigate = useNavigate();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const user = tenantMode
        ? await loginTenant(email, password)
        : await loginLandlord(email, password);
      const destination = signedInHome(user);
      navigate(destination.pathname, { state: destination.state });
    } catch (err) {
      // The password was right, but for the other role. The API only says this
      // once the password checks out, so it tells the account holder something
      // they already know and nobody else anything. Move the toggle for them
      // rather than leaving them to guess why a correct password "failed".
      const payload = err instanceof ApiError ? (err.payload as { code?: string; role?: string }) : null;
      if (payload?.code === 'wrong_role') {
        setTenantMode(payload.role === 'tenant');
        setError(`${err instanceof Error ? err.message : ''} Try again — we've switched the toggle for you.`.trim());
        setLoading(false);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Login failed';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // Tied to the fields so a screen reader reads the failure with them, and
  // role="alert" announces it the moment it appears.
  const errorId = error ? 'signin-error' : undefined;

  return (
    // Migrated to Lichen (D2): the whole screen is the dark scope. Flat ground,
    // no glow or gradient; depth comes from the surface card and its border.
    <div className="lichen relative flex min-h-screen flex-col bg-background font-sans text-foreground">
      <header className="flex w-full shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-5 sm:px-8 sm:py-6">
        {/* Full navigation to the marketing home (separate app served at "/"). */}
        <a href={marketingUrl('/')} className="flex items-center gap-2 rounded-md">
          <AstreloLogo className="h-8 w-8" />
          <span className="text-xl font-bold tracking-[-0.025em] text-ink">Artrelo</span>
        </a>
        <div className="text-sm">
          <span className="text-meta">New to Artrelo?</span>
          <Link to="/landlord-signup" className="ml-2 rounded-sm font-semibold text-lichen-text hover:underline">
            Create account
          </Link>
        </div>
      </header>

      <main className="flex w-full flex-grow items-center justify-center px-4 sm:px-6">
        <div className="w-full max-w-md py-8 sm:py-12">
          <div className="rounded-lg border border-border bg-card p-6 sm:p-10">
            <div className="mb-8 text-center">
              <h1 className="mb-2 text-3xl font-bold tracking-[-0.02em] text-ink">Sign in</h1>
              <p className="text-base text-meta">
                {tenantMode ? 'Welcome back, tenant.' : 'Welcome back to Artrelo.'}
              </p>
            </div>

            {/* Segmented role toggle: aria-pressed carries the state that the
                Lichen fill shows, so it is not conveyed by colour alone. */}
            <div role="group" aria-label="Sign in as" className="mb-6 flex rounded-md border border-border bg-well p-1">
              {[
                { tenant: false, label: 'Landlord', testId: 'signin-toggle-landlord' },
                { tenant: true, label: 'Tenant', testId: 'signin-toggle-tenant' },
              ].map((option) => {
                const selected = tenantMode === option.tenant;
                return (
                  <button
                    key={option.testId}
                    data-testid={option.testId}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setTenantMode(option.tenant)}
                    className={`flex-1 rounded-[4px] py-2 text-sm font-semibold transition-colors motion-reduce:transition-none ${
                      selected
                        ? 'bg-lichen text-on-lichen forced-colors:border-2 forced-colors:border-[Highlight]'
                        : 'text-meta hover:text-ink'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>

            {error && (
              <div
                id="signin-error"
                role="alert"
                data-testid="signin-error"
                className="mb-4 rounded-md border border-alert-line bg-alert-tint p-3 text-sm text-alert"
              >
                {error}
              </div>
            )}

            <form className="space-y-5" onSubmit={onSubmit}>
              <div>
                <label htmlFor="signin-email" className="mb-2 block text-xs font-semibold uppercase tracking-widest text-meta">
                  Email address
                </label>
                <Input
                  id="signin-email"
                  data-testid="signin-email-input"
                  required
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={errorId}
                  className="h-12 px-4 text-base"
                />
              </div>

              <div>
                <label htmlFor="signin-password" className="mb-2 block text-xs font-semibold uppercase tracking-widest text-meta">
                  Password
                </label>
                <div className="relative">
                  <Input
                    id="signin-password"
                    data-testid="signin-password-input"
                    required
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={errorId}
                    className="h-12 pl-4 pr-14 text-base"
                  />
                  <button
                    type="button"
                    data-testid="signin-password-toggle"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    aria-controls="signin-password"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-1.5 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-meta transition-colors hover:text-ink motion-reduce:transition-none"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" aria-hidden /> : <Eye className="h-5 w-5" aria-hidden />}
                  </button>
                </div>
              </div>

              <div className="-mt-2 text-right">
                <Link to="/login/forgot" className="rounded-sm text-sm text-meta hover:text-ink hover:underline">
                  Forgot password?
                </Link>
              </div>

              <Button
                data-testid="signin-submit-btn"
                disabled={loading}
                type="submit"
                className="h-12 w-full text-base font-semibold"
              >
                {loading ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                Sign in
              </Button>

              {tenantMode && (
                <p className="text-center text-sm text-meta">
                  Don&apos;t have an account yet?{' '}
                  <Link to="/signup" className="rounded-sm text-lichen-text hover:underline">
                    Enter your invite code
                  </Link>
                </p>
              )}
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
