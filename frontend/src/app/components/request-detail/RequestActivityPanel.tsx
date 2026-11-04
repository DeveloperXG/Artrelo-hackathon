import { Clock } from 'lucide-react';
import { Badge } from '../ui/badge';
import type { RequestActivityItem } from './requestDetailTypes';
import { DETAIL_STATUS_COLORS } from './requestDetailTypes';
import { DetailCard } from './detailUi';
import { activityTime } from '../../lib/requestWorkflow';
import { useTenantPresentation } from '../tenant/tenantPresentation';

export default function RequestActivityPanel({
  items,
  loading = false,
  error = '',
}: {
  items: RequestActivityItem[];
  loading?: boolean;
  error?: string;
}) {
  const tenantPresentation = useTenantPresentation();
  return (
    <DetailCard
      icon={Clock}
      iconColor="#a855f7"
      title="Activity"
      description="Lifecycle changes and agent actions on this request."
      id="request-detail-tab-activity"
      role={tenantPresentation ? 'region' : 'tabpanel'}
      aria-labelledby={tenantPresentation ? undefined : 'request-detail-tab-button-activity'}
      aria-label={tenantPresentation ? 'Activity' : undefined}
    >
      {error ? (
        <div className="mb-4 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-alert-line in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text">
          {error}
        </div>
      ) : null}
      {loading ? (
        <p className="py-6 text-sm text-slate-500 in-[.lichen-d5]:text-meta">Loading activity...</p>
      ) : items.length > 0 ? (
        <div
          className={items.length > 4 ? 'max-h-[27rem] overflow-y-auto pr-2' : ''}
          data-testid="detail-timeline"
        >
          <ol className="relative ml-1.5 space-y-5 border-l border-slate-200 pl-6 in-[.lichen-d5]:border-border">
            {items.map((item) => (
              <li key={item.id} className="relative" data-testid="activity-item" data-activity-id={item.id}>
                <span
                  className={`absolute -left-[31px] top-0.5 h-4 w-4 rounded-full border-2 border-white in-[.lichen-d5]:bg-meta ${
                    DETAIL_STATUS_COLORS[item.colorKey || '']?.split(' ')[0] || 'bg-slate-300'
                  }`}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-sm font-semibold capitalize text-slate-900 in-[.lichen-d5]:text-ink">{item.title}</div>
                  <Badge
                    className={
                      item.source === 'audit'
                        ? 'border-transparent bg-violet-100 text-violet-700 in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-meta'
                        : "border-transparent bg-slate-100 text-slate-600 in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-meta"
                    }
                  >
                    {item.source === 'audit' ? 'Audit log' : 'Lifecycle'}
                  </Badge>
                </div>
                {item.description ? (
                  <p className="mt-1 text-sm leading-6 text-slate-600 in-[.lichen-d5]:text-meta">{item.description}</p>
                ) : null}
                {item.actor ? (
                  <div className="mt-1 text-xs capitalize text-slate-500 in-[.lichen-d5]:text-meta">
                    Actor: {item.actor.replace(/_/g, ' ')}
                  </div>
                ) : null}
                <div className="mt-1 text-xs text-slate-400 in-[.lichen-d5]:text-meta">
                  {activityTime(item.at) === null ? 'Time not recorded' : new Date(item.at).toLocaleString()}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-8 text-center text-sm text-slate-400 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-well in-[.lichen-d5]:text-meta">
          No events yet.
        </div>
      )}
    </DetailCard>
  );
}
