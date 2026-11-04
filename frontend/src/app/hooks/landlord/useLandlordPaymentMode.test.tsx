import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { refreshLandlordBadges, useLandlordPaymentMode } from './useLandlordBadges';
const state = vi.hoisted(() => ({ accountId: 'owner-a', mode: 'platform', pending: null as null | Promise<unknown> }));
vi.mock('../../api/client', () => ({ getStoredUser: () => ({ id: state.accountId }),
  LandlordAPI: { badgeCounts: () => state.pending || Promise.resolve({ data: { paymentMode: state.mode } }) } }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: state.accountId } }) }));
function Mode() { return <span>{useLandlordPaymentMode() || 'unknown'}</span>; }
describe('account-scoped payment mode', () => {
  it('hides the prior account mode and discards a response arriving after an account change', async () => {
    await refreshLandlordBadges();
    expect(renderToStaticMarkup(<Mode />)).toContain('platform');
    let resolve!: (value: unknown) => void;
    state.pending = new Promise(done => { resolve = done; });
    const stale = refreshLandlordBadges();
    state.accountId = 'owner-b';
    expect(renderToStaticMarkup(<Mode />)).toContain('unknown');
    resolve({ data: { paymentMode: 'platform' } }); await stale;
    expect(renderToStaticMarkup(<Mode />)).toContain('unknown');
    state.pending = null; state.mode = 'direct'; await refreshLandlordBadges();
    expect(renderToStaticMarkup(<Mode />)).toContain('direct');
  });
});
