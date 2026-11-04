import { Plus, Trash2 } from 'lucide-react';
import { FieldError, invalidFieldClass } from '../ui/FieldError';
import { HackathonBadge } from '../judge/JudgeBadges';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  MAX_DESCRIPTION,
  MAX_ITEMS,
  addLine,
  draftTotals,
  formatCAD,
  removeLine,
  type DraftLine,
  type LineErrors,
  type LineField,
  type PricingMode,
} from '../../lib/itemization';

// Neutral controls: 6px radius, ink focus ring, no brand accent.
export const quoteFieldClass =
  'h-10 w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus-visible:border-slate-900 focus-visible:ring-2 focus-visible:ring-slate-900/20 disabled:bg-slate-50 disabled:text-slate-500';

const labelClass = 'block text-xs font-medium text-slate-600';

/**
 * Line-by-line price entry for an itemized quote or final statement. Amounts
 * stay as typed until submit; the running total is computed in integer cents.
 */
export default function ItemizationEditor({
  idPrefix,
  mode,
  onModeChange,
  lines,
  onLinesChange,
  lineErrors = {},
  onClearError,
  disabled = false,
  totalLabel = 'Total',
}: {
  idPrefix: string;
  mode: PricingMode;
  /** Omit to lock the mode (a final statement is always exact amounts). */
  onModeChange?: (mode: PricingMode) => void;
  lines: DraftLine[];
  onLinesChange: (lines: DraftLine[]) => void;
  lineErrors?: Record<string, LineErrors>;
  onClearError?: (key: string, field: LineField) => void;
  disabled?: boolean;
  totalLabel?: string;
}) {
  const totals = draftTotals(mode, lines);
  const update = (key: string, field: LineField, value: string) => {
    onLinesChange(lines.map((line) => (line.key === key ? { ...line, [field]: value } : line)));
    onClearError?.(key, field);
  };

  const amountInput = (line: DraftLine, field: 'amount' | 'low' | 'high', label: string, error?: string) => {
    const id = `${idPrefix}-${line.key}-${field}`;
    return (
      <div className="min-w-0">
        <label className={labelClass} htmlFor={id}>
          {label}
        </label>
        <div className="relative mt-1">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-slate-500" aria-hidden="true">
            $
          </span>
          <input
            id={id}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={line[field]}
            disabled={disabled}
            onChange={(event) => update(line.key, field, event.target.value)}
            placeholder="0.00"
            className={`${quoteFieldClass} pl-6 tabular-nums ${error ? invalidFieldClass : ''}`}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
            data-testid={`${idPrefix}-${field}`}
          />
        </div>
        <FieldError id={`${id}-error`} className="mt-1">
          {error}
        </FieldError>
      </div>
    );
  };

  return (
    <div className="space-y-3" data-testid={`${idPrefix}-editor`}>
      <HackathonBadge />
      {onModeChange ? (
        <div role="group" aria-label="How you are pricing this job" className="inline-flex rounded-md border border-slate-300 p-0.5">
          {(['fixed', 'range'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={disabled}
              onClick={() => onModeChange(value)}
              className={`min-h-9 rounded-[5px] px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-slate-900/30 forced-colors:border ${
                mode === value ? 'bg-slate-900 text-white forced-colors:border-[Highlight]' : 'text-slate-600 hover:text-slate-900'
              }`}
              data-testid={`${idPrefix}-mode-${value}`}
            >
              {value === 'fixed' ? 'Exact amounts' : 'Price ranges'}
            </button>
          ))}
        </div>
      ) : null}

      <ol className="space-y-3">
        {lines.map((line, index) => {
          const errors = lineErrors[line.key] || {};
          const descriptionId = `${idPrefix}-${line.key}-description`;
          const categoryId = `${idPrefix}-${line.key}-category`;
          return (
            <li
              key={line.key}
              className="rounded-lg border border-slate-200 bg-white p-3 sm:p-4"
              aria-label={`Line ${index + 1}`}
              data-testid={`${idPrefix}-line`}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <label className={labelClass} htmlFor={descriptionId}>
                    Line {index + 1} description
                  </label>
                  <input
                    id={descriptionId}
                    type="text"
                    value={line.description}
                    maxLength={MAX_DESCRIPTION}
                    disabled={disabled}
                    onChange={(event) => update(line.key, 'description', event.target.value)}
                    placeholder="Replace kitchen tap cartridge"
                    className={`${quoteFieldClass} mt-1 ${errors.description ? invalidFieldClass : ''}`}
                    aria-invalid={Boolean(errors.description)}
                    aria-describedby={errors.description ? `${descriptionId}-error` : undefined}
                    data-testid={`${idPrefix}-description`}
                  />
                  <FieldError id={`${descriptionId}-error`} className="mt-1">
                    {errors.description}
                  </FieldError>
                </div>
                <button
                  type="button"
                  onClick={() => onLinesChange(removeLine(lines, line.key))}
                  disabled={disabled || lines.length <= 1}
                  aria-label={`Remove line ${index + 1}`}
                  className="mt-5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-600 outline-none hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-slate-900/30 disabled:opacity-40"
                  data-testid={`${idPrefix}-remove`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              <div className={`mt-3 grid gap-3 ${mode === 'fixed' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'}`}>
                <div className="min-w-0">
                  <label className={labelClass} htmlFor={categoryId}>
                    Category
                  </label>
                  <select
                    id={categoryId}
                    value={line.category}
                    disabled={disabled}
                    onChange={(event) => update(line.key, 'category', event.target.value)}
                    className={`${quoteFieldClass} mt-1 ${errors.category ? invalidFieldClass : ''}`}
                    aria-invalid={Boolean(errors.category)}
                    aria-describedby={errors.category ? `${categoryId}-error` : undefined}
                    data-testid={`${idPrefix}-category`}
                  >
                    <option value="">Choose…</option>
                    {CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {CATEGORY_LABELS[category]}
                      </option>
                    ))}
                  </select>
                  <FieldError id={`${categoryId}-error`} className="mt-1">
                    {errors.category}
                  </FieldError>
                </div>
                {mode === 'fixed' ? (
                  amountInput(line, 'amount', 'Amount (CAD)', errors.amount)
                ) : (
                  <>
                    {amountInput(line, 'low', 'Low (CAD)', errors.low)}
                    {amountInput(line, 'high', 'High (CAD)', errors.high)}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
        <button
          type="button"
          onClick={() => onLinesChange(addLine(lines))}
          disabled={disabled || lines.length >= MAX_ITEMS}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 outline-none hover:border-slate-400 focus-visible:ring-2 focus-visible:ring-slate-900/30 disabled:opacity-40"
          data-testid={`${idPrefix}-add`}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add line
        </button>
        <p className="text-sm text-slate-700" aria-live="polite" data-testid={`${idPrefix}-total`}>
          {totalLabel}{' '}
          <strong className="tabular-nums text-slate-900">
            {mode === 'fixed' || totals.lowMinor === totals.highMinor
              ? formatCAD(totals.highMinor)
              : `${formatCAD(totals.lowMinor)}–${formatCAD(totals.highMinor)}`}
          </strong>{' '}
          CAD
          {!totals.complete ? <span className="block text-xs text-slate-500">Lines without a readable amount aren&rsquo;t counted yet.</span> : null}
        </p>
      </div>
    </div>
  );
}
