import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, LandlordAPI, TenantAPI } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Card } from './ui/card';
import { Button } from './ui/button';
import {
  type AppealDecisionTarget,
  ApproveContactDialog,
  type ApproveContactTarget,
  DeclineAppealDialog,
  DismissQuoteDialog,
  type DismissQuoteTarget,
  RejectRequestDialog,
  type RejectRequestTarget,
  ReopenRequestDialog,
} from './RequestActionDialogs';
import { AppealRequestDialog, type AppealRequestTarget } from './tenant/AppealRequestDialog';
import LandlordRequestDetailView from './request-detail/LandlordRequestDetailView';
import { toastOutreachResult, type OutreachResult } from '../hooks/landlord/useRequestActions';
import TenantRequestDetailView from './request-detail/TenantRequestDetailView';
import VendorFormDialog from './landlord/vendors/VendorFormDialog';
import { D3_FIELD, D3_PORTAL, D3PresentationScope, D3State, d3CandidateClass, useD3PageActive } from './request-detail/d3Presentation';
import { D3ModalFrame, D3ModalTitle } from './request-detail/D3ModalFrame';
import { TenantState, useTenantPresentation } from './tenant/tenantPresentation';
import { TenantModalFrame, TenantModalTitle } from './tenant/TenantDialogs';
import { useRoutingSetup } from '../hooks/landlord/useRoutingSetup';
import { useRequestTabSeen } from '../hooks/landlord/useRequestTabSeen';
import {
  getTabActivity,
  getTabIndicators,
  seenMarkFor,
} from './request-detail/requestTabActivity';
import {
  formatPriceEstimate,
  getActiveVendorCandidate,
  getAllVendorCandidates,
  getCandidateActionBlockReason,
  getCandidateStateBadge,
  getCandidateStateLabel,
  getOfferPreview,
  getPropertyLabel,
  getRequestCostDisplay,
  getRequestHeadline,
  getRequestWorkflowStage,
  getResponseSlaLabel,
  getRouteabilityBlockReason,
  getSourceLabel,
  getUnitLabel,
  getVisibleLandlordMetrics,
  isManuallySelectable,
} from './request-detail/requestDetailSelectors';
import type {
  RequestDetailRecord,
  RequestDetailTab,
  RequestAuditLog,
  VendorRecommendationCandidate,
} from './request-detail/requestDetailTypes';
import { useLiveTopic } from '../hooks/useLiveTopic';
import { markRequestOpened } from '../hooks/landlord/useNewRequests';

const REQUEST_DETAIL_TABS: readonly RequestDetailTab[] = ['overview', 'routing', 'work', 'messages', 'activity'];

function parseTab(value: string | null): RequestDetailTab {
  return REQUEST_DETAIL_TABS.includes(value as RequestDetailTab) ? (value as RequestDetailTab) : 'overview';
}

// Ring classes, not a keyframe animation: a deep link needs to say "this is
// what you came for" once, and a ring that fades via transition-shadow does
// that without injecting a stylesheet the way the Decisions page has to.
const FOCUS_RING = ['ring-4', 'ring-[#137fec]/40'];
const FOCUS_RING_MS = 2600;
// How often an open request re-reads itself, so a vendor's answer or a
// tenant's message shows up (and marks its tab) without a manual refresh.
// Matches the sidebar badge poll.
const LIVE_REFRESH_MS = 60_000;

