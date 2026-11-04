import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card } from '../../ui/card';
import type { Stats } from '../../../types/landlord';
import { CHART_RANGES, trendForRange, type ChartRange } from './overviewData';
import { LICHEN_CHART as C, LICHEN_TICK, LICHEN_TOOLTIP } from './categoryVisuals';

/** Incoming requests against resolved ones, over 7 days to 12 months. */
export default function RequestsTrendCard({ stats }: { stats: Stats }) {
  const [range, setRange] = useState<ChartRange>('6M');
  const data = useMemo(() => trendForRange(stats, range), [stats, range]);
  // Daily ranges have up to 30 ticks; label every few so they don't collide.
  const tickInterval = range === '30D' ? 4 : 0;

  return (
    <Card className="ll-fade-up flex min-w-0 flex-col gap-4 border-border p-5 lg:@min-[58rem]/page:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink">Maintenance requests</h3>
          <p className="text-sm text-meta">Incoming work compared with resolved requests.</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {/* Line style as well as colour: Incoming solid, Resolved dashed. */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-meta">
              <span className="h-0.5 w-4 rounded-full bg-lichen-icon" aria-hidden />
              Incoming
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-meta">
              <span className="w-4 border-t-2 border-dashed border-mist-text" aria-hidden />
              Resolved
            </span>
          </div>
          <div
            className="inline-flex flex-wrap rounded-md border border-border bg-well p-0.5 font-mono text-xs font-medium"
            role="group"
            aria-label="Chart range"
          >
            {CHART_RANGES.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={range === option}
                data-testid={`overview-range-${option}`}
                onClick={() => setRange(option)}
                className={`rounded-[4px] px-2.5 py-1 transition-colors motion-reduce:transition-none ${
                  range === option
                    ? 'bg-lichen text-on-lichen forced-colors:border forced-colors:border-[Highlight]'
                    : 'text-meta hover:text-ink'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="h-64 min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 16, left: -18, bottom: 0 }}>
            {/* Flat fills, no gradient: a faint wash under each line. */}
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={LICHEN_TICK} dy={6} interval={tickInterval} />
            <YAxis tickLine={false} axisLine={false} tick={LICHEN_TICK} width={42} allowDecimals={false} />
            <Tooltip {...LICHEN_TOOLTIP} cursor={{ stroke: C.axis, strokeDasharray: '4 4' }} />
            <Area
              type="monotone"
              dataKey="requests"
              name="Incoming"
              stroke={C.lichenLine}
              strokeWidth={2.5}
              fill={C.lichen}
              fillOpacity={0.12}
              isAnimationActive={false}
              dot={range === '30D' ? false : { r: 3.5, fill: C.lichenLine, strokeWidth: 0 }}
              activeDot={{ r: 5, strokeWidth: 2, stroke: C.surface }}
            />
            <Area
              type="monotone"
              dataKey="resolved"
              name="Resolved"
              stroke={C.mistStroke}
              strokeWidth={2.5}
              strokeDasharray="6 4"
              fill={C.mist}
              fillOpacity={0.08}
              isAnimationActive={false}
              dot={range === '30D' ? false : { r: 3.5, fill: C.mistStroke, strokeWidth: 0 }}
              activeDot={{ r: 5, strokeWidth: 2, stroke: C.surface }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
