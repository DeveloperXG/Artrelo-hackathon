import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { LandlordAPI, TenantAPI } from '../../api/client';
import {
  ApproveContactDialog,
  type ApproveContactTarget,
  CompleteRequestDialog,
  type CompleteRequestTarget,
  RejectRequestDialog,
  type RejectRequestTarget,
} from '../../components/RequestActionDialogs';
import {
  canRejectRequest,
  getContactCandidate,
} from '../../components/landlord/requestHelpers';
import { getResponseSlaLabel } from '../../components/request-detail/requestDetailSelectors';
import type { RequestItem, VendorItem } from '../../types/landlord';

export type OutreachResult = {
  sent?: boolean;
  scheduled?: boolean;
  scheduledFor?: string | null;
  message?: string;
};

/** The vendor is emailed (or the send is scheduled) — nothing on screen says
 *  which, or whether it worked, so say it. Shared with the request page. */
export function toastOutreachResult(vendorName: string, outreach?: OutreachResult) {
  if (outreach?.scheduled) {
    toast.success(
      `${vendorName} is closed right now. Outreach is scheduled for ${
        outreach.scheduledFor
          ? new Date(outreach.scheduledFor).toLocaleString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })
          : 'their next opening'
      }.`
    );
  } else if (outreach?.sent === false) {
    toast.error(`Contact approved, but the email to ${vendorName} could not be sent: ${outreach.message || 'unknown error'}`);
  } else {
    toast.success(`Outreach sent to ${vendorName}`);
  }
}

export function useRequestActions({
  vendors,
  onAfterMutation,
}: {
  vendors: VendorItem[];
  onAfterMutation: () => Promise<void>;
}) {
  const [rejectTarget, setRejectTarget] = useState<RejectRequestTarget | null>(null);
  const [contactTarget, setContactTarget] = useState<ApproveContactTarget | null>(null);
  const [completeTarget, setCompleteTarget] = useState<CompleteRequestTarget | null>(null);
  const [requestActionBusy, setRequestActionBusy] = useState(false);

  const openApproveContact = (request: RequestItem) => {
    const candidate = getContactCandidate(request);
    if (!candidate) {
      toast.error('Open the request to generate or review a vendor recommendation first.');
      return;
    }
    setContactTarget({
      requestId: request._id,
      issueTitle: request.issueTitle,
      candidateKey: candidate.candidateKey,
      vendorName: candidate.name,
      draftMessage: candidate.draftMessage || '',
      vendorEmailMasked: candidate.outreach?.toEmailMasked ?? null,
      vendorHasEmail: candidate.contact?.hasEmail !== false,
      responseSlaLabel: getResponseSlaLabel(request.urgency),
      sendTiming: candidate.sendTiming ?? null,
    });
    // The request list carries no live timing (it would be stale anyway), so
    // fetch it: a closed vendor turns the button into "Schedule send".
    if (!candidate.sendTiming) {
      void TenantAPI.getRequest(request._id)
        .then((response) => {
          const detail = response.data as RequestItem;
          const live = (detail.vendorRecommendationSnapshot?.candidateLedger || []).find(
            (entry) => entry.candidateKey === candidate.candidateKey
          );
          if (!live?.sendTiming) return;
          setContactTarget((current) =>
            current && current.candidateKey === candidate.candidateKey
              ? { ...current, sendTiming: live.sendTiming }
              : current
          );
        })
        .catch(() => {});
    }
  };

  const openRejectRequest = (request: RequestItem) => {
    if (!canRejectRequest(request)) {
      toast.error(`A ${request.status} request cannot be rejected.`);
      return;
    }
    setRejectTarget({ requestId: request._id, issueTitle: request.issueTitle });
  };

  const handleConfirmApproveContact = async (draftMessage: string) => {
    if (!contactTarget) return;
    setRequestActionBusy(true);
    try {
      const response = (await LandlordAPI.approveVendorContact(
        contactTarget.requestId,
        contactTarget.candidateKey,
        draftMessage
      )) as { outreach?: OutreachResult };
      toastOutreachResult(contactTarget.vendorName, response.outreach);
      setContactTarget(null);
      await onAfterMutation();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to approve vendor contact');
    } finally {
      setRequestActionBusy(false);
    }
  };

  const handleConfirmRejectRequest = async (reason: string) => {
    if (!rejectTarget) return;
    setRequestActionBusy(true);
    try {
      await LandlordAPI.reject(rejectTarget.requestId, reason);
      toast.success('Request rejected and tenant notified');
      setRejectTarget(null);
      await onAfterMutation();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reject request');
    } finally {
      setRequestActionBusy(false);
    }
  };

  const assignVendor = async (id: string) => {
    if (!vendors.length) {
      toast.error('Add a vendor first');
      return;
    }
    try {
      await LandlordAPI.assign(id, { vendorId: vendors[0]._id });
      toast.success(`Assigned to ${vendors[0].name}`);
      await onAfterMutation();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed');
    }
  };

  const completeRequest = (request: RequestItem | string) => {
    // Accepts an id for older call sites; the full record lets us prefill the
    // agreed quote so the landlord confirms a number rather than inventing one.
    if (typeof request === 'string') {
      setCompleteTarget({ requestId: request, issueTitle: 'this request' });
      return;
    }
    const candidate = getContactCandidate(request);
    setCompleteTarget({
      requestId: request._id,
      issueTitle: request.issueTitle,
      suggestedCost: request.estimatedCost ?? null,
      vendorName: candidate?.name ?? null,
    });
  };

  const handleConfirmComplete = async (finalCost: number, notes: string) => {
    if (!completeTarget) return;
    setRequestActionBusy(true);
    try {
      await LandlordAPI.complete(completeTarget.requestId, { finalCost, notes });
      setCompleteTarget(null);
      toast.success('Marked complete');
      await onAfterMutation();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed');
    } finally {
      setRequestActionBusy(false);
    }
  };

  const dialogs = useMemo(
    () => (
      <>
        <RejectRequestDialog
          target={rejectTarget}
          busy={requestActionBusy}
          onClose={() => setRejectTarget(null)}
          onConfirm={handleConfirmRejectRequest}
        />
        <ApproveContactDialog
          target={contactTarget}
          busy={requestActionBusy}
          onClose={() => setContactTarget(null)}
          onConfirm={handleConfirmApproveContact}
        />
        <CompleteRequestDialog
          target={completeTarget}
          busy={requestActionBusy}
          onClose={() => setCompleteTarget(null)}
          onConfirm={handleConfirmComplete}
        />
      </>
    ),
    [completeTarget, contactTarget, rejectTarget, requestActionBusy]
  );

  return {
    openApproveContact,
    openRejectRequest,
    assignVendor,
    completeRequest,
    dialogs,
  };
}
