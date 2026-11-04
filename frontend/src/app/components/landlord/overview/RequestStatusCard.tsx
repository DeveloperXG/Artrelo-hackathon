import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Card } from '../../ui/card';
import CountUp from '../CountUp';
import { statusBreakdown } from './overviewData';
import { LICHEN_CHART as C, LICHEN_TOOLTIP } from './categoryVisuals';

/** Every request the landlord has had, split open / completed / rejected-or-cancelled. */
export default function RequestStatusCard({ byStatus }: { byStatus: Record<string, number> }) {
  const { total, groups } = statusBreakdown(byStatus);
  const slices = groups.filter((group) => group.value > 0);

  return (
    <Card className="ll-fade-up flex min-w-0 flex-col gap-4 border-border p-5">
      <div>
        <h3 className="font-semibold text-ink">Request status</h3>
        <p className="text-sm text-meta">Current breakdown of maintenance requests.</p>
      </div>
      {total === 0 ? (
        <div className="flex flex-1 items-center justify-center py-10 text-sm text-meta">No requests yet.</div>
      ) : (
        // Side by side only when the CARD is wide enough (a container query),
        // not the screen: the card's width depends on the grid, and a legend
        // squeezed beside the donut pushed its percentages out of the card.
        <div className="@container flex flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center gap-5 @md:flex-row">
          {/* Its full size whenever the card allows; smaller only in a narrower card. */}
          <div className="relative aspect-square w-44 max-w-full shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={56}
                  outerRadius={80}
                  paddingAngle={slices.length > 1 ? 3 : 0}
                  cornerRadius={4}
                  startAngle={90}
                  endAngle={-270}
                  stroke="none"
                  isAnimationActive={false}
                >
                  {/* Closed's fill is decorative (1.6:1 on surface), so its
                      slice gets a readable muted outline as well. */}
                  {slices.map((slice) => (
                    <Cell
                      key={slice.key}
                      fill={slice.color}
                      stroke={slice.key === 'closed' ? C.closedEdge : 'none'}
                      strokeWidth={slice.key === 'closed' ? 1.5 : 0}
                    />
                  ))}
                </Pie>
                <Tooltip {...LICHEN_TOOLTIP} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-mono text-3xl font-semibold text-ink tabular-nums">
                <CountUp value={total} />
              </span>
              <span className="text-xs text-meta">Total requests</span>
            </div>
          </div>
          <ul className="w-full flex-1 space-y-3 text-sm">
            {groups.map((group) => (
              <li key={group.key} className="flex flex-wrap items-center gap-2.5" data-testid={`overview-status-${group.key}`}>
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${group.key === 'closed' ? 'border border-meta' : ''}`}
                  style={{ backgroundColor: group.color }}
                  aria-hidden
                />
                {/* The label gives way, never the numbers. The text, not the
                    swatch, is what tells the groups apart. */}
                <span className="min-w-0 flex-1 truncate text-nav" title={group.label}>
                  {group.label}
                </span>
                <span className="w-8 shrink-0 text-right font-mono font-semibold text-ink tabular-nums">{group.value}</span>
                <span className="ml-auto w-10 shrink-0 text-right font-mono text-meta tabular-nums">{group.percent}%</span>
              </li>
            ))}
          </ul>
        </div>
        </div>
      )}
    </Card>
  );
}
