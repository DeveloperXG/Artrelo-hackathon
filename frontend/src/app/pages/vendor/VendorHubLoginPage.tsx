import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, Loader2, Mail } from 'lucide-react';
import { VendorHubAPI } from '../../api/client';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

/**
 * Passwordless sign-in for the vendor hub.
 *
 * A contractor sourced from TaskRabbit or Thumbtack never signed up for
 * anything here. Asking them to invent a password for a portal they open twice
 * a month would simply not happen, so control of the email address is the
 * proof — the same thing every job link has always relied on.
 *
 * Serves two routes: the form, and the /enter/:token landing that exchanges a
 * magic link for a session cookie.
 */
export default function VendorHubLoginPage() {
  const { token } = useParams();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  // Magic-link landing: exchange, then go straight to the hub.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    (async () => {
      try {
        await VendorHubAPI.enter(token);
        if (!cancelled) navigate('/vendor-hub', { replace: true });
      } catch {
        if (!cancelled) {
          setError('That sign-in link has expired or was already used. Request a new one below.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, navigate]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError('');
    try {
      await VendorHubAPI.requestLink(email.trim());
      // Always shows the same confirmation, because the server always gives the
      // same answer. Reporting "no such vendor" would turn this form into a
      // directory of who works through Artrelo.
      setSent(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (token && !error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50">
        <Loader2 className="h-6 w-6 animate-spin text-[#137fec]" aria-hidden="true" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        {sent ? (
          <div className="text-center">
            <CheckCircle2 className="mx-auto h-9 w-9 text-emerald-600" aria-hidden="true" />
            <h1 className="mt-4 text-lg font-semibold text-slate-900">Check your email</h1>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              If that address is on file, we&rsquo;ve sent a sign-in link. It works once and
              expires in 15 minutes.
            </p>
            <Button
              variant="outline"
              className="mt-5 border-slate-200"
              onClick={() => {
                setSent(false);
                setEmail('');
              }}
            >
              Use a different address
            </Button>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-slate-900">Your Artrelo jobs</h1>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Sign in to see everything you&rsquo;re working on. No password needed.
            </p>

            {error ? (
              <p
                className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900"
                data-testid="hub-login-error"
              >
                {error}
              </p>
            ) : null}

            <form onSubmit={submit} className="mt-5">
              <label
                htmlFor="hub-email"
                className="text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                Email address
              </label>
              <Input
                id="hub-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="mt-1.5 border-slate-200 bg-white"
                data-testid="hub-login-email"
              />
              <Button
                type="submit"
                disabled={busy || !email.trim()}
                className="mt-4 w-full gap-2 bg-[#137fec] hover:bg-[#137fec]/90"
                data-testid="hub-login-submit"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Mail className="h-4 w-4" aria-hidden="true" />
                )}
                Email me a link
              </Button>
            </form>

            <p className="mt-5 text-xs leading-5 text-slate-400">
              The job links we email you still work as before — this is just the easier way in
              when you&rsquo;re juggling more than one.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
