import type { Evidence, NoticeCode, Route } from '../../types/irisV2';
import { decisionsFocusHref } from '../landlord/decisionHref';

/**
 * The only places an Iris answer can link to: literal routes from App.tsx,
 * chosen by the closed contract enums. Nothing here reads a URL from the
 * server or the model.
 */
export const ROUTE_PATHS: Record<Route, string | null> = {
  dashboard_home: '/dashboard',
  requests: '/dashboard/requests',
  decisions: '/dashboard/decisions',
  activity: '/dashboard/activity',
  properties: '/dashboard/properties',
  tenants: '/dashboard/tenants',
  vendors: '/dashboard/vendors',
  schedule: '/dashboard/schedule',
  wallet: '/dashboard/wallet',
  billing: '/dashboard/billing',
  reports: '/dashboard/reports',
  policy: '/dashboard/policy',
  none: null,
};

/** Contract navigation.noticeRoutes. */
export const NOTICE_ROUTES: Partial<Record<NoticeCode, Route>> = {
  unsupported_setting: 'policy',
  request_context_required: 'requests',
};

const ID_24 = /^[a-fA-F0-9]{24}$/;

/** Where a source chip's "Open" link goes, or null when it has no page. */
export function evidenceHref(evidence: Evidence): string | null {
  const requestId = evidence.requestId && ID_24.test(evidence.requestId) ? evidence.requestId : null;
  switch (evidence.routeKind) {
    case 'request_current':
      return requestId ? `/dashboard/requests/${requestId}?tab=activity` : null;
    case 'decision_current':
      return requestId ? decisionsFocusHref(requestId) : null;
    case 'policy_current':
      return ROUTE_PATHS.policy;
    case 'schedule_current':
      return ROUTE_PATHS.schedule;
    case 'help_context':
      return evidence.publicRouteKind ? ROUTE_PATHS[evidence.publicRouteKind] : null;
    case 'none':
    default:
      return null;
  }
}

/**
 * Contract navigation: viewPolicy keeps the panel open (the conversation stays
 * on screen while the page behind it changes); openRequests closes it so the
 * person can pick a request from the list.
 */
export function keepsPanelOpen(href: string) {
  return href.split('?')[0] !== ROUTE_PATHS.requests;
}

export function linkLabel(href: string) {
  const path = href.split('?')[0];
  if (path === ROUTE_PATHS.policy) return 'View Policy';
  if (path === ROUTE_PATHS.requests) return 'Open Requests';
  if (path.startsWith('/dashboard/requests/')) return 'Open request';
  if (path === ROUTE_PATHS.decisions) return 'Open Decisions';
  if (path === ROUTE_PATHS.schedule) return 'Open Schedule';
  return 'Open page';
}
