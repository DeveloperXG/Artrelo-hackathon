import type { TrendBucket } from '../../../types/landlord';

/** GET /landlords/reports — see backend/services/reports/landlordReports.service.js. */
export type ReportTotals = {
  spend: number;
  completed: number;
  incoming: number;
  avgResolutionDays: number | null;
  avgCostPerJob: number | null;
};

export type ReportData = {
  range: { from: string; to: string; unit: 'day' | 'month' };
  previousRange: { from: string; to: string };
  totals: ReportTotals;
  previousTotals: ReportTotals;
  trend: TrendBucket[];
  byCategory: Record<string, number>;
  spendByProperty: { propertyId: string; name: string; spend: number }[];
  vendorPerformance: {
    vendorId: string;
    name: string;
    company: string | null;
    jobs: number;
    spend: number;
    avgResolutionDays: number | null;
    avgRating: number | null;
    ratingCount: number;
    avgFirstResponseMinutes: number | null;
  }[];
};

/** A date as the API takes it: YYYY-MM-DD in local time. */
export function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const RANGE_PRESETS = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_3', label: 'Last 3 months' },
  { key: 'last_6', label: 'Last 6 months' },
  { key: 'ytd', label: 'Year to date' },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]['key'];

/** Inclusive [from, to] for a preset. "Last N months" means N calendar months ending with this one. */
export function presetRange(preset: RangePreset, now: Date = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case 'last_month':
      return { from: isoDay(new Date(y, m - 1, 1)), to: isoDay(new Date(y, m, 0)) };
    case 'last_3':
      return { from: isoDay(new Date(y, m - 2, 1)), to: isoDay(now) };
    case 'last_6':
      return { from: isoDay(new Date(y, m - 5, 1)), to: isoDay(now) };
    case 'ytd':
      return { from: isoDay(new Date(y, 0, 1)), to: isoDay(now) };
    default:
      return { from: isoDay(new Date(y, m, 1)), to: isoDay(now) };
  }
}

/** "Oct 1, 2026 – Oct 31, 2026", the year dropped from the start when both share it. */
export function rangeLabel(from: string, to: string): string {
  const parse = (day: string) => {
    const [yy, mm, dd] = day.slice(0, 10).split('-').map(Number);
    return new Date(yy, mm - 1, dd);
  };
  const a = parse(from);
  const b = parse(to);
  const fmt = (date: Date, withYear: boolean) =>
    date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: withYear ? 'numeric' : undefined });
  return `${fmt(a, a.getFullYear() !== b.getFullYear())} – ${fmt(b, true)}`;
}

/** One CSV field: quoted when it holds a comma, quote or line break. */
function field(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const row = (values: unknown[]) => values.map(field).join(',');

/**
 * The report as a CSV a spreadsheet opens cleanly: a summary block, then the
 * trend, spend by property and vendor performance, each under its own heading
 * and separated by a blank line.
 */
export function buildReportCsv(report: ReportData, label: string): string {
  const t = report.totals;
  const p = report.previousTotals;
  const lines: string[] = [
    row(['Artrelo maintenance report', label]),
    '',
    row(['Metric', 'This period', 'Previous period']),
    row(['Maintenance spend', t.spend, p.spend]),
    row(['Completed requests', t.completed, p.completed]),
    row(['Incoming requests', t.incoming, p.incoming]),
    row(['Average resolution (days)', t.avgResolutionDays ?? '', p.avgResolutionDays ?? '']),
    row(['Average cost per completed job', t.avgCostPerJob ?? '', p.avgCostPerJob ?? '']),
    '',
    row([report.range.unit === 'day' ? 'Day' : 'Month', 'Incoming', 'Completed', 'Spend']),
    ...report.trend.map((b) => row([b.label, b.requests, b.resolved, b.cost])),
    '',
    row(['Property', 'Spend']),
    ...report.spendByProperty.map((r) => row([r.name, r.spend])),
    '',
    row(['Vendor', 'Company', 'Jobs completed', 'Spend', 'Avg resolution (days)', 'Avg rating', 'Ratings', 'Avg first response (min)']),
    ...report.vendorPerformance.map((v) =>
      row([v.name, v.company ?? '', v.jobs, v.spend, v.avgResolutionDays ?? '', v.avgRating ?? '', v.ratingCount, v.avgFirstResponseMinutes ?? ''])
    ),
  ];
  return lines.join('\r\n');
}
