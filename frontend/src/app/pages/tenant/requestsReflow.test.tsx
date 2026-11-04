import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import RequestsPage from './RequestsPage';

vi.mock('../../hooks/tenant/useTenantRequests', () => ({ useTenantRequests: () => ({ requests: [{ _id: 'owned_request', status: 'completed', issueTitle: 'Synthetic sink repair', category: 'Plumbing', createdAt: '2026-10-31T20:00:00Z' }], setRequests: vi.fn(), loading: false, error: '', reload: vi.fn() }) }));
vi.mock('../../hooks/tenant/useTenantMoveOut', () => ({ useTenantMoveOut: () => ({ linked: false }) }));
vi.mock('../../hooks/tenant/useRequestQuota', () => ({ useRequestQuota: () => ({ quota: null, gate: { status: 'loading' }, reload: vi.fn() }) }));
vi.mock('../../hooks/useAppointments', () => ({ useAppointments: () => ({ appointments: [] }) }));

describe('tenant request reflow preserves controls and states', () => {
  it('retains named filters, view tabs and keyboard request navigation with completion status', () => {
    const html = renderToStaticMarkup(<MemoryRouter><RequestsPage /></MemoryRouter>);
    expect(html).toContain('Maintenance Requests');
    expect(html).toContain('data-testid="tenant-view-active"');
    expect(html).toContain('data-testid="tenant-view-archived"');
    expect(html).toContain('role="link" tabindex="0" aria-label="Open request: Synthetic sink repair"');
    expect(html).toContain('Completed');
    expect(html).toContain('All categories');
    expect(html).toContain('All statuses');
    expect(html).toContain('All process stages');
    expect(html).toMatch(/data-testid="new-request-btn"[^>]*disabled=""|disabled=""[^>]*data-testid="new-request-btn"/);
    expect(html).not.toContain('delete-pending-owned_request');
  });
});
