import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SANDBOX_OFF } from '../../contracts/judgeSandbox';

// Offline hook host: the real page, shared presentation and judge money gate
// render; only identity/API/live/badge/beta boundaries are synthetic. This is
// source/state coverage, not browser, native input, layout or payment proof.
const host = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0, effects: [] as (() => unknown)[], cleanups: [] as (() => void)[],
  mode: 'platform' as string | null, view: {} as any, data: {} as any,
  getLedger: vi.fn(), mark: vi.fn(), retry: vi.fn(), seen: vi.fn(), live: null as null | (() => void),
}));
const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => { const i = host.cursor++; if (!host.slots[i]) host.slots[i] = { value: typeof initial === 'function' ? (initial as () => unknown)() : initial }; return [host.slots[i].value, (next: unknown) => { host.slots[i].value = typeof next === 'function' ? (next as (v: unknown) => unknown)(host.slots[i].value) : next; }]; },
  useRef: (value: unknown) => { const i = host.cursor++; return host.slots[i] ||= { current: value }; },
  useCallback: (fn: unknown, deps: unknown[]) => { const i = host.cursor++, old = host.slots[i]; if (!old || !same(old.deps, deps)) host.slots[i] = { value: fn, deps }; return host.slots[i].value; },
  useEffect: (effect: () => unknown, deps: unknown[]) => { const i = host.cursor++, old = host.slots[i]; if (!old || !same(old.deps, deps)) { host.slots[i] = { deps }; host.effects.push(effect); } },
}));
vi.mock('../../api/client', () => ({ LandlordAPI: { getLedger: (...args: unknown[]) => host.getLedger(...args), markPayoutPaid: (...args: unknown[]) => host.mark(...args), retryPayout: (...args: unknown[]) => host.retry(...args) } }));
vi.mock('../../hooks/landlord/useLandlordBadges', () => ({ markWalletSeen: () => host.seen(), useLandlordPaymentMode: () => host.mode, refreshLandlordBadges: vi.fn() }));
vi.mock('../../hooks/landlord/useBetaStatus', () => ({ useBetaStatus: () => ({ beta: null, openOffer: vi.fn() }) }));
vi.mock('../../hooks/useLiveTopic', () => ({ useLiveTopic: (_: string, callback: () => void) => { host.live = callback; } }));
vi.mock('../../components/judge/JudgeSandboxProvider', () => ({ useJudgeSandbox: () => ({ view: host.view }), useJudgeSandboxEnabled: () => Boolean(host.view.status.enabled) }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'synthetic_landlord' } }) }));
vi.mock('../../lib/dismissedBanners', () => ({ isBannerDismissed: () => false, dismissBanner: vi.fn() }));
vi.mock('../../components/landlord/WalletDepositForm', () => ({ default: () => { throw new Error('Payment provider form must remain unmounted in this offline test'); } }));
import WalletPage from './WalletPage';
import FilterChips from '../../components/landlord/FilterChips';
import TablePagination from '../../components/landlord/TablePagination';
import { FormDialog } from '../../components/landlord/landlordUi';

const nodes = (node: ReactNode): ReactElement<any>[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement(node) ? [node as ReactElement<any>, ...nodes((node as ReactElement<any>).props.children)] : [];
let tree: ReactNode;
function page() { host.cursor = 0; tree = WalletPage(); return tree; }
async function flush() { for (const effect of host.effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === 'function') host.cleanups.push(cleanup as () => void); } await Promise.resolve(); await Promise.resolve(); return page(); }
function html() { return renderToStaticMarkup(<MemoryRouter initialEntries={['/dashboard/wallet']}>{tree}</MemoryRouter>); }
const entry = (extra: Record<string, unknown> = {}) => ({ id: 'synthetic_entry', type: 'payout', title: 'Synthetic completed repair', direction: 'out', amount: 240, currency: 'CAD', createdAt: '2026-11-03T10:00:00Z', provider: 'manual', providerStatus: 'pending_manual', providerRef: null, shortfall: false, vendorName: 'Synthetic vendor', ...extra });
beforeEach(() => {
  vi.clearAllMocks(); host.slots = []; host.effects = []; host.cleanups = []; host.cursor = 0; host.mode = 'platform';
  host.view = { loaded: true, refreshFailed: false, status: SANDBOX_OFF };
  host.data = { balance: { available: 0, held: 0, arrears: 0, lifetimeDeposited: 0, lifetimeReleased: 240, currency: 'CAD' }, owedToVendors: 0, bookingShortfall: 0, clearing: [], externalDeposits: 0, payoutProvider: 'manual', pendingPayouts: 240, paymentMode: 'platform', entries: [entry()] };
  host.getLedger.mockImplementation(async () => ({ data: host.data }));
});

