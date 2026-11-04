import {
  getVendorContactActionState,
  type VendorContactSnapshotState,
  type VendorContactActionState,
} from '../vendorContactAction';
import type { ContactCandidate, RequestItem } from '../../types/landlord';

type RejectableRequestShape = {
  routingGuidance?: { rejectable?: boolean } | null;
};

export const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-amber-100 text-amber-800',
  approved: 'bg-sky-100 text-sky-800',
  outreach_scheduled: 'bg-violet-100 text-violet-800',
  needs_approval: 'bg-amber-100 text-amber-900 ring-1 ring-amber-300',
  contacting_vendor: 'bg-cyan-100 text-cyan-800',
  needs_vendor: 'bg-orange-100 text-orange-800',
  assigned: 'bg-indigo-100 text-indigo-800',
  in_progress: 'bg-blue-100 text-blue-800',
  completed: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-rose-100 text-rose-800',
  appeal_pending: 'bg-fuchsia-100 text-fuchsia-800 ring-1 ring-fuchsia-300',
  cancelled: 'bg-slate-100 text-slate-800',
};

export const URGENCY_COLORS: Record<string, string> = {
  low: 'bg-slate-100 text-slate-700',
  medium: 'bg-amber-100 text-amber-700',
  high: 'bg-orange-100 text-orange-700',
  emergency: 'bg-rose-100 text-rose-700',
};

export const PIE_COLORS = ['#137fec', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6'];

export const DECISION_LABELS: Record<string, string> = {
  request_quota_increase: 'Quota increase needed',
  request_first_time_vendor_approval: 'First-time vendor approval',
  manual_vendor_assignment_required: 'No suitable vendor found',
  escalate_emergency: 'Emergency escalation',
  queue_for_manager_review: 'Manager review needed',
  recommend_preset_vendor: 'Vendor ready for review',
  request_vendor_contact_approval: 'Contact approval needed',
};

export function getRequestDisplayTitle(request: RequestItem): string {
  return request.ai?.shortTitle || request.issueTitle;
}

export function getTenantName(tenant: RequestItem['tenantId']): string {
  if (!tenant) return 'Tenant';
  if (typeof tenant === 'string') return 'Tenant';
  return `${tenant.firstName || ''} ${tenant.lastName || ''}`.trim() || tenant.email || 'Tenant';
}

export function getUnitLabel(unit: RequestItem['unitId']): string {
  if (!unit || typeof unit === 'string') return '-';
  return unit.unitNumber ? `Unit ${unit.unitNumber}` : '-';
}

export function getPropertyLabel(property: RequestItem['propertyId']): string {
  if (!property || typeof property === 'string') return '';
  return property.name || '';
}

export function getPropertyId(property: RequestItem['propertyId']): string {
  if (!property) return '';
  if (typeof property === 'string') return property;
  return property._id || '';
}

export function getContactCandidate(request: { vendorRecommendationSnapshot?: VendorContactSnapshotState | null }): ContactCandidate | null {
  const action = getVendorContactActionState(request.vendorRecommendationSnapshot);
  return action.kind === 'available' ? action.candidate : null;
}

export function getContactStatus(request: { vendorRecommendationSnapshot?: VendorContactSnapshotState | null }): VendorContactActionState {
  return getVendorContactActionState(request.vendorRecommendationSnapshot);
}

// The server's label (lifecycleStatus, from requestLifecycle.service), shown
// as-is. Derived here as well, it drifted from the server and kept reading
// "approved" after every vendor had declined or been turned down. Falls back
// to the raw status only for a payload that predates the field.
export function getRequestLifecycleStatus(request: Pick<RequestItem, 'status' | 'lifecycleStatus'>) {
  return request.lifecycleStatus || request.status || 'queued';
}

// The server's answer (routingGuidance.rejectable), not a local re-derivation:
// the copy here drifted and hid Reject after the server allowed it. Missing
// guidance means no button -- the endpoint is the authority either way.
export function canRejectRequest(request: RejectableRequestShape) {
  return Boolean(request.routingGuidance?.rejectable);
}

