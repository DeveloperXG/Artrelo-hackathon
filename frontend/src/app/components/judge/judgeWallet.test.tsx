import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SANDBOX_OFF } from '../../contracts/judgeSandbox';
import { JudgeSandboxProvider } from './JudgeSandboxProvider';
import { JudgeSandboxController, type JudgeView } from './judgeController';
import { JudgeMoneyActions, JudgeWalletNotice } from './JudgeWalletPresentation';

function renderController(controller: JudgeSandboxController) {
  return renderToStaticMarkup(<JudgeSandboxProvider controller={controller}>
    <JudgeWalletNotice />
    <JudgeMoneyActions><button>Add funds</button><button>Mark paid</button><div data-testid="payment-form">Payment form</div></JudgeMoneyActions>
  </JudgeSandboxProvider>);
}

function render(enabled: boolean, loaded = true) {
  const controller = new JudgeSandboxController({ api: { status: vi.fn(), start: vi.fn(), act: vi.fn() } });
  controller.view = { loaded, status: enabled ? { contractVersion: '1.2.0', enabled: true, role: 'landlord', pairLabel: 'Judge pair 1', simulatedVendorIds: [], run: null } : SANDBOX_OFF, busy: null, notice: null, polling: false, pollExpired: false, refreshFailed: false } satisfies JudgeView;
  return renderController(controller);
}

describe('synthetic Wallet presentation', () => {
  it('keeps all payment controls absent during a valid1.1 decline/recovery run and on old-version uncertainty', async () => {
    const at = '2026-11-01T17:00:00Z';
    const current = { contractVersion: '1.2.0', enabled: true, role: 'landlord', pairLabel: 'Synthetic pair', simulatedVendorIds: ['vendor_a', 'vendor_b'], run: {
      runId: 'run_owned', requestId: 'request_owned', revision: 3, state: 'ready_to_continue',
      step: { index: 3, total: 14, code: 'vendor_decline', title: 'Vendor declines', detail: 'Recovery remains backend-owned.' },
      allowedActions: ['continue', 'pause'], checkpoint: null, error: null, startedAt: at, updatedAt: at, completedAt: null,
    } };
    const status = vi.fn().mockResolvedValueOnce({ data: current }).mockResolvedValueOnce({ data: { ...current, contractVersion: '1.0.0' } });
    const api = { status, start: vi.fn(), act: vi.fn() };
    const controller = new JudgeSandboxController({ api });
    await controller.read();
    expect(controller.view.status.run?.step.code).toBe('vendor_decline');
    expect(renderController(controller)).toContain('no real money was sent');
    expect(renderController(controller)).not.toContain('<button');
    await controller.read();
    expect(controller.view.refreshFailed).toBe(true);
    expect(renderController(controller)).not.toContain('<button');
    expect(renderController(controller)).not.toContain('payment-form');
    expect(api.act).not.toHaveBeenCalled();
  });

  it('omits payment controls and the payment form for a server-enabled sandbox', () => {
    const markup = render(true);
    expect(markup).toContain('judge-wallet-notice');
    expect(markup).toContain('no real money was sent');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('payment-form');
  });
  it('retains ordinary-user payment controls and has no sandbox notice', () => {
    const markup = render(false);
    expect(markup).toContain('<button>Add funds</button>');
    expect(markup).toContain('<button>Mark paid</button>');
    expect(markup).toContain('payment-form');
    expect(markup).not.toContain('judge-wallet-notice');
  });
  it('offers no payment control before the current server eligibility read completes', () => {
    expect(render(false, false)).not.toContain('<button');
    expect(render(false, false)).not.toContain('payment-form');
  });
  it('keeps money controls absent after an actual rejected status read until a valid disabled response', async () => {
    const status = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce({ data: SANDBOX_OFF }).mockRejectedValueOnce(new TypeError('offline again'));
    const api = { status, start: vi.fn(), act: vi.fn() };
    const controller = new JudgeSandboxController({ api });
    expect(renderController(controller)).not.toContain('<button');
    await controller.read();
    expect(controller.getView().refreshFailed).toBe(true);
    expect(renderController(controller)).not.toContain('<button');
    expect(renderController(controller)).not.toContain('payment-form');
    expect(renderController(controller)).toContain('Payment controls are temporarily unavailable');
    await controller.read();
    expect(controller.getView().refreshFailed).toBe(false);
    expect(renderController(controller)).toContain('<button>Add funds</button>');
    expect(renderController(controller)).toContain('<button>Mark paid</button>');
    expect(renderController(controller)).toContain('payment-form');
    expect(renderController(controller)).not.toContain('Payment controls are temporarily unavailable');
    await controller.read();
    expect(renderController(controller)).not.toContain('<button');
    expect(api.start).not.toHaveBeenCalled();
    expect(api.act).not.toHaveBeenCalled();
  });
  it('treats a malformed successful body as unknown eligibility and recovers only on valid off', async () => {
    const status = vi.fn().mockResolvedValueOnce({ data: { enabled: false } }).mockResolvedValueOnce({ data: SANDBOX_OFF });
    const controller = new JudgeSandboxController({ api: { status, start: vi.fn(), act: vi.fn() } });
    await controller.read();
    expect(controller.getView().refreshFailed).toBe(true);
    expect(renderController(controller)).not.toContain('<button');
    expect(renderController(controller)).not.toContain('payment-form');
    expect(renderController(controller)).toContain('Payment controls are temporarily unavailable');
    await controller.read();
    expect(renderController(controller)).toContain('<button>Add funds</button>');
    expect(controller.getView().refreshFailed).toBe(false);
  });
});
