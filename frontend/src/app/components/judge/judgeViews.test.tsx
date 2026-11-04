import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SANDBOX_OFF, parseRun, type JudgeRun, type JudgeStatus } from '../../contracts/judgeSandbox';
import { JudgeBannerView, JudgeRunCardView, JudgeOverviewCardView } from './JudgeViews';
import { JudgeSandboxController, type JudgeView } from './judgeController';
import { JudgeSandboxProvider } from './JudgeSandboxProvider';
import { HackathonBadge, SimulatedVendorBadge } from './JudgeBadges';
import { ACTION_LABEL, STATE_LABEL, errorCopy } from './judgeCopy';
import { eventActor } from '../../lib/irisActivity';
import { irisEvent } from '../../lib/irisActivity.fixtures';
import { IrisEventItem } from '../iris-activity/IrisActivityParts';
import VendorCandidateCard from '../request-detail/VendorCandidateCard';
import type { VendorRecommendationCandidate } from '../request-detail/requestDetailTypes';
import contractJson from '../../contracts/judgeSandbox.v1.json';

const html = (element: ReactElement) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
// Existing 13-step fixtures intentionally exercise legacy histories under1.2.
const at = '2026-10-31T06:00:00.000Z';

function run(over: Partial<JudgeRun> = {}): JudgeRun {
  return {
    runId: 'run_owned',
    requestId: 'req_owned',
    revision: 2,
    state: 'ready_to_continue',
    step: { index: 3, total: 13, code: 'vendor_quote', title: 'Vendor sends a quote', detail: 'The simulated vendor sends an itemized quote.' },
    allowedActions: ['continue', 'pause'],
    checkpoint: null,
    error: null,
    startedAt: at,
    updatedAt: at,
    completedAt: null,
    ...over,
  };
}

function view(status: Partial<JudgeStatus> = {}, over: Partial<JudgeView> = {}): JudgeView {
  return {
    loaded: true,
    status: { contractVersion: '1.2.0', enabled: true, pairLabel: 'Judge pair 4', role: 'landlord', simulatedVendorIds: ['vendor_sim'], run: run(), ...status },
    busy: null,
    notice: null,
    polling: false,
    pollExpired: false,
    refreshFailed: false,
    ...over,
  };
}

const handlers = { onStart: vi.fn(), onAction: vi.fn(), onCheckAgain: vi.fn() };
const card = (v: JudgeView) => html(<JudgeRunCardView view={v} {...handlers} />);
const banner = (v: JudgeView) => html(<JudgeBannerView view={v} />);

/** A provider whose controller shows a fixed view (no network, no effects in static render). */
function withSandbox(v: JudgeView, element: ReactElement) {
  const controller = new JudgeSandboxController({ api: { status: vi.fn(), start: vi.fn(), act: vi.fn() } });
  controller.view = v;
  return html(<JudgeSandboxProvider controller={controller}>{element}</JudgeSandboxProvider>);
}

