import { describe, expect, it } from 'vitest';
import type { TrendBucket } from '../../../types/landlord';
import { spendForRange, statusBreakdown, topCategories, trendForRange } from './overviewData';

const bucket = (i: number, cost = 0, resolved = 0): TrendBucket => ({
  key: String(i),
  label: `m${i}`,
  requests: i,
  resolved,
  cost,
});
const monthly = Array.from({ length: 12 }, (_, i) => bucket(i, (i + 1) * 100, 1));
const daily = Array.from({ length: 30 }, (_, i) => bucket(i));

describe('trendForRange', () => {
  it('reads days for 7D/30D and months for 6M/12M', () => {
    expect(trendForRange({ monthly, daily }, '7D').map((b) => b.key)).toEqual(['23', '24', '25', '26', '27', '28', '29']);
    expect(trendForRange({ monthly, daily }, '30D')).toHaveLength(30);
    expect(trendForRange({ monthly, daily }, '6M').map((b) => b.key)).toEqual(['6', '7', '8', '9', '10', '11']);
    expect(trendForRange({ monthly, daily }, '12M')).toHaveLength(12);
  });

  it('copes with a server that sends no daily buckets', () => {
    expect(trendForRange({ monthly }, '7D')).toEqual([]);
  });
});

describe('statusBreakdown', () => {
  it('folds every non-terminal status into Open', () => {
    const { total, groups } = statusBreakdown({
      queued: 3,
      pending: 1,
      assigned: 2,
      in_progress: 2,
      completed: 10,
      rejected: 1,
      cancelled: 1,
    });
    expect(total).toBe(20);
    expect(groups.map((g) => [g.key, g.value, g.percent])).toEqual([
      ['open', 8, 40],
      ['completed', 10, 50],
      ['closed', 2, 10],
    ]);
  });

  it('reports zero percent rather than NaN when empty', () => {
    expect(statusBreakdown({}).groups.every((g) => g.percent === 0)).toBe(true);
  });
});

describe('topCategories', () => {
  it('keeps everything when it fits, largest first', () => {
    expect(topCategories({ HVAC: 2, Plumbing: 5 })).toEqual([
      { name: 'Plumbing', count: 5 },
      { name: 'HVAC', count: 2 },
    ]);
  });

  it('folds the tail into Other, which is always last', () => {
    const rows = topCategories({ A: 9, B: 8, C: 7, D: 6, E: 5, F: 4 }, 5);
    expect(rows).toEqual([
      { name: 'A', count: 9 },
      { name: 'B', count: 8 },
      { name: 'C', count: 7 },
      { name: 'D', count: 6 },
      { name: 'Other', count: 9 },
    ]);
  });

  it("merges the server's own Other category instead of listing it twice", () => {
    const rows = topCategories({ Other: 20, Plumbing: 3, HVAC: 2 }, 5);
    expect(rows).toEqual([
      { name: 'Plumbing', count: 3 },
      { name: 'HVAC', count: 2 },
      { name: 'Other', count: 20 },
    ]);
    expect(topCategories({ Other: 1, A: 5, B: 4, C: 3, D: 2, E: 1 }, 5).at(-1)).toEqual({ name: 'Other', count: 2 });
  });

  it('drops zero counts', () => {
    expect(topCategories({ A: 0, B: 1 })).toEqual([{ name: 'B', count: 1 }]);
  });
});

describe('spendForRange', () => {
  const stats = { monthly, totalCost: 99999, completedCount: 40 };

  it('compares this month with last month', () => {
    expect(spendForRange(stats, 'month')).toEqual({ amount: 1200, jobs: 1, previous: 1100, previousLabel: 'last month' });
  });

  it('compares the last six months with the six before', () => {
    const six = spendForRange(stats, 'six');
    expect(six.amount).toBe(700 + 800 + 900 + 1000 + 1100 + 1200);
    expect(six.previous).toBe(100 + 200 + 300 + 400 + 500 + 600);
    expect(six.jobs).toBe(6);
  });

  it('uses the all-time totals with nothing to compare against', () => {
    expect(spendForRange(stats, 'all')).toEqual({ amount: 99999, jobs: 40, previous: null, previousLabel: '' });
  });

  it('has no comparison for six months when the server sent fewer than twelve', () => {
    expect(spendForRange({ ...stats, monthly: monthly.slice(-6) }, 'six').previous).toBeNull();
  });
});
