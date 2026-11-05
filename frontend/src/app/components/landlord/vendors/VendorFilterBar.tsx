import { Check, Search, X } from 'lucide-react';
import { Input } from '../../ui/input';
import { cn } from '../../ui/utils';
import { EMPTY_FILTERS, hasActiveFilters, type VendorFilterState, type VendorSort } from './vendorFilters';

const SORTS: { key: VendorSort; label: string }[] = [
  { key: 'name', label: 'Name (A–Z)' },
  { key: 'jobs', label: 'Most jobs' },
  { key: 'response', label: 'Fastest response' },
];

/**
 * Search by name/company, narrow by trade (OR'd chips — "All" clears them),
 * emergency-ready only, and a sort. The "Missing details" stat tile drives
 * `missingOnly`; it shows here as a removable chip while it's on.
 */
export default function VendorFilterBar({
  filters,
  onChange,
  specialties,
  shown,
  total,
}: {
  filters: VendorFilterState;
  onChange: (next: VendorFilterState) => void;
  specialties: { label: string; count: number }[];
  shown: number;
  total: number;
}) {
  const active = hasActiveFilters(filters);
  const toggleSpecialty = (label: string) =>
    onChange({
      ...filters,
      specialties: filters.specialties.includes(label)
        ? filters.specialties.filter((value) => value !== label)
        : [...filters.specialties, label],
    });

  const chip = (on: boolean) =>
    cn(
      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
      on ? "border-[#137fec]/30 bg-[#137fec]/10 text-[#137fec] lichen:border-lichen-line lichen:bg-chip lichen:text-lichen-text" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 lichen:border-hairline lichen:bg-card lichen:text-meta lichen:hover:border-hairline"
    );

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 lichen:text-meta" />
          <Input
            data-testid="vendor-search"
            type="search"
            value={filters.query}
            onChange={(event) => onChange({ ...filters, query: event.target.value })}
            placeholder="Search by name or company…"
            aria-label="Search vendors by name or company"
            className="h-10 bg-white pl-9 lichen:bg-card"
          />
        </div>
        <button
          type="button"
          role="checkbox"
          aria-checked={filters.emergencyOnly}
          data-testid="vendor-filter-emergency"
          onClick={() => onChange({ ...filters, emergencyOnly: !filters.emergencyOnly })}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-sm font-medium text-slate-700 transition hover:border-slate-300 lichen:rounded-lg lichen:border-hairline lichen:bg-card lichen:text-ink lichen:hover:border-hairline"
        >
          <span
            className={cn(
              'flex h-4 w-4 items-center justify-center rounded border',
              filters.emergencyOnly ? "border-rose-500 bg-rose-500 text-white lichen:border-alert-line lichen:bg-alert-tint" : "border-slate-300 bg-white lichen:border-hairline lichen:bg-card"
            )}
          >
            {filters.emergencyOnly ? <Check className="h-3 w-3" /> : null}
          </span>
          Emergency ready only
        </button>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="vendor-filter-specialties">
          <button
            type="button"
            aria-pressed={filters.specialties.length === 0}
            onClick={() => onChange({ ...filters, specialties: [] })}
            className={chip(filters.specialties.length === 0)}
          >
            All
          </button>
          {specialties.map(({ label, count }) => {
            const on = filters.specialties.includes(label);
            return (
              <button key={label} type="button" aria-pressed={on} onClick={() => toggleSpecialty(label)} className={chip(on)}>
                {label}
                <span className={cn("tabular-nums lichen:font-mono", on ? "text-[#137fec]/70 lichen:text-lichen-text" : "text-slate-400 lichen:text-meta")}>{count}</span>
              </button>
            );
          })}
          {filters.missingOnly ? (
            <button
              type="button"
              onClick={() => onChange({ ...filters, missingOnly: false })}
              className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 lichen:border-lichen-line lichen:bg-lichen-tint lichen:text-lichen-text"
            >
              Missing details
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs text-slate-500 lichen:text-meta">
          Sort:
          <select
            value={filters.sort || 'name'}
            onChange={(event) => onChange({ ...filters, sort: event.target.value as VendorSort })}
            data-testid="vendor-sort"
            className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 outline-none focus:border-[#137fec] lichen:rounded-lg lichen:border-hairline lichen:bg-card lichen:text-ink lichen:focus:border-lichen-line"
          >
            {SORTS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {active ? (
        <div className="flex items-center justify-between text-xs text-slate-500 lichen:text-meta">
          <span data-testid="vendor-result-count">
            Showing {shown} of {total}
          </span>
          <button
            type="button"
            data-testid="vendor-clear-filters"
            onClick={() => onChange({ ...EMPTY_FILTERS, sort: filters.sort })}
            className="inline-flex items-center gap-1 font-medium text-[#137fec] hover:underline lichen:text-lichen-text"
          >
            <X className="h-3 w-3" />
            Clear filters
          </button>
        </div>
      ) : null}
    </div>
  );
}
