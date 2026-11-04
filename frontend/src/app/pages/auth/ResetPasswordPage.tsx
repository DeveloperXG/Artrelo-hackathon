import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthAPI, ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { toast } from 'sonner';
import AstreloLogo from '../../components/AstreloLogo';
import { marketingUrl } from '../../lib/marketingUrl';

// Choosing the new password.
//
// Like the invite page, the token arrives in the fragment — `/login/reset#t=…` —
// so it is never sent to a server, cannot reach an access log or a Referer
// header, and is stripped from the address bar as soon as it is read. Read once,
// outside an effect, because StrictMode double-invokes effects in dev and the
// second pass would find the fragment already gone.
//
// There is no peek endpoint for a reset token, deliberately: one would be a free
// oracle for whether a token is live, and the page has nothing to show that the
// token could tell it. So this renders the form immediately and finds out on
// submit, which is also the only moment the answer matters.
//
// Completing a reset invalidates every session, including one open in this
// browser, so the local session is cleared before redirecting to sign-in.

function takeTokenFromHash(): string {
  if (typeof window === 'undefined') return '';
  const hash = window.location.hash.replace(/^#/, '');
  const token = new URLSearchParams(hash).get('t') || '';
  if (token) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
  return token;
}

export default function ResetPasswordPage() {
  const [token] = useState(takeTokenFromHash);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [dead, setDead] = useState(token ? '' : 'This link is missing its reset code. Use the link from your email.');

  const { logout } = useAuth();
  const navigate = useNavigate();

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    // Mirrors the server's rule so a predictable rejection costs no round trip —
    // and, more importantly, does not spend the one-shot link. The server
    // validates before consuming for the same reason, so this is convenience
    // rather than the guarantee.
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setSubmitting(true);
    try {
      const res = await AuthAPI.resetPassword({ token, password });
      const roles = ((res as { roles?: string[] }).roles || []) as string[];

      // Every session for this account is gone, including this browser's.
      // Clearing locally avoids a stored user that the next refresh would 401.
      logout();

      toast.success('Password updated. Please sign in.');
      // Tell the sign-in page which toggle to preselect when the account has
      // only one role. With both, it cannot know which they want.
      navigate(roles.length === 1 ? `/login?role=${roles[0]}` : '/login');
    } catch (err) {
      const payload = err instanceof ApiError ? (err.payload as { code?: string }) : null;
      const msg = err instanceof Error ? err.message : 'Could not reset your password';

      // The link is spent, expired or revoked. No form can succeed now.
      if (payload?.code === 'reset_invalid') {
        setDead(msg);
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
          Back to sign in
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

  if (dead) {
    return shell(
      <div data-testid="reset-invalid" className="text-center">
        <h1 className="text-2xl font-bold text-white mb-3">This link can&apos;t be used</h1>
        <p className="text-slate-400 text-base mb-8">{dead}</p>
        <Link
          to="/login/forgot"
          className="inline-block px-6 py-3 rounded-xl text-white font-bold shadow-lg shadow-[#137fec]/20 hover:brightness-110 transition-all"
          style={{ background: 'linear-gradient(135deg, #137fec 0%, #a855f7 100%)' }}
        >
          Request a new link
        </Link>
      </div>
    );
  }

  const inputClass =
    'w-full px-6 py-4 rounded-xl text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#137fec]/20 focus:border-[#137fec] border border-white/10 bg-white/[0.03] transition-all text-lg';
  const labelClass = 'block text-xs font-bold uppercase tracking-widest text-slate-500 mb-2';

  return shell(
    <>
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Choose a new password</h1>
        <p className="text-slate-400 text-base">
          You&apos;ll be signed out everywhere else and can sign in again with this password.
        </p>
      </div>

      {error && (
        <div
          data-testid="reset-error"
          className="bg-red-500/10 text-red-300 p-3 rounded-xl mb-4 text-sm border border-red-500/30"
        >
          {error}
        </div>
      )}

      <form className="space-y-5" onSubmit={onSubmit}>
        <div>
          <label className={labelClass}>New Password</label>
          <div className="relative">
            <input
              data-testid="reset-password"
              required
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
            >
              {showPassword ? <EyeOff className="w-6 h-6" /> : <Eye className="w-6 h-6" />}
            </button>
          </div>
          <p className="text-slate-600 text-xs mt-2">At least 8 characters.</p>
        </div>

        <div>
          <label className={labelClass}>Confirm New Password</label>
          <input
            data-testid="reset-confirm"
            required
            type={showPassword ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••"
            autoComplete="new-password"
            className={inputClass}
          />
        </div>

        <button
          data-testid="reset-submit"
          disabled={submitting}
          type="submit"
          className="w-full py-4 rounded-xl text-white font-bold text-lg shadow-lg shadow-[#137fec]/20 hover:brightness-110 hover:-translate-y-[1px] active:translate-y-0 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          style={{ background: 'linear-gradient(135deg, #137fec 0%, #a855f7 100%)' }}
        >
          {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
          Update password
        </button>
      </form>
    </>
  );
}
