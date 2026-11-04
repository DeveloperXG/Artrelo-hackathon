import type { AppNotification } from '../../api/client';

/**
 * Where clicking a notification in the tenant bell should go, or null when
 * there is nowhere useful -- the bell then expands the message in place.
 *
 * The mirror of the landlord's notificationTarget: the same Notification model
 * serves both roles, so `actionUrl` is honoured only inside the tenant portal.
 * Trusting it blindly could bounce a tenant into a dashboard they can't open.
 */
export function tenantNotificationTarget(notification: AppNotification): string | null {
  const meta = notification.metadata || {};
  if (meta.actionUrl && /^\/portal(\/|$|\?)/.test(meta.actionUrl)) return meta.actionUrl;

  // A final rejection carries no request: it has been deleted, and the message
  // is the whole story.
  if (notification.type === 'request_rejected_final') return null;

  if (meta.workOrderId) return `/portal/requests/${meta.workOrderId}`;
  if (notification.type.startsWith('appointment_')) return '/portal/schedule';
  return null;
}
