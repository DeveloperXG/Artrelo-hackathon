import { describe, expect, it } from 'vitest';
import { isNewRequest, NEW_REQUEST_MS, requestReference, selectRequests } from './requestIdentity';
import type { RequestItem } from '../types/landlord';

const now = Date.parse('2026-10-19T23:00:00Z');
const make = (id: string, age: number, status = 'queued'): RequestItem => ({ _id: id, issueTitle: 'Clogged toilet', issueDescription: 'Will not flush',
  status, urgency: 'medium', category: 'Plumbing', createdAt: new Date(now - age).toISOString(),
  propertyId: { name: 'Maple Court' }, unitId: { unitNumber: '12B' }, tenantId: { firstName: 'Dave' } });

describe('request identity and discovery', () => {
  const old = make('6ac0a820f268a7bba694b587', 3 * NEW_REQUEST_MS, 'completed');
  const fresh = make('6ad692025c994557bac683bc', 60000);
  it('distinguishes identical titles and searches full IDs and readable references', () => {
    expect(requestReference(fresh._id)).toBe('REQ-BAC683BC');
    expect(selectRequests([old, fresh], { query: 'req-bac683bc' })).toEqual([fresh]);
    expect(selectRequests([old, fresh], { query: old._id })).toEqual([old]);
    for (const query of ['Maple', '12B', 'Dave', 'clogged']) expect(selectRequests([old, fresh], { query })).toHaveLength(2);
  });
  it('sorts before pagination without changing the input; updated order is independent of creation', () => {
    const input = [{ ...old, updatedAt: new Date(now).toISOString() }, fresh];
    expect(selectRequests(input).map(r => r._id)).toEqual([fresh._id, old._id]);
    expect(selectRequests(input, { sort: 'oldest' })[0]._id).toBe(old._id);
    expect(selectRequests(input, { sort: 'updated' })[0]._id).toBe(old._id);
    expect(input[0]._id).toBe(old._id);
  });
  it('filters by submission time, including the boundary and excluding unknown dates', () => {
    expect(selectRequests([old, fresh, make('edge', NEW_REQUEST_MS)], { period: 'day', now })).toHaveLength(2);
    expect(selectRequests([{ ...fresh, createdAt: 'invalid' }], { period: 'day', now })).toEqual([]);
  });
  it('marks only recent unopened active requests as new, without treating future dates as new', () => {
    expect(isNewRequest(fresh, {}, now)).toBe(true);
    expect(isNewRequest(fresh, { [fresh._id]: now }, now)).toBe(false);
    expect(isNewRequest(old, {}, now)).toBe(false);
    expect(isNewRequest(make('boundary', NEW_REQUEST_MS), {}, now)).toBe(false);
    expect(isNewRequest(make('future', -60000), {}, now)).toBe(false);
    expect(isNewRequest({ ...fresh, status: 'completed' }, {}, now)).toBe(false);
  });
});
