import type { AppNotification } from '../../api/client';

/**
 * Where clicking a notification in the landlord bell should go, or null when
 * there is nowhere useful.
 *
 * `actionUrl` is honoured only inside the landlord app. The one the backend
 * writes today is the tenant portal's `/portal`, and the same Notification
 * model serves both roles, so trusting it blindly would bounce a landlord into
 * a portal they cannot open.
 */
export function notificationTarget(notification: AppNotification): string | null {
  const meta = notification.metadata || {};
  if (meta.actionUrl && /^\/dashboard(\/|$|\?)/.test(meta.actionUrl)) return meta.actionUrl;

  const requestId = meta.workOrderId || null;
  switch (notification.type) {
    // Money: the wallet is where the balance and the stuck payout are.
    case 'payment_overdue':
    case 'payment_failed':
    case 'payment_processed':
    case 'payment_refunded':
    case 'vendor_payout_sent':
    case 'vendor_payout_clearing':
    // A direct-pay job to pay: the Payments page (same route) has the button.
    case 'vendor_payment_due':
      return '/dashboard/wallet';
    // A booking problem the manager resolves on Decisions — deep-linked, so the
    // card pulses when the page opens.
    case 'vendor_no_show_reported':
    case 'appointment_unconfirmed':
    // An approval waiting on the manager, or a request no vendor took.
    case 'decision_needed':
    case 'vendor_outreach_exhausted':
      return requestId ? `/dashboard/decisions?request=${requestId}` : '/dashboard/decisions';
    // Straight to the thread the message landed in.
    case 'tenant_message_received':
    case 'vendor_message_received':
      return requestId ? `/dashboard/requests/${requestId}?tab=messages` : null;
    // A batch about many requests: the list is where their new routing shows.
    case 'policy_requests_reevaluated':
      return '/dashboard/requests';
    default:
      break;
  }
  if (requestId) return `/dashboard/requests/${requestId}`;
  if (notification.type.startsWith('appointment_')) return '/dashboard/schedule';
  return null;
}
