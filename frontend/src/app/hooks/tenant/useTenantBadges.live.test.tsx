import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { adjustTenantBadge, refreshTenantBadges, useTenantBadges } from './useTenantBadges';
const state = vi.hoisted(() => ({ user: null as null | { id: string; accountId: string; role: string }, api: vi.fn(), topics: null as string[] | null, nudge: (() => {}) as () => void }));
vi.mock('../../api/client', () => ({ getStoredUser: () => state.user, TenantAPI: { badgeCounts: () => state.api() } }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock('../useLiveTopic', () => ({ useLiveTopic: (topics: string[] | null, handler: () => void) => { state.topics = topics; state.nudge = handler; } }));
function Count() { return <output>{useTenantBadges().counts.schedule}</output>; }
const shown = () => renderToStaticMarkup(<MemoryRouter initialEntries={['/portal']}><Count /></MemoryRouter>);
const count = () => Number(shown().match(/<output>(\d+)<\/output>/)![1]);
const data = (schedule: number) => ({ data: { schedule } });
const deferred = () => { let resolve!: (v: ReturnType<typeof data>) => void; const promise = new Promise<ReturnType<typeof data>>(r => { resolve = r; }); return { promise, resolve }; };
let identity = 0;
beforeEach(() => { state.user = { id: `tenant-${++identity}`, accountId: 'account-a', role: 'tenant' }; state.api.mockReset().mockResolvedValue(data(0)); });

describe('tenant live navigation counts', () => {
  it('reflects newly required and resolved answers from existing event-driven API reads', async () => {
    await refreshTenantBadges(); shown(); expect(state.topics).toEqual(['requests', 'notifications']);
    state.api.mockResolvedValue(data(2)); state.nudge(); await Promise.resolve(); expect(count()).toBe(2);
    state.api.mockResolvedValue(data(0)); state.nudge(); await Promise.resolve(); expect(count()).toBe(0);
  });
  it('drops stale overlapping counts and protects a local answer from an older read', async () => {
    state.api.mockResolvedValue(data(3)); await refreshTenantBadges();
    const old = deferred(), fresh = deferred();
    state.api.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    const a = refreshTenantBadges(), b = refreshTenantBadges();
    fresh.resolve(data(1)); await b; old.resolve(data(3)); await a; expect(count()).toBe(1);
    const late = deferred(); state.api.mockImplementationOnce(() => late.promise);
    const pending = refreshTenantBadges(); adjustTenantBadge('schedule', -1); late.resolve(data(1)); await pending;
    expect(count()).toBe(0);
  });
  it('hides previous-account/role counts immediately and ignores late old-account reads', async () => {
    state.api.mockResolvedValue(data(3)); await refreshTenantBadges();
    const old = deferred(); state.api.mockImplementationOnce(() => old.promise); const pending = refreshTenantBadges();
    state.user = { ...state.user!, accountId: 'account-b' }; expect(count()).toBe(0);
    state.api.mockResolvedValue(data(1)); await refreshTenantBadges(); old.resolve(data(9)); await pending; expect(count()).toBe(1);
    state.user = { ...state.user, role: 'landlord' }; expect(count()).toBe(0);
    state.user = null; shown(); expect(state.topics).toBeNull(); state.api.mockClear();
    await refreshTenantBadges(); expect(state.api).not.toHaveBeenCalled();
  });
  it('retains current-account known data on a failed read instead of inventing zero', async () => {
    state.api.mockResolvedValue(data(2)); await refreshTenantBadges();
    state.api.mockRejectedValue(new Error('offline')); await refreshTenantBadges(); expect(count()).toBe(2);
  });
});
