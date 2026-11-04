import { describe, expect, it } from 'vitest';
import type { RequestItem } from '../../types/landlord';
import { isOpenRequest, requestFinalCost, requestVendorLabel } from './requestsTableData';

const request = (overrides: Partial<RequestItem>): RequestItem => ({
  _id: 'r1',
  issueTitle: 'Leak',
  issueDescription: 'Sink leaks',
  status: 'queued',
  urgency: 'medium',
  category: 'Plumbing',
  createdAt: '2026-10-01T10:00:00Z',
  ...overrides,
});

describe('requestFinalCost', () => {
  it('shows the final cost only once a job is completed', () => {
    expect(requestFinalCost(request({ status: 'completed', finalCost: 240 }))).toBe(240);
    expect(requestFinalCost(request({ status: 'assigned', finalCost: 240, estimatedCost: 300 }))).toBeNull();
  });

  it('treats a zero final cost as real, not missing', () => {
    expect(requestFinalCost(request({ status: 'completed', finalCost: 0 }))).toBe(0);
  });

  it('never falls back to the estimate', () => {
    expect(requestFinalCost(request({ status: 'completed', estimatedCost: 300 }))).toBeNull();
  });
});

describe('requestVendorLabel', () => {
  it('names the booked vendor', () => {
    expect(requestVendorLabel(request({ vendorId: { name: 'BluePeak Plumbing' } }))).toEqual({
      name: 'BluePeak Plumbing',
      pending: false,
    });
  });

  it('falls back to the routing summary', () => {
    expect(requestVendorLabel(request({ routingSummary: { assignedVendorName: 'ClearFlow' } })).name).toBe('ClearFlow');
  });

  it('says nobody is lined up when nobody is', () => {
    expect(requestVendorLabel(request({}))).toEqual({ name: 'Pending assignment', pending: true });
  });
});

describe('isOpenRequest', () => {
  it('is every status that is not finished', () => {
    expect(['queued', 'pending', 'approved', 'assigned', 'in_progress'].map((status) => isOpenRequest({ status }))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(['completed', 'rejected', 'cancelled'].map((status) => isOpenRequest({ status }))).toEqual([false, false, false]);
  });
});
