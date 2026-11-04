import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { SANDBOX_OFF, type JudgeRun } from '../../contracts/judgeSandbox';
import type { JudgeView } from './judgeController';
import { DEMO_EXAMPLE, JudgeDemoExampleView, canUseDemoExample, demoExampleDraft } from './JudgeDemoScenario';

const run: JudgeRun = { runId: 'synthetic', requestId: null, revision: 1, state: 'waiting_on_tenant', step: { index: 1, total: 14, code: 'tenant_submit', title: 'Submit', detail: '' }, allowedActions: ['pause'], checkpoint: { kind: 'tenant_submit', requestId: null, approvalId: null }, error: null, startedAt: '2026-11-04T05:00:00Z', updatedAt: '2026-11-04T05:00:00Z', completedAt: null };
const tenant: JudgeView = { loaded: true, status: { ...SANDBOX_OFF, enabled: true, role: 'tenant', pairLabel: 'Synthetic pair', run }, busy: null, notice: null, polling: false, pollExpired: false, refreshFailed: false };

describe('explicit judge-only unsent scenario example', () => {
  it('loads only on the explicit button action, remains editable and never sends', () => {
    let draft = '';
    const use = vi.fn(() => { draft = demoExampleDraft(draft); });
    const tree = JudgeDemoExampleView({ view: tenant, value: draft, disabled: false, onUse: use })!;
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain('Use demo example'); expect(markup).toContain('editable, unsent');
    expect(use).not.toHaveBeenCalled(); expect(draft).toBe('');
    const button = tree.props.children[0] as ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    expect(use).toHaveBeenCalledTimes(1); expect(draft).toBe(DEMO_EXAMPLE);
    draft = 'My actual issue'; button.props.onClick(); expect(draft).toBe('My actual issue');
    expect(JudgeDemoExampleView({ view: tenant, value: draft, disabled: false, onUse: use })).toBeNull();
    expect(DEMO_EXAMPLE).not.toMatch(/pets|available|permission/i);
  });

  it('never overwrites typed or whitespace content and honours disabled intake', () => {
    for (const text of [' ', 'already typed', DEMO_EXAMPLE]) {
      expect(canUseDemoExample(tenant, text)).toBe(false); expect(demoExampleDraft(text)).toBe(text);
    }
    const use = vi.fn();
    const tree = JudgeDemoExampleView({ view: tenant, value: '', disabled: true, onUse: use })!;
    expect(renderToStaticMarkup(tree)).toContain('disabled'); tree.props.children[0].props.onClick(); expect(use).not.toHaveBeenCalled();
  });

  it('never offers an example to ordinary, landlord, unknown, stopped or unstarted scopes', () => {
    const variants: JudgeView[] = [
      { ...tenant, status: SANDBOX_OFF }, { ...tenant, status: { ...tenant.status, role: 'landlord' } },
      { ...tenant, status: { ...tenant.status, run: null } }, { ...tenant, loaded: false },
      { ...tenant, status: { ...tenant.status, run: { ...run, requestId: 'already_bound' } } },
      { ...tenant, status: { ...tenant.status, run: { ...run, step: { index: 2, total: 14, code: 'routing', title: 'Routing', detail: '' } } } },
      { ...tenant, refreshFailed: true }, { ...tenant, pollExpired: true }, { ...tenant, busy: 'pause' },
      { ...tenant, notice: { kind: 'unknown' } },
      ...(['failed', 'completed'] as const).map(state => ({ ...tenant, status: { ...tenant.status, run: { ...run, state } } })),
      { ...tenant, status: { ...tenant.status, run: { ...run, error: { code: 'unsupported_scenario', retryable: false, nextAvailableAt: null, retryAfterSeconds: null } } } },
    ];
    for (const view of variants) expect(JudgeDemoExampleView({ view, value: '', disabled: false, onUse: vi.fn() })).toBeNull();
  });
});
