import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { JudgeSandboxController } from '../judge/judgeController';
import { JudgeSandboxProvider } from '../judge/JudgeSandboxProvider';
import { SANDBOX_OFF, type JudgeRun } from '../../contracts/judgeSandbox';
import RescheduleRequestForm from './RescheduleRequestForm';

const run: JudgeRun = { runId: 'synthetic', requestId: 'r1', revision: 9, state: 'waiting_on_landlord', step: { index: 7, total: 14, code: 'visit_change', title: 'Visit change', detail: '' }, allowedActions: ['pause'], checkpoint: null, error: null, startedAt: '2026-11-04T12:00:00Z', updatedAt: '2026-11-04T12:00:00Z', completedAt: null };
function render(enabled: boolean, role: 'landlord' | 'tenant' = 'landlord', requestId = 'r1') {
  const api = { status: vi.fn(), start: vi.fn(), act: vi.fn() }, controller = new JudgeSandboxController({ api });
  controller.view = { ...controller.getView(), loaded: true, status: { ...SANDBOX_OFF, enabled, role, run } };
  const onSent = vi.fn(), onReconcile = vi.fn();
  const out = renderToStaticMarkup(<JudgeSandboxProvider controller={controller}><RescheduleRequestForm requestId={requestId} revision={4} onSent={onSent} onReconcile={onReconcile} onCancel={vi.fn()} /></JudgeSandboxProvider>);
  expect(onSent).not.toHaveBeenCalled(); expect(onReconcile).not.toHaveBeenCalled();
  expect(api.status).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled(); expect(api.act).not.toHaveBeenCalled();
  return out;
}
describe('actual reschedule form demo chrome', () => {
  it('offers explicit non-submit examples only in a matched server-enabled landlord run, leaving all fields empty', () => {
    const out = render(true);
    expect(out).toMatch(/<button[^>]*type="button"[^>]*>Use synthetic demo reason/);
    expect(out).toContain('Load current demo windows'); expect(out).toContain('editable and unsent');
    expect(out).toContain('not a free-calendar check'); expect(out).toMatch(/<textarea[^>]*data-testid="visit-change-reason-input"[^>]*><\/textarea>/);
    expect(out).toContain('value=""'); expect(out).toContain('the vendor and the tenant each confirm one exact new time');
  });
  it('keeps ordinary, tenant and foreign request forms blank with no demo controls', () => {
    for (const out of [render(false), render(true, 'tenant'), render(true, 'landlord', 'foreign')]) {
      expect(out).not.toContain('Use synthetic demo reason'); expect(out).not.toContain('Load current demo windows');
      expect(out).toMatch(/<textarea[^>]*data-testid="visit-change-reason-input"[^>]*><\/textarea>/); expect(out).toContain('value=""');
    }
  });
});
