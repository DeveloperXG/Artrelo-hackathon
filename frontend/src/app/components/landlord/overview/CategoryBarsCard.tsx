import { useEffect, useState } from 'react';
import { Card } from '../../ui/card';
import CountUp from '../CountUp';
import { topCategories } from './overviewData';

/**
 * The busiest request types as horizontal bars.
 *
 * The bars grow in from zero one after another (a short stagger) while the
 * counts tick up beside them, so the ranking reads as it draws. Widths are
 * relative to the busiest category, not to the total, so the top bar is always
 * full and the rest compare against it. Reduced motion draws them in place.
 */
export default function CategoryBarsCard({ byCategory }: { byCategory: Record<string, number> }) {
  const rows = topCategories(byCategory, 5);
  const max = rows.reduce((acc, row) => Math.max(acc, row.count), 0);
  // Start at zero width and flip on the next frame so the CSS transition runs.
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <Card className="ll-fade-up flex min-w-0 flex-col gap-4 border-border p-5">
      <div>
        <h3 className="font-semibold text-ink">Requests by category</h3>
        <p className="text-sm text-meta">Top request types across all your requests.</p>
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-10 text-sm text-meta">No category data yet.</div>
      ) : (
        <ul className="flex flex-1 flex-col justify-center gap-4" data-testid="overview-category-bars">
          {rows.map((row, index) => {
            const width = max ? (row.count / max) * 100 : 0;
            return (
              <li key={row.name} className="grid grid-cols-[minmax(0,6.5rem)_1fr_2rem] items-center gap-3 text-sm">
                <span className="truncate capitalize text-nav" title={row.name}>
                  {row.name}
                </span>
                <span className="h-2.5 overflow-hidden rounded-full bg-chip" aria-hidden>
                  <span
                    className="block h-full rounded-full motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-out"
                    style={{
                      width: grown ? `${width}%` : '0%',
                      transitionDelay: `${index * 110}ms`,
                      // A comparison, not a state: every bar is Mist and the
                      // count beside it carries the value.
                      background: 'var(--color-mist)',
                    }}
                  />
                </span>
                <span className="text-right font-mono font-semibold text-ink tabular-nums">
                  <CountUp value={row.count} duration={700 + index * 110} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