export default function RequestDetail() {
  const d3 = useD3PageActive();
  const tenantPresentation = useTenantPresentation();
  const DetailState = tenantPresentation ? TenantState : D3State;
  const DeleteModalFrame = tenantPresentation ? TenantModalFrame : D3ModalFrame;
  const DeleteModalTitle = tenantPresentation ? TenantModalTitle : D3ModalTitle;
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  // The tab lives in the URL (?tab=routing) so Decisions Needed can link
  // straight to the place where the decision is made, and a refresh stays put.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = parseTab(searchParams.get('tab'));
  const focusTarget = searchParams.get('focus');

  const [request, setRequest] = useState<RequestDetailRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [comment, setComment] = useState('');
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [vendorActionBusy, setVendorActionBusy] = useState('');
  const [draftEditorOpen, setDraftEditorOpen] = useState<Record<string, boolean>>({});
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [showManualAssignModal, setShowManualAssignModal] = useState(false);
  const [manualSearch, setManualSearch] = useState('');
  const [manualCandidateKey, setManualCandidateKey] = useState('');
  const [manualOverrideReason, setManualOverrideReason] = useState('');
  const [rejectTarget, setRejectTarget] = useState<RejectRequestTarget | null>(null);
  // Keep the raw note above the loading return: refusal refreshes unmount the
  // dialog. The scope gate hides it immediately on request/account/role change.
  const appealScope = id && user?.id && user.role === 'tenant'
    ? JSON.stringify([id, user.id, user.role])
    : null;
  const [appealDraft, setAppealDraft] = useState<{
    scope: string | null;
    target: AppealRequestTarget | null;
    note: string;
  }>({ scope: null, target: null, note: '' });
  const appealTarget = appealScope && request?._id === id && appealDraft.scope === appealScope && appealDraft.target?.requestId === id
    ? appealDraft.target
    : null;
  useEffect(() => {
    setAppealDraft({ scope: appealScope, target: null, note: '' });
  }, [appealScope]);
  const clearAppealDraft = () => setAppealDraft((current) =>
    current.scope === appealScope && current.target === appealTarget
      ? { scope: appealScope, target: null, note: '' }
      : current
  );
  const [reopenTarget, setReopenTarget] = useState<AppealDecisionTarget | null>(null);
  const [declineTarget, setDeclineTarget] = useState<AppealDecisionTarget | null>(null);
  const [contactTarget, setContactTarget] = useState<ApproveContactTarget | null>(null);
  const [dismissTarget, setDismissTarget] = useState<DismissQuoteTarget | null>(null);
  const [requestActionBusy, setRequestActionBusy] = useState(false);
  const [auditLogs, setAuditLogs] = useState<RequestAuditLog[]>([]);

  const isLandlord = Boolean(user && user.role !== 'tenant');
  useEffect(() => {
    if (isLandlord && user?.id && request?._id) markRequestOpened(user.id, request._id);
  }, [isLandlord, user?.id, request?._id]);
  const { setup: routingSetup, reload: reloadRoutingSetup } = useRoutingSetup(isLandlord);
  const { seen: tabSeen, markSeen: markTabSeen } = useRequestTabSeen(id, isLandlord);
  const [addVendorOpen, setAddVendorOpen] = useState(false);

  const load = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!id) return;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const [requestResponse, logsResponse] = await Promise.all([
        TenantAPI.getRequest(id),
        isLandlord
          ? // Only feeds the tab dots now; the Activity tab loads its own
            // projection, and a failure here just leaves the dots unlit.
            LandlordAPI.listAgentActionLogs({ requestId: id }).catch(() => null)
          : Promise.resolve(null),
      ]);
      setRequest(requestResponse.data as RequestDetailRecord);
      setAuditLogs(
        isLandlord ? ((logsResponse?.data as RequestAuditLog[] | undefined) || []) : []
      );
    } catch (error) {
      if (!silent) setError(error instanceof Error ? error.message : 'Failed to load');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isLandlord]);

  const changeTab = (tab: RequestDetailTab) => {
    // replace, not push: Back should leave the request, not walk the tabs.
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (tab === 'overview') next.delete('tab');
        else next.set('tab', tab);
        return next;
      },
      { replace: true }
    );
  };

  // ?focus=<target> scrolls to the element marked data-focus-target and rings
  // it briefly, then drops the param so a refresh doesn't replay it.
  useEffect(() => {
    if (!focusTarget || loading || !request) return;
    // One frame so the tab's panel has rendered before it is looked up.
    const frame = window.requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(
        `[data-focus-target="${CSS.escape(focusTarget)}"]`
      );
      if (element) {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        element.classList.add(...FOCUS_RING);
        // Not cleared on cleanup: dropping the param below re-runs this effect,
        // and the ring must still fade out afterwards.
        window.setTimeout(() => element.classList.remove(...FOCUS_RING), FOCUS_RING_MS);
      }
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('focus');
          return next;
        },
        { replace: true }
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusTarget, loading, request, setSearchParams]);

  useEffect(() => {
    const refreshVisibleRequest = () => {
      if (document.visibilityState === 'visible') {
        void load({ silent: true });
        // Coming back from the Policy page (or another tab) is how the
        // "max vendors" setup step usually gets done.
        void reloadRoutingSetup();
      }
    };

    window.addEventListener('focus', refreshVisibleRequest);
    document.addEventListener('visibilitychange', refreshVisibleRequest);
    return () => {
      window.removeEventListener('focus', refreshVisibleRequest);
      document.removeEventListener('visibilitychange', refreshVisibleRequest);
    };
    // The request loader is intentionally refreshed when identity or role changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isLandlord]);

  // A new message in this thread (from either side, or a relayed vendor SMS)
  // lands without waiting for the poll below. Resync is left to the focus
  // handler above, which also reloads the routing setup.
  useLiveTopic(id ? `request:${id}` : null, () => void load({ silent: true }), { resync: false });

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load({ silent: true });
    }, LIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isLandlord]);

  // What changed on each tab, and the open tab marked seen -- again whenever
  // new data lands while it is open, so the tab in view never shows a marker.
  const tabActivity = useMemo(
    () => (isLandlord && request ? getTabActivity(request, auditLogs) : null),
    [isLandlord, request, auditLogs]
  );
  // seenReady: the stored marks load in an effect of their own, and a mark
  // attempted before they exist is dropped, so try again once they do.
  const seenReady = tabSeen !== null;
  useEffect(() => {
    if (!seenReady || !tabActivity || activeTab === 'overview' || activeTab === 'work') return;
    markTabSeen(activeTab, seenMarkFor(activeTab, tabActivity));
  }, [activeTab, tabActivity, markTabSeen, seenReady]);
  const tabIndicators = tabActivity ? getTabIndicators(tabActivity, tabSeen) : undefined;

  const postComment = async () => {
    if (!comment.trim() || !id) return;
    setSending(true);
    try {
      await TenantAPI.comment(id, comment.trim());
      setComment('');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed');
    } finally {
      setSending(false);
    }
  };

  const deletePendingRequest = () => {
    setShowDeleteModal(true);
  };

  const confirmDeletePendingRequest = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await TenantAPI.deletePendingRequest(id);
      toast.success('Pending request deleted');
      setShowDeleteModal(false);
      navigate('/portal');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete request');
    } finally {
      setDeleting(false);
    }
  };

  const runVendorAction = async (key: string, action: () => Promise<void>) => {
    setVendorActionBusy(key);
    try {
      await action();
      await load();
    } catch (error) {
      // Several of these used to report only success; with nothing catching,
      // a failure surfaced as an unhandled rejection and the landlord saw nothing.
      toast.error(error instanceof Error ? error.message : 'That vendor action failed');
      // The server refused on setup this page thought was done (changed in
      // another tab): re-read it so the checklist comes back.
      if (error instanceof ApiError && (error.payload as { code?: string } | null)?.code === 'routing_setup_incomplete') {
        void reloadRoutingSetup();
      }
    } finally {
      setVendorActionBusy('');
    }
  };

  const handleGenerateRecommendations = async () => {
    if (!id || !request) return;
    const routeabilityBlockReason = getRouteabilityBlockReason(request);
    if (routeabilityBlockReason) {
      toast.error(routeabilityBlockReason);
      return;
    }
    await runVendorAction('generate', async () => {
      await LandlordAPI.generateVendorRecommendations(id);
    });
  };

  const handleApproveContact = (candidate: VendorRecommendationCandidate) => {
    if (!id || !request) return;
    setContactTarget({
      requestId: id,
      issueTitle: request.issueTitle || 'Maintenance request',
      candidateKey: candidate.candidateKey,
      vendorName: candidate.name,
      draftMessage: draftValues[candidate.candidateKey] ?? candidate.draftMessage ?? '',
      vendorEmailMasked: candidate.outreach?.toEmailMasked ?? null,
      vendorHasEmail: candidate.contact?.hasEmail !== false,
      responseSlaLabel: getResponseSlaLabel(request.urgency),
      sendTiming: candidate.sendTiming ?? null,
      offerPreview: getOfferPreview(candidate),
    });
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
      setContactTarget(null);
      toastOutreachResult(contactTarget.vendorName, response.outreach);
      await load();
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
      setRejectTarget(null);
      if (rejectTarget.final) {
        // Final: the request no longer exists, so there is nothing left to show.
        toast.success('Request rejected for good. The tenant has been told.');
        navigate('/dashboard/requests');
        return;
      }
      toast.success('Request rejected and tenant notified');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reject request');
    } finally {
      setRequestActionBusy(false);
    }
  };

  const appealDecisionTarget = (): AppealDecisionTarget | null =>
    request
      ? {
          requestId: request._id,
          issueTitle: request.issueTitle,
          rejectionReason: request.rejectionReason,
          appealNote: request.appeal?.state === 'pending' ? request.appeal.note : null,
        }
      : null;

  const handleConfirmAppeal = async (note: string) => {
    if (!appealTarget) return;
    setRequestActionBusy(true);
    try {
      await TenantAPI.appealRequest(appealTarget.requestId, note);
      // An old pending response must not clear a newly opened request's draft.
      clearAppealDraft();
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to submit the appeal');
      await load();
    } finally {
      setRequestActionBusy(false);
    }
  };

  const handleConfirmReopen = async (note: string) => {
    if (!reopenTarget) return;
    setRequestActionBusy(true);
    try {
      await LandlordAPI.reopenRequest(reopenTarget.requestId, note);
      setReopenTarget(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reopen the request');
      await load();
    } finally {
      setRequestActionBusy(false);
    }
  };

  const handleConfirmDeclineAppeal = async (reason: string) => {
    if (!declineTarget) return;
    setRequestActionBusy(true);
    try {
      await LandlordAPI.declineAppeal(declineTarget.requestId, reason);
      setDeclineTarget(null);
      toast.success('Appeal declined. The tenant has been told.');
      navigate('/dashboard/requests');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to decline the appeal');
      await load();
    } finally {
      setRequestActionBusy(false);
    }
  };

  const handleSaveDraft = async (candidate: VendorRecommendationCandidate) => {
    if (!id) return;
    const nextDraft = (draftValues[candidate.candidateKey] ?? candidate.draftMessage ?? '').trim();
    if (!nextDraft) {
      toast.error('Draft message cannot be empty');
      return;
    }
    await runVendorAction(`draft:${candidate.candidateKey}`, async () => {
      await LandlordAPI.updateVendorDraft(id, candidate.candidateKey, nextDraft);
      setDraftEditorOpen((current) => ({ ...current, [candidate.candidateKey]: false }));
      setDraftValues((current) => {
        const { [candidate.candidateKey]: _saved, ...rest } = current;
        return rest;
      });
    });
  };

  const handleManualAssignment = async (candidateKey = '') => {
    setManualSearch('');
    setManualCandidateKey(candidateKey);
    setManualOverrideReason('');
    setShowManualAssignModal(true);
  };

  const handleConfirmManualAssignment = async () => {
    if (!id || !request) return;
    if (!manualCandidateKey) {
      toast.error('Select a vendor candidate first');
      return;
    }

    const selectedManualCandidate = getAllVendorCandidates(request.vendorRecommendationSnapshot).find(
      (candidate) => candidate.candidateKey === manualCandidateKey
    );
    const requiresOverride = selectedManualCandidate?.state === 'excluded';
    if (requiresOverride && !manualOverrideReason.trim()) {
      toast.error('Override reason is required for excluded vendors');
      return;
    }

    await runVendorAction('manual-assignment', async () => {
      const response = (await LandlordAPI.manualAssignVendor(id, {
        candidateKey: manualCandidateKey,
        overrideReason: manualOverrideReason.trim() || undefined,
      })) as { outreach?: OutreachResult };
      setShowManualAssignModal(false);
      toastOutreachResult(selectedManualCandidate?.name || 'The vendor', response.outreach);
    });
  };

  // A vendor added from this page. The setup checklist re-reads so its first
  // step ticks off, and when routing can run the search goes again at once:
  // the landlord added that vendor to move THIS request, and making them find
  // Regenerate afterwards is a step that only exists to be forgotten. Under
  // autopilot that search may contact the new vendor -- the same thing
  // clicking Search again would do.
  const handleVendorAdded = async () => {
    const setup = await reloadRoutingSetup();
    const canSearch = Boolean(setup?.ready && request && !getRouteabilityBlockReason(request));
    if (!canSearch || !id) {
      toast.success('Vendor added to your network');
      return;
    }
    toast.success('Vendor added — searching your network again');
    await runVendorAction('generate', async () => {
      await LandlordAPI.generateVendorRecommendations(id);
    });
  };

  const handleResendOutreach = async (candidate: VendorRecommendationCandidate) => {
    if (!id) return;
    await runVendorAction(`outreach:${candidate.candidateKey}`, async () => {
      await LandlordAPI.resendVendorOutreach(id, candidate.candidateKey);
      toast.success(`Outreach resent to ${candidate.name}`);
    });
  };

  const handleCancelScheduled = async (candidate: VendorRecommendationCandidate) => {
    if (!id) return;
    const outreachId = candidate.outreach?.outreachId;
    if (!outreachId) return;
    // The panel flips back to Approve contact, which says what happened.
    await runVendorAction(`outreach:${candidate.candidateKey}`, async () => {
      await LandlordAPI.cancelScheduledOutreach(id, outreachId);
    });
  };

  const handleDismissResponse = async (candidate: VendorRecommendationCandidate) => {
    if (!id) return;
    const outreachId = candidate.outreach?.outreachId;
    if (!outreachId) {
      toast.error('No vendor response to dismiss');
      return;
    }
    // Also the way past an email that couldn't be delivered: the same endpoint
    // retires the vendor and moves the job on. Nobody to tell, so no dialog.
    if (candidate.outreach?.status === 'delivery_failed') {
      await runVendorAction(`outreach:${candidate.candidateKey}`, async () => {
        await LandlordAPI.dismissVendorResponse(id, outreachId);
        toast.success('Moving to the next vendor');
      });
      return;
    }
    // A quote they accepted with: they're emailed, so ask for a reason first.
    setDismissTarget({ outreachId, vendorName: candidate.name, candidateKey: candidate.candidateKey });
  };

  const handleConfirmDismissQuote = async (reason: string) => {
    if (!id || !dismissTarget) return;
    const target = dismissTarget;
    await runVendorAction(`outreach:${target.candidateKey}`, async () => {
      await LandlordAPI.dismissVendorResponse(id, target.outreachId, reason);
      setDismissTarget(null);
      toast.success(`Quote turned down — ${target.vendorName} has been emailed`);
    });
  };

  if (loading) {
    return (
      <DetailState><div role={tenantPresentation ? 'status' : undefined} aria-label={tenantPresentation ? 'Loading request' : undefined} className="flex min-h-screen items-center justify-center bg-slate-50 lichen:bg-background in-[.lichen-d3]:bg-well in-[.lichen-d5]:bg-well">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta" />
      </div></DetailState>
    );
  }

  if (error || !request) {
    return (
      <DetailState><div className="flex min-h-screen items-center justify-center bg-slate-50 lichen:bg-background in-[.lichen-d3]:bg-well in-[.lichen-d5]:bg-well">
        <Card role={tenantPresentation ? 'alert' : undefined} className="max-w-md p-8 text-center" data-testid="detail-error">
          <p className="mb-3 text-rose-600 in-[.lichen-d3]:text-alert-text in-[.lichen-d5]:text-alert-text">{error || 'Request not found'}</p>
          <Button onClick={() => navigate(-1)}>Go back</Button>
        </Card>
      </div></DetailState>
    );
  }

  const propertyLabel = getPropertyLabel(request);
  const unitLabel = getUnitLabel(request);
  const headline = getRequestHeadline(request, isLandlord);
  // Tenant view only: the landlord sidebar no longer shows a cost.
  const costDisplay = getRequestCostDisplay(request);
  const snapshot = request.vendorRecommendationSnapshot || null;
  const activeCandidate = getActiveVendorCandidate(request);
  // The server's label for both audiences (requestLifecycle.service); the raw
  // status only for a payload that predates the field.
  const lifecycleStatus = request.lifecycleStatus || request.status;
  const workflowStage = getRequestWorkflowStage(request);
  const routeabilityBlockReason = getRouteabilityBlockReason(request);
  const landlordMetrics = getVisibleLandlordMetrics(request);
  const manualPickerCandidates = getAllVendorCandidates(snapshot);
  const filteredManualCandidates = manualPickerCandidates.filter((candidate) => {
    const haystack = [
      candidate.name,
      candidate.service,
      candidate.category,
      candidate.city,
      candidate.providerName,
      candidate.candidateSource,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(manualSearch.trim().toLowerCase());
  });
  const selectedManualCandidate =
    filteredManualCandidates.find((candidate) => candidate.candidateKey === manualCandidateKey) ||
    manualPickerCandidates.find((candidate) => candidate.candidateKey === manualCandidateKey) ||
    null;
  const requiresOverride = selectedManualCandidate?.state === 'excluded';
  const hasSelectableCandidate = manualPickerCandidates.some((candidate) =>
    isManuallySelectable(candidate, snapshot)
  );

  return (
    <D3PresentationScope>
      {isLandlord ? (
        <LandlordRequestDetailView
          request={request}
          onRequestChanged={() => void load({ silent: true })}
          onRequestReplaced={setRequest}
          headline={headline}
          propertyLabel={propertyLabel}
          unitLabel={unitLabel}
          lifecycleStatus={lifecycleStatus}
          workflowStage={workflowStage}
          metrics={landlordMetrics}
          activeCandidate={activeCandidate}
          activeTab={activeTab}
          onTabChange={changeTab}
          onBack={() => navigate(-1)}
          onOpenRejectRequest={() =>
            setRejectTarget({
              requestId: request._id,
              issueTitle: request.issueTitle,
              final: Boolean(request.appeal?.rejectIsFinal),
            })
          }
          onReopen={() => setReopenTarget(appealDecisionTarget())}
          onDeclineAppeal={() => setDeclineTarget(appealDecisionTarget())}
          comment={comment}
          onCommentChange={setComment}
          onSubmitComment={postComment}
          sendingComment={sending}
          snapshot={snapshot}
          routeabilityBlockReason={routeabilityBlockReason}
          vendorActionBusy={vendorActionBusy}
          draftValues={draftValues}
          draftEditorOpen={draftEditorOpen}
          onGenerateRecommendations={handleGenerateRecommendations}
          onManualAssign={handleManualAssignment}
          onToggleDraft={(candidate) => {
            const key = candidate.candidateKey;
            const opening = !draftEditorOpen[key];
            // Opening always starts from the saved draft, and closing without
            // saving discards the edit -- otherwise an abandoned edit would
            // leak into Approve Contact, which prefills from draftValues.
            setDraftValues((current) => {
              const { [key]: _discarded, ...rest } = current;
              return opening ? { ...rest, [key]: candidate.draftMessage ?? '' } : rest;
            });
            setDraftEditorOpen((current) => ({ ...current, [key]: opening }));
          }}
          onChangeDraft={(candidate, value) =>
            setDraftValues((current) => ({
              ...current,
              [candidate.candidateKey]: value,
            }))
          }
          onSaveDraft={handleSaveDraft}
          onApproveContact={handleApproveContact}
          onResendOutreach={handleResendOutreach}
          onDismissResponse={handleDismissResponse}
          onCancelScheduled={handleCancelScheduled}
          routingSetup={routingSetup}
          onAddVendor={() => setAddVendorOpen(true)}
          tabIndicators={tabIndicators}
        />
      ) : (
        <TenantRequestDetailView
          request={request}
          onRequestReplaced={setRequest}
          lifecycleStatus={lifecycleStatus}
          costDisplay={costDisplay}
          propertyLabel={propertyLabel}
          unitLabel={unitLabel}
          onBack={() => navigate(-1)}
          onDeletePending={deletePendingRequest}
          deleting={deleting}
          comment={comment}
          onCommentChange={setComment}
          onSubmitComment={postComment}
          sendingComment={sending}
          onAppeal={() => {
            if (!appealScope || request._id !== id) return;
            setAppealDraft({
              scope: appealScope,
              target: {
                requestId: request._id,
                issueTitle: request.issueTitle,
                summary: request.ai?.summary,
                rejectionReason: request.rejectionReason,
              },
              note: '',
            });
          }}
        />
      )}

      <AnimatePresence>
        {showDeleteModal && (
          <DeleteModalFrame key="detail-delete-frame" busy={deleting} onClose={() => setShowDeleteModal(false)}>
          <motion.div
            key="detail-delete-modal"
            className={`fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[2px] ${d3 ? `${D3_PORTAL} bg-black/50! backdrop-blur-none` : ''}`}
            initial={d3 || tenantPresentation ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: d3 || tenantPresentation ? 1 : 0 }}
            onClick={() => {
              if (!deleting) setShowDeleteModal(false);
            }}
            data-testid="detail-delete-modal"
          >
            <motion.div
              initial={d3 || tenantPresentation ? false : { opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={d3 || tenantPresentation ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 10, scale: 0.98 }}
              transition={{ duration: d3 || tenantPresentation ? 0 : 0.15 }}
              className="w-full max-w-md overflow-hidden rounded-2xl border border-white/20 bg-white shadow-2xl in-[.lichen-d3]:rounded-lg in-[.lichen-d5]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d5]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d5]:bg-card in-[.lichen-d3]:shadow-none in-[.lichen-d5]:shadow-none"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="bg-gradient-to-r from-[#137fec] to-[#a855f7] px-6 py-5 text-white in-[.lichen-d3]:bg-none in-[.lichen-d5]:bg-none in-[.lichen-d3]:bg-card in-[.lichen-d5]:bg-card in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">
                <DeleteModalTitle><h3 className="text-lg font-bold">Delete Pending Request?</h3></DeleteModalTitle>
                <p className="mt-1 text-sm text-white/90 in-[.lichen-d3]:text-meta in-[.lichen-d5]:text-meta">This action cannot be undone.</p>
              </div>
              <div className="px-6 py-5 text-sm text-slate-700 in-[.lichen-d3]:text-ink in-[.lichen-d5]:text-ink">
                Deleting will permanently remove this queued request and its related draft workflow artifacts.
              </div>
              <div className="flex justify-end gap-2 px-6 pb-6 in-[.lichen-d5]:flex-wrap">
                <Button
                  data-testid="detail-delete-cancel"
                  variant="outline"
                  onClick={() => setShowDeleteModal(false)}
                  disabled={deleting}
                >
                  Cancel
                </Button>
                <Button
                  data-testid="detail-delete-confirm"
                  className="gap-2 bg-rose-600 text-white hover:bg-rose-700 in-[.lichen-d3]:bg-destructive in-[.lichen-d5]:bg-destructive in-[.lichen-d3]:text-destructive-foreground in-[.lichen-d5]:text-destructive-foreground in-[.lichen-d3]:hover:bg-destructive/90 in-[.lichen-d5]:hover:bg-destructive/90"
                  onClick={confirmDeletePendingRequest}
                  disabled={deleting}
                >
                  {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Delete Request
                </Button>
              </div>
            </motion.div>
          </motion.div>
          </DeleteModalFrame>
        )}

        {showManualAssignModal && (
          <D3ModalFrame key="detail-manual-assignment-frame" busy={vendorActionBusy === 'manual-assignment'} onClose={() => setShowManualAssignModal(false)}>
          <motion.div
            key="detail-manual-assign-modal"
            className={`fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[2px] ${d3 ? `${D3_PORTAL} bg-black/50! backdrop-blur-none` : ''}`}
            initial={d3 ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: d3 ? 1 : 0 }}
            onClick={() => {
              if (vendorActionBusy !== 'manual-assignment') setShowManualAssignModal(false);
            }}
            data-testid="detail-manual-assignment-modal"
          >
            <motion.div
              initial={d3 ? false : { opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={d3 ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 10, scale: 0.98 }}
              transition={{ duration: d3 ? 0 : 0.15 }}
              className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/20 bg-white shadow-2xl in-[.lichen-d3]:min-w-0 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:shadow-none"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="bg-gradient-to-r from-[#137fec] to-[#a855f7] px-6 py-4 text-white in-[.lichen-d3]:bg-none in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink">
                <D3ModalTitle><h3 className="text-lg font-bold">Manual Vendor Assignment</h3></D3ModalTitle>
                <p className="mt-1 text-sm text-white/90 in-[.lichen-d3]:text-meta">
                  Choose a vendor and we&rsquo;ll send them this job, the same as Approve contact. Other
                  candidates wait in line in case they decline.
                </p>
              </div>

              <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
                <div className="grid gap-4 md:grid-cols-[1.2fr,0.8fr]">
                  <div>
                    <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500 in-[.lichen-d3]:text-meta">
                      Search candidates
                    </div>
                    <input
                      aria-label="Search candidates"
                      value={manualSearch}
                      onChange={(event) => setManualSearch(event.target.value)}
                      placeholder="Search by vendor, service, city, or provider"
                      className={`h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-[#137fec] focus:ring-2 focus:ring-[#137fec]/20 ${D3_FIELD}`}
                    />
                    <div className="mt-3 max-h-[16rem] space-y-2 overflow-y-auto pr-1">
                      {!hasSelectableCandidate ? (
                        // Everyone here has declined, been turned down, or is
                        // otherwise out -- a list of greyed-out names is not a
                        // choice. Say so, and offer the way forward.
                        <div
                          className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-600 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-meta"
                          data-testid="manual-assign-nobody"
                        >
                          <p>No vendor from this search can be assigned.</p>
                          <Button
                            size="sm"
                            className="mt-3 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
                            onClick={() => {
                              setShowManualAssignModal(false);
                              setAddVendorOpen(true);
                            }}
                          >
                            Add a vendor
                          </Button>
                        </div>
                      ) : filteredManualCandidates.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-meta">
                          No candidates match this search.
                        </div>
                      ) : (
                        filteredManualCandidates.map((candidate) => {
                          const selected = manualCandidateKey === candidate.candidateKey;
                          const blockedReason = getCandidateActionBlockReason(candidate, snapshot);
                          const selectable = isManuallySelectable(candidate, snapshot);

                          return (
                            <button
                              key={candidate.candidateKey}
                              type="button"
                              aria-pressed={selected}
                              onClick={() => selectable && setManualCandidateKey(candidate.candidateKey)}
                              disabled={!selectable}
                              className={`w-full rounded-2xl border px-4 py-3 text-left transition in-[.lichen-d3]:rounded-lg ${
                                selected
                                  ? "border-[#a855f7] bg-violet-50 shadow-sm in-[.lichen-d3]:border-lichen-icon in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:shadow-none"
                                  : "border-slate-200 bg-white hover:border-slate-300 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:hover:border-control-border"
                              } ${!selectable ? 'cursor-not-allowed opacity-60' : ''}`}
                            >
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{candidate.name}</span>
                                <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getCandidateStateBadge(candidate)} ${d3CandidateClass(candidate.state)}`}>
                                  {getCandidateStateLabel(candidate)}
                                </span>
                                <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-ink">
                                  {getSourceLabel(candidate.candidateSource)}
                                </span>
                                {candidate.service ? (
                                  <span className="inline-flex rounded-full bg-cyan-100 px-2.5 py-1 text-xs font-semibold text-cyan-700 in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink">
                                    {candidate.service}
                                  </span>
                                ) : null}
                              </div>
                              <div className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                                {candidate.city || 'Service area pending'} • {candidate.providerName}
                              </div>
                              {candidate.humanReadableReasons?.length ? (
                                <div className="mt-2 text-xs text-slate-600 in-[.lichen-d3]:text-meta">
                                  {candidate.humanReadableReasons.join(', ')}
                                </div>
                              ) : null}
                              {blockedReason ? (
                                <div className="mt-2 text-xs text-amber-700 in-[.lichen-d3]:text-lichen-text">{blockedReason}</div>
                              ) : null}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well">
                    <div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500 in-[.lichen-d3]:text-meta">
                      Selection summary
                    </div>
                    {selectedManualCandidate ? (
                      <div className="space-y-3">
                        <div>
                          <div className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{selectedManualCandidate.name}</div>
                          <div className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                            {getSourceLabel(selectedManualCandidate.candidateSource)} • {selectedManualCandidate.providerName}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${getCandidateStateBadge(selectedManualCandidate)} ${d3CandidateClass(selectedManualCandidate.state)}`}>
                            {getCandidateStateLabel(selectedManualCandidate)}
                          </span>
                          {selectedManualCandidate.service ? (
                            <span className="inline-flex rounded-full bg-cyan-100 px-2.5 py-1 text-xs font-semibold text-cyan-700 in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink">
                              {selectedManualCandidate.service}
                            </span>
                          ) : null}
                        </div>
                        <div className="text-sm text-slate-700 in-[.lichen-d3]:text-ink">
                          Estimated price: {formatPriceEstimate(selectedManualCandidate.priceEstimate)}
                        </div>
                        {selectedManualCandidate.humanReadableReasons?.length ? (
                          <div className="text-xs text-slate-600 in-[.lichen-d3]:text-meta">
                            Constraints: {selectedManualCandidate.humanReadableReasons.join(', ')}
                          </div>
                        ) : null}
                        {requiresOverride ? (
                          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint">
                            <div className="mb-1 text-xs font-bold uppercase tracking-wider text-amber-700 in-[.lichen-d3]:text-lichen-text">
                              Override required
                            </div>
                            <p className="text-sm text-amber-900 in-[.lichen-d3]:text-lichen-text">
                              This candidate was excluded by deterministic constraints. Provide a manager override reason to continue.
                            </p>
                            <textarea
                              aria-label="Manager override reason"
                              value={manualOverrideReason}
                              onChange={(event) => setManualOverrideReason(event.target.value)}
                              rows={5}
                              className={`mt-3 w-full rounded-xl border border-amber-200 bg-white px-3 py-3 text-sm text-slate-700 focus:border-[#a855f7] focus:outline-none focus:ring-2 focus:ring-[#a855f7]/20 ${D3_FIELD}`}
                              placeholder="Explain why this override is justified"
                            />
                          </div>
                        ) : (
                          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-mist-line in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text">
                            No override reason is needed for this candidate.
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-sm text-slate-500 in-[.lichen-d3]:text-meta">
                        Select a candidate to review the assignment details.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-end gap-2 px-6 pb-6">
                <Button
                  variant="outline"
                  onClick={() => setShowManualAssignModal(false)}
                  disabled={vendorActionBusy === 'manual-assignment'}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleConfirmManualAssignment}
                  disabled={!selectedManualCandidate || vendorActionBusy === 'manual-assignment'}
                  className="gap-2 bg-[#a855f7] hover:bg-[#9333ea] in-[.lichen-d3]:bg-primary in-[.lichen-d3]:text-primary-foreground in-[.lichen-d3]:hover:bg-primary/90"
                >
                  {vendorActionBusy === 'manual-assignment' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  Assign and contact vendor
                </Button>
              </div>
            </motion.div>
          </motion.div>
          </D3ModalFrame>
        )}
      </AnimatePresence>

      {isLandlord ? (
        <VendorFormDialog
          open={addVendorOpen}
          onOpenChange={setAddVendorOpen}
          vendor={null}
          onSaved={handleVendorAdded}
        />
      ) : null}

      <RejectRequestDialog
        target={rejectTarget}
        busy={requestActionBusy}
        onClose={() => setRejectTarget(null)}
        onConfirm={handleConfirmRejectRequest}
      />
      <ReopenRequestDialog
        target={reopenTarget}
        busy={requestActionBusy}
        onClose={() => setReopenTarget(null)}
        onConfirm={handleConfirmReopen}
      />
      <DeclineAppealDialog
        target={declineTarget}
        busy={requestActionBusy}
        onClose={() => setDeclineTarget(null)}
        onConfirm={handleConfirmDeclineAppeal}
      />
      <AppealRequestDialog
        target={appealTarget}
        busy={requestActionBusy}
        note={appealTarget ? appealDraft.note : ''}
        onNoteChange={(note) => setAppealDraft((current) =>
          appealTarget && current.scope === appealScope && current.target === appealTarget
            ? { ...current, note }
            : current
        )}
        onClose={clearAppealDraft}
        onConfirm={handleConfirmAppeal}
      />
      <DismissQuoteDialog
        target={dismissTarget}
        busy={Boolean(dismissTarget) && vendorActionBusy === `outreach:${dismissTarget?.candidateKey}`}
        onClose={() => setDismissTarget(null)}
        onConfirm={handleConfirmDismissQuote}
      />
      <ApproveContactDialog
        target={contactTarget}
        busy={requestActionBusy}
        onClose={() => setContactTarget(null)}
        onConfirm={handleConfirmApproveContact}
      />
    </D3PresentationScope>
  );
}


