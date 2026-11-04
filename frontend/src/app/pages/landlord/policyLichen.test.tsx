import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import PolicyPage from './PolicyPage';

// Lichen Light presentation of Policy (D4 Policy checkpoint). The page column
// joins the Lichen scope only once lib/lichenRoutes lists /dashboard/policy;
// until then the legacy markup must be exactly what it was. Both sides are
// rendered here, the Lichen one by stubbing the route gate.

const gate = vi.hoisted(() => ({ lichen: true }));
vi.mock('../../lib/lichenRoutes', () => ({ isLichenLandlordPath: () => gate.lichen }));

vi.mock('../../hooks/landlord/useLandlordBadges', () => ({ useLandlordPaymentMode: () => 'platform' }));
vi.mock('../../hooks/landlord/useLandlordPolicy', () => ({
  useLandlordPolicy: () => ({
    policy: {
      defaultQuota: 200,
      lowFundsThreshold: 100,
      maxOutreachAttempts: 3,
      autoAdvanceOnVendorDecline: true,
      allowAutopilotForLowSeverity: true,
      allowAutopilotForMediumSeverity: false,
      requireApprovalOverQuota: true,
      requireApprovalForFirstTimeVendor: false,
      allowQuoteClarification: false,
    },
    setPolicy: vi.fn(),
    loading: false,
    reload: vi.fn(),
  }),
}));
vi.mock('../../hooks/landlord/useRoutingSetup', () => ({ useRoutingSetup: () => ({ setup: null, reload: vi.fn() }) }));

// A judge pair with a run in progress; the run now lives on Guided demo.
vi.mock('../../components/judge/JudgeSandboxProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useJudgeSandbox: () => ({
    controller: { start: vi.fn(), act: vi.fn(), checkAgain: vi.fn() },
    view: {
      loaded: true,
      busy: null,
      notice: null,
      polling: false,
      pollExpired: false,
      refreshFailed: false,
      status: {
        contractVersion: '1.0.0',
        enabled: true,
        pairLabel: 'Judge pair 4',
        role: 'landlord',
        simulatedVendorIds: [],
        run: {
          runId: 'run_owned',
          requestId: 'req_owned',
          revision: 2,
          state: 'ready_to_continue',
          step: { index: 3, total: 13, code: 'vendor_quote', title: 'Vendor sends a quote', detail: 'The simulated vendor sends an itemized quote.' },
          allowedActions: ['continue', 'pause'],
          checkpoint: null,
          error: null,
          startedAt: '2026-10-31T06:00:00.000Z',
          updatedAt: '2026-10-31T06:00:00.000Z',
          completedAt: null,
        },
      },
    },
  }),
}));

const html = () =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={['/dashboard/policy']}>
      <PolicyPage />
    </MemoryRouter>
  );

const switches = (markup: string) => [...markup.matchAll(/<button type="button" role="switch"[^>]*>/g)].map((m) => m[0]);

describe('Policy under Lichen Light', () => {
  beforeEach(() => {
    gate.lichen = true;
  });

  it('keeps every Policy control and removes the relocated judge run card', () => {
    const markup = html();
    expect(markup).not.toContain('data-testid="judge-run-card"');
    for (const id of ['policy-save', 'policy-default-quota', 'policy-low-funds', 'policy-max-vendors', 'policy-quote-clarification']) {
      expect(markup).toContain(`data-testid="${id}"`);
    }
    const rows = switches(markup);
    expect(rows).toHaveLength(7);
    // External vendor search stays visible, off and inert.
    expect(rows.filter((r) => r.includes('disabled=""') && r.includes('aria-disabled="true"'))).toHaveLength(1);
    expect(markup).toMatch(/aria-checked="false" disabled="" aria-disabled="true"[^>]*>.*?External vendor search.*?Coming soon/s);
    expect(rows.filter((r) => r.includes('aria-checked="true"'))).toHaveLength(3);
    // Save starts disabled: nothing differs from the saved policy.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*data-testid="policy-save"|<button[^>]*data-testid="policy-save"[^>]*disabled=""/);
    expect(markup).not.toContain('data-testid="policy-unsaved"');
  });

  it('uses Lichen roles, not the legacy blue, purple or sky accents', () => {
    const markup = html();
    // Section icon tiles are inline styles; under Lichen they are omitted.
    expect(markup).not.toMatch(/#a855f7|#0ea5e9|#137fec1a/);
    expect(markup.match(/lichen:animate-none!/g)?.length).toBe(4);
    // Stat tiles enter together, not as a staggered cascade.
    expect(markup).not.toMatch(/animation-delay:\s*(60|120|180)ms/);
    for (const row of switches(markup)) expect(row).toContain('lichen:rounded-lg');
    expect(markup).toContain('lichen:bg-lichen lichen:ring-lichen-icon');
    expect(markup).toContain('lichen:bg-primary');
    expect(markup.match(/lichen:text-meta">(Default quota|Low-funds threshold) \(\$\)/g)?.length).toBe(2);
    expect(markup.match(/lichen:bg-input-background/g)?.length).toBe(3);
  });
});

describe('Policy before route activation', () => {
  beforeEach(() => {
    gate.lichen = false;
  });

  it('keeps the legacy section icons and staggered entrance', () => {
    const markup = html();
    expect(markup).toContain('#a855f71a');
    expect(markup).toContain('#0ea5e91a');
    expect(markup).toMatch(/animation-delay:\s*180ms/);
    expect(markup).not.toContain('data-testid="judge-run-card"');
  });
});
