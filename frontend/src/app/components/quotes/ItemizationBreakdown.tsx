import { CATEGORY_LABELS, formatCAD, formatTotals, type Category, type Itemization } from '../../lib/itemization';

/**
 * A stored itemization, read-only. A list rather than a table so a long
 * description wraps under its amount on a phone instead of scrolling sideways.
 */
export default function ItemizationBreakdown({
  itemization,
  title,
  caption,
  highlight,
  testId,
}: {
  itemization: Itemization;
  title?: string;
  /** Under the title: revision, reference, "can't be changed". */
  caption?: string;
  /** lineIds a flag or question points at. */
  highlight?: Set<string>;
  testId?: string;
}) {
  const fixed = itemization.pricingMode === 'fixed';
  return (
    <section className="min-w-0" data-testid={testId}>
      {title ? <h4 className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{title}</h4> : null}
      {caption ? <p className="mt-0.5 text-xs text-slate-500 in-[.lichen-d3]:text-meta">{caption}</p> : null}
      <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white in-[.lichen-d3]:divide-hairline in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card">
        {itemization.items.map((item, index) => {
          const marked = highlight?.has(item.lineId);
          return (
            <li
              key={item.lineId || index}
              className={`flex items-start justify-between gap-3 px-3 py-2.5 ${marked ? "bg-amber-50 in-[.lichen-d3]:bg-lichen-tint" : ''}`}
              data-testid={testId ? `${testId}-line` : undefined}
            >
              <div className="min-w-0">
                <p className="break-words text-sm text-slate-900 in-[.lichen-d3]:text-ink">{item.description}</p>
                <p className="mt-0.5 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                  {CATEGORY_LABELS[item.category as Category] || item.category}
                  {marked ? <span className="ml-1.5 font-semibold text-amber-800 in-[.lichen-d3]:text-lichen-text">· Flagged</span> : null}
                </p>
              </div>
              <span className="shrink-0 text-right text-sm tabular-nums text-slate-900 in-[.lichen-d3]:text-ink">
                {fixed
                  ? formatCAD(item.amountMinor ?? 0)
                  : item.lowMinor === item.highMinor
                    ? formatCAD(item.highMinor ?? 0)
                    : (
                      <>
                        {formatCAD(item.lowMinor ?? 0)}
                        <span className="block text-xs text-slate-500 in-[.lichen-d3]:text-meta">to {formatCAD(item.highMinor ?? 0)}</span>
                      </>
                    )}
              </span>
            </li>
          );
        })}
        <li className="flex flex-wrap items-center justify-between gap-x-3 bg-slate-50 px-3 py-2.5 in-[.lichen-d3]:bg-well">
          <span className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">Total</span>
          <span className="text-right text-sm font-semibold tabular-nums text-slate-900 in-[.lichen-d3]:text-ink" data-testid={testId ? `${testId}-total` : undefined}>
            {formatTotals(itemization)} CAD
          </span>
        </li>
      </ul>
    </section>
  );
}
