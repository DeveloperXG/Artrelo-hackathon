import { Navigate, Link } from 'react-router-dom';
import PageHeader from '../../components/landlord/PageHeader';
import { JudgeRunCard } from '../../components/judge/JudgeViews';
import { useJudgeSandbox } from '../../components/judge/JudgeSandboxProvider';
import type { JudgeView } from '../../components/judge/judgeController';
import { Button } from '../../components/ui/button';

/** Auth is enforced by the parent route; eligibility comes only from the server. */
export function guidedDemoAccess(view: JudgeView): 'loading' | 'allowed' | 'denied' | 'unavailable' {
  if (!view.loaded) return 'loading';
  if (view.refreshFailed && !view.status.enabled) return 'unavailable';
  return view.status.enabled && view.status.role === 'landlord' ? 'allowed' : 'denied';
}

export function GuidedDemoInstructions() {
  return (
    <section className="min-w-0 rounded-lg border border-hairline bg-background p-4 sm:p-5" aria-labelledby="demo-pair-title">
      <h2 id="demo-pair-title" className="text-base font-semibold">Use your paired accounts</h2>
      <ol className="mt-4 list-decimal space-y-4 pl-5 text-sm text-meta marker:font-mono marker:text-ink">
        <li>Keep the landlord and the paired tenant in separate signed-in browser profiles. Check that both banners show the same pair.</li>
        <li>Review <Link to="/dashboard/policy" className="rounded-md font-medium text-lichen-text underline underline-offset-2">Policy</Link>. If this pair has no run, choose Start guided run here deliberately. If a run already exists, follow its current step; do not start again, reset or reseed.</li>
        <li>Follow the current step. Use the tenant profile for tenant actions and the landlord profile for Decisions. Approvals, access consent and completion stay on their ordinary pages.</li>
        <li>Use Return to demo to come back. The tenant link appears only after this pair has a server-confirmed start and stays within the tenant portal. Progress survives navigation and reload; Pause and Resume appear only when available and never run automatically.</li>
      </ol>
      <p className="mt-4 rounded-md bg-well p-3 text-sm text-meta">Vendors and work reports are simulated. No physical repair, real message, money transfer or bank receipt is established by this demo.</p>
    </section>
  );
}

export default function GuidedDemoPage() {
  const { view, controller } = useJudgeSandbox();
  // Before the provider creates its identity-bound controller, do not interpret
  // the hook's off fallback as a completed eligibility read.
  if (!controller || guidedDemoAccess(view) === 'loading') {
    return <p role="status" className="text-sm text-meta">Checking demo access…</p>;
  }
  if (guidedDemoAccess(view) === 'denied') return <Navigate to="/dashboard" replace />;
  if (guidedDemoAccess(view) === 'unavailable') return <div className="text-sm text-meta"><p role="status">Demo access could not be checked. Nothing was started.</p><Button variant="outline" className="mt-3" onClick={() => void controller.checkAgain()}>Check access again</Button></div>;
  return (
    <div className="min-w-0" data-testid="guided-demo-page">
      <PageHeader title="Guided demo" description="Follow one maintenance request with your paired tenant account." />
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-2">
        <div className="min-w-0"><JudgeRunCard /></div>
        <GuidedDemoInstructions />
      </div>
    </div>
  );
}
