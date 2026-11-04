import type { RequestItem } from '../../types/landlord';
import { getContactStatus } from './requestHelpers';

const nameOf = (ref: RequestItem['vendorId']) => (ref && typeof ref === 'object' ? ref.name || '' : '');

/**
 * Who the "Vendor / Assignment" column names: the booked vendor, else the one
 * selected or being contacted, else that nobody is lined up yet.
 */
export function requestVendorLabel(request: RequestItem): { name: string; pending: boolean; note?: string } {
  const booked = nameOf(request.vendorId) || nameOf(request.selectedVendorId) || request.routingSummary?.assignedVendorName;
  if (booked) return { name: booked, pending: false };
  const contact = getContactStatus(request);
  if (contact.kind === 'approved' && contact.candidate?.name) {
    return { name: contact.candidate.name, pending: false, note: 'Awaiting reply' };
  }
  if (contact.kind === 'selected' && contact.candidate?.name) return { name: contact.candidate.name, pending: false };
  return { name: 'Pending assignment', pending: true };
}

/**
 * The money column is FINAL cost: what a completed job actually cost. An open
 * job's estimate is a vendor's quote ceiling, not a cost, so it shows nothing
 * here — the same rule the dashboard's spend figures use. `0` is a real final
 * cost (warranty, goodwill) and is shown as such.
 */
export function requestFinalCost(request: Pick<RequestItem, 'status' | 'finalCost'>): number | null {
  if (request.status !== 'completed') return null;
  return typeof request.finalCost === 'number' ? request.finalCost : null;
}

/** Finished one way or another. Everything else is open — the stats endpoint's definition. */
export const OPEN_STATUSES_EXCLUDED = ['completed', 'rejected', 'cancelled'];

export function isOpenRequest(request: Pick<RequestItem, 'status'>): boolean {
  return !OPEN_STATUSES_EXCLUDED.includes(request.status);
}
