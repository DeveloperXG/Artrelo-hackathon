import type { ReactNode } from 'react';

/**
 * Title, one-line description and primary actions for the redesigned landlord
 * pages. Deliberately separate from LandlordPageHeader, which the tenant portal
 * shares and which keeps its gradient icon tile.
 */
export default function PageHeader({
  title,
  description,
  actions,
  titleTestId = 'dashboard-title',
}: {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  titleTestId?: string;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h2 className="break-words text-3xl font-bold tracking-tight text-slate-900 lichen:tracking-[-0.02em] lichen:text-ink" data-testid={titleTestId}>
          {title}
        </h2>
        <p className="mt-1.5 text-sm text-slate-500 sm:text-[15px] lichen:text-meta">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
