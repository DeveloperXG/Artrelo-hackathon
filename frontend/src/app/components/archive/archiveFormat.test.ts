import { describe, expect, it } from 'vitest';
import { finishedAt, groupByUnit, outcomeLabel, type ArchivedRequest } from './archiveFormat';

const row = (over: Partial<ArchivedRequest>): ArchivedRequest => ({
  _id: over._id || 'r',
  issueTitle: 'Leak',
  status: 'completed',
  archivedAt: '2026-10-08T00:00:00.000Z',
  ...over,
});

describe('groupByUnit', () => {
  it('groups by unit in natural order, with unit-less requests last', () => {
    const groups = groupByUnit([
      row({ _id: 'a', unitId: { _id: 'u10', unitNumber: '10' } }),
      row({ _id: 'b', unitId: null }),
      row({ _id: 'c', unitId: { _id: 'u2', unitNumber: '2' } }),
      row({ _id: 'd', unitId: { _id: 'u10', unitNumber: '10' } }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['Unit 2', 'Unit 10', 'No unit']);
    expect(groups[1].rows.map((r) => r._id)).toEqual(['a', 'd']);
    expect(groups[2].key).toBe('none');
  });

  it('accepts a bare unit id as well as a populated one', () => {
    const groups = groupByUnit([row({ _id: 'a', unitId: 'u1' }), row({ _id: 'b', unitId: { _id: 'u1', unitNumber: '4B' } })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(2);
  });
});

describe('finishedAt / outcomeLabel', () => {
  it('uses the completion or cancellation date', () => {
    expect(finishedAt(row({ completedAt: '2026-09-30T10:00:00.000Z' }))).toBe('2026-09-30T10:00:00.000Z');
    expect(finishedAt(row({ status: 'cancelled', cancelledAt: '2026-09-29T10:00:00.000Z' }))).toBe(
      '2026-09-29T10:00:00.000Z'
    );
    // A request cancelled before cancelledAt existed falls back to its last write.
    expect(finishedAt(row({ status: 'cancelled', updatedAt: '2026-09-28T10:00:00.000Z' }))).toBe(
      '2026-09-28T10:00:00.000Z'
    );
    expect(outcomeLabel(row({ status: 'cancelled' }))).toBe('Cancelled');
  });
});
