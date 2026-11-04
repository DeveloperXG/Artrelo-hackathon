import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { adjustLandlordBadge, markWalletSeen, refreshLandlordBadges, useLandlordBadges } from './useLandlordBadges';

const state = vi.hoisted(() => ({
  user: null as null | { id: string; accountId: string; role: string },
  api: vi.fn(), topics: null as string[] | null, nudge: (() => {}) as () => void,
}));
vi.mock('../../api/client', () => ({ getStoredUser: () => state.user, LandlordAPI: { badgeCounts: (...args: unknown[]) => state.api(...args) } }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('../useLiveTopic', () => ({ useLiveTopic: (topics: string[] | null, handler: () => void) => { state.topics = topics; state.nudge = handler; } }));
function Counts() { const { counts } = useLandlordBadges(); return <output>{JSON.stringify(counts)}</output>; }
const shown = () => renderToStaticMarkup(<MemoryRouter initialEntries={['/dashboard/policy']}><Counts /></MemoryRouter>);
const readCounts = () => JSON.parse(shown().match(/<output>(.*?)<\/output>/)![1].replaceAll('&quot;', '"'));
const data = (decisions = 0, schedule = 0, requests = 0, wallet = 0) => ({ data: { decisions, schedule, requests, wallet, paymentMode: 'platform' } });
const deferred = () => { let resolve!: (v: ReturnType<typeof data>) => void; const promise = new Promise<ReturnType<typeof data>>(r => { resolve = r; }); return { promise, resolve }; };
let identity = 0;
beforeEach(() => { state.user = { id: `landlord-${++identity}`, accountId: 'account-a', role: 'landlord' }; state.api.mockReset().mockResolvedValue(data()); });

describe('landlord live navigation counts', () => {
  it('refetches all four authoritative counts on a domain nudge without navigation', async () => {
    await refreshLandlordBadges(); shown();
    expect(state.topics).toEqual(['requests', 'notifications', 'wallet']);
    state.api.mockResolvedValue(data(1, 2, 3, 4)); state.nudge(); await Promise.resolve();
    expect(readCounts()).toEqual({ decisions: 1, schedule: 2, requests: 3, wallet: 4 });
    state.api.mockResolvedValue(data(0, 0, 0, 1)); state.nudge(); await Promise.resolve();
    expect(readCounts()).toEqual({ decisions: 0, schedule: 0, requests: 0, wallet: 1 });
  });

  it('discards older overlapping reads rather than undoing a newer create/resolve result', async () => {
    await refreshLandlordBadges();
    const old = deferred(), fresh = deferred();
    state.api.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    const a = refreshLandlordBadges(), b = refreshLandlordBadges();
    fresh.resolve(data(0, 1, 0, 2)); await b;
    old.resolve(data(5, 5, 5, 5)); await a;
    expect(readCounts()).toEqual({ decisions: 0, schedule: 1, requests: 0, wallet: 2 });
  });

  it('does not leak counts across account or role changes, including late answers', async () => {
    state.api.mockResolvedValue(data(2, 2, 2, 2)); await refreshLandlordBadges();
    const old = deferred(); state.api.mockImplementationOnce(() => old.promise);
    const pending = refreshLandlordBadges();
    state.user = { ...state.user!, accountId: 'account-b' };
    expect(readCounts()).toEqual({ decisions: 0, schedule: 0, requests: 0, wallet: 0 });
    state.api.mockResolvedValue(data(1)); await refreshLandlordBadges();
    old.resolve(data(9, 9, 9, 9)); await pending;
    expect(readCounts().decisions).toBe(1);
    state.user = { ...state.user, role: 'tenant' };
    expect(readCounts().decisions).toBe(0);
    state.user = null; shown(); expect(state.topics).toBeNull();
    state.api.mockClear(); await refreshLandlordBadges(); expect(state.api).not.toHaveBeenCalled();
  });

  it('keeps last known current-account counts on failure and rejects reads predating a local answer', async () => {
    state.api.mockResolvedValue(data(2)); await refreshLandlordBadges();
    const old = deferred(); state.api.mockImplementationOnce(() => old.promise);
    const pending = refreshLandlordBadges(); adjustLandlordBadge('decisions', -1);
    old.resolve(data(2)); await pending; expect(readCounts().decisions).toBe(1);
    state.api.mockRejectedValue(new Error('offline')); await refreshLandlordBadges();
    expect(readCounts().decisions).toBe(1);
  });

  it('sends existing seen marks without clearing decision work or guessing Wallet exclusions', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) } });
    try {
      state.api.mockResolvedValue(data(2, 0, 0, 1)); await refreshLandlordBadges();
      markWalletSeen(); await Promise.resolve();
      expect(state.api.mock.lastCall?.[0].walletSeenAt).toMatch(/^\d{4}-/);
      expect(readCounts()).toEqual({ decisions: 2, schedule: 0, requests: 0, wallet: 1 });
      // Principal's same-shape authoritative exclusion can return zero; no client subtraction.
      state.api.mockResolvedValue(data(2)); state.nudge(); await Promise.resolve();
      expect(readCounts().wallet).toBe(0); expect(readCounts().decisions).toBe(2);
    } finally { vi.unstubAllGlobals(); }
  });
});
