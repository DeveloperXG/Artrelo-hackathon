import { ArrowRight, FlaskConical, Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '../ui/button';
import type { JudgeAction } from '../../contracts/judgeSandbox';
import type { JudgeView } from './judgeController';
import {
  ACTION_LABEL,
  BUSY_LABEL,
  STATE_LABEL,
  UNKNOWN_OUTCOME,
  checkpointLink,
  errorCopy,
} from './judgeCopy';
import { useJudgeSandbox } from './JudgeSandboxProvider';
import { GuidedDemoStepInstructions, recordedScopeReviewBlocker, recordedVendorFollowupHold } from './GuidedDemoStepInstructions';
import { DemoScenarioNotice } from './JudgeDemoScenario';

// The persistent role-specific banner and the dedicated landlord demo guide.
// Presentational views take the controller's view so they render the
// same in tests; the connected wrappers below read the provider.

const ACTION_ORDER: JudgeAction[] = ['continue', 'pause', 'resume'];

export const GUIDED_DEMO_HREF = '/dashboard/guided-demo';

// Own scope also keeps the banner readable on unmigrated pages.
const SCOPE = 'lichen lichen-light font-sans text-ink';

/** Completion copy comes only from a current successful server status, never progress. */
function freshCompletedRun(view: JudgeView): boolean {
  return view.loaded && view.status.enabled && Boolean(view.status.role) &&
    view.status.run?.state === 'completed' && !view.status.run.error &&
    !view.refreshFailed && !view.pollExpired && !view.polling && !view.busy && !view.notice;
}

export function judgeReturnHref(view: JudgeView): string | null {
  const { status } = view;
  if (!view.loaded || !status.enabled || !status.role) return null;
  if (status.role === 'landlord') return GUIDED_DEMO_HREF;
  const run = status.run;
  // The server creates a pair-owned Run only on deliberate landlord Start.
  // Legacy startedAt may be null: existence is the approved minimal gate,
  // never a guessed timestamp or proof of the page where Start happened.
  if (view.refreshFailed || !run) return null;
  if (run.error?.code === 'unsupported_scenario') return run.requestId ? `/portal/requests/${encodeURIComponent(run.requestId)}` : '/portal';
  const next = run ? checkpointLink(run.checkpoint, 'tenant') : null;
  return next?.href || (run?.requestId ? `/portal/requests/${run.requestId}` : '/portal');
}

export function JudgeBannerView({ view, nextStepReady = false }: { view: JudgeView; nextStepReady?: boolean }) {
  const { status } = view;
  if (!view.loaded || !status.enabled || !status.role) return null;
  const run = status.run;
  const returnHref = judgeReturnHref(view);
  const unsupported = run?.error?.code === 'unsupported_scenario';
  const tenantStep =
    status.role === 'tenant' && !unsupported && run && run.state === 'waiting_on_tenant' ? checkpointLink(run.checkpoint, 'tenant') : null;
  return (
    <div
      className={`${SCOPE} mb-4 rounded-lg border border-hairline bg-background px-4 py-2.5 text-sm`}
      data-testid="judge-banner"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <FlaskConical className="h-4 w-4 shrink-0 text-meta" aria-hidden="true" />
        <span className="font-semibold">{status.pairLabel || 'Judge sandbox'}</span>
        <span className="text-meta">
          Judge sandbox · vendors are simulated · no real messages or money
        </span>
      </p>
      {status.role === 'tenant' ? <DemoScenarioNotice /> : null}
      {unsupported ? <p role="status" className="mt-2 text-sm">{errorCopy('unsupported_scenario', null, null)} <Link className="underline underline-offset-2" to={run?.requestId ? `${status.role === 'tenant' ? '/portal' : '/dashboard'}/requests/${encodeURIComponent(run.requestId)}` : status.role === 'tenant' ? '/portal' : '/dashboard/requests'}>View ordinary request records</Link></p> : null}
      {returnHref ? <Link
        to={returnHref}
        className={`mt-2 inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-lichen-text underline underline-offset-2${status.role === 'landlord' ? ' max-w-full flex-wrap' : ''}`}
        data-testid="judge-return-demo"
      >
        {freshCompletedRun(view) ? 'Guided demo complete' : 'Return to demo'}
        <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {nextStepReady && status.role === 'landlord' && run && run.state !== 'completed' && run.state !== 'failed' && run.state !== 'running' && run.state !== 'paused' &&
          !run.error && !view.refreshFailed && !view.pollExpired && !view.busy && !view.notice ? (
          <span className="ml-2 inline-flex items-center gap-2 text-ink" data-testid="judge-next-step-ready">
            <span className="h-2 w-2 shrink-0 rounded-full bg-lichen" aria-hidden="true" />
            Next step ready
          </span>
        ) : null}
      </Link> : null}
      {status.role === 'tenant' && !run && !view.refreshFailed ? <div className="mt-3 text-sm" data-testid="judge-tenant-not-started">
        <h2 className="font-semibold">Demo not started</h2>
        <p className="mt-1 text-meta [overflow-wrap:anywhere]">In a separate browser profile, sign into this same pair’s landlord account. Open Guided demo and choose Start guided run, then return to this tenant profile. Compare the pair labels before continuing.</p>
      </div> : null}
      {status.role === 'tenant' && view.refreshFailed ? <p role="status" className="mt-2 text-sm text-meta">The current demo status could not be checked. No tenant return link is available until a fresh server read.</p> : null}
      {tenantStep ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="judge-tenant-prompt">
          <span>{tenantStep.text}</span>
          {tenantStep.href ? (
            <Link
              to={tenantStep.href}
              className="inline-flex items-center gap-1 rounded-sm font-medium text-lichen-text underline-offset-2 hover:underline"
            >
              {tenantStep.label}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export interface RunCardHandlers {
  onStart: () => void;
  onAction: (action: JudgeAction) => void;
  onCheckAgain: () => void;
}

export function JudgeRunCardView({ view, onStart, onAction, onCheckAgain }: { view: JudgeView } & RunCardHandlers) {
  const { status, busy, notice, polling, pollExpired, refreshFailed } = view;
  if (!status.enabled || status.role !== 'landlord') return null;
  const run = status.run;
  const complete = freshCompletedRun(view);
  const unsupported = run?.error?.code === 'unsupported_scenario' || (notice?.kind === 'error' && notice.code === 'unsupported_scenario');
  const link = run && !unsupported ? checkpointLink(run.checkpoint, 'landlord') : null;
  const actions = run && !unsupported ? ACTION_ORDER.filter((a) => run.allowedActions.includes(a)) : [];
  const noticeText = notice
    ? notice.kind === 'unknown' || notice.code === 'action_unknown'
      ? UNKNOWN_OUTCOME
      : errorCopy(notice.code, notice.nextAvailableAt, notice.retryAfterSeconds)
    : null;
  const runError = run?.error ? errorCopy(run.error.code, run.error.nextAvailableAt, run.error.retryAfterSeconds) : null;

  return (
    <section
      className={`${SCOPE} mb-6 rounded-lg border border-hairline bg-background p-4 sm:p-5`}
      aria-labelledby="judge-run-title"
      data-testid="judge-run-card"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="judge-run-title" className="text-base font-semibold">
          {complete ? 'Guided demo complete' : 'Guided run'}
        </h2>
        <span className="text-xs text-meta">{status.pairLabel}</span>
      </div>

      {!run ? (
        <>
          <DemoScenarioNotice />
          <p className="mt-2 text-sm text-meta">
            Review your Policy before starting. The paired tenant then submits a request from their separate
            signed-in profile. Every step that needs a person stops on its own page.
          </p>
          {!unsupported ? <div className="mt-4">
            <Button onClick={onStart} disabled={busy !== null} aria-busy={busy === 'start'} data-testid="judge-start">
              {busy === 'start' ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
              {busy === 'start' ? BUSY_LABEL.start : 'Start guided run'}
            </Button>
          </div> : <Link to="/dashboard/requests" className="mt-2 inline-flex min-h-11 items-center underline underline-offset-2">View ordinary request records</Link>}
        </>
      ) : (
        <>
          <div className="mt-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-meta">
              <span data-testid="judge-step-position">
                Step {run.step.index} of {run.step.total}
              </span>
              <span className="font-medium text-ink" data-testid="judge-state">
                {run.state === 'completed' && !complete ? `Last loaded: ${STATE_LABEL[run.state]}` : STATE_LABEL[run.state]}
              </span>
            </div>
            <div
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-chip"
              role="progressbar"
              aria-label="Guided run progress"
              aria-valuemin={1}
              aria-valuemax={run.step.total}
              aria-valuenow={run.step.index}
              aria-valuetext={`Step ${run.step.index} of ${run.step.total}`}
            >
              <div className="h-full rounded-full bg-lichen" style={{ width: `${(run.step.index / run.step.total) * 100}%` }} />
            </div>
            <p className="mt-2 text-xs text-meta" data-testid="judge-checkpoint-count-note">Recorded checkpoints include simulated vendor actions.</p>
          </div>

          <h3 className="mt-4 text-sm font-semibold [overflow-wrap:anywhere]" data-testid="judge-step-title">
            {run.step.title}
          </h3>
          {run.step.detail && !recordedScopeReviewBlocker(run) && !recordedVendorFollowupHold(run) ? (
            <p className="mt-1 text-sm text-meta [overflow-wrap:anywhere]">{run.step.detail}</p>
          ) : null}
          {run.state !== 'completed' && !unsupported ? <GuidedDemoStepInstructions run={run} uncertain={refreshFailed || notice?.kind === 'unknown'} /> : null}
          {unsupported ? <div role="status" className="mt-3 text-sm" data-testid="judge-unsupported-scenario">
            <p>{errorCopy('unsupported_scenario', null, null)}</p>
            <Link className="mt-2 inline-flex min-h-11 items-center rounded-md text-lichen-text underline underline-offset-2" to={run.requestId ? `/dashboard/requests/${encodeURIComponent(run.requestId)}` : '/dashboard/requests'}>View ordinary request records</Link>
          </div> : null}

          {link ? (
            <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="judge-checkpoint">
              <span>{link.text}</span>
              {link.href ? (
                <Link
                  to={link.href}
                  className="inline-flex items-center gap-1 rounded-sm font-medium text-lichen-text underline-offset-2 hover:underline"
                >
                  {link.label}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              ) : null}
            </p>
          ) : null}

          {runError ? (
            <p className="mt-3 rounded-md border border-hairline bg-alert-tint px-3 py-2 text-sm text-alert-text" data-testid="judge-run-error">
              {runError}
            </p>
          ) : null}

          {complete ? (
            <div className="mt-3 text-sm">
              <p className="text-meta">The server marks this run complete. Available request and review records remain available; missing records are not inferred.</p>
              <p className="mt-2 text-meta">Completion does not certify physical repair, payment, bank receipt or model use. Guide acknowledgement alone does not verify an Ask Iris change or its saved receipt.</p>
              {run.requestId ? (
                <Link
                  to={`/dashboard/requests/${encodeURIComponent(run.requestId)}`}
                  className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-md font-medium text-lichen-text underline underline-offset-2"
                  data-testid="judge-completed-request"
                >
                  View completed request
                  <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                </Link>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                {run.requestId ? <Link to={`/dashboard/requests/${encodeURIComponent(run.requestId)}?tab=activity`} className="inline-flex min-h-11 items-center rounded-md font-medium text-lichen-text underline underline-offset-2">Review request Activity</Link> : null}
                <Link to="/dashboard/policy" className="inline-flex min-h-11 items-center rounded-md font-medium text-lichen-text underline underline-offset-2">Review saved Policy</Link>
              </div>
            </div>
          ) : run.state === 'completed' ? <p role="status" className="mt-3 text-sm text-meta">Completion needs a fresh status check. Last loaded records may be out of date.</p> : null}

          {actions.length ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {actions.map((action) => (
                <Button
                  key={action}
                  variant={action === 'continue' ? 'default' : 'outline'}
                  onClick={() => onAction(action)}
                  disabled={busy !== null}
                  aria-busy={busy === action}
                  data-testid={`judge-${action}`}
                >
                  {busy === action ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                  {busy === action ? BUSY_LABEL[action] : ACTION_LABEL[action]}
                </Button>
              ))}
            </div>
          ) : null}
        </>
      )}

      {noticeText ? (
        <p role="alert" className="mt-3 text-sm text-alert-text" data-testid="judge-notice">
          {noticeText}
        </p>
      ) : null}

      <div role="status" aria-live="polite" className="mt-3 text-xs text-meta empty:hidden" data-testid="judge-live">
        {busy ? BUSY_LABEL[busy] : polling ? 'Checking for updates…' : run?.state === 'completed' && !complete ? 'Completion needs a fresh status check.' : run ? `Step ${run.step.index} of ${run.step.total}. ${STATE_LABEL[run.state]}. ${run.step.title}` : ''}
      </div>

      {!unsupported && (pollExpired || refreshFailed) ? (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-meta" data-testid="judge-check-again">
          <span>{refreshFailed ? 'Could not refresh the run.' : 'Still working.'}</span>
          <Button variant="outline" size="sm" onClick={onCheckAgain} disabled={busy !== null}>
            Check again
          </Button>
        </p>
      ) : null}
    </section>
  );
}

export function JudgeOverviewCardView({ view }: { view: JudgeView }) {
  if (!view.status.enabled || view.status.role !== 'landlord') return null;
  const run = view.status.run;
  const complete = freshCompletedRun(view);
  const uncertain = !view.loaded || view.refreshFailed || view.pollExpired || view.polling || Boolean(view.busy) || Boolean(view.notice) || Boolean(run?.error);
  return (
    <section className={`${SCOPE} mb-6 flex min-w-0 flex-wrap items-center justify-between gap-4 rounded-lg border border-hairline bg-background p-4`} aria-label="Guided demo" data-testid="judge-overview-card">
      <div className="min-w-0 flex-1 basis-48">
        <h2 className="text-base font-semibold">{complete ? 'Guided demo complete' : 'Guided demo'}</h2>
        <p className="mt-1 text-sm text-meta [overflow-wrap:anywhere]">
          {uncertain ? 'The current demo status needs a fresh check.' : run ? `Step ${run.step.index} of ${run.step.total} · ${STATE_LABEL[run.state]}` : 'Explore the sandbox with your paired tenant account.'}
        </p>
      </div>
      <Link to={GUIDED_DEMO_HREF} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-lichen px-3 py-2 text-sm font-semibold text-on-lichen hover:bg-lichen/90">
        {complete ? 'Review demo' : run ? 'Continue demo' : 'Start demo'}
        <ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
      </Link>
    </section>
  );
}

export function JudgeOverviewCard() {
  return <JudgeOverviewCardView view={useJudgeSandbox().view} />;
}

export function JudgeBanner() {
  const { view, controller } = useJudgeSandbox();
  const location = useLocation();
  const locationKey = `${location.key}:${location.pathname}${location.search}${location.hash}`;
  const onGuide = location.pathname.replace(/\/+$/, '') === GUIDED_DEMO_HREF;
  useEffect(() => {
    controller?.observeReturnLocation(locationKey, onGuide);
  }, [controller, locationKey, onGuide]);
  return <JudgeBannerView view={view} nextStepReady={controller?.returnStepReadyAt(locationKey, onGuide) ?? false} />;
}

export function JudgeRunCard() {
  const { view, controller } = useJudgeSandbox();
  if (!controller) return null;
  return (
    <JudgeRunCardView
      view={view}
      onStart={() => void controller.start()}
      onAction={(action) => void controller.act(action)}
      onCheckAgain={() => void controller.checkAgain()}
    />
  );
}
