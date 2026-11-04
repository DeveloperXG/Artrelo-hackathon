import { ArrowLeft, Loader2, Trash2 } from 'lucide-react';
import IntakeFollowUpForm from '../tenant/IntakeFollowUpForm';
import CarriedUpdateCard from '../tenant/CarriedUpdateCard';
import { Button } from '../ui/button';
import RequestOverviewPanel from './RequestOverviewPanel';
import RequestMessagesPanel from './RequestMessagesPanel';
import RequestActivityPanel from './RequestActivityPanel';
import RequestDetailHero from './RequestDetailHero';
import BookingCoordinationPanel from '../BookingCoordinationPanel';
import { detailSurfaceStyle } from './detailUi';
import type { RequestDetailRecord } from './requestDetailTypes';
import { getTenantSafeRequestSummary, getTimelineActivityItems } from './requestDetailSelectors';
import { TENANT_PORTAL, useTenantPresentation } from '../tenant/tenantPresentation';

export default function TenantRequestDetailView({
  request,
  lifecycleStatus,
  costDisplay,
  propertyLabel,
  unitLabel,
  onBack,
  onDeletePending,
  deleting,
  comment,
  onCommentChange,
  onSubmitComment,
  sendingComment,
  onAppeal,
  onRequestReplaced,
}: {
  request: RequestDetailRecord;
  lifecycleStatus: string;
  costDisplay: { label: string; value: string };
  propertyLabel: string;
  unitLabel: string;
  onBack: () => void;
  onDeletePending: () => void;
  deleting: boolean;
  comment: string;
  onCommentChange: (value: string) => void;
  onSubmitComment: () => void;
  sendingComment: boolean;
  onAppeal: () => void;
  /** Swap in the record a workflow write returned. */
  onRequestReplaced: (next: RequestDetailRecord) => void;
}) {
  const tenantPresentation = useTenantPresentation();
  const tenantSafe = getTenantSafeRequestSummary(request);
  const submittedAt = new Date(request.createdAt);

  return (
    <div
      className={`min-h-screen bg-slate-50 px-4 py-6 sm:px-6 lg:px-8 ${tenantPresentation ? `${TENANT_PORTAL} bg-card! px-0! py-0!` : ''}`}
      style={tenantPresentation ? undefined : detailSurfaceStyle}
    >
      <div className="mx-auto max-w-5xl space-y-6">
        <Button data-testid="detail-back-btn" variant="ghost" onClick={onBack} className="gap-1">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>

        <RequestDetailHero
          request={request}
          headline={tenantSafe.headline}
          propertyLabel={propertyLabel}
          unitLabel={unitLabel}
          lifecycleStatus={lifecycleStatus}
          metrics={[
            {
              label: 'Submitted',
              value: submittedAt.toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              }),
              secondaryValue: submittedAt.toLocaleTimeString(undefined, {
                hour: 'numeric',
                minute: '2-digit',
              }),
            },
          ]}
          isLandlord={false}
          actions={
            lifecycleStatus === 'queued' ? (
              <Button
                data-testid="detail-delete-pending"
                variant="outline"
                onClick={onDeletePending}
                disabled={deleting}
                className="gap-2 border-rose-200 text-rose-600 hover:bg-rose-50 in-[.lichen-d5]:border-alert-text in-[.lichen-d5]:text-alert-text in-[.lichen-d5]:hover:bg-alert-tint"
              >
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Delete
              </Button>
            ) : undefined
          }
        />

        <CarriedUpdateCard request={request} onRequestReplaced={onRequestReplaced} />
        <IntakeFollowUpForm key={request._id} request={request} onRequestReplaced={onRequestReplaced} />

        {request.bookingVersion === 2 && <BookingCoordinationPanel requestId={request._id} requestStatus={request.status} archivedAt={request.archivedAt} audience="tenant" />}
        <div className="space-y-6">
          <RequestOverviewPanel request={request} isLandlord={false} onAppeal={onAppeal} />
          <RequestMessagesPanel
            comments={request.comments || []}
            comment={comment}
            onCommentChange={onCommentChange}
            onSubmit={onSubmitComment}
            sending={sendingComment}
            isLandlord={false}
          />
          <RequestActivityPanel items={getTimelineActivityItems(request.timeline || [])} />
        </div>
      </div>
    </div>
  );
}
