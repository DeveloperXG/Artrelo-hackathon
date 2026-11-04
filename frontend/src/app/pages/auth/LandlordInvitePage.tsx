import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { AuthAPI, ApiError } from '../../api/client';
import AstreloLogo from '../../components/AstreloLogo';
import { marketingUrl } from '../../lib/marketingUrl';

// Accepting a beta landlord invite.
//
// Public landlord sign-up is shut, so this page is the only way in. It lives
// under /login* on purpose: the production proxy already routes that prefix to
// the SPA, so this needs no Caddy change, and it is gated on SIGN_IN_ENABLED
// rather than REGISTRATION_ENABLED — an invite is not public sign-up, and
// gating it on the registration flag would close the one door we just opened.
//
// THE TOKEN LIVES IN THE FRAGMENT. `/login/invite#t=<token>` — after the `#`,
// so the browser never sends it to a server: it cannot appear in an access log,
// a Referer header, or an analytics payload. We read it once, then strip it from
// the address bar so it is not sitting in history or on screen over someone's
// shoulder. From then on it exists only in component state.

type InviteInfo = {
  email: string;
  firstName: string | null;
  lastName: string | null;
  accountExists: boolean;
  alreadyLandlord: boolean;
  // Length of the free beta, counted from the day they join.
  betaDays: number;
  termsVersion: string;
};

