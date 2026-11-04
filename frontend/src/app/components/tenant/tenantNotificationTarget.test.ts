import { describe, expect, it } from 'vitest';
import type { AppNotification } from '../../api/client';
import { tenantNotificationTarget } from './tenantNotificationTarget';

const make = (type: string, metadata: AppNotification['metadata'] = {}): AppNotification => ({
  _id: 'n1',
  type,
  title: 't',
  message: 'm',
  read: false,
  createdAt: '2026-10-08T00:00:00Z',
  metadata,
});

describe('tenantNotificationTarget', () => {
  it('opens the request a notification is about', () => {
    expect(tenantNotificationTarget(make('request_rejected', { workOrderId: 'r1' }))).toBe('/portal/requests/r1');
    expect(tenantNotificationTarget(make('maintenance_scheduled', { workOrderId: 'r2' }))).toBe('/portal/requests/r2');
  });

  it('sends appointment news with no request to the schedule', () => {
    expect(tenantNotificationTarget(make('appointment_reminder'))).toBe('/portal/schedule');
  });

  it('honours actionUrl only inside the tenant portal', () => {
    expect(tenantNotificationTarget(make('tenant_move_out_requested', { actionUrl: '/portal' }))).toBe('/portal');
    expect(tenantNotificationTarget(make('x', { actionUrl: '/dashboard/requests' }))).toBeNull();
    expect(tenantNotificationTarget(make('x', { actionUrl: 'https://evil.example/portal' }))).toBeNull();
    expect(tenantNotificationTarget(make('x', { actionUrl: '/portalish' }))).toBeNull();
  });

  it('keeps a final rejection in the bell: its request is gone', () => {
    expect(tenantNotificationTarget(make('request_rejected_final'))).toBeNull();
    expect(tenantNotificationTarget(make('request_rejected_final', { workOrderId: 'gone' }))).toBeNull();
  });
});
