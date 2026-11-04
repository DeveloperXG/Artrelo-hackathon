import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import appealNoteFixture from '../../../qa/d5-appeal/note747.json';

// Deterministic hook/lifecycle host, not React DOM/browser acceptance. Real
// parent handlers/load paths execute; actual mount/portal/focus replay is QA.
const host = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0, effects: [] as (() => void)[], dirty: false,
  id: 'request_a', user: { id: 'tenant_a', role: 'tenant' } as { id: string; role: string } | null,
  active: true, records: {} as Record<string, any>, requests: [] as any[],
  get: vi.fn(), appeal: vi.fn(), reload: vi.fn(), toast: vi.fn(), navigate: vi.fn(),
  params: new URLSearchParams(), setParams: vi.fn(), markSeen: vi.fn(), reloadRouting: vi.fn(),
}));
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  return { ...actual,
    useState: (initial: unknown) => {
      const i = host.cursor++;
      if (!host.slots[i]) host.slots[i] = { value: typeof initial === 'function' ? (initial as () => unknown)() : initial };
      return [host.slots[i].value, (next: unknown) => { const old = host.slots[i].value; const value = typeof next === 'function' ? (next as (old: unknown) => unknown)(old) : next; if (!Object.is(old, value)) { host.slots[i].value = value; host.dirty = true; } }];
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const i = host.cursor++, previous = host.slots[i];
      if (changed(previous?.deps, deps)) { host.slots[i] = { deps, cleanup: previous?.cleanup }; host.effects.push(() => { previous?.cleanup?.(); host.slots[i].cleanup = effect(); }); }
    },
    useMemo: (calculate: () => unknown, deps?: unknown[]) => { const i = host.cursor++; if (changed(host.slots[i]?.deps, deps)) host.slots[i] = { deps, value: calculate() }; return host.slots[i].value; },
  };
});
vi.mock('react-router-dom', async original => ({ ...await original<typeof import('react-router-dom')>(), useParams: () => ({ id: host.id }), useNavigate: () => host.navigate, useSearchParams: () => [host.params, host.setParams] }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: host.user }) }));
vi.mock('../api/client', () => ({ ApiError: class extends Error {}, TenantAPI: { getRequest: (...a: any[]) => host.get(...a), appealRequest: (...a: any[]) => host.appeal(...a) }, LandlordAPI: {} }));
vi.mock('sonner', () => ({ toast: { error: (...a: any[]) => host.toast(...a), success: vi.fn(), info: vi.fn() } }));
vi.mock('../hooks/useLiveTopic', () => ({ useLiveTopic: () => {} }));
vi.mock('../hooks/landlord/useRoutingSetup', () => ({ useRoutingSetup: () => ({ setup: null, reload: host.reloadRouting }) }));
vi.mock('../hooks/landlord/useRequestTabSeen', () => ({ useRequestTabSeen: () => ({ seen: null, markSeen: host.markSeen }) }));
vi.mock('../hooks/landlord/useNewRequests', () => ({ markRequestOpened: () => {} }));
vi.mock('./request-detail/d3Presentation', async original => ({ ...await original<typeof import('./request-detail/d3Presentation')>(), useD3PageActive: () => false }));
vi.mock('./tenant/tenantPresentation', async original => ({ ...await original<typeof import('./tenant/tenantPresentation')>(), useTenantPresentation: () => host.active }));
vi.mock('./request-detail/TenantRequestDetailView', () => ({ default: () => null }));
vi.mock('./request-detail/LandlordRequestDetailView', () => ({ default: () => null }));
// Read-only second caller executes its actual target/submission handlers.
vi.mock('../hooks/tenant/useTenantRequests', () => ({ useTenantRequests: () => ({ requests: host.requests, setRequests: vi.fn(), loading: false, error: '', reload: host.reload }) }));
vi.mock('../hooks/tenant/useTenantMoveOut', () => ({ useTenantMoveOut: () => ({ linked: true }) }));
vi.mock('../hooks/tenant/useRequestQuota', () => ({ useRequestQuota: () => ({ quota: null, gate: { allowed: true, reasons: [] }, reload: vi.fn() }) }));
vi.mock('../hooks/useAppointments', () => ({ useAppointments: () => ({ appointments: [] }) }));
vi.mock('./landlord/landlordUi', async original => ({ ...await original<typeof import('./landlord/landlordUi')>(), useLandlordEntrance: () => {} }));
vi.mock('./tenant/TenantDialogs', async original => ({ ...await original<typeof import('./tenant/TenantDialogs')>(), useTenantConfirmationFocus: () => ({}) }));

