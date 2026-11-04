import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export default function LandlordPageHeader({
  title,
  description,
  icon: Icon,
  actions,
  titleTestId = 'dashboard-title',
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
  actions?: ReactNode;
  titleTestId?: string;
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-4">
        {Icon ? (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#137fec] to-[#a855f7] text-white shadow-lg shadow-[#137fec]/20">
            <Icon className="h-6 w-6" />
          </div>
        ) : null}
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-900" data-testid={titleTestId}>
            {title}
          </h2>
          <p className="mt-1 text-sm text-slate-500">{description}</p>
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
