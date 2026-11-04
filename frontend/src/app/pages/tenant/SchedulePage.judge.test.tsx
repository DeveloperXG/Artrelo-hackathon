import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SANDBOX_OFF } from '../../contracts/judgeSandbox';
import type { JudgeView } from '../../components/judge/judgeController';
import { TenantPresentationProvider } from '../../components/tenant/tenantPresentation';
import TenantSchedulePage from './SchedulePage';
const fixture = vi.hoisted(() => ({ view: null as unknown, api: vi.fn() }));
vi.mock('../../api/client', () => ({ TenantAPI: { verifyAppointment: fixture.api }, BookingAPI: {}, EvidenceAPI: {}, ApiError: class extends Error {} }));
vi.mock('../../components/judge/JudgeSandboxProvider', () => ({ useJudgeSandbox: () => ({ view: fixture.view }) }));
vi.mock('../../hooks/useAppointments', () => ({ useAppointments: () => ({ loading: false, error: '', reload: vi.fn(), appointments: [{ _id: 'synthetic_visit', status: 'work_verifying', requestId: { _id: 'synthetic_request', issueTitle: 'Synthetic repair' }, completion: { status: 'submitted', needsVerification: true, workPerformed: 'Synthetic report', photos: [] } }] }) }));
vi.mock('../../hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('../../hooks/tenant/useTenantBadges', () => ({ adjustTenantBadge: vi.fn(), refreshTenantBadges: vi.fn() }));
// Calendar interaction is covered by its maintained tests; this test owns the real page/card wiring.
vi.mock('../../components/landlord/schedule/ScheduleCalendar', () => ({ default: () => null }));
const view = (patch: Partial<JudgeView> = {}): JudgeView => ({ loaded: true, status: { ...SANDBOX_OFF, enabled: true, role: 'tenant', pairLabel: 'Synthetic pair' }, busy: null, notice: null, polling: false, pollExpired: false, refreshFailed: false, ...patch });
const render = (active: boolean) => renderToStaticMarkup(<MemoryRouter><TenantPresentationProvider active={active}><TenantSchedulePage /></TenantPresentationProvider></MemoryRouter>);

describe('trusted judge tenant completion presentation', () => {
  it.each([false, true])('omits only the dispute action in a server-known judge tenant scope, active=%s', active => {
    fixture.view = view();
    const html = render(active);
    expect(html).not.toContain('appointment-dispute-synthetic_visit');
    expect(html).not.toContain('No, still broken');
    expect(html).toContain('appointment-verify-synthetic_visit');
    expect(html).toContain('appointment-rate-4');
    expect(html).toContain('Synthetic report');
    expect(fixture.api).not.toHaveBeenCalled();
  });
  it.each([view({ status: SANDBOX_OFF }), view({ loaded: false }), view({ refreshFailed: true }),
    view({ pollExpired: true }), view({ notice: { kind: 'unknown' } }),
    view({ status: { ...SANDBOX_OFF, enabled: true, role: 'landlord' } }),
  ])('preserves the ordinary action when judge tenant eligibility is absent or untrusted', current => {
    fixture.view = current;
    for (const active of [false, true]) expect(render(active)).toContain('appointment-dispute-synthetic_visit');
  });
});
