import type { HTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../ui/utils';

/**
 * Shared building blocks for the request-detail views so the landlord and
 * tenant experiences share one consistent, polished visual language built
 * around the brand blue (#137fec) and accent purple (#a855f7) — matching the
 * rest of the dashboard.
 */

export const DETAIL_BRAND = '#137fec';
export const DETAIL_ACCENT = '#a855f7';

/** Subtle light grid surface, matching the landlord dashboard background. */
export const detailSurfaceStyle = {
  backgroundImage:
    'linear-gradient(to right, rgba(15, 23, 42, 0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(15, 23, 42, 0.04) 1px, transparent 1px)',
  backgroundSize: '48px 48px',
} as const;

/** Small uppercase eyebrow label used above section titles and meta. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta",
        className
      )}
    >
      {children}
    </span>
  );
}

/** A white surface card with an optional tinted icon-chip header. */
export function DetailCard({
  icon: Icon,
  iconColor = DETAIL_BRAND,
  eyebrow,
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
  ...rest
}: {
  icon?: LucideIcon;
  iconColor?: string;
  eyebrow?: string;
  title?: string;
  description?: string;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
} & HTMLAttributes<HTMLElement>) {
  const hasHeader = Boolean(Icon || title || eyebrow || description || action);
  return (
    <section
      className={cn("@container/card min-w-0 rounded-2xl border border-slate-300 bg-white p-4 shadow-sm sm:p-6 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:shadow-lichen-card in-[.lichen-d3]:p-[min(1rem,16px)] in-[.lichen-d3]:sm:p-[min(1.5rem,24px)] in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card in-[.lichen-d5]:shadow-lichen-card in-[.lichen-d5]:p-[min(1rem,16px)] in-[.lichen-d5]:sm:p-[min(1.5rem,24px)] in-[.lichen-d5]:[overflow-wrap:anywhere]", className)}
      {...rest}
    >
      {hasHeader ? (
        // Title and action share a row only when the card itself has room
        // (36rem, which grows with the text size), not when the screen does.
        <div className={cn('flex flex-col items-start justify-between gap-4 @xl/card:flex-row', children ? 'mb-5' : '')}>
          {/* The icon sits above the text only when the two cannot share a row. */}
          <div className="flex min-w-0 flex-wrap items-start gap-3">
            {Icon ? (
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl in-[.lichen-d3]:rounded-md in-[.lichen-d3]:bg-chip! in-[.lichen-d3]:text-chip-icon! in-[.lichen-d5]:rounded-md in-[.lichen-d5]:bg-chip! in-[.lichen-d5]:text-chip-icon!"
                style={{ backgroundColor: `${iconColor}1a`, color: iconColor }}
              >
                <Icon className="h-5 w-5" />
              </div>
            ) : null}
            <div className="min-w-0 flex-1 basis-0 [overflow-wrap:anywhere] in-[.lichen-d5]:basis-48">
              {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
              {title ? (
                <h2 className={cn("text-base font-semibold text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink", eyebrow ? 'mt-1' : '')}>
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">{description}</p>
              ) : null}
            </div>
          </div>
          {action ? <div className="max-w-full @xl/card:shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children ? <div className={bodyClassName}>{children}</div> : null}
    </section>
  );
}

/** A compact labelled stat tile used inside cards. */
export function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-300 bg-slate-50/70 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-well">
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-1.5 text-sm font-semibold capitalize text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">{value}</div>
    </div>
  );
}
