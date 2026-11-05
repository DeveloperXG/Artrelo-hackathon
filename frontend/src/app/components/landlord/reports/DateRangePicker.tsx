import { REMAINDER_PORTAL } from '../remainderPresentation';
import { useEffect, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Button } from '../../ui/button';
import { FieldError, invalidFieldClass } from '../../ui/FieldError';
import { cn } from '../../ui/utils';
import { fieldClass, FieldLabel } from '../landlordUi';
import { RANGE_PRESETS, isoDay, presetRange, rangeLabel, type RangePreset } from './reportData';

export type ReportRange = { from: string; to: string; preset: RangePreset | 'custom' };

/**
 * The Reports date window: presets for the usual questions, and two native
 * date inputs for anything else. A server-side refusal (`error`) shows beside
 * the inputs, never as a toast.
 */
export default function DateRangePicker({
  value,
  onChange,
  error,
}: {
  value: ReportRange;
  onChange: (next: ReportRange) => void;
  error?: { field?: string; message: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const [localError, setLocalError] = useState('');

  // Re-seed the custom inputs from whatever is applied each time it opens.
  useEffect(() => {
    if (open) {
      setFrom(value.from);
      setTo(value.to);
      setLocalError('');
    }
  }, [open, value.from, value.to]);

  // A refusal from the server re-opens the picker so the message is seen.
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);

  const applyCustom = () => {
    if (!from || !to) {
      setLocalError('Choose both a start and an end date.');
      return;
    }
    if (from > to) {
      setLocalError('The start date must be on or before the end date.');
      return;
    }
    setLocalError('');
    onChange({ from, to, preset: 'custom' });
    setOpen(false);
  };

  const message = localError || error?.message || '';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="reports-range"
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 lichen:rounded-lg lichen:border-hairline lichen:bg-card lichen:text-ink lichen:shadow-lichen-card lichen:hover:border-hairline"
        >
          <CalendarDays className="h-4 w-4 text-slate-500 lichen:text-meta" />
          {rangeLabel(value.from, value.to)}
          <ChevronDown className="h-4 w-4 text-slate-400 lichen:text-meta" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className={`${REMAINDER_PORTAL} w-[19rem] p-3`}>
        <div className="space-y-1">
          {RANGE_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              data-testid={`reports-preset-${preset.key}`}
              onClick={() => {
                onChange({ ...presetRange(preset.key), preset: preset.key });
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition',
                value.preset === preset.key ? "bg-[#137fec]/10 font-semibold text-[#137fec] lichen:bg-chip lichen:text-lichen-text" : "text-slate-700 hover:bg-slate-50 lichen:text-ink lichen:hover:bg-well"
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="mt-3 border-t border-slate-100 pt-3 lichen:border-hairline">
          <FieldLabel>Custom range</FieldLabel>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              type="date"
              value={from}
              max={isoDay(new Date())}
              onChange={(event) => setFrom(event.target.value)}
              aria-label="Start date"
              aria-invalid={Boolean(message && error?.field !== 'to')}
              aria-describedby={message ? 'reports-range-error' : undefined}
              data-testid="reports-from"
              className={cn(fieldClass, 'px-2 text-xs', message && error?.field !== 'to' ? invalidFieldClass : '')}
            />
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              aria-label="End date"
              aria-invalid={Boolean(message && error?.field === 'to')}
              aria-describedby={message ? 'reports-range-error' : undefined}
              data-testid="reports-to"
              className={cn(fieldClass, 'px-2 text-xs', message && error?.field === 'to' ? invalidFieldClass : '')}
            />
          </div>
          <FieldError id="reports-range-error" className="mt-1.5">
            {message}
          </FieldError>
          <Button
            type="button"
            onClick={applyCustom}
            data-testid="reports-apply-custom"
            className="mt-2 h-9 w-full bg-[#137fec] text-sm hover:bg-[#137fec]/90 lichen:bg-primary lichen:hover:bg-chip lichen:text-primary-foreground"
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
