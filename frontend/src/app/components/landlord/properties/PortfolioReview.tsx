import { useState } from 'react';
import { AlertCircle, Building2, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { FieldLabel } from '../landlordUi';
import UnitReviewTable from '../units/UnitReviewTable';
import type { ProposedUnit } from '../units/proposedUnits';
import type { PortfolioReviewResult, ProposedProperty } from './proposedPortfolio';

/**
 * The portfolio review stage.
 *
 * Same contract as the unit review table: nothing here has touched the
 * database, every field is editable, and the only way out is a button that
 * names the number. It just has two levels — properties, and the units under
 * each — and the inner level is literally the unit review table, so editing
 * units inside a portfolio import behaves exactly like editing them in a
 * single-property one.
 *
 * Properties start collapsed. Twelve buildings expanded into 438 open inputs is
 * not a review screen, it is a wall. The counts and the problems are on the
 * collapsed row; opening one is for when you want to change something.
 */
export interface PortfolioReviewProps {
  properties: ProposedProperty[];
  review: PortfolioReviewResult;
  onChange: (properties: ProposedProperty[]) => void;
  busy?: boolean;
}

export default function PortfolioReview({
  properties,
  review,
  onChange,
  busy,
}: PortfolioReviewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const patch = (id: string, changes: Partial<ProposedProperty>) => {
    onChange(properties.map((property) => (property.id === id ? { ...property, ...changes } : property)));
  };

  const remove = (id: string) => {
    onChange(properties.filter((property) => property.id !== id));
  };

  const toggle = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const { summary } = review;

  return (
    <div className="space-y-3">
      <div
        role="status"
        data-testid="portfolio-summary"
        className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-3 text-sm"
      >
        <span className="text-slate-700">
          <span className="font-semibold text-slate-900">{summary.properties}</span> propert
          {summary.properties === 1 ? 'y' : 'ies'}
        </span>
        <span className="text-slate-700">
          <span className="font-semibold text-slate-900">{summary.units}</span> unit
          {summary.units === 1 ? '' : 's'}
        </span>
        {summary.duplicateProperties + summary.duplicateUnits > 0 ? (
          <span className="text-amber-700">
            {summary.duplicateProperties + summary.duplicateUnits} duplicate
            {summary.duplicateProperties + summary.duplicateUnits === 1 ? '' : 's'}
          </span>
        ) : null}
        {summary.invalidProperties > 0 ? (
          <span className="text-rose-700">
            {summary.invalidProperties} need
            {summary.invalidProperties === 1 ? 's' : ''} attention
          </span>
        ) : null}
      </div>

      <div className="max-h-[46vh] space-y-2 overflow-auto pr-1">
        {review.properties.map((property) => {
          const open = expanded.has(property.id);
          return (
            <div
              key={property.id}
              data-testid={`portfolio-property-${property.index}`}
              className={`rounded-xl border ${
                property.valid ? 'border-slate-200 bg-white' : 'border-rose-200 bg-rose-50/40'
              }`}
            >
              <div className="flex items-start gap-2 p-3">
                <button
                  type="button"
                  onClick={() => toggle(property.id)}
                  aria-expanded={open}
                  aria-label={`${open ? 'Collapse' : 'Expand'} ${property.name || 'unnamed property'}`}
                  className="mt-2 shrink-0 rounded p-0.5 text-slate-400 transition hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]/40"
                >
                  {open ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>

                <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                  <label className="space-y-1">
                    <FieldLabel>Property</FieldLabel>
                    <Input
                      value={property.name}
                      disabled={busy}
                      aria-invalid={property.errors.some((error) => error.code.startsWith('NAME'))}
                      className="h-9 bg-white"
                      onChange={(event) => patch(property.id, { name: event.target.value })}
                    />
                  </label>
                  <label className="space-y-1">
                    <FieldLabel>Address</FieldLabel>
                    <Input
                      value={property.address}
                      disabled={busy}
                      aria-invalid={property.errors.some((error) => error.code.startsWith('ADDRESS'))}
                      className="h-9 bg-white"
                      onChange={(event) => patch(property.id, { address: event.target.value })}
                    />
                  </label>
                </div>

                <div className="mt-5 flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                    {property.unitReview.summary.total}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    aria-label={`Remove ${property.name || 'unnamed property'}`}
                    className="h-8 w-8 text-slate-300 hover:bg-rose-50 hover:text-rose-600"
                    onClick={() => remove(property.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {property.errors.length > 0 || property.unitReview.summary.invalid > 0 ? (
                <p className="flex items-start gap-1.5 px-3 pb-2.5 text-xs text-rose-600">
                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    {[
                      ...property.errors.map((error) => error.message),
                      ...(property.unitReview.summary.invalid > 0
                        ? [
                            property.unitReview.summary.invalid === 1
                              ? '1 unit needs attention — open this property to fix it'
                              : `${property.unitReview.summary.invalid} units need attention — open this property to fix them`,
                          ]
                        : []),
                    ].join('. ')}
                  </span>
                </p>
              ) : null}

              {open ? (
                <div className="border-t border-slate-100 p-3">
                  <UnitReviewTable
                    rows={property.units}
                    review={property.unitReview}
                    busy={busy}
                    onChange={(units: ProposedUnit[]) => patch(property.id, { units })}
                  />
                </div>
              ) : null}
            </div>
          );
        })}

        {review.properties.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-6 py-10 text-center">
            <Building2 className="h-5 w-5 text-slate-300" />
            <p className="text-sm text-slate-500">No properties left to import.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
