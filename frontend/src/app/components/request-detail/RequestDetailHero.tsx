import type { ReactNode } from 'react';
import { Badge } from '../ui/badge';
import { d3StatusClass } from './d3Presentation';
import { tenantStatusClass } from '../tenant/tenantRoles';
import RequestIdentity from '../landlord/RequestIdentity';
import { condenseSummary } from './requestDetailSelectors';
import type {
  HeroMetric,
  RequestDetailRecord,
} from './requestDetailTypes';
import { TENANT_PRIORITY_LABELS } from './requestDetailTypes';
import { safetyPendingReview, tenantSafetyLabel } from '../../lib/requestWorkflow';

function heroMetric(label: string, value: string, secondaryValue?: string) {
  return (
    <div
      key={label}
      className="flex min-h-[84px] flex-col justify-between rounded-xl border border-slate-300 bg-slate-50/60 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-well"
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">{label}</div>
      <div className="mt-2 space-y-0.5">
        <div className="break-words text-base font-semibold leading-snug text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d3]:font-mono in-[.lichen-d5]:text-ink in-[.lichen-d5]:font-mono">{value}</div>
        {secondaryValue ? (
          <div className="break-words text-sm text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">{secondaryValue}</div>
        ) : null}
      </div>
    </div>
  );
}

