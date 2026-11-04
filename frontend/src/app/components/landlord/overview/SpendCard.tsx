import { useMemo, useState } from 'react';
import { ArrowRight, DollarSign } from 'lucide-react';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card } from '../../ui/card';
import CountUp from '../CountUp';
import { DeltaBadge, percentChange } from '../StatCard';
import type { Stats } from '../../../types/landlord';
import { SPEND_RANGES, spendForRange, type SpendRange } from './overviewData';
import { LICHEN_CHART as C, LICHEN_TICK, LICHEN_TOOLTIP } from './categoryVisuals';

const money = (value: number) => `$${Math.round(value).toLocaleString()}`;
const compact = (value: number) => (value >= 1000 ? `${Math.round(value / 100) / 10}K` : String(value));

/**
 * Realised maintenance spend: the final cost of completed work, never a quote.
 * The committed line is the separate, labelled upper bound for booked jobs.
 */
export default function SpendCard({ stats, onViewReports }: { stats: Stats; onViewReports: () => void }) {
  const [range, setRange] = useState<SpendRange>('month');
  const spend = useMemo(() => spendForRange(stats, range), [stats, range]);
  const change = spend.previous === null ? null : percentChange(spend.amount, spend.previous);
  const bars = (stats.monthly || []).slice(-6);
  const committed = stats.committedCost ?? 0;

  return (
    <Card className="ll-fade-up @container/spend flex min-w-0 flex-col gap-0 border-border p-5">
      {/* Wraps rather than squeezing: in a narrow column the period select drops
          below the title instead of folding the title onto three lines. The title
          itself stays on one line while the card fits it (measured in rem, so large
          text counts), and wraps only when it would otherwise overflow the card.
          The icon moves above the title only when not even its longest word fits beside it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-chip text-chip-icon">
            <DollarSign className="h-[18px] w-[18px]" aria-hidden />
          </div>
          <h3 className="min-w-0 flex-1 basis-[min-content] break-words font-semibold text-ink @min-[15.75rem]/spend:whitespace-nowrap">Total maintenance spend</h3>
        </div>
        <select
          value={range}
          onChange={(event) => setRange(event.target.value as SpendRange)}
          aria-label="Spend period"
          data-testid="overview-spend-range"
          className="h-8 rounded-md border border-control-border bg-well px-2 text-xs font-medium text-ink"
        >
          {SPEND_RANGES.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4 font-mono text-4xl font-semibold text-ink tabular-nums" data-testid="overview-spend">
        {/* Keyed by range so switching periods replays the count-up. */}
        <CountUp key={range} value={spend.amount} prefix="$" />
      </div>
      <div className="mt-1 text-sm text-meta">
        Final cost across <span className="font-mono">{spend.jobs}</span> completed job{spend.jobs === 1 ? '' : 's'}
      </div>
      {change !== null && spend.previous !== null ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-meta">
          <span className="rounded-full bg-chip px-1.5 py-0.5">
            {/* Spend going down is the good direction. */}
            <DeltaBadge delta={{ percent: change, upIsGood: false, label: '' }} />
          </span>
          vs {spend.previousLabel} (<span className="font-mono">{money(spend.previous)}</span>)
        </div>
      ) : null}

      <div className="mt-4 h-28 min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bars} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ ...LICHEN_TICK, fontSize: 11 }} />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ ...LICHEN_TICK, fontSize: 10 }}
              width={34}
              tickFormatter={compact}
              allowDecimals={false}
            />
            <Tooltip
              {...LICHEN_TOOLTIP}
              cursor={{ fill: C.grid }}
              formatter={(value) => [money(Number(value)), 'Spend']}
            />
            {/* Realised spend is settled history, so Mist; the current month
                is the full tone and earlier months its quieter line step. */}
            <Bar dataKey="cost" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false}>
              {bars.map((bar, index) => (
                <Cell key={bar.key} fill={index === bars.length - 1 ? C.mist : C.mistLine} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {committed > 0 ? (
        <div className="mt-3 flex items-center justify-between border-t border-hairline pt-3 text-sm">
          <span className="text-meta" title="Vendor quote ceilings on booked, unfinished jobs">
            Committed (max)
          </span>
          <span className="font-mono font-semibold text-ink" data-testid="overview-committed">
            {money(committed)}
          </span>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onViewReports}
        data-testid="overview-view-reports"
        className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-control-border py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-hairline motion-reduce:transition-none"
      >
        View detailed reports
        <ArrowRight className="h-4 w-4" aria-hidden />
      </button>
    </Card>
  );
}
