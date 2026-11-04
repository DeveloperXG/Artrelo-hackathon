import type { Stats, TrendBucket } from '../../../types/landlord';

/**
 * Pure shaping of /landlords/stats for the Overview cards, kept out of the
 * components so the arithmetic is testable on its own.
 */

export const CHART_RANGES = ['7D', '30D', '6M', '12M'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

/** 7D/30D read the daily buckets, 6M/12M the monthly ones. */
export function trendForRange(stats: Pick<Stats, 'monthly' | 'daily'>, range: ChartRange): TrendBucket[] {
  const monthly = stats.monthly || [];
  const daily = stats.daily || [];
  switch (range) {
    case '7D':
      return daily.slice(-7);
    case '30D':
      return daily.slice(-30);
    case '6M':
      return monthly.slice(-6);
    default:
      return monthly.slice(-12);
  }
}

/**
 * Owner chart roles: Lichen = open (live), Mist = completed, Closed = rejected
 * or cancelled. Closed (#d3d8dc) is a low-contrast decorative fill, so it is
 * never the only cue: the legend names every group with its count and share.
 */
export const STATUS_GROUPS = [
  { key: 'open', label: 'Open', color: '#b8c65a' },
  { key: 'completed', label: 'Completed', color: '#7fa3bd' },
  { key: 'closed', label: 'Rejected or cancelled', color: '#d3d8dc' },
] as const;

/**
 * byStatus folded into the three groups a landlord reads at a glance. Open is
 * every non-terminal status — the same definition as openRequestCount — so the
 * donut and the KPI tile can never disagree.
 */
export function statusBreakdown(byStatus: Record<string, number>) {
  const totals = { open: 0, completed: 0, closed: 0 };
  for (const [status, count] of Object.entries(byStatus || {})) {
    if (status === 'completed') totals.completed += count;
    else if (status === 'rejected' || status === 'cancelled') totals.closed += count;
    else totals.open += count;
  }
  const total = totals.open + totals.completed + totals.closed;
  return {
    total,
    groups: STATUS_GROUPS.map((group) => ({
      ...group,
      value: totals[group.key],
      percent: total ? Math.round((totals[group.key] / total) * 100) : 0,
    })),
  };
}

/**
 * At most `limit` rows: the busiest named categories, largest first, then
 * "Other" — always last, holding the server's own "Other" category (the AI's
 * catch-all) plus every category that didn't make the cut.
 */
export function topCategories(byCategory: Record<string, number>, limit = 5) {
  const entries = Object.entries(byCategory || {}).filter(([, count]) => count > 0);
  const isOther = (name: string) => name.trim().toLowerCase() === 'other';
  let otherCount = entries.filter(([name]) => isOther(name)).reduce((acc, [, count]) => acc + count, 0);
  const named = entries
    .filter(([name]) => !isOther(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));

  const room = otherCount > 0 || named.length > limit ? limit - 1 : limit;
  const head = named.slice(0, room);
  otherCount += named.slice(room).reduce((acc, row) => acc + row.count, 0);
  return otherCount > 0 ? [...head, { name: 'Other', count: otherCount }] : head;
}

export const SPEND_RANGES = [
  { key: 'month', label: 'This month' },
  { key: 'six', label: 'Last 6 months' },
  { key: 'all', label: 'All time' },
] as const;
export type SpendRange = (typeof SPEND_RANGES)[number]['key'];

const sum = (rows: TrendBucket[], field: 'cost' | 'resolved') => rows.reduce((acc, row) => acc + (row[field] || 0), 0);

/**
 * Realised spend for a range, the jobs it covers, and the same figure for the
 * period before it (null for "all time", which has nothing before it).
 */
export function spendForRange(
  stats: Pick<Stats, 'monthly' | 'totalCost' | 'completedCount'>,
  range: SpendRange
): { amount: number; jobs: number; previous: number | null; previousLabel: string } {
  const monthly = stats.monthly || [];
  if (range === 'month') {
    const current = monthly.slice(-1);
    const prior = monthly.slice(-2, -1);
    return {
      amount: sum(current, 'cost'),
      jobs: sum(current, 'resolved'),
      previous: prior.length ? sum(prior, 'cost') : null,
      previousLabel: 'last month',
    };
  }
  if (range === 'six') {
    const current = monthly.slice(-6);
    const prior = monthly.length >= 12 ? monthly.slice(-12, -6) : [];
    return {
      amount: sum(current, 'cost'),
      jobs: sum(current, 'resolved'),
      previous: prior.length ? sum(prior, 'cost') : null,
      previousLabel: 'previous 6 months',
    };
  }
  return { amount: stats.totalCost || 0, jobs: stats.completedCount || 0, previous: null, previousLabel: '' };
}
