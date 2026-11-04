import { Loader2, RefreshCcw, Route } from 'lucide-react';
import { Button } from '../ui/button';
import type {
  RequestDetailRecord,
  VendorRecommendationCandidate,
  VendorRecommendationSnapshot,
} from './requestDetailTypes';
import { DetailCard } from './detailUi';
import VendorRoutingSummary from './VendorRoutingSummary';
import VendorCandidateSection from './VendorCandidateSection';
import RoutingSetupChecklist from './RoutingSetupChecklist';
import RoutingNextSteps from './RoutingNextSteps';
import {
  getAllVendorCandidates,
  isManuallySelectable,
} from './requestDetailSelectors';
import type { RoutingSetup } from '../../types/landlord';

export default function VendorRoutingPanel({
  request,
  snapshot,
  routeabilityBlockReason,
  activeCandidate,
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
}: {
  request: RequestDetailRecord;
  snapshot: VendorRecommendationSnapshot | null;
  routeabilityBlockReason: string;
  activeCandidate: VendorRecommendationCandidate | null;
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
  /** null while loading or if it failed -- the server still enforces it. */
  routingSetup: RoutingSetup | null;
  /** Opens the Add vendor dialog in place. */
  onAddVendor: () => void;
}) {
  // Rejected/cancelled/completed requests (and other non-routeable states)
  // must not be assignable by any path — lock manual assignment everywhere.
  const manualAssignBlocked = Boolean(routeabilityBlockReason);
  // No vendors, or a vendor cap of 0: generating would only find nobody, and
  // nothing could be contacted anyway. The checklist says what to do instead.
  const setupIncomplete = Boolean(routingSetup && !routingSetup.ready);
  const generateBlockReason = setupIncomplete
    ? 'Finish the setup steps below to unlock recommendations.'
    : routeabilityBlockReason;
  // Not on a closed request: rejecting also sets routingStatus "paused", and
  // a rejected request offered Add a vendor. The server's pauseKind is null
  // for anything that can't be routed, so it answers both at once.
  const showNextSteps = Boolean(
    snapshot && request.routingStatus === 'paused' && !activeCandidate && request.routingGuidance?.pauseKind
  );
  const canAssignManually =
    !manualAssignBlocked &&
    getAllVendorCandidates(snapshot).some((candidate) => isManuallySelectable(candidate, snapshot));
  return (
    <DetailCard
      icon={Route}
      eyebrow="Vendor routing"
      title="Vendor recommendations"
      description="Recommendations come from your vendor network, ranked for this job."
      data-testid="detail-vendor-recommendations"
      action={
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            data-testid="detail-generate-recommendations"
            onClick={onGenerateRecommendations}
            disabled={Boolean(generateBlockReason) || vendorActionBusy === 'generate'}
            title={generateBlockReason || undefined}
            className="gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
          >
            {vendorActionBusy === 'generate' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="h-4 w-4" />
            )}
            {/* The snapshot is stored on the request and never cleared, so once
                one exists this stays "Regenerate" for the rest of the request. */}
            {snapshot ? 'Regenerate' : 'Generate'}
          </Button>
          {snapshot ? (
            <Button
              variant="outline"
              className="border-slate-200 in-[.lichen-d3]:border-border"
              onClick={() => onManualAssign()}
              disabled={manualAssignBlocked || vendorActionBusy === 'manual-assignment'}
              title={manualAssignBlocked ? routeabilityBlockReason : undefined}
            >
              {vendorActionBusy === 'manual-assignment' ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Assign manually
            </Button>
          ) : null}
        </div>
      }
    >
      {request.routingStatus === 'failed' && <div role="alert" className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text">
        Automatic vendor preparation could not finish. Review any existing outreach, or use Generate to retry recommendations, then approve vendor contact.
      </div>}
      {setupIncomplete && routingSetup ? (
        <RoutingSetupChecklist setup={routingSetup} onAddVendor={onAddVendor} />
      ) : null}

      {/* Hoisted out of the `snapshot` branch below: with no snapshot yet, a
          greyed-out Generate had no explanation anywhere on the page. */}
      {routeabilityBlockReason ? (
        <div className="mb-5 rounded-xl border border-amber-100 bg-amber-50 px-4 py-4 text-sm text-amber-900 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text">
          {routeabilityBlockReason}
        </div>
      ) : null}

      {!snapshot ? (
        setupIncomplete ? null : (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-5 py-10 text-center text-sm text-slate-500 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-meta">
            Generate recommendations to review vendor candidates for this request.
          </div>
        )
      ) : (
        <div
          className="space-y-5"
          id="request-detail-tab-routing"
          role="tabpanel"
          aria-labelledby="request-detail-tab-button-routing"
        >
          <VendorRoutingSummary
            request={request}
            snapshot={snapshot}
            activeCandidate={activeCandidate}
          />

          {/* Paused with nobody being contacted: say why, and offer every way
              forward -- add a vendor, search again, or pick one by hand. This
              also covers the empty-network case the old "Add a vendor" banner
              handled, so the two never stack. */}
          {showNextSteps ? (
            <RoutingNextSteps
              kind={request.routingGuidance?.pauseKind || 'paused'}
              trade={snapshot.requestSnapshot?.vendorTypeNeeded || 'this job'}
              onAddVendor={onAddVendor}
              onSearchAgain={onGenerateRecommendations}
              searchBlockReason={generateBlockReason}
              searching={vendorActionBusy === 'generate'}
              canAssign={canAssignManually}
              onAssign={() => onManualAssign()}
            />
          ) : null}

          {/* "Manual assignment required" used to render here whenever the
              decision type said so. That decision always pauses routing, so it
              stacked under Next steps restating it -- with "Review the ranked
              candidates" when there were none, and after a manual pick it
              stayed up while the vendor was being contacted. Next steps owns
              the way forward. */}

          {/* The vendor being contacted. Activation moves them to the
              "active" display group, which none of the lists below show, so
              their outreach panel -- scheduled time and Cancel, sent/viewed,
              resend, the quote -- had nowhere to render. */}
          {activeCandidate ? (
            <VendorCandidateSection
              title="Contacted vendor"
              candidates={[activeCandidate]}
              emptyMessage=""
              tone="primary"
              snapshot={snapshot}
              vendorActionBusy={vendorActionBusy}
              draftValues={draftValues}
              draftEditorOpen={draftEditorOpen}
              onToggleDraft={onToggleDraft}
              onChangeDraft={onChangeDraft}
              onSaveDraft={onSaveDraft}
              onApproveContact={onApproveContact}
              onManualAssign={onManualAssign}
              onResendOutreach={onResendOutreach}
              onDismissResponse={onDismissResponse}
              onCancelScheduled={onCancelScheduled}
            />
          ) : null}

          <VendorCandidateSection
            title="Recommended vendors"
            candidates={snapshot.recommendations || []}
            emptyMessage="No recommended vendors yet."
            tone="primary"
            snapshot={snapshot}
            vendorActionBusy={vendorActionBusy}
            draftValues={draftValues}
            draftEditorOpen={draftEditorOpen}
            allowApprove
            allowManualAssign={!manualAssignBlocked}
            onToggleDraft={onToggleDraft}
            onChangeDraft={onChangeDraft}
            onSaveDraft={onSaveDraft}
            onApproveContact={onApproveContact}
            onManualAssign={onManualAssign}
            onResendOutreach={onResendOutreach}
            onDismissResponse={onDismissResponse}
            onCancelScheduled={onCancelScheduled}
          />

          <VendorCandidateSection
            title="Eligible backup vendors"
            candidates={snapshot.eligibleButNotTopCandidates || []}
            emptyMessage="No additional eligible vendors were kept below the recommendation cutoff."
            defaultExpanded={false}
            snapshot={snapshot}
            vendorActionBusy={vendorActionBusy}
            draftValues={draftValues}
            draftEditorOpen={draftEditorOpen}
            allowApprove
            allowManualAssign={!manualAssignBlocked}
            onToggleDraft={onToggleDraft}
            onChangeDraft={onChangeDraft}
            onSaveDraft={onSaveDraft}
            onApproveContact={onApproveContact}
            onManualAssign={onManualAssign}
            onResendOutreach={onResendOutreach}
            onDismissResponse={onDismissResponse}
            onCancelScheduled={onCancelScheduled}
          />

          <VendorCandidateSection
            title="Held vendors"
            candidates={snapshot.heldCandidates || []}
            emptyMessage="No vendors are currently on hold."
            defaultExpanded={false}
            snapshot={snapshot}
            vendorActionBusy={vendorActionBusy}
            draftValues={draftValues}
            draftEditorOpen={draftEditorOpen}
            onToggleDraft={onToggleDraft}
            onChangeDraft={onChangeDraft}
            onSaveDraft={onSaveDraft}
            onApproveContact={onApproveContact}
            onManualAssign={onManualAssign}
            onResendOutreach={onResendOutreach}
            onDismissResponse={onDismissResponse}
            onCancelScheduled={onCancelScheduled}
          />
        </div>
      )}
    </DetailCard>
  );
}