describe('judge sandbox views', () => {
  it.each(['unknown', 'action_unknown'] as const)('keeps a prior %s response distinct from server recovery, failed reads and actual unknown without resend', async kind => {
    const advanced = run({ revision: 4, step: { index: 4, total: 14, code: 'vendor_quote', title: 'Recorded recovery', detail: 'The server verified current vendor delivery.' } });
    const prior = run({ step: { index: 3, total: 14, code: 'vendor_decline', title: 'Decline', detail: '' } });
    const failure = kind === 'unknown' ? Error('No response') : Object.assign(Error('Unknown outcome'), { status: 409, payload: { success: false, code: 'action_unknown', message: 'Never display raw server errors', retryAfterSeconds: null, nextAvailableAt: null } });
    const api = { status: vi.fn().mockResolvedValueOnce({ data: view({ run: prior }).status }).mockResolvedValueOnce({ data: view({ run: advanced }).status }), start: vi.fn(), act: vi.fn().mockRejectedValueOnce(failure) };
    const controller = new JudgeSandboxController({ api }); await controller.read(); await controller.act('continue');
    const notice = controller.getView().notice;
    expect(notice).not.toBeNull();
    const recovered = card(controller.getView());
    expect(recovered).toContain('An earlier action response could not be confirmed.'); expect(recovered).toContain('No action was resent.');
    expect(recovered).toContain('Step 4 of 14'); expect(recovered).toContain('Recorded recovery'); expect(recovered).not.toContain('judge-run-error');
    expect(recovered).toContain('judge-continue'); // Exactly the backend allowedActions, unchanged by presentation.
    api.status.mockRejectedValueOnce(Error('Read unavailable')); await controller.read();
    expect(card(controller.getView())).toContain('Could not refresh the run.'); expect(card(controller.getView())).toContain('An earlier action response');
    const unknown = { ...prior, state: 'failed' as const, allowedActions: [], error: { code: 'action_unknown' as const, retryable: false, retryAfterSeconds: null, nextAvailableAt: null } };
    api.status.mockResolvedValueOnce({ data: view({ run: unknown }).status }); await controller.read();
    const stillUnknown = card(controller.getView());
    expect(stillUnknown).toContain('judge-run-error'); expect(stillUnknown).toContain('We could not confirm whether that step ran.');
    expect(stillUnknown).toContain('An earlier action response'); expect(stillUnknown).not.toContain('judge-continue');
    expect(controller.getView().notice).toBe(notice); expect(api.act).toHaveBeenCalledTimes(1); expect(api.start).not.toHaveBeenCalled();
  });
  it('discloses the contained non-emergency scenario before Start and at tenant entry without acting', () => {
    const beforeStart = card(view({ run: null }));
    expect(beforeStart).toContain('normally draining sink'); expect(beforeStart).toContain('no water on the floor or active damage');
    expect(beforeStart.indexOf('judge-demo-scenario')).toBeLessThan(beforeStart.indexOf('judge-start'));
    for (const tenantRun of [null, run()]) expect(banner(view({ role: 'tenant', run: tenantRun }))).toContain('ordinary request and safety process');
  });

  it('shows an unsupported boundary with ordinary records, never Continue or generic retry instructions', () => {
    const stopped = run({ state: 'failed', error: { code: 'unsupported_scenario', retryable: false, retryAfterSeconds: null, nextAvailableAt: null }, allowedActions: ['continue'], checkpoint: { kind: 'approval', requestId: 'req_owned', approvalId: 'approval_owned' } });
    const markup = card(view({ run: stopped }, { refreshFailed: true, pollExpired: true }));
    expect(markup).toContain('outside the guided demo scenario'); expect(markup).toContain('href="/dashboard/requests/req_owned"');
    for (const absent of ['judge-continue', 'judge-check-again', 'judge-step-instructions', 'Review in Decisions', 'judge-start']) expect(markup).not.toContain(absent);
    expect(markup).toContain('Do not retry, reset or reseed'); expect(markup).toContain('ordinary request and safety process');
    const tenantMarkup = banner(view({ role: 'tenant', run: { ...stopped, checkpoint: { kind: 'tenant_submit', requestId: null, approvalId: null } } }));
    expect(tenantMarkup).toContain('href="/portal/requests/req_owned"'); expect(tenantMarkup).not.toContain('href="/portal/new"');
    expect(tenantMarkup).not.toContain('judge-tenant-prompt'); expect(tenantMarkup).not.toContain('/dashboard');
  });

  it('waits for an actual fresh verified recovery read and preserves a genuinely unknown server outcome', async () => {
    const unknown = run({ state: 'failed', step: { index: 3, total: 14, code: 'vendor_decline', title: 'Recorded decline', detail: 'Current delivery is not confirmed.' }, error: { code: 'action_unknown', retryable: false, retryAfterSeconds: null, nextAvailableAt: null }, allowedActions: [] });
    let release!: (value: unknown) => void;
    const api = { status: vi.fn().mockResolvedValueOnce({ data: view({ run: unknown }).status }).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })), start: vi.fn(), act: vi.fn() };
    const controller = new JudgeSandboxController({ api }); await controller.read();
    expect(card(controller.getView())).toContain('could not confirm whether');
    const reading = controller.read(); expect(card(controller.getView())).toContain('Current delivery is not confirmed');
    const recovered = run({ revision: 4, step: { index: 4, total: 14, code: 'vendor_quote', title: 'Verified recovery', detail: 'The server verified the recorded decline and current vendor delivery.' } });
    release({ data: view({ run: recovered }).status }); await reading;
    expect(card(controller.getView())).toContain('Step 4 of 14'); expect(card(controller.getView())).toContain('Verified recovery');
    expect(card(controller.getView())).not.toContain('could not confirm whether');
    api.status.mockResolvedValueOnce({ data: view({ run: unknown }).status }); await controller.read();
    expect(card(controller.getView())).toContain('could not confirm whether'); expect(card(controller.getView())).not.toContain('judge-continue');
    expect(api.start).not.toHaveBeenCalled(); expect(api.act).not.toHaveBeenCalled();
  });
  it('adds a non-color readiness label to the existing landlord link without new controls or destinations', () => {
    const current = view();
    const ready = html(<JudgeBannerView view={current} nextStepReady />);
    expect(ready).toContain('Return to demo');
    expect(ready).toContain('Next step ready');
    expect(ready).toContain('href="/dashboard/guided-demo"');
    expect(ready.match(/<a /g)).toHaveLength(1);
    expect(ready).not.toContain('<button');
    expect(ready).toContain('aria-hidden="true"');
    expect(banner(current)).not.toContain('Next step ready');
    for (const v of [
      view({ role: 'tenant' }), view({ run: null }), view({ run: run({ state: 'completed' }) }),
      view({ run: run({ state: 'failed' }) }), view({}, { loaded: false }),
      view({ run: run({ state: 'running' }) }), view({ run: run({ state: 'paused' }) }),
      view({}, { refreshFailed: true }), view({}, { busy: 'continue' }),
      view({}, { pollExpired: true }),
      view({}, { notice: { kind: 'unknown' } }),
    ]) expect(html(<JudgeBannerView view={v} nextStepReady />)).not.toContain('Next step ready');
    expect(html(<JudgeBannerView view={view({}, { polling: true })} nextStepReady />)).toContain('Next step ready');
    expect(html(<JudgeBannerView view={view({ role: 'tenant' })} nextStepReady />)).toBe(banner(view({ role: 'tenant' })));
  });

  it('explains the actual recorded checkpoint count without renumbering legacy or recovery runs', () => {
    for (const step of [
      { index: 3, total: 13, code: 'vendor_quote' as const, title: 'Quote', detail: '' },
      { index: 3, total: 14, code: 'vendor_decline' as const, title: 'Decline', detail: '' },
    ]) {
      const markup = card(view({ run: run({ step }) }));
      expect(markup).toContain(`Step ${step.index} of ${step.total}`);
      expect(markup).toContain(`aria-valuemax="${step.total}"`);
      expect(markup).toContain('Recorded checkpoints include simulated vendor actions.');
    }
  });

  it('labels only a fresh server-known completed run and preserves tenant-safe destinations', () => {
    const completed = run({ state: 'completed', step: { index: 14, total: 14, code: 'complete', title: 'Recorded complete', detail: '' }, completedAt: at, allowedActions: [], checkpoint: null });
    for (const role of ['landlord', 'tenant'] as const) {
      const current = view({ role, run: completed });
      const markup = banner(current);
      expect(markup).toContain('Guided demo complete');
      expect(markup).toContain(role === 'landlord' ? 'href="/dashboard/guided-demo"' : 'href="/portal/requests/req_owned"');
      if (role === 'tenant') {
        expect(markup).not.toContain('/dashboard/');
        expect(card(current)).toBe('');
        expect(html(<JudgeOverviewCardView view={current} />)).toBe('');
      } else {
        expect(card(current)).toContain('Guided demo complete');
        expect(card(current)).toContain('Completion does not certify physical repair, payment, bank receipt or model use.');
        expect(html(<JudgeOverviewCardView view={current} />)).toContain('Guided demo complete');
      }
    }
    expect(banner(view({ role: 'tenant', run: { ...completed, requestId: null } }))).toContain('href="/portal"');
  });

  it.each([
    { loaded: false }, { refreshFailed: true }, { pollExpired: true }, { polling: true },
    { busy: 'continue' as const }, { notice: { kind: 'unknown' as const } },
    { notice: { kind: 'error' as const, code: 'stale_revision' as const, nextAvailableAt: null, retryAfterSeconds: null } },
  ])('does not promote a stale/loading/error/unknown completed snapshot: %j', (state) => {
    const completed = run({ state: 'completed', allowedActions: [], checkpoint: null });
    for (const role of ['landlord', 'tenant'] as const) {
      const current = view({ role, run: completed }, state);
      for (const markup of [banner(current), card(current), html(<JudgeOverviewCardView view={current} />)]) {
        expect(markup).not.toContain('Guided demo complete');
        expect(markup).not.toContain('The server marks this run complete.');
      }
      if (role === 'tenant') expect(banner(current)).not.toContain('/dashboard/');
    }
  });

  it('does not infer completion from final progress or a request, and no run stays unstarted', () => {
    const progress = run({ step: { index: 14, total: 14, code: 'complete', title: 'Final record', detail: '' } });
    for (const role of ['landlord', 'tenant'] as const) {
      for (const currentRun of [progress, null]) {
        const current = view({ role, run: currentRun });
        expect(banner(current)).not.toContain('Guided demo complete');
        expect(card(current)).not.toContain('Guided demo complete');
        expect(html(<JudgeOverviewCardView view={current} />)).not.toContain('Guided demo complete');
      }
    }
    const noRunTenant = banner(view({ role: 'tenant', run: null }));
    expect(noRunTenant).toContain('Demo not started');
    expect(noRunTenant).not.toContain('judge-return-demo');
  });
  it('renders trusted14-step decline and recovered quote with their actual progress and server copy', () => {
    for (const step of [
      { index: 3, total: 14, code: 'vendor_decline', title: 'Vendor A declines', detail: 'Simulated vendor A declined. Automation follows ordinary backend policy.' },
      { index: 4, total: 14, code: 'vendor_quote', title: 'Recovered vendor quote', detail: 'Vendor B delivery is recorded before its itemized quote.' },
    ]) {
      const parsed = parseRun(run({ step: step as JudgeRun['step'] }));
      expect(parsed).not.toBeNull();
      const current = view({ run: parsed! });
      const markup = card(current);
      expect(markup).toContain(`Step ${step.index} of 14`);
      expect(markup).toContain(step.title);
      expect(markup).toContain(step.detail);
      expect(markup).toMatch(new RegExp(`role="progressbar"[^>]*aria-valuemax="14"[^>]*aria-valuenow="${step.index}"[^>]*aria-valuetext="Step ${step.index} of 14"`));
      expect(markup).toContain(`width:${step.index === 3 ? '21.428571428571427' : '28.57142857142857'}%`);
      expect(markup).toContain('judge-continue');
      expect(markup).not.toContain('Start guided run');
      expect(markup).not.toMatch(/<(?:input|select)\b/);
      const busy = card({ ...current, busy: 'continue' });
      expect(busy).toContain('aria-busy="true"');
      expect(busy).toContain('disabled=""');
      expect(card({ ...current, notice: { kind: 'unknown' } })).toContain('No action was resent');
      expect(card({ ...current, notice: { kind: 'error', code: 'stale_revision', nextAvailableAt: null, retryAfterSeconds: null } })).toContain('Showing the current step');
      expect(card(view({ role: 'tenant', run: parsed! }))).toBe('');
      expect(banner(view({ role: 'tenant', run: parsed! }))).not.toContain('<button');
    }
  });

  it('U1: renders nothing at all when the sandbox is off', () => {
    const off: JudgeView = { ...view(), status: SANDBOX_OFF };
    expect(card(off)).toBe('');
    expect(banner(off)).toBe('');
    expect(html(<HackathonBadge />)).toBe('');
    expect(html(<SimulatedVendorBadge vendorId="vendor_sim" />)).toBe('');
  });

  it('shows the pair banner with the simulation notice on both roles', () => {
    for (const role of ['landlord', 'tenant'] as const) {
      const markup = banner(view({ role }));
      expect(markup).toContain('Judge pair 4');
      expect(markup).toContain('vendors are simulated · no real messages or money');
    }
  });

  it('offers Start before a run, and nothing else', () => {
    const markup = card(view({ run: null }));
    expect(markup).toContain('data-testid="judge-start"');
    expect(markup).toContain('Start guided run');
    expect(markup).not.toContain('judge-continue');
  });

  it('U2: each state shows its step position, title, label and only the allowed buttons', () => {
    for (const state of contractJson.states as JudgeRun['state'][]) {
      const markup = card(view({ run: run({ state, allowedActions: ['pause'] }) }));
      expect(markup).toContain('Step 3 of 13');
      expect(markup).toContain('Vendor sends a quote');
      expect(markup).toContain(STATE_LABEL[state]);
      expect(markup).toContain('data-testid="judge-pause"');
      expect(markup).not.toContain('data-testid="judge-continue"');
      expect(markup).not.toContain('data-testid="judge-resume"');
    }
    const both = card(view({ run: run({ allowedActions: ['resume', 'continue'] }) }));
    expect(both.indexOf(ACTION_LABEL.continue)).toBeLessThan(both.indexOf(ACTION_LABEL.resume));
    expect(card(view({ run: run({ allowedActions: [] }) }))).not.toContain('<button');
  });

  it('U3: every error code has fixed copy and the server message is never shown', () => {
    for (const code of Object.keys(contractJson.errors) as Parameters<typeof errorCopy>[0][]) {
      const copy = errorCopy(code, null, null);
      expect(copy.length).toBeGreaterThan(10);
      const markup = card(view({}, { notice: { kind: 'error', code, retryAfterSeconds: null, nextAvailableAt: null } }));
      expect(markup).toContain('role="alert"');
      expect(markup).not.toContain('Server text');
    }
    expect(errorCopy('tenant_quota_reached', at, null)).toMatch(/until .*spare pair/);
    expect(card(view({}, { notice: { kind: 'unknown' } }))).toContain('No action was resent');
  });

  it('U4: a human checkpoint links to its own page and offers no approve control', () => {
    const markup = card(view({ run: run({ state: 'waiting_on_landlord', allowedActions: ['pause'], checkpoint: { kind: 'approval', requestId: 'req_owned', approvalId: 'appr_1' } }) }));
    expect(markup).toContain('href="/dashboard/decisions?request=req_owned"');
    expect(markup).not.toMatch(/>\s*(Approve|Confirm|Fund|Pay)/);
    const wallet = card(view({ run: run({ checkpoint: { kind: 'wallet_funding', requestId: null, approvalId: null } }) }));
    expect(wallet).toContain('href="/dashboard/wallet"');
  });

  it('U5: announces busy and polling politely, and offers Check again after the poll stops', () => {
    expect(card(view({}, { busy: 'continue' }))).toContain('Continuing…');
    expect(card(view({}, { busy: 'continue' }))).toContain('aria-busy="true"');
    expect(card(view({}, { polling: true }))).toMatch(/role="status" aria-live="polite"[^>]*>Checking for updates/);
    expect(card(view({}, { pollExpired: true }))).toContain('Still working.');
    expect(card(view({}, { refreshFailed: true }))).toContain('Could not refresh the run.');
  });

  it('exposes progress to assistive tech', () => {
    expect(card(view())).toMatch(/role="progressbar"[^>]*aria-valuenow="3"[^>]*aria-valuetext="Step 3 of 13"/);
  });

  it('U10: the tenant gets the banner and their own prompt, never run controls', () => {
    const tenantView = view({ role: 'tenant', run: run({ state: 'waiting_on_tenant', allowedActions: [], checkpoint: { kind: 'tenant_submit', requestId: null, approvalId: null } }) });
    expect(card(tenantView)).toBe('');
    const markup = banner(tenantView);
    expect(markup).toContain('data-testid="judge-tenant-prompt"');
    expect(markup).toContain('href="/portal/new"');
    // A landlord-only checkpoint is not shown to the tenant.
    expect(banner(view({ role: 'tenant', run: run({ state: 'waiting_on_tenant', checkpoint: { kind: 'wallet_funding', requestId: null, approvalId: null } }) }))).not.toContain('judge-tenant-prompt');
  });
});

