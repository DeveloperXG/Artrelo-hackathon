import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { SANDBOX_OFF, parseRun, type JudgeRun } from '../../contracts/judgeSandbox';
import { JudgeSandboxController, type JudgeView } from './judgeController';
import { JudgeSandboxProvider } from './JudgeSandboxProvider';
import { JudgeBannerView, JudgeOverviewCardView, judgeReturnHref } from './JudgeViews';
import GuidedDemoPage, { guidedDemoAccess } from '../../pages/landlord/GuidedDemoPage';
import { checkpointLink } from './judgeCopy';

// Deliberately legacy13; transport version is1.2 for old and new histories.
const run: JudgeRun = {
  runId: 'owned', requestId: 'request_owned', revision: 15,
  state: 'waiting_on_landlord', step: { index: 11, total: 13, code: 'landlord_review', title: 'Review final costs and evidence', detail: '' },
  allowedActions: ['pause'], checkpoint: { kind: 'approval', requestId: 'request_owned', approvalId: 'approval_owned' },
  error: null, startedAt: '2026-10-31T20:00:00Z', updatedAt: '2026-10-31T20:00:00Z', completedAt: null,
};
function view(over: Partial<JudgeView> = {}): JudgeView {
  return { loaded: true, status: { contractVersion: '1.2.0', enabled: true, role: 'landlord', pairLabel: 'Judge pair 1', simulatedVendorIds: [], run }, busy: null, notice: null, polling: false, pollExpired: false, refreshFailed: false, ...over };
}
const html = (element: ReactElement) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
function page(v: JudgeView) {
  const api = { status: vi.fn(), start: vi.fn(), act: vi.fn() };
  const controller = new JudgeSandboxController({ api });
  controller.view = v;
  const markup = html(<JudgeSandboxProvider controller={controller}><GuidedDemoPage /></JudgeSandboxProvider>);
  return { markup, api };
}

