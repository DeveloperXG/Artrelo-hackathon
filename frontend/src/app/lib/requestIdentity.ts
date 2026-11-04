import type { RequestItem } from '../types/landlord';
import { getPropertyLabel, getRequestDisplayTitle, getTenantName, getUnitLabel } from '../components/landlord/requestHelpers';

// A readable display reference; links and API actions always use the full ID.
export const requestReference = (id: string) => `REQ-${id.slice(-8).toUpperCase()}`;
export const requestTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Time unavailable';
};
export const NEW_REQUEST_MS = 24 * 60 * 60 * 1000;
export function isNewRequest(request: Pick<RequestItem, '_id' | 'createdAt' | 'status'>, opened: Record<string, number>, now = Date.now()) {
  const age = now - Date.parse(request.createdAt);
  return !opened[request._id] && age >= 0 && age < NEW_REQUEST_MS && !['completed', 'rejected', 'cancelled'].includes(request.status);
}

export type RequestSort = 'newest' | 'oldest' | 'updated';
export type RequestPeriod = 'all' | 'day' | 'week' | 'month';
export function selectRequests(requests: RequestItem[], { query = '', sort = 'newest', period = 'all', now = Date.now() }: {
  query?: string; sort?: RequestSort; period?: RequestPeriod; now?: number;
} = {}) {
  const search = query.trim().toLowerCase();
  const days = { all: Infinity, day: 1, week: 7, month: 30 }[period];
  const timestamp = (request: RequestItem) => Date.parse(sort === 'updated' ? request.updatedAt || request.createdAt : request.createdAt) || 0;
  return requests.filter(request => {
    if (period !== 'all' && !(Date.parse(request.createdAt) >= now - days * NEW_REQUEST_MS)) return false;
    return !search || [request._id, requestReference(request._id), getRequestDisplayTitle(request), request.issueTitle,
      request.issueDescription, getPropertyLabel(request.propertyId), getUnitLabel(request.unitId), getTenantName(request.tenantId)]
      .some(value => value?.toLowerCase().includes(search));
  }).sort((a, b) => (sort === 'oldest' ? timestamp(a) - timestamp(b) : timestamp(b) - timestamp(a)) || a._id.localeCompare(b._id));
}
