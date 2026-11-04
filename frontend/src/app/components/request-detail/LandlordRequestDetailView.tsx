import { ArrowLeft, XCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { canRejectRequest } from '../landlord/requestHelpers';
import { detailSurfaceStyle } from './detailUi';
import RequestDetailHero from './RequestDetailHero';
import BookingCoordinationPanel from '../BookingCoordinationPanel';
import RequestWorkflowProgress from './RequestWorkflowProgress';
import RequestDetailTabs from './RequestDetailTabs';
import RequestContextSidebar from './RequestContextSidebar';
import RequestOverviewPanel from './RequestOverviewPanel';
import VendorRoutingPanel from './VendorRoutingPanel';
import RequestMessagesPanel from './RequestMessagesPanel';
import IrisRequestActivityPanel from '../iris-activity/IrisRequestActivityPanel';
import WorkRecordPanel from './WorkRecordPanel';
import QuoteReviewPanel from './QuoteReviewPanel';
import IntakeSafetyReviewPanel from './IntakeSafetyReviewPanel';
import OutreachSummaryLine from '../landlord/OutreachSummaryLine';
import { isTerminalRequest } from '../../lib/requestWorkflow';
import { D3_PAGE, useD3Presentation } from './d3Presentation';
import type {
  RequestComment,
  RequestDetailRecord,
  RequestDetailTab,
  HeroMetric,
  RequestWorkflowStage,
  VendorRecommendationCandidate,
  VendorRecommendationSnapshot,
} from './requestDetailTypes';
import type { RoutingSetup } from '../../types/landlord';
import type { TabIndicators } from './requestTabActivity';

export default function LandlordRequestDetailView({
  request,
  headline,
  propertyLabel,
  unitLabel,
  lifecycleStatus,
  workflowStage,
  metrics,
  activeCandidate,
  activeTab,
  onTabChange,
  onBack,
  onOpenRejectRequest,
  onReopen,
  onDeclineAppeal,
  comment,
  onCommentChange,
  onSubmitComment,
  sendingComment,
  snapshot,
  routeabilityBlockReason,
  vendorActionBusy,
  draftValues,
  draftEditorOpen,
  onGenerateRecommendations,
  onManualAssign,
  onToggleDraft,
  onChangeDraft,
  onSaveDraft,
  onApproveContact,
  onResendOutreach,
  onDismissResponse,
  onCancelScheduled,
  routingSetup,
  onAddVendor,
  tabIndicators,
  onRequestChanged,
  onRequestReplaced,
}: {
  request: RequestDetailRecord;
  headline: string;
  propertyLabel: string;
  unitLabel: string;
  lifecycleStatus: string;
  workflowStage: RequestWorkflowStage;
  metrics: HeroMetric[];
  activeCandidate: VendorRecommendationCandidate | null;
  activeTab: RequestDetailTab;
  onTabChange: (tab: RequestDetailTab) => void;
  onBack: () => void;
  onOpenRejectRequest: () => void;
  /** Accept the tenant's appeal, or withdraw the rejection. */
  onReopen: () => void;
  onDeclineAppeal: () => void;
  comment: string;
  onCommentChange: (value: string) => void;
  onSubmitComment: () => void;
  sendingComment: boolean;
  snapshot: VendorRecommendationSnapshot | null;
  routeabilityBlockReason: string;
  vendorActionBusy: string;
  draftValues: Record<string, string>;
  draftEditorOpen: Record<string, boolean>;
  onGenerateRecommendations: () => void;
  onManualAssign: (candidateKey?: string) => void;
  onToggleDraft: (candidate: VendorRecommendationCandidate) => void;
  onChangeDraft: (candidate: VendorRecommendationCandidate, value: string) => void;
  onSaveDraft: (candidate: VendorRecommendationCandidate) => void;
  onApproveContact: (candidate: VendorRecommendationCandidate) => void;
  onResendOutreach?: (candidate: VendorRecommendationCandidate) => void;
  onDismissResponse?: (candidate: VendorRecommendationCandidate) => void;
  onCancelScheduled?: (candidate: VendorRecommendationCandidate) => void;
  routingSetup: RoutingSetup | null;
  onAddVendor: () => void;
  tabIndicators?: TabIndicators;
  /** Re-read the request after a change made from inside the view. */
  onRequestChanged?: () => void;
  /** Swap in the record a review decision returned. */
  onRequestReplaced: (next: RequestDetailRecord) => void;
}) {
  const d3 = useD3Presentation();
  return (
    // No gutter of its own below sm: the landlord shell already supplies one.
    <div
      className={`min-h-screen bg-slate-50 px-0 py-6 sm:px-6 lg:px-8 in-[.lichen-d3]:bg-well ${d3 ? `${D3_PAGE} lichen:bg-background lichen:bg-none!` : ''}`}
      style={detailSurfaceStyle}
    >
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button data-testid="detail-back-btn" variant="ghost" onClick={onBack} className="gap-1">
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {canRejectRequest(request) ? (
            <Button
              data-testid="detail-reject-request"
              variant="outline"
              onClick={onOpenRejectRequest}
              className="gap-2 border-rose-200 text-rose-600 hover:bg-rose-50 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:hover:bg-alert-tint"
            >
              <XCircle className="h-4 w-4" />
              Reject Request
            </Button>
          ) : null}
        </div>

        <RequestDetailHero
          request={request}
          headline={headline}
          propertyLabel={propertyLabel}
          unitLabel={unitLabel}
          lifecycleStatus={lifecycleStatus}
          // The compact overview or work record owns the completed amount.
          // Keep the other hero facts, without a second final-cost figure.
          metrics={request.status === 'completed' && (activeTab === 'overview' || activeTab === 'work')
            ? metrics.filter((metric) => metric.label !== 'Final cost')
            : metrics}
          isLandlord
        />
        {/* The latest attempt on a live request; a finished request keeps its
            outreach history in Activity only. */}
        {isTerminalRequest({ status: request.status, lifecycleStatus, archivedAt: request.archivedAt }) ? null : (
          <OutreachSummaryLine summary={request.outreachSummary} className="-mt-3 px-1" testId="detail-outreach-summary" />
        )}

        {/* Above the tabs and independent of routing: a held request needs a
            person whether or not any vendor was ever recommended. */}
        <IntakeSafetyReviewPanel request={request} onRequestReplaced={onRequestReplaced} />

        {request.bookingVersion === 2 && <BookingCoordinationPanel requestId={request._id} requestStatus={request.status} archivedAt={request.archivedAt} audience="landlord" onChanged={onRequestChanged} />}
        {/* Landlord-only. Renders nothing for requests priced the older way. */}
        <QuoteReviewPanel
          requestId={request._id}
          revision={request.updatedAt}
          completed={request.status === 'completed' && (activeTab === 'overview' || activeTab === 'work')
            ? { view: activeTab, finalCost: request.finalCost, onViewWorkRecord: () => onTabChange('work') }
            : undefined}
        />
        <RequestWorkflowProgress stage={workflowStage} />

        <RequestDetailTabs
          activeTab={activeTab}
          onChange={onTabChange}
          indicators={tabIndicators}
          routingNeedsManager={['paused', 'approval_needed'].includes(request.routingStatus || '')}
        />

        {/* Follows the page column, not the viewport, so docked Iris stacks the
            side column instead of squeezing the record. The side column only
            comes up once the page has 64rem: after the padding, the gap and
            its 360px that leaves the record about 35rem. The old threshold
            (42rem, the former lg) left it barely 13rem, too narrow for the
            routing tiles and actions, docked or not. */}
        <div className="grid grid-cols-1 gap-8 lg:@min-[64rem]/page:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-6">
            {activeTab === 'work' ? <WorkRecordPanel requestId={request._id} revision={request.updatedAt} /> : null}
            {activeTab === 'overview' ? (
              <RequestOverviewPanel
                request={request}
                isLandlord
                onReopen={onReopen}
                onDeclineAppeal={onDeclineAppeal}
              />
            ) : null}
            {activeTab === 'routing' ? (
              <VendorRoutingPanel
                request={request}
                snapshot={snapshot}
                routeabilityBlockReason={routeabilityBlockReason}
                activeCandidate={activeCandidate}
                vendorActionBusy={vendorActionBusy}
                draftValues={draftValues}
                draftEditorOpen={draftEditorOpen}
                onGenerateRecommendations={onGenerateRecommendations}
                onManualAssign={onManualAssign}
                onToggleDraft={onToggleDraft}
                onChangeDraft={onChangeDraft}
                onSaveDraft={onSaveDraft}
                onApproveContact={onApproveContact}
                onResendOutreach={onResendOutreach}
                // A closed request has no routing left: nothing to dismiss,
                // and nobody to email about a job that is done. The server
                // refuses it too (request_closed).
                onDismissResponse={
                  ['completed', 'rejected', 'cancelled'].includes(request.status) ? undefined : onDismissResponse
                }
                onCancelScheduled={onCancelScheduled}
                routingSetup={routingSetup}
                onAddVendor={onAddVendor}
              />
            ) : null}
            {activeTab === 'messages' ? (
              <RequestMessagesPanel
                comments={(request.comments || []) as RequestComment[]}
                comment={comment}
                onCommentChange={onCommentChange}
                onSubmit={onSubmitComment}
                sending={sendingComment}
                isLandlord
              />
            ) : null}
            {activeTab === 'activity' ? (
              <IrisRequestActivityPanel requestId={request._id} />
            ) : null}
          </div>

          <RequestContextSidebar
            request={request}
            lifecycleStatus={lifecycleStatus}
            urgencyLabel={request.urgency}
            propertyLabel={propertyLabel}
            unitLabel={unitLabel}
            activeCandidate={activeCandidate}
            onRequestChanged={onRequestChanged}
          />
        </div>
      </div>
    </div>
  );
}
