import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Clock, DollarSign, Download, FileText, Receipt, Star } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ApiError, LandlordAPI } from '../../api/client';
import PageHeader from '../../components/landlord/PageHeader';
import StatCard, { StatGrid, percentChange, type StatDelta } from '../../components/landlord/StatCard';
import CountUp from '../../components/landlord/CountUp';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import {
  EmptyState,
  LandlordError,
  LandlordLoading,
  PageContainer,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import DateRangePicker, { type ReportRange } from '../../components/landlord/reports/DateRangePicker';
import { buildReportCsv, presetRange, rangeLabel, type ReportData } from '../../components/landlord/reports/reportData';
import { topCategories } from '../../components/landlord/overview/overviewData';
import { CHART_TOOLTIP_STYLE } from '../../components/landlord/overview/categoryVisuals';
import { formatMinutes } from '../../components/landlord/vendors/vendorFilters';
import { PIE_COLORS } from '../../components/landlord/requestHelpers';

const money = (value: number) => `$${Math.round(value).toLocaleString()}`;
const compact = (value: number) => (value >= 1000 ? `$${Math.round(value / 100) / 10}K` : `$${value}`);

function delta(current: number | null, previous: number | null, upIsGood: boolean, previousText: string): StatDelta | null {
  if (current === null || previous === null) return null;
  const percent = percentChange(current, previous);
  return percent === null ? null : { percent, upIsGood, label: `vs previous period${previousText}` };
}

function ChartCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card className="ll-fade-up flex min-w-0 flex-col gap-4 border border-slate-200/70 p-5 shadow-sm">
      <div>
        <h3 className="font-semibold text-slate-900">{title}</h3>
        <p className="text-sm text-slate-500">{description}</p>
      </div>
      {children}
    </Card>
  );
}

