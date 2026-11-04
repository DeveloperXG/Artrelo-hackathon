import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth, type AuthUser } from '../../auth/AuthContext';
import { Button } from '../ui/button';
import { judgeIdentity, useJudgeSandbox } from './JudgeSandboxProvider';
import type { JudgeView } from './judgeController';

/** Navigation intent only. Eligibility is read by the existing signed-in shell,
 * never inferred from login fields or persisted in browser storage. */
export function signedInHome(user: Pick<AuthUser, 'id' | 'accountId' | 'role'>) {
  return user.role === 'tenant'
    ? { pathname: '/portal', state: null }
    : { pathname: '/dashboard', state: { judgeEntryIdentity: judgeIdentity(user) } };
}

export function judgeEntryResolution(
  requestedIdentity: unknown, currentIdentity: string | null,
  view: JudgeView, hasController: boolean,
): 'ordinary' | 'checking' | 'unavailable' | 'guide' | 'overview' {
  // A late read cannot redirect a different identity or deliberate later visit.
  if (!currentIdentity || requestedIdentity !== currentIdentity) return 'ordinary';
  if (!hasController || !view.loaded) return 'checking';
  if (view.refreshFailed) return 'unavailable';
  return view.status.enabled && view.status.role === 'landlord' ? 'guide' : 'overview';
}

export function JudgeEntryStatus({ unavailable, onCheckAgain }: { unavailable: boolean; onCheckAgain: () => void }) {
  return <section className="lichen lichen-light min-w-0 rounded-lg border border-hairline bg-background p-4 font-sans text-ink sm:p-5" aria-label="Checking sign-in destination">
    <p role="status" className="text-sm text-meta">{unavailable ? 'Demo access could not be checked. Nothing was started.' : 'Checking your sign-in destination…'}</p>
    {unavailable ? <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button variant="outline" onClick={onCheckAgain}>Check access again</Button>
      <Link to="/dashboard" state={null} replace className="rounded-md text-sm font-medium text-lichen-text underline underline-offset-2">Go to Overview</Link>
    </div> : null}
  </section>;
}

/** Mounted only at the dashboard index, inside its existing identity-bound
 * provider. Consuming/replacing this one navigation does not redirect later
 * Overview visits, deep links or a switched/signed-out identity. */
export function JudgeEntryDestination({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { state } = useLocation();
  const { view, controller } = useJudgeSandbox();
  const result = judgeEntryResolution(state?.judgeEntryIdentity, judgeIdentity(user), view, !!controller);
  if (result === 'ordinary') return children;
  if (result === 'guide') return <Navigate to="/dashboard/guided-demo" replace state={null} />;
  if (result === 'overview') return <Navigate to="/dashboard" replace state={null} />;
  return <JudgeEntryStatus unavailable={result === 'unavailable'} onCheckAgain={() => void controller?.checkAgain()} />;
}
