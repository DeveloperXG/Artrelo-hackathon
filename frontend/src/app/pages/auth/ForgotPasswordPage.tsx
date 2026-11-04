import { useState } from 'react';
import { Loader2, MailCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AuthAPI } from '../../api/client';
import AstreloLogo from '../../components/AstreloLogo';
import { marketingUrl } from '../../lib/marketingUrl';

// Asking for a reset link.
//
// The API answers the same way whether or not the address has an account, and
// this page must not undo that. So there is exactly ONE outcome on screen: the
// confirmation panel. No "no account found", no differing copy, and — because a
// rate-limit refusal would otherwise be the tell — even a 429 lands on the same
// panel. The person who hit the cooldown already got an email a minute ago.
//
// The only visible failure is the network being unreachable, which says nothing
// about the address.

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSending(true);
    try {
      await AuthAPI.forgotPassword(email);
      setSent(true);
    } catch (err) {
      // A 4xx here is the limiter, not a verdict on the address — show the same
      // confirmation. Anything else is a genuine transport failure.
      const status = (err as { status?: number })?.status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        setSent(true);
      } else {
        setError("We couldn't reach the server. Check your connection and try again.");
      }
    } finally {
      setSending(false);
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

  if (sent) {
    return shell(
      <div data-testid="forgot-sent" className="text-center">
        <div className="flex justify-center mb-5">
          <MailCheck className="w-12 h-12 text-[#137fec]" />
        </div>
        <h1 className="text-2xl font-bold text-white mb-3">Check your email</h1>
        {/* Deliberately conditional-free. "If that address has an account" is the
            whole point — stating it outright is honest and leaks nothing. */}
        <p className="text-slate-400 text-base mb-2">
          If that address has an Artrelo account, a reset link is on its way.
        </p>
        <p className="text-slate-500 text-sm mb-8">
          The link works once and expires in 30 minutes. Check your spam folder if it
          doesn&apos;t arrive in a few minutes.
        </p>
        <Link
          to="/login"
          className="inline-block px-6 py-3 rounded-xl text-white font-bold shadow-lg shadow-[#137fec]/20 hover:brightness-110 transition-all"
          style={{ background: 'linear-gradient(135deg, #137fec 0%, #a855f7 100%)' }}
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  return shell(
    <>
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Reset your password</h1>
        <p className="text-slate-400 text-base">
          Enter your email and we&apos;ll send you a link to choose a new one.
        </p>
      </div>

      {error && (
        <div
          data-testid="forgot-error"
          className="bg-red-500/10 text-red-300 p-3 rounded-xl mb-4 text-sm border border-red-500/30"
        >
          {error}
        </div>
      )}

      <form className="space-y-5" onSubmit={onSubmit}>
        <div>
          <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">
            Email Address
          </label>
          <input
            data-testid="forgot-email"
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            className="w-full px-6 py-4 rounded-xl text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#137fec]/20 focus:border-[#137fec] border border-white/10 bg-white/[0.03] transition-all text-lg"
          />
        </div>

        <button
          data-testid="forgot-submit"
          disabled={sending}
          type="submit"
          className="w-full py-4 rounded-xl text-white font-bold text-lg shadow-lg shadow-[#137fec]/20 hover:brightness-110 hover:-translate-y-[1px] active:translate-y-0 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          style={{ background: 'linear-gradient(135deg, #137fec 0%, #a855f7 100%)' }}
        >
          {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
          Send reset link
        </button>
      </form>
    </>
  );
}