describe('Guided demo eligibility and authority', () => {
  it('keeps14-step recovery human gates on their normal pages without approving or replaying them', () => {
    for (const [step, checkpoint, href] of [
      [{ index: 2, total: 14, code: 'routing', title: 'Review routing', detail: 'A genuine manual fallback needs approval.' }, { kind: 'approval', requestId: 'request_owned', approvalId: 'approval_owned' }, '/dashboard/decisions?request=request_owned'],
      [{ index: 5, total: 14, code: 'quote_resolution', title: 'Review recovered quote', detail: 'A quote above the policy limit needs your decision.' }, { kind: 'quote_over_limit', requestId: 'request_owned', approvalId: 'approval_owned' }, '/dashboard/decisions?request=request_owned'],
      [{ index: 6, total: 14, code: 'booking', title: 'Review booking', detail: 'Funding is a separate human checkpoint.' }, { kind: 'wallet_funding', requestId: 'request_owned', approvalId: null }, '/dashboard/wallet'],
    ] as const) {
      const parsed = parseRun({ ...run, step, checkpoint });
      expect(parsed).not.toBeNull();
      const { markup, api } = page(view({ status: { ...view().status, run: parsed! } }));
      expect(markup).toContain(`Step ${step.index} of 14`);
      expect(markup).toContain(href);
      expect(markup).toContain(step.detail);
      expect(markup).toContain('judge-pause');
      expect(markup).not.toContain('judge-continue');
      expect(markup).not.toMatch(/>\s*(Approve|Confirm|Pay|Retry|Select vendor)/);
      expect(api.act).not.toHaveBeenCalled();
      expect(api.start).not.toHaveBeenCalled();
    }
  });

  it('retains tenant-only completion navigation and passive14-step completed-request access', () => {
    const completion = parseRun({ ...run, state: 'waiting_on_tenant', step: { index: 11, total: 14, code: 'tenant_completion', title: 'Confirm work', detail: '' }, checkpoint: { kind: 'tenant_completion', requestId: 'request_owned', approvalId: null }, allowedActions: [] });
    expect(completion).not.toBeNull();
    const tenantView = view({ status: { ...view().status, role: 'tenant', run: completion } });
    expect(html(<JudgeBannerView view={tenantView} />)).toContain('href="/portal/schedule"');
    expect(page(tenantView).markup).not.toContain('judge-run-card');
    const completed = parseRun({ ...run, state: 'completed', step: { index: 14, total: 14, code: 'complete', title: 'Completed', detail: '' }, checkpoint: null, allowedActions: [], completedAt: run.updatedAt });
    expect(completed).not.toBeNull();
    const { markup, api } = page(view({ status: { ...view().status, run: completed } }));
    expect(markup).toContain('Step 14 of 14');
    expect(markup).toContain('href="/dashboard/requests/request_owned"');
    expect(markup).not.toContain('<button');
    expect(api.act).not.toHaveBeenCalled();
  });

  it('requires a completed server read with enabled landlord role', () => {
    expect(guidedDemoAccess(view({ loaded: false }))).toBe('loading');
    expect(guidedDemoAccess(view({ status: SANDBOX_OFF }))).toBe('denied');
    expect(guidedDemoAccess(view({ status: { ...view().status, role: 'tenant' } }))).toBe('denied');
    expect(guidedDemoAccess(view())).toBe('allowed');
    expect(guidedDemoAccess(view({ status: SANDBOX_OFF, refreshFailed: true }))).toBe('unavailable');
  });
  it('hides all guide content and controls while loading or outside the sandbox', () => {
    for (const v of [view({ loaded: false }), view({ status: SANDBOX_OFF }), view({ status: { ...view().status, role: 'tenant' } })]) {
      const { markup, api } = page(v);
      expect(markup).not.toContain('guided-demo-page');
      expect(markup).not.toContain('judge-run-card');
      expect(api.start).not.toHaveBeenCalled();
      expect(api.act).not.toHaveBeenCalled();
    }
  });
  it('renders the current human checkpoint with navigation, never an approval action', () => {
    const { markup, api } = page(view());
    expect(markup).toContain('Step 11 of 13');
    expect(markup).toContain('/dashboard/decisions?request=request_owned');
    expect(markup).toContain('judge-pause');
    expect(markup).not.toContain('judge-continue');
    expect(markup).not.toMatch(/>\s*(Approve|Confirm|Pay)/);
    expect(api.start).not.toHaveBeenCalled();
    expect(api.act).not.toHaveBeenCalled();
  });
  it('Overview Start and Continue only navigate to the guide', () => {
    for (const current of [null, run]) {
      const markup = html(<JudgeOverviewCardView view={view({ status: { ...view().status, run: current } })} />);
      expect(markup).toContain('href="/dashboard/guided-demo"');
      expect(markup).toContain(current ? 'Continue demo' : 'Start demo');
      expect(markup).not.toContain('<button');
    }
    expect(html(<JudgeOverviewCardView view={view({ status: SANDBOX_OFF })} />)).toBe('');
    expect(html(<JudgeOverviewCardView view={view({ status: { ...view().status, role: 'tenant' } })} />)).toBe('');
  });
  it('offers passive navigation to the server-owned completed request without run actions', () => {
    const completed = { ...run, state: 'completed' as const, step: { ...run.step, index: 13, code: 'complete' as const }, allowedActions: [], checkpoint: null };
    const { markup, api } = page(view({ status: { ...view().status, run: completed } }));
    expect(markup).toContain('View completed request');
    expect(markup).toContain('href="/dashboard/requests/request_owned"');
    expect(markup).not.toContain('<button');
    expect(api.start).not.toHaveBeenCalled();
    expect(api.act).not.toHaveBeenCalled();
    expect(page(view({ status: { ...view().status, run: { ...completed, requestId: null } } })).markup).not.toContain('judge-completed-request');
  });
  it('recaps only recorded completion and omits missing request/Activity links without certifying money or Iris', () => {
    const completed = { ...run, state: 'completed' as const, step: { ...run.step, index: 13, code: 'complete' as const }, allowedActions: [], checkpoint: null, requestId: null };
    const { markup, api } = page(view({ status: { ...view().status, run: completed } }));
    expect(markup).toContain('server marks this run complete');expect(markup).toContain('does not certify');expect(markup).toContain('acknowledgement alone does not verify');expect(markup).toContain('href="/dashboard/policy"');
    expect(markup).not.toContain('/dashboard/requests/');expect(markup).not.toContain('Review request Activity');expect(markup).not.toContain('<button');expect(api.start).not.toHaveBeenCalled();expect(api.act).not.toHaveBeenCalled();
  });
  it('keeps tenant return links within the tenant portal and completion on Schedule', () => {
    const tenant = view({ status: { ...view().status, role: 'tenant', run: { ...run, state: 'waiting_on_tenant', allowedActions: [], checkpoint: { kind: 'tenant_completion', requestId: 'request_owned', approvalId: null } } } });
    const markup = html(<JudgeBannerView view={tenant} />);
    expect(judgeReturnHref(tenant)).toBe('/portal/schedule');
    expect(markup).toContain('Review the work');
    expect(markup).not.toContain('/dashboard');
    expect(markup).not.toContain('<button');
    expect(checkpointLink({ kind: 'visit_change', requestId: 'request_owned', approvalId: null }, 'tenant')?.href).toBe('/portal/requests/request_owned');
    expect(judgeReturnHref(view({ status: SANDBOX_OFF }))).toBeNull();
    expect(judgeReturnHref(view())).toBe('/dashboard/guided-demo');
  });

  it('orients an enabled tenant before Start, with no Return or same-profile role switch', () => {
    const tenant = view({ status: { ...view().status, role: 'tenant', run: null } });
    const markup = html(<JudgeBannerView view={tenant} />);
    expect(markup).toContain('Demo not started');expect(markup).toContain('separate browser profile');expect(markup).toContain('Start guided run');
    expect(markup).toContain('Judge sandbox');expect(markup).not.toContain('judge-return-demo');expect(markup).not.toContain('href="/login');expect(markup).not.toContain('<button');expect(judgeReturnHref(tenant)).toBeNull();
    expect(html(<JudgeBannerView view={{ ...tenant, loaded: false }} />)).toBe('');
    const unknown = html(<JudgeBannerView view={{ ...tenant, refreshFailed: true }} />);
    expect(unknown).not.toContain('Demo not started');expect(unknown).not.toContain('judge-return-demo');expect(unknown).toContain('could not be checked');
  });

  it('unlocks only the same provider server run and preserves role-safe original-booking navigation', () => {
    const tenant = view({ status: { ...view().status, role: 'tenant', run: { ...run, state: 'waiting_on_tenant', checkpoint: { kind: 'booking', requestId: 'request_owned', approvalId: null } } } });
    const markup = html(<JudgeBannerView view={tenant} />);
    expect(markup).toContain('judge-return-demo');expect(markup).toContain('Review original visit');expect(markup).toContain('href="/portal/requests/request_owned"');expect(markup).not.toContain('/dashboard');
    expect(judgeReturnHref({ ...tenant, refreshFailed: true })).toBeNull();
    expect(judgeReturnHref({ ...tenant, status: { ...tenant.status, run: null } })).toBeNull();
  });

  it('failed Start does not unlock tenant Return; a subsequent server-confirmed started run does without a second Start', async () => {
    const status = { ...view().status, run: null }, api = { status: vi.fn().mockResolvedValue({ data: status }), start: vi.fn().mockRejectedValue(Error('Unknown start outcome')), act: vi.fn() };
    const controller = new JudgeSandboxController({ api, isVisible: () => false });await controller.read();await controller.start();
    const tenantBefore = view({ status: { ...controller.getView().status, role: 'tenant' } });expect(judgeReturnHref(tenantBefore)).toBeNull();expect(html(<JudgeBannerView view={tenantBefore} />)).not.toContain('judge-return-demo');expect(api.start).toHaveBeenCalledTimes(1);
    api.status.mockResolvedValueOnce({ data: { ...status, run } });await controller.read();
    const tenantAfter = view({ status: { ...controller.getView().status, role: 'tenant' } });expect(judgeReturnHref(tenantAfter)).toBe('/portal/requests/request_owned');expect(api.start).toHaveBeenCalledTimes(1);expect(api.act).not.toHaveBeenCalled();controller.dispose();
  });
  it('accepts server Run existence with nullable legacy start metadata without inventing a timestamp or retaining another pair gate', () => {
    const legacy = parseRun({ ...run, startedAt: null });expect(legacy).not.toBeNull();
    const tenant = view({ status: { ...view().status, role: 'tenant', run: legacy } });expect(judgeReturnHref(tenant)).toBe('/portal/requests/request_owned');
    expect(html(<JudgeBannerView view={tenant} />)).not.toContain('startedAt');
    expect(judgeReturnHref({ ...tenant, loaded: false })).toBeNull();expect(judgeReturnHref({ ...tenant, refreshFailed: true })).toBeNull();
    const newPair = { ...tenant, status: { ...tenant.status, pairLabel: 'Other synthetic pair', run: null } };expect(judgeReturnHref(newPair)).toBeNull();expect(html(<JudgeBannerView view={newPair} />)).toContain('Demo not started');
  });
});
