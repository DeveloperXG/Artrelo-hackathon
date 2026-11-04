import { cn } from '../ui/utils';

export type FilterChipOption<K extends string> = { key: K; label: string; count?: number };

/** The row of pill filters the Requests, Schedule, Decisions and Wallet pages share. */
export default function FilterChips<K extends string>({
  options,
  value,
  onChange,
  testIdPrefix,
  className,
  presentation = false,
}: {
  options: ReadonlyArray<FilterChipOption<K>>;
  value: K;
  onChange: (key: K) => void;
  /** Each chip gets `${testIdPrefix}-${key}`; omit to set none. */
  testIdPrefix?: string;
  className?: string;
  /** Opt-in Wallet presentation; legacy consumers keep their existing appearance. */
  presentation?: boolean;
}) {
  return (
    <div className={cn('flex flex-wrap gap-2', className)} role="group">
      {options.map((option) => {
        const active = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            data-testid={testIdPrefix ? `${testIdPrefix}-${option.key}` : undefined}
            onClick={() => onChange(option.key)}
            className={cn(
              presentation && 'max-w-full whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none',
              'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition',
              presentation ? (active ? 'border-transparent bg-primary text-primary-foreground' : 'border-border bg-card text-meta hover:border-lichen-line hover:text-lichen-text') : active
                ? 'border-transparent bg-[#137fec] text-white shadow-sm shadow-[#137fec]/25'
                : 'border-slate-200 bg-white text-slate-600 hover:border-[#137fec]/40 hover:text-[#137fec]'
            )}
          >
            {option.label}
            {option.count !== undefined ? (
              <span className={cn('tabular-nums text-xs', presentation ? (active ? 'text-primary-foreground' : 'text-meta') : active ? 'text-white/75' : 'text-slate-400')}>
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
