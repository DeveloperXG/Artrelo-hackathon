import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../ui/utils';
import { LICHEN_FOCUS } from '../ui/lichen';

export type StatDelta = {
  /** Percent change, already rounded by the caller. */
  percent: number;
  /** Whether a rise is good news. Open requests rising is bad; spend falling is good. */
  upIsGood: boolean;
  /** "from last month", "vs previous period" … */
  label: string;
};

/**
 * One tile of the KPI row at the top of a landlord page.
 *
 * Only tiles with an `onClick` get a chevron and hover lift: a tile either
 * does something (filters the page, opens a tab) or is plainly a figure. When
 * it filters, `active` marks the filter that is on.
 */
export default function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  delta,
  tone = 'slate',
  onClick,
  active = false,
  delay = 0,
  testId,
  wrap = false,
  entrance = true,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  delta?: StatDelta | null;
  /** Icon chip colour. Slate by default, matching the mockups' neutral chips. */
  tone?: 'slate' | 'blue' | 'amber' | 'rose' | 'emerald' | 'violet';
  onClick?: () => void;
  active?: boolean;
  delay?: number;
  testId?: string;
  /** Wrap the label and note instead of truncating them, for a page whose tiles
   * must stay fully readable at large text sizes. Off by default. */
  wrap?: boolean;
  /** Opt out of decorative entrance on migrated Wallet/Schedule only. */
  entrance?: boolean;
}) {
  // lichen: the owner's neutral icon chip, except the two tones that carry
  // meaning there: amber (needs you) is Lichen, rose (urgent) is Alert.
  const tones: Record<string, string> = {
    slate: 'bg-slate-50 text-slate-600 ring-slate-200/70 lichen:bg-chip lichen:text-chip-icon lichen:ring-chip-ring',
    blue: 'bg-[#137fec]/10 text-[#137fec] ring-[#137fec]/15 lichen:bg-chip lichen:text-chip-icon lichen:ring-chip-ring',
    amber: 'bg-amber-50 text-amber-600 ring-amber-200/70 lichen:bg-lichen-tint lichen:text-lichen-icon lichen:ring-lichen-line',
    rose: 'bg-rose-50 text-rose-600 ring-rose-200/70 lichen:bg-alert-tint lichen:text-alert-text lichen:ring-alert-line',
    emerald: 'bg-emerald-50 text-emerald-600 ring-emerald-200/70 lichen:bg-chip lichen:text-chip-icon lichen:ring-chip-ring',
    violet: 'bg-violet-50 text-violet-600 ring-violet-200/70 lichen:bg-chip lichen:text-chip-icon lichen:ring-chip-ring',
  };

  const body = (
    <>
      <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 lichen:rounded-md', tones[tone])}>
        <Icon className="h-5 w-5" aria-hidden />
      </div>
      {/* With wrap, the 6rem basis keeps the icon beside the text at normal
          sizes and moves it above only for very large text. */}
      <div className={cn('min-w-0', wrap ? 'flex-[1_1_6rem]' : 'flex-1')}>
        <div className={cn(wrap ? 'break-words' : 'truncate', 'text-sm font-medium text-slate-500 lichen:text-meta')}>{label}</div>
        {/* Figures in Plex Mono inside the Lichen scope. */}
        <div className={cn('mt-1 text-2xl font-bold tracking-tight text-slate-900 tabular-nums lichen:font-mono lichen:font-semibold lichen:tracking-normal lichen:text-ink', wrap && 'break-words')}>{value}</div>
        {delta || sub ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500 lichen:text-meta">
            {delta ? <DeltaBadge delta={delta} /> : null}
            {delta ? <span>{delta.label}</span> : null}
            {sub ? <span className={wrap ? 'break-words' : 'truncate'}>{sub}</span> : null}
          </div>
        ) : null}
      </div>
      {onClick ? (
        <ChevronRight
          className="mt-1 h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500 motion-reduce:transition-none lichen:text-meta lichen:group-hover:text-ink"
          aria-hidden
        />
      ) : null}
    </>
  );

  const shell = cn(
    wrap && 'flex-wrap',
    entrance && 'll-fade-up',
    'group flex w-full items-start gap-4 rounded-2xl border bg-white p-5 text-left shadow-sm lichen:rounded-lg lichen:bg-card lichen:shadow-lichen-card',
    active
      ? 'border-[#137fec]/50 ring-2 ring-[#137fec]/15 lichen:border-lichen lichen:ring-0'
      : 'border-slate-200/70 lichen:border-border'
  );
  const style = entrance && delay ? { animationDelay: `${delay}ms` } : undefined;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active || undefined}
        data-testid={testId}
        style={style}
        className={cn(
          shell,
          'transition duration-200 hover:-translate-y-0.5 hover:shadow-md motion-reduce:transition-none motion-reduce:hover:translate-y-0',
          // No lift or shadow in Lichen: the hover is a border step.
          'lichen:hover:translate-y-0 lichen:hover:border-chip-ring lichen:hover:shadow-lichen-card',
          LICHEN_FOCUS
        )}
      >
        {body}
      </button>
    );
  }
  return (
    <div data-testid={testId} style={style} className={shell}>
      {body}
    </div>
  );
}

export function DeltaBadge({ delta }: { delta: StatDelta }) {
  const up = delta.percent > 0;
  const flat = delta.percent === 0;
  const good = flat ? null : up === delta.upIsGood;
  const Arrow = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 font-semibold tabular-nums lichen:font-mono',
        good === null
          ? 'text-slate-500 lichen:text-meta'
          : good
            ? 'text-emerald-600 lichen:text-mist-text'
            : 'text-rose-600 lichen:text-alert-text'
      )}
    >
      {flat ? null : <Arrow className="h-3 w-3" aria-hidden />}
      {up ? '+' : ''}
      {delta.percent}%
    </span>
  );
}

/** Percent change from `previous` to `current`, or null when there is no base to compare against. */
export function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * The four-up row the KPI tiles sit in. Columns follow the page column (the
 * layout's `page` container), not the viewport, so docked Iris narrowing the
 * page drops to two columns instead of cutting the labels to "Pro…".
 * 58rem is the old xl (960px of page) less up to 32px of classic scrollbar,
 * which a viewport media query counted but the page column does not. The wide
 * step is lg-guarded: below lg there is no sidebar, so the page is wider than
 * the old xl assumed and would otherwise go four-up early.
 */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-1 gap-4 @min-[38rem]/page:grid-cols-2 lg:@min-[58rem]/page:grid-cols-4', className)}>{children}</div>
  );
}