import RequestDetail from './RequestDetail';
import RequestsPage from '../pages/tenant/RequestsPage';
import TenantRequestDetailView from './request-detail/TenantRequestDetailView';
import { AppealRequestDialog } from './tenant/AppealRequestDialog';

const record = (id: string) => ({ _id: id, issueTitle: 'Synthetic kitchen leak', issueDescription: 'Synthetic description.', status: 'rejected', lifecycleStatus: 'rejected', category: 'Plumbing', tenantId: 'tenant_a', createdAt: '2026-11-01T12:00:00Z', propertyId: { name: 'Cedar Court' }, unitId: { unitNumber: '4B' }, appeal: { state: 'available', canAppeal: true, rejectIsFinal: false }, rejectionReason: 'Synthetic rejection.', timeline: [], comments: [] });
const draft747 = appealNoteFixture.note;
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function nodes(node: ReactNode): ReactElement<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!isValidElement(node)) return []; const e = node as ReactElement<any>; return [e, ...nodes(e.props.children)]; }
let tree: ReactNode;
function render(component = RequestDetail, effects = true) { let loops = 0; do { if (++loops > 12) throw Error('Hook host render loop'); host.cursor = 0; host.dirty = false; tree = component(); if (effects) host.effects.splice(0).forEach(effect => effect()); } while (effects && host.dirty); return tree; }
const dialog = () => nodes(tree).find(e => e.type === AppealRequestDialog)?.props;
const view = () => nodes(tree).find(e => e.type === TenantRequestDetailView)?.props;
const open = (note = draft747) => { view()!.onAppeal(); render(); dialog()!.onNoteChange(note); render(); };
async function ready() { render(); await tick(); render(); expect(view()).toBeTruthy(); }
function resetHost() { for (const s of host.slots) s?.cleanup?.(); host.slots = []; host.effects = []; host.cursor = 0; host.dirty = false; }
beforeEach(() => {
  resetHost(); host.id = 'request_a'; host.user = { id: 'tenant_a', role: 'tenant' }; host.active = true; host.params = new URLSearchParams();
  host.records = { request_a: record('request_a'), request_b: record('request_b') }; host.requests = Object.values(host.records);
  host.get.mockReset().mockImplementation(async (id: string) => ({ data: host.records[id] })); host.appeal.mockReset(); host.reload.mockReset(); host.toast.mockClear();
  const win = Object.assign(new EventTarget(), { setInterval: () => 1, clearInterval: () => {}, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
  vi.stubGlobal('window', win); vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'hidden' }));
});
afterEach(() => { resetHost(); vi.unstubAllGlobals(); });