describe('Activity actors (judge contract v1)', () => {
  it('U7: maps each actor kind to fixed copy; automation is never Iris', () => {
    const label = (actorKind: string, extra = {}) => eventActor(irisEvent({ actor: 'Iris', actorKind, ...extra })).label;
    expect(label('automation')).toBe('Automation');
    expect(label('ai_triage')).toBe('AI triage');
    expect(label('iris_assistant')).toBe('Ask Iris');
    expect(label('landlord', { actorLabel: 'Iris' })).toBe('Landlord');
    expect(label('simulated_vendor', { actorLabel: 'Synthetic demo vendor' })).toBe('Synthetic demo vendor');
    expect(eventActor(irisEvent({ actorKind: 'simulated_vendor' })).simulated).toBe(true);
    expect(label('unknown')).toBe('Unknown');
  });

  it('lets the server actorLabel win where it is known, but never credits a person action to Iris', () => {
    const one = (extra: Record<string, unknown>) => eventActor(irisEvent({ actor: 'ai_agent', ...extra })).label;
    expect(one({ actorKind: 'automation', actorLabel: 'AI cost analysis' })).toBe('AI cost analysis');
    expect(one({ actorKind: 'ai_triage', actorLabel: 'AI triage (intake)' })).toBe('AI triage (intake)');
    // An Iris-assisted Policy save is the landlord's.
    expect(one({ actorKind: 'landlord', actorLabel: 'Iris' })).toBe('Landlord');
    expect(one({ actorKind: 'landlord', actorLabel: 'Saved with Iris' })).toBe('Landlord');
    expect(one({ actorKind: 'landlord', actorLabel: 'Property manager' })).toBe('Property manager');
    // A bare "Iris" or ai_agent label never stands in for a known kind.
    expect(one({ actorKind: 'automation', actorLabel: 'Iris' })).toBe('Automation');
    expect(one({ actorKind: 'automation', actorLabel: '  ' })).toBe('Automation');
  });

  it('reads legacy "Iris" / ai_agent without actorKind as Unknown, other legacy actors as before', () => {
    expect(eventActor(irisEvent({ actor: 'Iris', actorLabel: 'AI cost analysis' })).label).toBe('Unknown');
    expect(eventActor(irisEvent({ actor: 'Iris' })).label).toBe('Unknown');
    expect(eventActor(irisEvent({ actor: 'ai_agent' })).label).toBe('Unknown');
    expect(eventActor(irisEvent({ actor: 'vendor_portal' })).label).toBe('Vendor portal');
    expect(eventActor(irisEvent({ actor: 'tenant', actorKind: 'made_up' })).label).toBe('Tenant');
  });

  it('shows model provenance only when the server says model', () => {
    expect(eventActor(irisEvent({ provenance: { kind: 'model', label: 'x' } })).provenance).toBe('AI model');
    expect(eventActor(irisEvent({ provenance: { kind: 'fallback', label: null } })).provenance).toBe('Fallback, no AI');
    expect(eventActor(irisEvent({ provenance: null })).provenance).toBeNull();
    expect(eventActor(irisEvent({ provenance: { kind: 'llm' } })).provenance).toBeNull();
  });

  it('renders the actor, the simulated marker and provenance on an event', () => {
    const markup = withSandbox(view(), <ol><IrisEventItem event={irisEvent({ actor: 'ai_agent', actorKind: 'simulated_vendor', actorLabel: 'Synthetic demo vendor', provenance: { kind: 'simulation' } })} /></ol>);
    expect(markup).toContain('Synthetic demo vendor');
    expect(markup).toContain('data-testid="simulated-vendor"');
    expect(markup).toContain('(Simulation)');
    expect(markup).not.toMatch(/data-testid="iris-event-actor">Iris</);
  });
});

