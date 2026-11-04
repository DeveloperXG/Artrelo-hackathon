import { ClipboardCheck, ShieldAlert } from 'lucide-react';
import OutreachSummaryLine from './OutreachSummaryLine';
import type { IntakeFollowUp, OutreachSummary, SafetyAssessment } from '../../types/requestWorkflow';
import { isTerminalRequest, safetyPendingReview } from '../../lib/requestWorkflow';

/**
 * The request-workflow lines a list row or card carries: a held safety
 * concern, tenant details waiting for review, and the outreach summary. Each
 * is omitted when it has nothing to say.
 */
export default function RequestWorkflowLines({
  request,
}: {
  request: {
    _id: string;
    status?: string;
    lifecycleStatus?: string;
    archivedAt?: string | null;
    outreachSummary?: OutreachSummary | null;
    safetyAssessment?: SafetyAssessment | null;
    intakeFollowUp?: IntakeFollowUp | null;
  };
}) {
  const safety = request.safetyAssessment?.state;
  const safetyPending = safetyPendingReview(request.safetyAssessment);
  const detailsWaiting = request.intakeFollowUp?.state === 'ready_for_review';
  // A finished request's last outreach attempt is history, not status.
  const outreach = isTerminalRequest(request) ? null : request.outreachSummary;
  if (!outreach && safety !== 'needs_review' && safety !== 'confirmed_hazard' && !detailsWaiting) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {safety === 'needs_review' || safety === 'confirmed_hazard' ? (
        <div
          className="flex items-center gap-1.5 text-xs font-medium text-rose-700 in-[.lichen-d3]:text-alert-text"
          data-testid={`row-safety-${request._id}`}
          data-state={safety}
          data-pending={safetyPending ? 'true' : 'false'}
        >
          <ShieldAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
          {safety === 'confirmed_hazard'
            ? safetyPending
              ? 'Confirmed safety hazard — needs your review'
              : 'Confirmed safety hazard'
            : safetyPending
              ? 'Safety concern — needs your review'
              : 'Urgent safety concern (reviewed)'}
        </div>
      ) : null}
      {detailsWaiting ? (
        <div className="flex items-center gap-1.5 text-xs text-sky-700 in-[.lichen-d3]:text-lichen-text" data-testid={`row-intake-${request._id}`}>
          <ClipboardCheck className="h-3 w-3 shrink-0" aria-hidden="true" />
          Tenant details to review
        </div>
      ) : null}
      <OutreachSummaryLine summary={outreach} testId={`row-outreach-${request._id}`} />
    </div>
  );
}
