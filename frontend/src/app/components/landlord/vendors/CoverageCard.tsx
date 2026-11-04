import { AlertTriangle, Layers, Plus } from 'lucide-react';
import type { VendorItem } from '../../../types/landlord';
import { Card } from '../../ui/card';
import { cn } from '../../ui/utils';
import { tradeCoverage } from './vendorFilters';

/**
 * How many vendors cover each trade, with the gaps called out.
 *
 * A trade with nobody in it is where a tenant's request turns into a routing
 * exception on the Decisions page, so the empty core trades are the point of
 * this card, not the bars.
 */
export default function CoverageCard({
  vendors,
  onAddVendor,
  onPickTrade,
}: {
  vendors: VendorItem[];
  onAddVendor: () => void;
  onPickTrade: (trade: string) => void;
}) {
  const rows = tradeCoverage(vendors);
  const max = rows.reduce((acc, row) => Math.max(acc, row.count), 0);
  const gaps = rows.filter((row) => row.gap);

  return (
    <Card className="ll-fade-up gap-0 border border-slate-200/70 p-5 shadow-sm" data-testid="vendor-coverage">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#137fec]/10 text-[#137fec]">
          <Layers className="h-[18px] w-[18px]" />
        </div>
        <h3 className="font-semibold text-slate-900">Coverage by trade</h3>
      </div>

      {gaps.length ? (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span>
            No vendor for {gaps.map((g) => g.label).join(', ')}. Requests in {gaps.length === 1 ? 'that trade' : 'those trades'} will
            need you to find someone.
          </span>
        </div>
      ) : null}

      <ul className="mt-4 space-y-2.5">
        {rows.map((row) => (
          <li key={row.label}>
            <button
              type="button"
              disabled={row.gap}
              onClick={() => onPickTrade(row.label)}
              title={row.gap ? undefined : `Show ${row.label} vendors`}
              className="grid w-full grid-cols-[minmax(0,7.5rem)_1fr_1.5rem] items-center gap-3 rounded-md text-left text-sm transition enabled:hover:bg-slate-50 disabled:cursor-default"
            >
              <span className={cn('truncate', row.gap ? 'text-amber-700' : 'text-slate-600')}>{row.label}</span>
              <span className="h-2 overflow-hidden rounded-full bg-slate-100">
                <span
                  className="block h-full rounded-full bg-[#137fec]"
                  style={{ width: max ? `${(row.count / max) * 100}%` : '0%' }}
                />
              </span>
              <span className={cn('text-right font-semibold tabular-nums', row.gap ? 'text-amber-600' : 'text-slate-900')}>
                {row.count}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {gaps.length ? (
        <button
          type="button"
          onClick={onAddVendor}
          className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 py-2 text-sm font-semibold text-[#137fec] transition hover:border-[#137fec]/30 hover:bg-[#137fec]/5"
        >
          <Plus className="h-4 w-4" />
          Add a vendor
        </button>
      ) : null}
    </Card>
  );
}