export default function RequestDetailHero({
  request,
  headline,
  propertyLabel,
  unitLabel,
  lifecycleStatus,
  metrics,
  isLandlord,
  actions,
}: {
  request: RequestDetailRecord;
  headline: string;
  propertyLabel: string;
  unitLabel: string;
  lifecycleStatus: string;
  metrics: HeroMetric[];
  isLandlord: boolean;
  actions?: ReactNode;
}) {
  const statusLabel = lifecycleStatus.replace(/_/g, ' ');
  // A safety concern is never shown as routine, whatever the model's urgency
  // said; once a person has assessed it, the label says so.
  const safetyLabel = tenantSafetyLabel(request.safetyAssessment);
  const urgencyLabel = safetyLabel || TENANT_PRIORITY_LABELS[request.urgency] || 'Under review';

  return (
    <section className="relative overflow-hidden rounded-2xl border border-slate-300 bg-gradient-to-br from-[#137fec]/[0.04] via-white to-[#a855f7]/[0.05] shadow-sm in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-none in-[.lichen-d3]:bg-card in-[.lichen-d3]:shadow-lichen-card in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-none in-[.lichen-d5]:bg-card in-[.lichen-d5]:shadow-lichen-card">
      <div className="absolute inset-x-0 top-0 h-1 bg-[#137fec] in-[.lichen-d3]:hidden in-[.lichen-d5]:hidden" />
      <div className="pointer-events-none in-[.lichen-d3]:hidden absolute -top-16 right-8 h-64 w-64 rounded-full bg-[#137fec]/20 blur-2xl in-[.lichen-d5]:hidden" />
      <div className="pointer-events-none in-[.lichen-d3]:hidden absolute -top-20 left-1/4 h-56 w-56 rounded-full bg-[#a855f7]/[0.12] blur-2xl in-[.lichen-d5]:hidden" />
      <div className="pointer-events-none in-[.lichen-d3]:hidden absolute -left-16 top-1/3 h-56 w-56 rounded-full bg-[#137fec]/[0.14] blur-2xl in-[.lichen-d5]:hidden" />
      <div className="pointer-events-none in-[.lichen-d3]:hidden absolute -bottom-16 -left-10 h-64 w-64 rounded-full bg-[#a855f7]/[0.15] blur-2xl in-[.lichen-d5]:hidden" />
      <div className="pointer-events-none in-[.lichen-d3]:hidden absolute -bottom-20 right-1/4 h-56 w-56 rounded-full bg-[#137fec]/[0.12] blur-2xl in-[.lichen-d5]:hidden" />
      <div className="pointer-events-none in-[.lichen-d3]:hidden absolute -right-16 bottom-1/4 h-56 w-56 rounded-full bg-[#a855f7]/[0.12] blur-2xl in-[.lichen-d5]:hidden" />
      <div className="pointer-events-none in-[.lichen-d3]:hidden absolute left-1/2 top-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#137fec]/[0.07] blur-3xl in-[.lichen-d5]:hidden" />

      <div className="relative px-6 py-7 sm:px-8 sm:py-8 in-[.lichen-d3]:p-[min(1.5rem,24px)] in-[.lichen-d3]:sm:p-[min(2rem,32px)] in-[.lichen-d5]:p-[min(1.5rem,24px)] in-[.lichen-d5]:sm:p-[min(2rem,32px)]">
        <div className="flex flex-col gap-8 lg:@min-[58rem]/page:flex-row lg:@min-[58rem]/page:items-end lg:@min-[58rem]/page:justify-between">
          <div className="min-w-0 max-w-4xl">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge
                className={`border border-[#137fec]/20 bg-[#137fec]/10 capitalize text-[#137fec] ${d3StatusClass(lifecycleStatus)} ${tenantStatusClass(lifecycleStatus)}`}
                data-testid="detail-status"
              >
                <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#137fec] in-[.lichen-d3]:bg-current in-[.lichen-d5]:bg-current" />
                {statusLabel}
              </Badge>
              {isLandlord ? (
                <Badge className="border border-slate-200 bg-slate-50 capitalize text-slate-600 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-meta in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-well in-[.lichen-d5]:text-meta">
                  {request.category}
                </Badge>
              ) : (
                <Badge
                  className={
                    safetyLabel
                      ? 'max-w-full whitespace-normal text-left [overflow-wrap:anywhere] border border-rose-200 bg-rose-50 text-rose-700 in-[.lichen-d5]:border-alert-line in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text'
                      : "max-w-full whitespace-normal text-left [overflow-wrap:anywhere] border border-slate-200 bg-slate-50 text-slate-600 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-meta in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-well in-[.lichen-d5]:text-meta"
                  }
                  data-testid={safetyLabel ? 'tenant-safety-review' : 'tenant-urgency'}
                  data-pending={safetyLabel ? (safetyPendingReview(request.safetyAssessment) ? 'true' : 'false') : undefined}
                >
                  {urgencyLabel}
                </Badge>
              )}
              {isLandlord && request.urgency === 'emergency' ? (
                <Badge className="border border-rose-200 bg-rose-50 text-rose-600 in-[.lichen-d3]:border-transparent in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-destructive in-[.lichen-d5]:border-transparent in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-destructive">Emergency</Badge>
              ) : null}
            </div>

            {request.archivedAt ? (
              <p
                className="mb-2 inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-meta in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-meta"
                data-testid="request-archived-note"
              >
                {/* Month spelled out: a numeric 01/10 reads as January in some locales, October in others. */}
                Archived{' '}
                {new Date(request.archivedAt).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}{' '}
                · kept in {isLandlord ? "the property's history" : 'your archived requests'}
              </p>
            ) : null}
            <p className="mb-2 text-sm font-medium text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">
              {propertyLabel || 'Property unavailable'}
              {unitLabel ? ` • ${unitLabel}` : ''}
            </p>

            <h1
              className="line-clamp-3 break-words text-2xl font-semibold leading-tight tracking-tight text-slate-900 sm:text-3xl in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink in-[.lichen-d5]:line-clamp-none"
              data-testid="detail-title"
            >
              {headline}
            </h1>
            {isLandlord ? <div className="mt-3"><RequestIdentity id={request._id} createdAt={request.createdAt} /></div> : null}

            {request.ai?.summary || request.issueTitle ? (
              <p className="mt-4 line-clamp-3 max-w-3xl break-words text-sm leading-6 text-slate-600 sm:line-clamp-4 sm:text-base xl:line-clamp-5 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">
                <span className="sm:hidden">
                  {condenseSummary(request.ai?.summary || request.issueTitle, 140)}
                </span>
                <span className="hidden sm:inline">
                  {condenseSummary(request.ai?.summary || request.issueTitle, 240)}
                </span>
              </p>
            ) : null}
          </div>

          <div className="flex w-full flex-col gap-4 lg:@min-[58rem]/page:max-w-md">
            <div className="grid min-w-full gap-3 sm:grid-cols-2">
              {metrics.map((metric) => heroMetric(metric.label, metric.value, metric.secondaryValue))}
            </div>
            {actions ? (
              <div className="flex flex-wrap justify-start gap-2 lg:@min-[58rem]/page:justify-end">{actions}</div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
