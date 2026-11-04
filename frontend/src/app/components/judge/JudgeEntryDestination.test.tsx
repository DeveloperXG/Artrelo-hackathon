import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SANDBOX_OFF } from '../../contracts/judgeSandbox';
import { JudgeSandboxController, type JudgeView } from './judgeController';
import { JudgeSandboxProvider, judgeIdentity, currentController } from './JudgeSandboxProvider';
import { JudgeEntryDestination, JudgeEntryStatus, judgeEntryResolution, signedInHome } from './JudgeEntryDestination';

const auth = vi.hoisted(() => ({ user: { id: 'profile_a', accountId: 'account_a', role: 'landlord' as const } }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => auth }));
const identity = 'landlord:account_a:profile_a';
const enabled = { contractVersion: '1.2.0' as const, enabled: true, role: 'landlord' as const, pairLabel: 'Synthetic pair', simulatedVendorIds: [], run: null };
const view = (patch: Partial<JudgeView> = {}): JudgeView => ({ loaded: true, status: enabled, busy: null, notice: null, polling: false, pollExpired: false, refreshFailed: false, ...patch });

describe('one-time server-confirmed judge landing', () => {
  it('uses authenticated identity only as an entry intent, never as eligibility', () => {
    expect(signedInHome(auth.user)).toEqual({ pathname: '/dashboard', state: { judgeEntryIdentity: identity } });
    expect(signedInHome({ id: 'tenant_a', role: 'tenant' })).toEqual({ pathname: '/portal', state: null });
    expect(judgeEntryResolution(identity, identity, view({ loaded: false }), true)).toBe('checking');
    expect(judgeEntryResolution(identity, identity, view(), false)).toBe('checking');
    expect(judgeEntryResolution(identity, identity, view(), true)).toBe('guide');
    expect(judgeEntryResolution(identity, identity, view({ status: SANDBOX_OFF }), true)).toBe('overview');
    expect(judgeEntryResolution(identity, identity, view({ status: { ...enabled, role: 'tenant' } }), true)).toBe('overview');
  });

  it('never hijacks deliberate later Overview navigation, missing identity, logout or account/profile switch', () => {
    for (const [requested, current] of [[undefined, identity], [null, identity], [identity, null], [identity, 'landlord:account_b:profile_b'], [identity, 'tenant:account_a:profile_t'], ['landlord:account_a:other_profile', identity]]) {
      expect(judgeEntryResolution(requested, current as string | null, view(), true)).toBe('ordinary');
    }
    expect(judgeIdentity(null)).toBeNull();
    const controller = new JudgeSandboxController({ api: { status: vi.fn(), start: vi.fn(), act: vi.fn() } });
    expect(currentController({ identity, controller }, 'landlord:account_b:profile_b')).toBeNull();
  });

  it('uses the existing coalesced controller read; initial failure/malformed status never selects Guide and retry is read-only', async () => {
    for (const first of [async () => { throw Error('offline'); }, async () => ({ data: { ...enabled, extra: true } })]) {
      const api = { status: vi.fn().mockImplementationOnce(first).mockResolvedValue({ data: enabled }), start: vi.fn(), act: vi.fn() };
      const controller = new JudgeSandboxController({ api, isVisible: () => false });
      expect(judgeEntryResolution(identity, identity, controller.getView(), true)).toBe('checking');
      await controller.read();
      expect(judgeEntryResolution(identity, identity, controller.getView(), true)).toBe('unavailable');
      await controller.checkAgain();
      expect(judgeEntryResolution(identity, identity, controller.getView(), true)).toBe('guide');
      expect(api.status).toHaveBeenCalledTimes(2);expect(api.start).not.toHaveBeenCalled();expect(api.act).not.toHaveBeenCalled();controller.dispose();
    }
  });

  it('drops a late eligibility result after identity changes and coalesces a second read', async () => {
    let release!: (value: { data: typeof enabled }) => void;
    const api = { status: vi.fn(() => new Promise<{ data: typeof enabled }>(r => { release = r; })), start: vi.fn(), act: vi.fn() };
    const controller = new JudgeSandboxController({ api });
    const pending = controller.read();const same = controller.read();expect(api.status).toHaveBeenCalledTimes(1);
    controller.dispose();release({ data: enabled });await Promise.all([pending, same]);
    expect(judgeEntryResolution(identity, 'landlord:account_b:profile_b', controller.getView(), false)).toBe('ordinary');
    expect(controller.getView().status.enabled).toBe(false);expect(api.start).not.toHaveBeenCalled();
  });

  it('shows checking/unavailable with only a read-only retry and ordinary Overview escape', () => {
    const render = (unavailable: boolean) => renderToStaticMarkup(<MemoryRouter><JudgeEntryStatus unavailable={unavailable} onCheckAgain={vi.fn()} /></MemoryRouter>);
    expect(render(false)).toContain('role="status"');expect(render(false)).not.toContain('<button');
    expect(render(true)).toContain('Nothing was started');expect(render(true)).toContain('Check access again');expect(render(true)).toContain('href="/dashboard"');
    expect(render(true)).not.toMatch(/Start guided run|Continue|Approve|Consent|Pay/);
  });

  it('keeps the real ordinary child visible when no entry intent is present, without starting a run', () => {
    const api = { status: vi.fn(), start: vi.fn(), act: vi.fn() }, controller = new JudgeSandboxController({ api });controller.view = view();
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/dashboard']}><JudgeSandboxProvider controller={controller}><JudgeEntryDestination><p>Ordinary Overview</p></JudgeEntryDestination></JudgeSandboxProvider></MemoryRouter>);
    expect(html).toContain('Ordinary Overview');expect(api.status).not.toHaveBeenCalled();expect(api.start).not.toHaveBeenCalled();expect(api.act).not.toHaveBeenCalled();
  });

  it('rechecks a retained reload entry once, then consumes its replace intent so Back/Overview cannot loop', () => {
    const landing = signedInHome(auth.user);
    expect(judgeEntryResolution(landing.state?.judgeEntryIdentity, identity, view({ loaded: false }), true)).toBe('checking');
    expect(judgeEntryResolution(landing.state?.judgeEntryIdentity, identity, view(), true)).toBe('guide');
    // Both resolved destinations use replace with cleared state; a later visit
    // with the resulting navigation state is ordinary, even for an enabled pair.
    expect(judgeEntryResolution(null, identity, view(), true)).toBe('ordinary');
    expect(judgeEntryResolution(undefined, identity, view(), true)).toBe('ordinary');
    expect(judgeEntryResolution(landing.state?.judgeEntryIdentity, identity, view({ status: SANDBOX_OFF }), true)).toBe('overview');
  });
});