describe('Wallet/Payments preserved money and read boundaries', () => {
  it('keeps zero, pending manual and missing bank receipt truthful for the synthetic sandbox, with no money control/provider mount', async () => {
    host.view.status = { ...SANDBOX_OFF, enabled: true };
    page(); expect(html()).toContain('Loading wallet'); await flush();
    const result = html(); expect(result).toContain('wallet-available'); expect(result).toContain('$0.00');
    expect(result).toContain('Pay manually'); expect(result).toContain('no real money was sent'); expect(result).toContain('no bank receipt is verified');
    expect(result).toContain('payments still pending'); expect(result).not.toContain('wallet-add-funds'); expect(result).not.toContain('wallet-mark-paid-'); expect(result).not.toContain('Ref:');
    expect(host.mark).not.toHaveBeenCalled(); expect(host.retry).not.toHaveBeenCalled();
  });
  it.each([{ loaded: false, refreshFailed: false }, { loaded: true, refreshFailed: true }])('keeps existing unknown eligibility money gate closed: %j', async state => {
    Object.assign(host.view, state); page(); await flush(); const result = html();
    expect(result).not.toContain('wallet-add-funds'); expect(result).not.toContain('wallet-mark-paid-'); expect(host.mark).not.toHaveBeenCalled();
  });
  it('keeps direct Payments separate from wallet money/provider and preserves the request identity and recorded zero', async () => {
    host.mode = 'direct'; host.data.paymentMode = 'direct'; host.data.directPayments = { due: [{ appointmentId: 'visit_a', requestId: 'request_a', issueTitle: 'Long supplied issue title', property: 'Synthetic home', unit: '12', vendorName: 'Synthetic vendor', amount: 0, status: 'due', dueSince: '2026-11-03T10:00:00Z', paidAt: null, reference: null }], paid: [], dueTotal: 0 };
    page(); await flush(); const result = html(); expect(result).toContain('Payments'); expect(result).toContain('/dashboard/requests/request_a'); expect(result).toContain('$0.00'); expect(result).toContain('Mark paid');
    expect(result).not.toContain('wallet-available'); expect(result).not.toContain('wallet-add-funds'); expect(host.mark).not.toHaveBeenCalled();
  });
  it('preserves the existing unknown payment-mode fallback without inventing a direct-pay result', async () => {
    host.mode = null; host.data.paymentMode = null; page(); expect(html()).toContain('Loading payments'); await flush(); expect(html()).toContain('wallet-available');
  });
  it('preserves initial error/retry, exact server filter/page arguments, live refresh and seen lifecycle', async () => {
    host.getLedger.mockRejectedValueOnce(new Error('Synthetic offline read')); page(); await flush(); expect(html()).toContain('Synthetic offline read');
    nodes(tree).find(n => n.props.onRetry)!.props.onRetry(); await Promise.resolve(); page(); expect(html()).toContain('Transactions');
    const filters = nodes(tree).find(n => n.type === FilterChips)!; filters.props.onChange('paid'); page(); await flush(); expect(host.getLedger).toHaveBeenLastCalledWith({ page: 1, limit: 20, kind: 'paid' });
    host.data = { ...host.data, pagination: { page: 1, limit: 20, total: 25, totalPages: 2, kind: 'paid' } }; host.live!(); await Promise.resolve(); page();
    nodes(tree).find(n => n.type === TablePagination)!.props.onPageChange(2); page(); await flush(); expect(host.getLedger).toHaveBeenLastCalledWith({ page: 2, limit: 20, kind: 'paid' });
    expect(host.seen).toHaveBeenCalledTimes(1); host.cleanups.forEach(fn => fn()); expect(host.seen).toHaveBeenCalledTimes(2);
  });
  it('preserves every supplied payout status, long source labels and signed row amounts without summing or hiding unknown balances', async () => {
    const states = ['paid', 'pending', 'pending_manual', 'pending_onboarding', 'awaiting_funds', 'awaiting_clearance', 'failed'];
    const long = 'SyntheticUnbrokenVendorAndRequestReference'.repeat(8);
    host.data.entries = states.map((providerStatus, i) => entry({ id: 'entry_' + i, providerStatus, amount: i === 0 ? 0 : 240, title: long + i, vendorName: long, balanceAfter: i === 0 ? { available: 0, held: 0 } : null, clearsOn: '2026-11-05T00:00:00Z' }));
    page(); await flush(); const result = html();
    for (const label of ['Paid', 'Sending', 'Pay manually', 'Vendor setting up payouts', 'Waiting on your top-up', 'Clearing at Stripe', 'Failed']) expect(result).toContain(label);
    for (let i = 0; i < states.length; i++) expect(result).toContain(long + i);
    expect(result).toContain('\u2212$0.00'); expect(result).toContain('\u2212$240.00'); expect(result).toContain('Balance $0.00');
    expect(host.mark).not.toHaveBeenCalled(); expect(host.retry).not.toHaveBeenCalled();
  });
  it('keeps source references and exact action identities, without automatic retry or payout', async () => {
    host.data.entries = [entry({ providerStatus: 'failed', provider: 'stripe_connect', providerRef: 'synthetic_ref' })]; page(); await flush(); const result = html(); expect(result).toContain('Ref: synthetic_ref'); expect(result).toContain('Failed');
    expect(host.retry).not.toHaveBeenCalled(); const retry = nodes(tree).find(n => n.props.onClick && Array.isArray(n.props.children) && n.props.children.some((child: unknown) => typeof child === 'string' && child.trim() === 'Retry'))!; expect(retry).toBeTruthy(); await retry.props.onClick(); expect(host.retry).toHaveBeenCalledExactlyOnceWith('synthetic_entry');
    expect(host.mark).not.toHaveBeenCalled();
    expect(nodes(tree).find(n => n.type === FormDialog)!.props.open).toBe(false);
  });
});
