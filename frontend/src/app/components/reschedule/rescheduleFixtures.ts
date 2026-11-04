import type { RescheduleView } from '../../types/booking';

/** Test fixture: a pending change awaiting the tenant. Synthetic ids only. */
export const change = (over: Partial<RescheduleView> = {}): RescheduleView => ({ ref: '6ae2c0000000000000000001', revision: 2,
  status: 'awaiting_tenant', active: true, reason: 'Tenant asked for an afternoon visit.',
  original: { start: '2026-11-02T15:00:00Z', end: '2026-11-02T17:00:00Z' },
  proposed: { start: '2026-11-03T20:00:00Z', end: '2026-11-03T22:00:00Z' }, outsideSuggestedWindows: false,
  slotKey: 'a'.repeat(64), windows: [{ start: '2026-11-03T19:00:00Z', end: '2026-11-03T23:00:00Z' }],
  expiresAt: '2026-10-31T12:00:00Z', vendorResponse: 'accepted', tenantResponse: 'pending',
  canVendorConfirm: false, canTenantRespond: true, canDecline: true, delivery: [], events: [], ...over });