// Read `#t=…` and remove it from the URL.
//
// Done once, before the first render that matters, because React StrictMode
// runs effects twice in dev — the second pass would find the fragment already
// gone and conclude there was no token at all.
function takeTokenFromHash(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.replace(/^#/, '');
  const token = new URLSearchParams(hash).get('t') || '';
  if (token) {
    // replaceState, not a navigation: it must not add a history entry that
    // still holds the token.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
  return token;
}

export default function LandlordInvitePage() {
  const [token] = useState(takeTokenFromHash);
  const [checking, setChecking] = useState(true);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [invalid, setInvalid] = useState('');

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    password: '',
    confirmPassword: '',
    companyName: '',
    phone: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  // Must be ticked by the person. The server refuses anything but `true`, and
  // does so before spending the invite, so forgetting it costs nothing.
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const { setSession } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    if (!token) {
      setInvalid('This link is missing its invite code. Use the link from your invitation email.');
      setChecking(false);
      return;
    }

    // Peek, which deliberately does not spend the invite — see
    // backend/services/auth/accountToken.service.js. Opening the link twice, or
    // a mail scanner prefetching the page, must not destroy it.
    AuthAPI.invitePeek(token)
      .then((res) => {
        if (cancelled) return;
        setInvite(res as InviteInfo);
        setForm((f) => ({
          ...f,
          firstName: (res as InviteInfo).firstName || '',
          lastName: (res as InviteInfo).lastName || '',
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        setInvalid(
          err instanceof Error
            ? err.message
            : 'This invite link is no longer valid. Ask for a new one.'
        );
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const onChange = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invite) return;
    setError('');

    if (!termsAccepted) {
      setError('Please accept the Terms to continue');
      return;
    }

    // Mirrors the server's check (utils/phone.toE164): a number with its area
    // code, or one that starts with + and a country code. The server decides.
    const phoneDigits = form.phone.replace(/\D/g, '');
    if (form.phone.trim().startsWith('+') ? phoneDigits.length < 8 : phoneDigits.length < 10) {
      setError('Enter a phone number we can call you on for emergencies, with its area code.');
      return;
    }

    // Only meaningful for a NEW account. When the address already has one, the
    // field is that account's existing password and these rules are not ours to
    // impose — the server checks it against the stored hash.
    if (!invite.accountExists) {
      if (form.password !== form.confirmPassword) {
        setError('Passwords do not match');
        return;
      }
      if (form.password.length < 8) {
        setError('Password must be at least 8 characters');
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await AuthAPI.inviteAccept({
        token,
        password: form.password,
        firstName: form.firstName,
        lastName: form.lastName,
        companyName: form.companyName || undefined,
        phone: form.phone.trim(),
        termsAccepted: true,
      });
      const user = (res as { user?: Record<string, unknown>; token?: string }).user;
      const accessToken = (res as { token?: string }).token;
      if (!user || !accessToken) throw new Error('Missing session in response');

      setSession(
        {
          id: String(user.id ?? ''),
          email: String(user.email ?? ''),
          firstName: (user.firstName as string) ?? '',
          lastName: (user.lastName as string) ?? '',
          role: 'landlord',
          ...(user.companyName ? { companyName: String(user.companyName) } : {}),
        },
        accessToken
      );
      navigate('/dashboard');
    } catch (err) {
      const payload = err instanceof ApiError ? (err.payload as { code?: string }) : null;
      const msg = err instanceof Error ? err.message : 'Could not accept the invite';

      // The invite itself has gone — spent, expired or revoked. The form cannot
      // succeed any more, so stop showing one.
      if (payload?.code === 'invite_invalid') {
        setInvalid(msg);
        return;
      }
      // Already a landlord: they do not need this page, they need to sign in.
      if (payload?.code === 'profile_exists') {
        setInvalid(msg);
        return;
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="bg-[#0a0f14] text-slate-100 min-h-screen flex flex-col font-sans relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(circle at center, rgba(19, 127, 236, 0.12) 0%, rgba(168, 85, 247, 0.08) 35%, transparent 70%)',
        }}
      />
      <header className="px-8 py-6 flex justify-between items-center relative z-10 w-full shrink-0">
        <a href={marketingUrl('/')} className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <AstreloLogo className="w-8 h-8" />
          <span className="text-white text-xl font-bold tracking-tight">Artrelo</span>
        </a>
        <Link to="/login" className="text-slate-400 text-sm hover:text-white transition-colors">
          Already have an account? Sign in
        </Link>
      </header>
      <main className="flex-grow flex items-center justify-center px-6 relative z-10 w-full overflow-y-auto">
        <div className="w-full max-w-lg py-12">
          <div
            className="p-10 md:p-14 rounded-[2rem] shadow-2xl backdrop-blur-xl border border-white/10"
            style={{ background: 'rgba(18, 24, 31, 0.8)' }}
          >
            {children}
          </div>
        </div>
      </main>
    </div>
  );

  if (checking) {
    return shell(
      <div data-testid="invite-loading" className="flex flex-col items-center gap-4 py-8">
        <Loader2 className="w-8 h-8 animate-spin text-[#137fec]" />
        <p className="text-slate-400 text-sm">Checking your invitation…</p>
      </div>
    );
  }

  if (invalid || !invite) {
    return shell(
      <div data-testid="invite-invalid" className="text-center">
        <h1 className="text-2xl font-bold text-white mb-3">This invite can&apos;t be used</h1>
        <p className="text-slate-400 text-base mb-8">{invalid}</p>
        <Link
          to="/login"
          className="inline-block px-6 py-3 rounded-xl text-white font-bold shadow-lg shadow-[#137fec]/20 hover:brightness-110 transition-all"
          style={{ background: 'linear-gradient(135deg, #137fec 0%, #a855f7 100%)' }}
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  // The address already has an account, so this form ADDS landlord access to it
  // rather than creating anything. Different copy, one password field, and no
  // strength rules of ours — it is a password they already chose.
  const adding = invite.accountExists;

  const inputClass =
    'w-full px-5 py-3.5 rounded-xl text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#137fec]/20 focus:border-[#137fec] border border-white/10 bg-white/[0.03] transition-all';
  const labelClass = 'block text-xs font-bold uppercase tracking-widest text-slate-500 mb-2';

  return shell(
    <>
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">
          {adding ? 'Add landlord access' : "You're invited"}
        </h1>
        <p className="text-slate-400 text-base">
          {adding
            ? 'Confirm your password and we’ll add landlord access to your existing account.'
            : 'Set up your Artrelo landlord account.'}
        </p>
      </div>

      {/* Locked, and not merely disabled for looks: the SERVER takes the address
          from the invite and ignores anything sent in the body, so editing this
          could not change the outcome. Shown because the person needs to know
          which address they are accepting for. */}
      <div className="mb-6">
        <label className={labelClass}>Email Address</label>
        <input
          data-testid="invite-email"
          type="email"
          value={invite.email}
          readOnly
          aria-readonly="true"
          className={`${inputClass} opacity-60 cursor-not-allowed`}
        />
        <p className="text-slate-600 text-xs mt-2">This invite is tied to this address.</p>
      </div>

      {/* What they are agreeing to be part of. No calendar date: the clock starts
          the day they JOIN, which is when this form is submitted. */}
      <div
        data-testid="invite-beta-note"
        className="mb-6 rounded-xl border border-[#137fec]/30 bg-[#137fec]/10 p-4 text-sm text-slate-200"
      >
        <p className="font-semibold text-white">Free during the beta</p>
        <p className="text-slate-300 mt-1">
          Artrelo is free for {invite.betaDays} days from the day you join. We&apos;ll remind you
          before it ends, and nothing is billed without your say.
        </p>
      </div>

      {error && (
        <div
          data-testid="invite-error"
          className="bg-red-500/10 text-red-300 p-3 rounded-xl mb-4 text-sm border border-red-500/30"
        >
          {error}
        </div>
      )}

      <form className="space-y-5" onSubmit={onSubmit}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>First Name</label>
            <input
              data-testid="invite-first-name"
              required
              value={form.firstName}
              onChange={(e) => onChange('firstName', e.target.value)}
              placeholder="Dana"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Last Name</label>
            <input
              data-testid="invite-last-name"
              required
              value={form.lastName}
              onChange={(e) => onChange('lastName', e.target.value)}
              placeholder="Okafor"
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>{adding ? 'Your existing password' : 'Password'}</label>
          <div className="relative">
            <input
              data-testid="invite-password"
              required
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(e) => onChange('password', e.target.value)}
              placeholder="••••••••"
              autoComplete={adding ? 'current-password' : 'new-password'}
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
            >
              {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>
          {adding && (
            <p className="text-slate-600 text-xs mt-2">
              The password you already use for Artrelo. We won&apos;t change it.{' '}
              {/* The dead end this removes: an invited person who has an old
                  account and cannot recall its password had no way forward, and
                  the invite is the only route to a landlord account. Resetting
                  does not consume the invite, so they can come back to it. */}
              <Link to="/login/forgot" className="text-[#137fec] hover:underline">
                Forgot it?
              </Link>
            </p>
          )}
        </div>

        {!adding && (
          <div>
            <label className={labelClass}>Confirm Password</label>
            <input
              data-testid="invite-confirm-password"
              required
              type={showPassword ? 'text' : 'password'}
              value={form.confirmPassword}
              onChange={(e) => onChange('confirmPassword', e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              className={inputClass}
            />
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Company (optional)</label>
            <input
              data-testid="invite-company"
              value={form.companyName}
              onChange={(e) => onChange('companyName', e.target.value)}
              placeholder="Okafor Property"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Phone</label>
            <input
              data-testid="invite-phone"
              type="tel"
              autoComplete="tel"
              required
              value={form.phone}
              onChange={(e) => onChange('phone', e.target.value)}
              placeholder="306 555 0100"
              className={inputClass}
            />
            {/* Why it's asked for, at the moment it's asked. */}
            <p className="mt-1 text-xs text-slate-500">We call this number when a tenant reports an emergency.</p>
          </div>
        </div>

        <label className="flex items-start gap-3 text-sm text-slate-400 cursor-pointer">
          <input
            data-testid="invite-terms"
            type="checkbox"
            checked={termsAccepted}
            onChange={(e) => setTermsAccepted(e.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-[#137fec]"
          />
          <span>
            I agree to the{' '}
            <a
              href={marketingUrl('/terms')}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#137fec] hover:underline"
            >
              Terms
            </a>{' '}
            and{' '}
            <a
              href={marketingUrl('/privacy')}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#137fec] hover:underline"
            >
              Privacy Policy
            </a>
            .
          </span>
        </label>

        <button
          data-testid="invite-submit"
          disabled={submitting}
          type="submit"
          className="w-full py-4 rounded-xl text-white font-bold text-lg shadow-lg shadow-[#137fec]/20 hover:brightness-110 hover:-translate-y-[1px] active:translate-y-0 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          style={{ background: 'linear-gradient(135deg, #137fec 0%, #a855f7 100%)' }}
        >
          {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
          {adding ? 'Add landlord access' : 'Create my account'}
        </button>
      </form>
    </>
  );
}