export default function ReportsPage() {
  useLandlordEntrance();
  // The range the report on screen describes. A new range becomes this only
  // once it loads, so the picker never labels a report it isn't showing.
  const [range, setRange] = useState<ReportRange>(() => ({ ...presetRange('this_month'), preset: 'this_month' }));
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [rangeError, setRangeError] = useState<{ field?: string; message: string } | null>(null);
  const loadedOnce = useRef(false);

  const load = useCallback(async (next: ReportRange) => {
    if (loadedOnce.current) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await LandlordAPI.reports({ from: next.from, to: next.to });
      setReport(response.data as ReportData);
      setRange(next);
      setError('');
      setRangeError(null);
      loadedOnce.current = true;
    } catch (err) {
      const field = err instanceof ApiError ? (err.payload as { field?: string } | null)?.field : undefined;
      // A range the server refuses is the picker's problem, shown beside it;
      // the last good report stays on screen.
      if (field && loadedOnce.current) setRangeError({ field, message: err instanceof Error ? err.message : 'Check the dates.' });
      else setError(err instanceof Error ? err.message : 'Could not load reports');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // First load only; later ranges load through the picker.
  const initialRange = useRef(range);
  useEffect(() => {
    void load(initialRange.current);
  }, [load]);

  const categories = useMemo(() => (report ? topCategories(report.byCategory, 5) : []), [report]);
  const categoryTotal = categories.reduce((acc, row) => acc + row.count, 0);
  const propertyMax = report?.spendByProperty.reduce((acc, row) => Math.max(acc, row.spend), 0) || 0;

  const exportCsv = () => {
    if (!report) return;
    const csv = buildReportCsv(report, rangeLabel(range.from, range.to));
    // BOM so Excel reads the file as UTF-8 (property names, en dashes).
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `artrelo-report-${range.from}-to-${range.to}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  if (loading && !report) return <LandlordLoading label="Building your report..." />;
  if (error || !report) {
    return <LandlordError title="Reports unavailable" message={error} onRetry={() => void load(range)} />;
  }

  const t = report.totals;
  const p = report.previousTotals;
  const trendLabelEvery = report.trend.length > 16 ? Math.ceil(report.trend.length / 10) - 1 : 0;
  const highlightLast = report.range.unit === 'month';

  return (
    <PageContainer>
      <PageHeader
        title="Reports"
        description="Track maintenance performance, spend, vendor activity, and request trends."
        titleTestId="reports-title"
        actions={
          <>
            <DateRangePicker value={range} onChange={(next) => void load(next)} error={rangeError} />
            <Button
              onClick={exportCsv}
              data-testid="reports-export"
              className="h-10 gap-1.5 bg-[#137fec] px-4 hover:bg-[#137fec]/90"
            >
              <Download className="h-4 w-4" />
              Export report
            </Button>
          </>
        }
      />

      <div className={`transition-opacity ${refreshing ? 'pointer-events-none opacity-60' : ''}`} aria-busy={refreshing}>
        <StatGrid className="mb-6">
          <StatCard
            icon={DollarSign}
            tone="blue"
            label="Total maintenance spend"
            value={<CountUp key={`${range.from}${range.to}`} value={t.spend} prefix="$" />}
            delta={delta(t.spend, p.spend, false, ` (${money(p.spend)})`)}
            testId="reports-kpi-spend"
          />
          <StatCard
            icon={FileText}
            tone="blue"
            label="Completed requests"
            value={<CountUp key={`c${range.from}${range.to}`} value={t.completed} />}
            delta={delta(t.completed, p.completed, true, '')}
            delay={60}
          />
          <StatCard
            icon={Clock}
            tone="blue"
            label="Average resolution time"
            value={t.avgResolutionDays === null ? '—' : `${t.avgResolutionDays} day${t.avgResolutionDays === 1 ? '' : 's'}`}
            delta={delta(t.avgResolutionDays, p.avgResolutionDays, false, p.avgResolutionDays === null ? '' : ` (${p.avgResolutionDays} d)`)}
            // Jobs can be completed without a recorded completion time (older
            // rows), and then there is nothing to measure — say which it is.
            sub={
              t.avgResolutionDays !== null
                ? undefined
                : t.completed
                  ? 'No completion times recorded'
                  : 'No jobs completed in this period'
            }
            delay={120}
          />
          <StatCard
            icon={Receipt}
            tone="blue"
            label="Avg cost per completed job"
            value={t.avgCostPerJob === null ? '—' : money(t.avgCostPerJob)}
            delta={delta(t.avgCostPerJob, p.avgCostPerJob, false, '')}
            sub={t.avgCostPerJob === null ? 'No jobs completed in this period' : undefined}
            delay={180}
          />
        </StatGrid>

        <div className="grid min-w-0 gap-6 xl:grid-cols-2">
          <ChartCard
            title="Maintenance spend trend"
            description={`Final cost of completed work, by ${report.range.unit}.`}
          >
            <div className="h-64 min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={report.trend} margin={{ top: 24, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#eef2f7" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} stroke="#94a3b8" fontSize={12} interval={trendLabelEvery} />
                  <YAxis tickLine={false} axisLine={false} stroke="#94a3b8" fontSize={11} width={48} tickFormatter={compact} />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    cursor={{ fill: 'rgba(19, 127, 236, 0.06)' }}
                    formatter={(value) => [money(Number(value)), 'Spend']}
                  />
                  <Bar dataKey="cost" radius={[6, 6, 0, 0]} maxBarSize={56}>
                    {report.trend.map((bucket, index) => (
                      <Cell
                        key={bucket.key}
                        fill={highlightLast && index === report.trend.length - 1 ? '#137fec' : '#93c5fd'}
                      />
                    ))}
                    {report.range.unit === 'month' ? (
                      <LabelList
                        dataKey="cost"
                        position="top"
                        formatter={(value: unknown) => (Number(value) ? money(Number(value)) : '')}
                        style={{ fontSize: 11, fill: '#334155', fontWeight: 600 }}
                      />
                    ) : null}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          <ChartCard title="Requests volume" description="Incoming versus completed requests.">
            <div className="flex items-center gap-4 text-xs font-medium text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-[#137fec]" />
                Incoming
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                Completed
              </span>
            </div>
            <div className="h-56 min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={report.trend} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="rpIn" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#137fec" stopOpacity={0.18} />
                      <stop offset="100%" stopColor="#137fec" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="rpDone" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="#eef2f7" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} stroke="#94a3b8" fontSize={12} interval={trendLabelEvery} />
                  <YAxis tickLine={false} axisLine={false} stroke="#94a3b8" fontSize={12} width={42} allowDecimals={false} />
                  <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                  <Area type="monotone" dataKey="requests" name="Incoming" stroke="#137fec" strokeWidth={2.5} fill="url(#rpIn)" dot={report.trend.length <= 16 ? { r: 3.5, fill: '#137fec', strokeWidth: 0 } : false} />
                  <Area type="monotone" dataKey="resolved" name="Completed" stroke="#10b981" strokeWidth={2.5} fill="url(#rpDone)" dot={report.trend.length <= 16 ? { r: 3.5, fill: '#10b981', strokeWidth: 0 } : false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          <ChartCard title="Request category breakdown" description="Requests raised in this period, by category.">
            {categoryTotal === 0 ? (
              <EmptyState title="No requests in this period" />
            ) : (
              // Container query, as on the Overview donut: the card's width,
              // not the screen's, decides whether the legend fits beside it.
              <div className="@container flex flex-1 flex-col">
              <div className="flex flex-1 flex-col items-center gap-6 @md:flex-row">
                <div className="relative h-48 w-48 shrink-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={categories}
                        dataKey="count"
                        nameKey="name"
                        innerRadius={58}
                        outerRadius={86}
                        paddingAngle={categories.length > 1 ? 2 : 0}
                        cornerRadius={5}
                        startAngle={90}
                        endAngle={-270}
                        stroke="none"
                      >
                        {categories.map((row, index) => (
                          <Cell key={row.name} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-3xl font-bold text-slate-900 tabular-nums">{categoryTotal}</span>
                    <span className="text-xs text-slate-500">Total requests</span>
                  </div>
                </div>
                <ul className="w-full flex-1 space-y-3 text-sm">
                  {categories.map((row, index) => (
                    <li key={row.name} className="flex items-center gap-2.5">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: PIE_COLORS[index % PIE_COLORS.length] }} />
                      <span className="min-w-0 flex-1 truncate capitalize text-slate-600" title={row.name}>
                        {row.name}
                      </span>
                      <span className="w-8 shrink-0 text-right font-semibold text-slate-900 tabular-nums">{row.count}</span>
                      <span className="w-10 shrink-0 text-right text-slate-400 tabular-nums">
                        {Math.round((row.count / categoryTotal) * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              </div>
            )}
          </ChartCard>

          <ChartCard title="Spend by property" description="Final cost of completed work, per property.">
            {report.spendByProperty.length === 0 ? (
              <EmptyState title="No completed work in this period" />
            ) : (
              <ul className="flex flex-1 flex-col justify-center gap-3.5" data-testid="reports-property-spend">
                {report.spendByProperty.slice(0, 8).map((row) => (
                  <li key={row.propertyId} className="grid grid-cols-[minmax(0,9rem)_1fr_5rem] items-center gap-3 text-sm">
                    <span className="truncate text-slate-600" title={row.name}>
                      {row.name}
                    </span>
                    <span className="h-3 overflow-hidden rounded-full bg-slate-100">
                      <span
                        className="block h-full rounded-full bg-[#137fec]/80"
                        style={{ width: propertyMax ? `${(row.spend / propertyMax) * 100}%` : '0%' }}
                      />
                    </span>
                    <span className="text-right font-semibold text-slate-900 tabular-nums">{money(row.spend)}</span>
                  </li>
                ))}
              </ul>
            )}
          </ChartCard>
        </div>

        <Card className="ll-fade-up mt-6 gap-0 overflow-hidden border border-slate-200/70 p-0 shadow-sm">
          <div className="px-5 pb-3 pt-5">
            <h3 className="font-semibold text-slate-900">Vendor performance</h3>
            <p className="text-sm text-slate-500">Vendors by jobs completed in this period.</p>
          </div>
          {report.vendorPerformance.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState title="No vendor completed a job in this period" />
            </div>
          ) : (
            <div className="overflow-x-auto border-t border-slate-100">
              <table className="w-full min-w-[44rem] text-left text-sm" data-testid="reports-vendor-table">
                <thead>
                  <tr className="border-b border-slate-100 text-xs font-semibold text-slate-500">
                    <th className="px-5 py-3 font-semibold">Vendor</th>
                    <th className="px-3 py-3 font-semibold">Jobs completed</th>
                    <th className="px-3 py-3 font-semibold" title="The vendor's running average, across all jobs">
                      Avg. response
                    </th>
                    <th className="px-3 py-3 font-semibold">Avg. resolution</th>
                    <th className="px-3 py-3 font-semibold">Total spend</th>
                    <th className="px-5 py-3 font-semibold">Tenant rating</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.vendorPerformance.map((vendor) => (
                    <tr key={vendor.vendorId}>
                      <td className="max-w-[16rem] px-5 py-3">
                        <div className="truncate font-medium text-slate-900">{vendor.name}</div>
                        {vendor.company ? <div className="truncate text-xs text-slate-500">{vendor.company}</div> : null}
                      </td>
                      <td className="px-3 py-3 text-slate-700 tabular-nums">{vendor.jobs}</td>
                      <td className="px-3 py-3 text-slate-700 tabular-nums">{formatMinutes(vendor.avgFirstResponseMinutes)}</td>
                      <td className="px-3 py-3 text-slate-700 tabular-nums">
                        {vendor.avgResolutionDays === null ? '—' : `${vendor.avgResolutionDays} days`}
                      </td>
                      <td className="px-3 py-3 font-semibold text-slate-900 tabular-nums">{money(vendor.spend)}</td>
                      <td className="px-5 py-3">
                        {vendor.avgRating === null ? (
                          <span className="text-xs text-slate-400">No ratings</span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 font-semibold text-emerald-700"
                            title={`${vendor.ratingCount} rating${vendor.ratingCount === 1 ? '' : 's'}`}
                          >
                            {vendor.avgRating.toFixed(1)}
                            <Star className="h-3.5 w-3.5 fill-emerald-500 text-emerald-500" />
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
