import { FileText, ShieldAlert, Sparkles, UserCheck } from 'lucide-react';
import { SimulatedVendorBadge } from '../judge/JudgeBadges';
import { Badge } from '../ui/badge';
import type { RequestDetailRecord } from './requestDetailTypes';
import { DetailCard, Eyebrow } from './detailUi';
import RejectionAppealCard from './RejectionAppealCard';
import { useTenantPresentation } from '../tenant/tenantPresentation';

export default function RequestOverviewPanel({
  request,
  isLandlord,
  onAppeal,
  onReopen,
  onDeclineAppeal,
}: {
  request: RequestDetailRecord;
  isLandlord: boolean;
  onAppeal?: () => void;
  onReopen?: () => void;
  onDeclineAppeal?: () => void;
}) {
  const tenantPresentation = useTenantPresentation();
  return (
    <div
      className="space-y-6"
      id="request-detail-tab-overview"
      role={tenantPresentation ? 'region' : 'tabpanel'}
      aria-labelledby={tenantPresentation ? undefined : 'request-detail-tab-button-overview'}
      aria-label={tenantPresentation ? 'Original request and triage summary' : undefined}
    >
      <DetailCard
        icon={FileText}
        eyebrow="Tenant submission"
        title="Original request"
        description="Tenant-provided maintenance details and submitted context."
      >
        {request.ai?.summary ? (
          <details className="tenant-original-note group rounded-xl border border-slate-300 bg-slate-50/70 px-5 py-4 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-well in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-well">
            <summary className="flex min-w-0 flex-wrap cursor-pointer items-center justify-between gap-x-2 gap-y-1 [overflow-wrap:anywhere] text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">
              Original tenant note
              <span className="text-[11px] font-medium normal-case tracking-normal text-slate-400 group-open:hidden in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">
                Show
              </span>
            </summary>
            <p
              className="mt-3 whitespace-pre-line text-sm leading-7 text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink"
              data-testid="detail-description"
            >
              {request.issueDescription}
            </p>
          </details>
        ) : (
          <div className="rounded-xl border border-slate-300 bg-slate-50/70 p-5 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-well in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-well">
            <Eyebrow>Description</Eyebrow>
            <p
              className="mt-2 whitespace-pre-line text-sm leading-7 text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink"
              data-testid="detail-description"
            >
              {request.issueDescription}
            </p>
          </div>
        )}
      </DetailCard>

      <DetailCard
        icon={Sparkles}
        iconColor="#a855f7"
        eyebrow="AI assessment"
        title="Triage summary"
        description="Generated assessment for priority, responsibility, and next action."
      >
        {request.ai?.summary ? (
          <div
            className="rounded-xl border border-violet-100 bg-violet-50/60 p-5 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-well"
            data-testid="detail-ai-summary"
          >
            <p className="text-sm leading-7 text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">{request.ai.summary}</p>
            {request.ai?.additionalNotes ? (
              <div
                className="mt-4 rounded-xl border border-violet-100 bg-white p-4 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-card in-[.lichen-d3]:border-border in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-card in-[.lichen-d5]:border-border"
                data-testid="detail-ai-additional-notes"
              >
                <p className="min-w-0 [overflow-wrap:anywhere] text-xs font-semibold uppercase tracking-[0.12em] text-violet-500 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">
                  Additional notes
                </p>
                <p className="mt-2 whitespace-pre-line text-sm leading-7 text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">
                  {request.ai.additionalNotes}
                </p>
              </div>
            ) : null}
            {isLandlord ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {request.ai?.suggestedVendorType ? (
                  <Badge className="max-w-full whitespace-normal text-left [overflow-wrap:anywhere] border-transparent bg-white text-slate-700 shadow-sm in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink in-[.lichen-d3]:shadow-none in-[.lichen-d5]:bg-card in-[.lichen-d5]:text-ink in-[.lichen-d5]:shadow-none">
                    Suggested vendor: {request.ai.suggestedVendorType}
                  </Badge>
                ) : null}
                {request.ai?.suggestedResponsibility ? (
                  <Badge className="max-w-full whitespace-normal text-left [overflow-wrap:anywhere] border-transparent bg-white text-slate-700 shadow-sm in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink in-[.lichen-d3]:shadow-none in-[.lichen-d5]:bg-card in-[.lichen-d5]:text-ink in-[.lichen-d5]:shadow-none">
                    Responsibility: {request.ai.suggestedResponsibility}
                  </Badge>
                ) : null}
                {request.ai?.severity ? (
                  <Badge className="max-w-full whitespace-normal text-left [overflow-wrap:anywhere] border-transparent bg-white text-slate-700 shadow-sm in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink in-[.lichen-d3]:shadow-none in-[.lichen-d5]:bg-card in-[.lichen-d5]:text-ink in-[.lichen-d5]:shadow-none">
                    Severity: {request.ai.severity}/5
                  </Badge>
                ) : null}
              </div>
            ) : null}
            {request.ai?.safetyWarning ? (
              <div className="mt-5 flex items-start gap-2 rounded-xl border border-rose-100 bg-white p-4 text-sm font-medium text-rose-700 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-card in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:text-alert-text in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-card in-[.lichen-d5]:border-alert-line in-[.lichen-d5]:text-alert-text">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                {request.ai.safetyWarning}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-300 bg-slate-50/70 p-5 text-sm text-slate-500 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-meta in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-control-border in-[.lichen-d5]:bg-well in-[.lichen-d5]:text-meta">
            No AI summary is available for this request.
          </div>
        )}
      </DetailCard>

      <RejectionAppealCard
        request={request}
        isLandlord={isLandlord}
        onAppeal={onAppeal}
        onReopen={onReopen}
        onDeclineAppeal={onDeclineAppeal}
      />

      {typeof request.vendorId === 'object' && request.vendorId ? (
        <DetailCard
          icon={UserCheck}
          iconColor="#4f46e5"
          eyebrow="Vendor assigned"
          title={request.vendorId.name || 'Assigned vendor'}
          data-testid="detail-vendor"
        >
          <div className="space-y-1 text-sm text-slate-500 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">
            <SimulatedVendorBadge vendorId={request.vendorId._id} />
            {request.vendorId.company ? <p>{request.vendorId.company}</p> : null}
            {request.vendorId.phone ? <p>{request.vendorId.phone}</p> : null}
          </div>
        </DetailCard>
      ) : null}
    </div>
  );
}
