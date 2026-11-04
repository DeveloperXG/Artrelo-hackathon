import { describe, expect, it } from 'vitest';
import type { AppNotification } from '../../api/client';
import { notificationTarget } from './notificationTarget';

const make = (type: string, metadata: AppNotification['metadata'] = {}): AppNotification => ({
  _id: 'n1',
  type,
  title: 't',
  message: 'm',
  read: false,
  createdAt: '2026-10-05T09:00:00Z',
  metadata,
});

describe('notificationTarget', () => {
  it('opens the request a new work order is about', () => {
    expect(notificationTarget(make('work_order_created', { workOrderId: 'r1' }))).toBe('/dashboard/requests/r1');
  });

  it('sends booking problems to Decisions, deep-linked to the request', () => {
    expect(notificationTarget(make('vendor_no_show_reported', { workOrderId: 'r2' }))).toBe(
      '/dashboard/decisions?request=r2'
    );
    expect(notificationTarget(make('appointment_unconfirmed'))).toBe('/dashboard/decisions');
  });

  it('sends approvals and exhausted outreach to Decisions, deep-linked to the request', () => {
    expect(notificationTarget(make('decision_needed', { workOrderId: 'r5' }))).toBe('/dashboard/decisions?request=r5');
    expect(notificationTarget(make('vendor_outreach_exhausted', { workOrderId: 'r6' }))).toBe(
      '/dashboard/decisions?request=r6'
    );
  });

  it('sends money problems to the wallet even when a request is attached', () => {
    expect(notificationTarget(make('payment_overdue', { workOrderId: 'r3' }))).toBe('/dashboard/wallet');
  });

  it('sends a direct payment due to the Payments page, where the Mark paid button is', () => {
    expect(notificationTarget(make('vendor_payment_due', { workOrderId: 'r4' }))).toBe('/dashboard/wallet');
  });

  it('ignores an actionUrl outside the landlord app', () => {
    expect(notificationTarget(make('tenant_move_out_requested', { actionUrl: '/portal' }))).toBeNull();
    expect(notificationTarget(make('x', { actionUrl: 'https://evil.example/dashboard' }))).toBeNull();
    expect(notificationTarget(make('x', { actionUrl: '/dashboardish' }))).toBeNull();
  });

  it('honours an actionUrl inside the dashboard', () => {
    expect(notificationTarget(make('x', { actionUrl: '/dashboard/policy' }))).toBe('/dashboard/policy');
  });

  it('opens the Messages tab for a message in a request thread', () => {
    expect(notificationTarget(make('tenant_message_received', { workOrderId: 'r4' }))).toBe(
      '/dashboard/requests/r4?tab=messages'
    );
  });

  it('sends a policy re-evaluation to the requests list', () => {
    expect(notificationTarget(make('policy_requests_reevaluated'))).toBe('/dashboard/requests');
  });

  it('falls back to the schedule for appointment news without a request', () => {
    expect(notificationTarget(make('appointment_booked'))).toBe('/dashboard/schedule');
  });
});
