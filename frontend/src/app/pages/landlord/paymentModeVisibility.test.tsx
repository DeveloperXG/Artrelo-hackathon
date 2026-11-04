import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import PolicyPage from './PolicyPage';

const state = vi.hoisted(() => ({ mode: null as null | 'direct' | 'platform' }));
vi.mock('../../hooks/landlord/useLandlordBadges', () => ({ useLandlordPaymentMode: () => state.mode }));
vi.mock('../../hooks/landlord/useLandlordPolicy', () => ({ useLandlordPolicy: () => ({ policy: { defaultQuota: 200,
  lowFundsThreshold: 20, maxOutreachAttempts: 3, allowAutopilotForLowSeverity: true, allowAutopilotForMediumSeverity: true },
  setPolicy: vi.fn(), loading: false, reload: vi.fn() }) }));
vi.mock('../../hooks/landlord/useRoutingSetup', () => ({ useRoutingSetup: () => ({ setup: null, reload: vi.fn() }) }));

describe('wallet-only policy controls', () => {
  for (const mode of ['direct', null] as const) it(`hides wallet settings for ${mode ?? 'unknown'} mode while retaining job quotas`, () => {
    state.mode = mode;
    const html = renderToStaticMarkup(<MemoryRouter><PolicyPage /></MemoryRouter>);
    expect(html).not.toContain('Low-funds threshold');
    expect(html).not.toContain('policy-low-funds');
    expect(html).toContain('Spending limits');
    expect(html).toContain('policy-default-quota');
  });
  it('shows wallet settings when platform payouts are enabled', () => {
    state.mode = 'platform';
    const html = renderToStaticMarkup(<MemoryRouter><PolicyPage /></MemoryRouter>);
    expect(html).toContain('Low-funds threshold');
    expect(html).toContain('policy-low-funds');
    expect(html).toContain('Quotas &amp; funds');
  });
});