describe('detail appeal retention (deterministic host; real browser replay separate)', () => {
  it.each([true, false])('keeps the exact747 raw characters through pending/refusal/loading unmount for active=%s without automatic retry', async active => {
    host.active = active; await ready(); open(); expect(draft747).toHaveLength(747);
    const refusal = deferred<any>(), refresh = deferred<any>(); host.appeal.mockReturnValueOnce(refusal.promise); host.get.mockReturnValueOnce(refresh.promise);
    const pending = dialog()!.onConfirm(draft747.trim()); render(); expect(dialog()!.busy).toBe(true); expect(dialog()!.note).toBe(draft747);
    refusal.reject(new Error('Synthetic server refusal')); await tick(); render(); expect(dialog()).toBeUndefined(); // real early loading return excludes child
    refresh.resolve({ data: { ...host.records.request_a, appeal: { ...host.records.request_a.appeal, canAppeal: false } } }); await pending; render();
    expect(dialog()!.note).toBe(draft747); expect(dialog()!.target.requestId).toBe('request_a'); expect(dialog()!.busy).toBe(false);
    expect(host.appeal).toHaveBeenCalledExactlyOnceWith('request_a', draft747.trim()); expect(host.toast).toHaveBeenCalledWith('Synthetic server refusal'); expect(view()!.request.appeal.canAppeal).toBe(false);
  });
  it('retains a same-target draft through the existing silent stale/read refresh without submitting it', async () => {
    await ready(); open(); const refresh = deferred<any>(); host.get.mockReturnValueOnce(refresh.promise);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); window.dispatchEvent(new Event('focus')); render(); expect(dialog()!.note).toBe(draft747);
    refresh.resolve({ data: { ...host.records.request_a, issueTitle: 'Fresh server title', appeal: { ...host.records.request_a.appeal, canAppeal: false } } }); await tick(); render();
    expect(dialog()!.note).toBe(draft747); expect(view()!.request.issueTitle).toBe('Fresh server title'); expect(view()!.request.appeal.canAppeal).toBe(false); expect(host.appeal).not.toHaveBeenCalled();
  });
  it('clears on explicit cancel and success, and never resubmits by itself', async () => {
    await ready(); open(); dialog()!.onClose(); render(); expect(dialog()!.target).toBeNull(); expect(dialog()!.note).toBe('');
    open('New appeal'); host.appeal.mockResolvedValueOnce({}); await dialog()!.onConfirm('New appeal'); render(); expect(dialog()!.target).toBeNull(); expect(dialog()!.note).toBe(''); expect(host.appeal).toHaveBeenCalledTimes(1);
  });
  it.each(['request', 'identity', 'role', 'signed-out'] as const)('hides a draft immediately and clears it on %s change, including return to original scope', async change => {
    await ready(); open(); const oldChange = dialog()!.onNoteChange;
    if (change === 'request') host.id = 'request_b'; else if (change === 'identity') host.user = { id: 'tenant_b', role: 'tenant' }; else if (change === 'role') host.user = { id: 'tenant_a', role: 'landlord' }; else host.user = null;
    render(RequestDetail, false); expect(dialog()?.target ?? null).toBeNull(); expect(dialog()?.note ?? '').toBe(''); oldChange('stale callback'); render();
    host.id = 'request_a'; host.user = { id: 'tenant_a', role: 'tenant' }; render(); await tick(); render(); expect(dialog()!.target).toBeNull(); expect(dialog()!.note).toBe(''); expect(host.appeal).not.toHaveBeenCalled();
  });
  it('does not let an old response clear a newly opened draft after request A -> B -> A', async () => {
    await ready(); open(); const response = deferred<any>(); host.appeal.mockReturnValueOnce(response.promise); const submitted = dialog()!.onConfirm(draft747.trim()); render();
    host.id = 'request_b'; render(); await tick(); render(); host.id = 'request_a'; render(); await tick(); render(); open('New request-scoped draft');
    response.resolve({}); await submitted; render(); expect(dialog()!.note).toBe('New request-scoped draft'); expect(dialog()!.target.requestId).toBe('request_a'); expect(host.appeal).toHaveBeenCalledTimes(1);
  });
});

describe('read-only RequestsPage second caller compatibility', () => {
  it('continues using the default uncontrolled seam, retains target after refusal and clears target on cancel/success', async () => {
    render(RequestsPage); const event = { stopPropagation: vi.fn() }; const button = nodes(tree).find(e => e.props['data-testid'] === 'appeal-request_a'); expect(button).toBeTruthy(); button!.props.onClick(event); render(RequestsPage);
    expect(dialog()!.note).toBeUndefined(); expect(dialog()!.onNoteChange).toBeUndefined(); expect(dialog()!.target.requestId).toBe('request_a');
    const refused = deferred<any>(); host.appeal.mockReturnValueOnce(refused.promise); const pending = dialog()!.onConfirm('Normalized list appeal'); render(RequestsPage); expect(dialog()!.busy).toBe(true); expect(dialog()!.target.requestId).toBe('request_a');
    refused.reject(new Error('Synthetic list refusal')); await pending; render(RequestsPage);
    expect(dialog()!.target.requestId).toBe('request_a'); expect(host.reload).toHaveBeenCalledWith({ silent: true }); expect(host.appeal).toHaveBeenCalledExactlyOnceWith('request_a', 'Normalized list appeal');
    dialog()!.onClose(); render(RequestsPage); expect(dialog()!.target).toBeNull();
    nodes(tree).find(e => e.props['data-testid'] === 'appeal-request_b')!.props.onClick(event); render(RequestsPage); host.appeal.mockResolvedValueOnce({}); await dialog()!.onConfirm('Second target'); render(RequestsPage); expect(dialog()!.target).toBeNull(); expect(host.reload).toHaveBeenLastCalledWith(); expect(event.stopPropagation).toHaveBeenCalledTimes(2);
  });
});
