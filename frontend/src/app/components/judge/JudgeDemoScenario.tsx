import { Button } from '../ui/button';
import type { JudgeView } from './judgeController';
import { useJudgeSandbox } from './JudgeSandboxProvider';

export const DEMO_EXAMPLE = 'The kitchen faucet has a slow drip into the sink. The sink drains normally. There is no water on the floor or active damage.';

/** Recheck at the state update too: a late click must not replace newly typed text. */
export const demoExampleDraft = (current: string) => current.length === 0 ? DEMO_EXAMPLE : current;

export function DemoScenarioNotice() {
  return <p className="mt-2 text-sm text-meta [overflow-wrap:anywhere]" data-testid="judge-demo-scenario">
    This guided demo covers a contained, non-emergency kitchen faucet drip into a normally draining sink, with no water on the floor or active damage. Real emergencies and other issues still use the ordinary request and safety process; do not soften or change real facts to fit this demo.
  </p>;
}

export function canUseDemoExample(view: JudgeView, value: string): boolean {
  const { run } = view.status;
  return value.length === 0 && view.loaded && view.status.enabled && view.status.role === 'tenant' &&
    Boolean(run && run.step.code === 'tenant_submit' && run.requestId === null && run.state !== 'completed' && run.state !== 'failed' && !run.error) &&
    !view.refreshFailed && !view.pollExpired && !view.busy && !view.notice;
}

/** An explicit unsent example, never intake facts or a submission. */
export function JudgeDemoExampleView({ view, value, disabled, onUse }: {
  view: JudgeView; value: string; disabled: boolean; onUse: (example: string) => void;
}) {
  if (!canUseDemoExample(view, value)) return null;
  return <div className="mb-2 text-sm">
    <Button variant="outline" size="sm" disabled={disabled} onClick={() => {
      if (!disabled && canUseDemoExample(view, value)) onUse(DEMO_EXAMPLE);
    }}>Use demo example</Button>
    <p className="mt-1 text-meta">Loads an editable, unsent example. Review it before sending; supply only truthful availability, pets and access details.</p>
  </div>;
}

export function JudgeDemoExample(props: { value: string; disabled: boolean; onUse: (example: string) => void }) {
  const { view } = useJudgeSandbox();
  return <JudgeDemoExampleView {...props} view={view} />;
}