describe('simulation labels and hackathon badges', () => {
  const candidate = {
    candidateKey: 'cand_1',
    vendorId: 'vendor_sim',
    providerName: 'Mock',
    providerVendorId: 'p1',
    name: 'Synthetic demo vendor',
    candidateSource: 'mock_external',
    state: 'candidate',
  } as unknown as VendorRecommendationCandidate;
  const renderCard = (v: JudgeView, c = candidate) =>
    withSandbox(v, <VendorCandidateCard candidate={c} snapshot={null} draftValue="" draftOpen={false} vendorActionBusy="" onToggleDraft={vi.fn()} onChangeDraft={vi.fn()} onSaveDraft={vi.fn()} onApproveContact={vi.fn()} onManualAssign={vi.fn()} />);

  it('U8: the pair\'s simulated vendor reads "Simulated vendor", never "External vendor"', () => {
    const markup = renderCard(view());
    expect(markup).toContain('Simulated vendor');
    expect(markup).not.toContain('External vendor');
  });

  it('labels only vendors the server lists, and nothing outside the sandbox', () => {
    expect(renderCard(view(), { ...candidate, vendorId: 'vendor_real' } as VendorRecommendationCandidate)).not.toContain('Simulated vendor');
    expect(renderCard({ ...view(), status: SANDBOX_OFF })).toContain('External vendor');
  });

  it('shows the hackathon badge only in the sandbox', () => {
    expect(withSandbox(view(), <HackathonBadge />)).toContain('Built during the hackathon');
  });
});
