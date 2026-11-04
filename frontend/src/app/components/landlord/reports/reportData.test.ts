import { describe, expect, it } from 'vitest';
import { buildReportCsv, isoDay, presetRange, rangeLabel, type ReportData } from './reportData';

const now = new Date(2026, 9, 5, 15); // 5 Oct 2026

describe('presetRange', () => {
  it('this month runs from the 1st to today', () => {
    expect(presetRange('this_month', now)).toEqual({ from: '2026-10-01', to: '2026-10-05' });
  });

  it('last month is the whole previous calendar month', () => {
    expect(presetRange('last_month', now)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetRange('last_month', new Date(2026, 0, 15))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('last N months are N calendar months ending with this one', () => {
    expect(presetRange('last_3', now)).toEqual({ from: '2026-08-01', to: '2026-10-05' });
    expect(presetRange('last_6', now)).toEqual({ from: '2026-05-01', to: '2026-10-05' });
  });

  it('year to date starts on Jan 1', () => {
    expect(presetRange('ytd', now)).toEqual({ from: '2026-01-01', to: '2026-10-05' });
  });
});

describe('isoDay / rangeLabel', () => {
  it('formats local dates without drifting a day', () => {
    expect(isoDay(new Date(2026, 0, 1, 23, 30))).toBe('2026-01-01');
  });

  it('shows the start year only when it differs', () => {
    expect(rangeLabel('2026-10-01', '2026-10-31')).not.toMatch(/2026.*2026/);
    expect(rangeLabel('2025-12-01', '2026-01-31')).toMatch(/2025.*2026/);
  });
});

describe('buildReportCsv', () => {
  const report: ReportData = {
    range: { from: '2026-10-01', to: '2026-10-31', unit: 'month' },
    previousRange: { from: '2026-08-31', to: '2026-09-30' },
    totals: { spend: 800, completed: 3, incoming: 4, avgResolutionDays: 2.5, avgCostPerJob: 266.67 },
    previousTotals: { spend: 200, completed: 1, incoming: 2, avgResolutionDays: null, avgCostPerJob: 200 },
    trend: [{ key: 'k', label: 'Oct', requests: 4, resolved: 3, cost: 800 }],
    byCategory: { Plumbing: 2 },
    spendByProperty: [{ propertyId: 'p1', name: 'Maple Court, East', spend: 800 }],
    vendorPerformance: [
      {
        vendorId: 'v1',
        name: 'Joe "the pipe" Smith',
        company: null,
        jobs: 3,
        spend: 800,
        avgResolutionDays: 2.5,
        avgRating: null,
        ratingCount: 0,
        avgFirstResponseMinutes: 12,
      },
    ],
  };
  const csv = buildReportCsv(report, 'Oct 1 – Oct 31, 2026');
  const lines = csv.split('\r\n');

  it('leads with the summary against the previous period', () => {
    expect(lines).toContain('Maintenance spend,800,200');
    expect(lines).toContain('Average resolution (days),2.5,');
  });

  it('labels the trend by its bucket unit', () => {
    expect(lines).toContain('Month,Incoming,Completed,Spend');
    expect(lines).toContain('Oct,4,3,800');
  });

  it('quotes commas and doubles quotes, so names never split a column', () => {
    expect(lines).toContain('"Maple Court, East",800');
    expect(lines).toContain('"Joe ""the pipe"" Smith",,3,800,2.5,,0,12');
  });
});
