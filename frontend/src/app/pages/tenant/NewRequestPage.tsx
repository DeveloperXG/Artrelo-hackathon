import { useEffect, useRef, useState } from 'react';
import { MetaTriageHackathonBadge } from '../../components/judge/JudgeBadges';
import { JudgeDemoExample, demoExampleDraft } from '../../components/judge/JudgeDemoScenario';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  Camera,
  CheckCircle,
  ChevronRight,
  Info,
  Loader2,
  Send,
  ShieldAlert,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { AIAPI, ApiError, TenantAPI, type EvidenceAsset, type RequestQuota } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { CATEGORY_LIST } from '../../components/tenant/tenantRequests';
import EvidenceCapture from '../../components/tenant/EvidenceCapture';
import { useTenantMoveOut } from '../../hooks/tenant/useTenantMoveOut';
import { useRequestQuota } from '../../hooks/tenant/useRequestQuota';
import { useSubmissionKey } from '../../hooks/useSubmissionKey';
import { usePropertyManagerContact } from '../../hooks/tenant/usePropertyManagerContact';
import RequestQuotaMeter, { formatNextAvailable } from '../../components/tenant/RequestQuotaMeter';
import { buildReadyReply } from '../../lib/intakeReply';
import { adaptTriageResponse, type TriageResult } from '../../lib/triageResponse';
import {
  mergeSimilarRequests,
  stripAcknowledgment,
  writeCarriedDraft,
  type CreationGate,
} from '../../lib/requestWorkflow';
import { CreationGateNotice, SafetyConcernLink } from '../../components/tenant/NewRequestGate';
import { TenantState, TENANT_FIELD, useTenantPresentation } from '../../components/tenant/tenantPresentation';
import type { SimilarRequest } from '../../types/requestWorkflow';

type Step = 'category' | 'chat';

/** Cap a heading at a word boundary. The summary is a multi-sentence recap, so
 *  take its first sentence rather than slicing blindly into the middle of one. */
function capTitle(text: string, maxLength = 80) {
  const firstSentence = String(text || '').split(/(?<=[.!?])\s+/)[0] || '';
  const compact = (firstSentence.trim() || String(text || '').trim()).replace(/\s+/g, ' ');
  if (!compact) return '';
  if (compact.length <= maxLength) return compact.replace(/[\s.,;:!?-]+$/, '');
  const cut = compact.slice(0, maxLength + 1);
  const lastSpace = cut.lastIndexOf(' ');
  const sliced =
    lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : compact.slice(0, maxLength);
  return sliced.replace(/[\s.,;:!?-]+$/, '');
}

type PrecheckResult = {
  decision: 'allow' | 'duplicate' | 'blocked_cap' | 'blocked_quota';
  isEmergency: boolean;
  emergencyOverride?: boolean;
  safetyWarning?: string;
  cap: number;
  openCount?: number;
  nextAvailableAt?: string;
  quota?: RequestQuota | null;
  duplicate?: { id: string; issueTitle: string; category?: string | null; createdAt?: string };
  similarRequests?: SimilarRequest[];
};

// A similar open request is a suggestion, never a gate: only the limits stop
// a routine intake, and a safety concern has its own form.
type IntakeGate =
  | { type: 'cap'; openCount: number; cap: number }
  | { type: 'quota'; quota: RequestQuota | null; nextAvailableAt: string };

/** An older server reports a similar request as a blocking "duplicate". */
function similarFromPrecheck(pre: PrecheckResult): SimilarRequest[] {
  if (pre.similarRequests?.length) return pre.similarRequests;
  if (pre.duplicate) {
    return [
      {
        id: pre.duplicate.id,
        issueTitle: pre.duplicate.issueTitle,
        reason: 'Looks like the same problem',
        createdAt: pre.duplicate.createdAt || '',
      },
    ];
  }
  return [];
}

const normalizeReplyText = (text = '') =>
  text
    .replace(/^safety note:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const containsSameReply = (message = '', needle = '') => {
  const normalizedMessage = normalizeReplyText(message);
  const normalizedNeedle = normalizeReplyText(needle);
  return Boolean(
    normalizedMessage &&
      normalizedNeedle &&
      (normalizedMessage === normalizedNeedle ||
        normalizedMessage.includes(normalizedNeedle) ||
        normalizedNeedle.includes(normalizedMessage))
  );
};

const appendUniqueReplyPart = (parts: string[], next?: string) => {
  const trimmed = next?.trim();
  if (!trimmed) return;
  if (parts.some((part) => containsSameReply(part, trimmed))) return;
  parts.push(trimmed);
};

export default function NewRequestPage() {
  const tenantPresentation = useTenantPresentation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { linked } = useTenantMoveOut();
  const { quota, gate, reload: reloadQuota } = useRequestQuota(linked);
  const userName = user?.name || 'there';
  // One id per intake, reused on every retry of the same submission.
  const submissionKey = useSubmissionKey();
  const [similar, setSimilar] = useState<SimilarRequest[]>([]);
  const [dismissedSimilar, setDismissedSimilar] = useState<Set<string>>(() => new Set());
  const [carryTarget, setCarryTarget] = useState<SimilarRequest | null>(null);

  const [step, setStep] = useState<Step>('category');
  const [category, setCategory] = useState('');
  const [chatMessages, setChatMessages] = useState<{ role: 'ai' | 'user'; content: string }[]>([]);
  const [currentMessage, setCurrentMessage] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [isReadyToSubmit, setIsReadyToSubmit] = useState(false);
  const [triage, setTriage] = useState<TriageResult | null>(null);
  const [triageReceipt, setTriageReceipt] = useState<string | null>(null);
  const [intakeGate, setIntakeGate] = useState<IntakeGate | null>(null);
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);
  const [intakeCleared, setIntakeCleared] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceAsset[]>([]);
  // Non-null while the chat is auto-closing after the tenant resolved the issue.
  const [closeCountdown, setCloseCountdown] = useState<number | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: tenantPresentation && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [chatMessages, tenantPresentation]);

  // Resolved-issue auto-close countdown. Ticks once per second and navigates the
  // tenant back to their requests at zero, unless they cancel (sets it back to null).
  useEffect(() => {
    if (closeCountdown === null) return;
    if (closeCountdown <= 0) {
      navigate('/portal');
      return;
    }
    const timer = setTimeout(
      () => setCloseCountdown((n) => (n === null ? null : n - 1)),
      1000
    );
    return () => clearTimeout(timer);
  }, [closeCountdown, navigate]);

  const closeFlow = () => navigate('/portal');

  // Picking a category opens the AI chat directly; there is no other intake
  // method to choose between.
  const handleCategorySelect = (id: string) => {
    const firstName = (userName || 'there').trim().split(/\s+/)[0] || 'there';
    setCategory(id);
    setChatMessages([
      {
        role: 'ai',
        content: `Hi ${firstName}! Describe your ${id} issue with as much detail as possible - when it started, what you've tried, and anything that affects access to your unit.`,
      },
    ]);
    setTriage(null);
    setTriageReceipt(null);
    setIsReadyToSubmit(false);
    setIntakeGate(null);
    setPendingFirstMessage(null);
    setIntakeCleared(false);
    setEvidence([]);
    setCloseCountdown(null);
    setSimilar([]);
    setDismissedSimilar(new Set());
    setCarryTarget(null);
    submissionKey.reset();
    setStep('chat');
  };

  const gateFromPrecheck = (pre: PrecheckResult): IntakeGate | null => {
    if (pre.decision === 'blocked_quota') {
      return { type: 'quota', quota: pre.quota || null, nextAvailableAt: pre.nextAvailableAt || '' };
    }
    if (pre.decision === 'blocked_cap') {
      return { type: 'cap', openCount: pre.openCount ?? pre.cap, cap: pre.cap };
    }
    return null;
  };

  const showSimilar = (incoming: SimilarRequest[] | undefined, dismissed = dismissedSimilar) => {
    // Only replace when the server said something this turn: a turn with no
    // suggestions field keeps the ones already on screen.
    if (incoming === undefined) return;
    setSimilar(mergeSimilarRequests(incoming, dismissed));
  };

  const dismissSimilar = (id: string) => {
    const next = new Set(dismissedSimilar);
    next.add(id);
    setDismissedSimilar(next);
    setSimilar((current) => current.filter((item) => item.id !== id));
    if (carryTarget?.id === id) setCarryTarget(null);
  };

  // Confirmed "same issue": carry what the tenant typed to that request, where
  // they confirm it once more as an update. Nothing is merged automatically.
  const carryToExisting = (target: SimilarRequest) => {
    const body = chatMessages.filter((m) => m.role === 'user').map((m) => m.content).join('\n') || currentMessage.trim();
    if (!user?.id) return;
    const draft = writeCarriedDraft(user.id, target.id, body);
    navigate(`/portal/requests/${target.id}`, { state: { carryover: draft } });
  };

  // The paid triage turn. `conversationHistory` already includes the user's
  // latest message; the bubble is rendered by the caller.
  const runTriage = async (
    msg: string,
    conversationHistory: { role: 'ai' | 'user'; content: string }[]
  ) => {
    setChatBusy(true);
    setIsReadyToSubmit(false);
    try {
      const res = await AIAPI.triage({
        message: msg,
        category,
        photos: evidence.filter((a) => a.type === 'image').map((a) => a.url),
        context: { conversationHistory, previousTriage: triage || undefined },
        intakeMode: 'routine',
      });
      const {
        triage: data,
        tenantResponse,
        workflow,
        triageReceipt: receipt,
        similarRequests,
      } = adaptTriageResponse(res);
      showSimilar(similarRequests);
      const previous = triage;
      setTriage(data);
      setTriageReceipt(receipt);

      // Tenant successfully troubleshooted the issue — close the chat instead of
      // continuing to ask questions or creating a request.
      const isResolved =
        tenantResponse?.nextAction === 'issue_resolved' ||
        workflow?.actionType === 'resolved_closed';
      if (isResolved) {
        setIsReadyToSubmit(false);
        setChatMessages((m) => [
          ...m,
          {
            role: 'ai',
            content:
              stripAcknowledgment(tenantResponse?.message, data.acknowledgment) ||
              "I'm glad this issue is resolved! This chat will close shortly and take you back to your requests.",
          },
        ]);
        setCloseCountdown(3);
        return;
      }

      const ready = workflow
        ? Boolean(workflow.shouldCreateTicket)
        : Boolean(data.readyToSubmit || data.intakeStatus === 'ready_to_submit');
      setIsReadyToSubmit(ready);
      const followUp = (data.missingFields?.[0] || data.followUpQuestions?.[0])?.trim();
      const safetyWarning = data.safetyWarning?.trim();
      const safetyWarningChanged = Boolean(safetyWarning && safetyWarning !== previous?.safetyWarning);
      // The model's acknowledgement line is never shown, only its question or guidance.
      const tenantMessage = stripAcknowledgment(tenantResponse?.message, data.acknowledgment) || undefined;
      const tenantMessageRepeatsSafety = Boolean(safetyWarning && tenantMessage && containsSameReply(tenantMessage, safetyWarning));
      const urgentOrEmergency = Boolean(data.emergencyServicesRecommended || ['high', 'emergency'].includes(data.urgency));
      const readyPrompt = buildReadyReply({ previous, current: data, urgentOrEmergency });
      const replyParts: string[] = [];

      if (safetyWarningChanged) {
        appendUniqueReplyPart(replyParts, `Safety note: ${safetyWarning}`);
      }
      if (tenantMessage && tenantResponse?.nextAction !== 'submit_request' && !tenantMessageRepeatsSafety) {
        appendUniqueReplyPart(replyParts, tenantMessage);
      } else if (!ready && followUp) {
        appendUniqueReplyPart(replyParts, followUp);
      } else if (ready) {
        appendUniqueReplyPart(replyParts, tenantMessage && !tenantMessageRepeatsSafety ? tenantMessage : readyPrompt);
      } else {
        appendUniqueReplyPart(replyParts, 'Could you share one more detail about what happened or when it started?');
      }

      const reply = replyParts.join('\n\n');
      setChatMessages((m) => [...m, { role: 'ai', content: reply }]);
    } catch (e) {
      setChatMessages((m) => [...m, { role: 'ai', content: 'Sorry, I had trouble understanding. Try rephrasing?' }]);
      toast.error(e instanceof Error ? e.message : 'AI triage failed');
    } finally {
      setChatBusy(false);
    }
  };

  const sendChat = async () => {
    if (intakeGate || chatBusy || submitting || closeCountdown !== null) return;
    if (!currentMessage.trim()) return;
    const msg = currentMessage.trim();
    const isFirstTurn = chatMessages.filter((m) => m.role === 'user').length === 0;

    // First message: run the free pre-screen before opening the paid triage chat.
    if (isFirstTurn && !intakeCleared) {
      setChatMessages((m) => [...m, { role: 'user', content: msg }]);
      setCurrentMessage('');
      setChatBusy(true);
      let pre: PrecheckResult;
      try {
        pre = (await TenantAPI.precheckRequest({ description: msg, category, intakeMode: 'routine' }))
          .data as PrecheckResult;
      } catch {
        // Fail open: the server rechecks the limits when the request is created.
        pre = { decision: 'allow', isEmergency: false, cap: 2 };
      }
      setChatBusy(false);
      showSimilar(similarFromPrecheck(pre));
      const blocked = gateFromPrecheck(pre);
      if (blocked) {
        // Usually a second tab used the last slot after this page loaded.
        setPendingFirstMessage(msg);
        setIntakeGate(blocked);
        return;
      }
      setIntakeCleared(true);
      await runTriage(msg, [{ role: 'user', content: msg }]);
      return;
    }

    const conversationHistory = [...chatMessages, { role: 'user' as const, content: msg }];
    setChatMessages(conversationHistory);
    setCurrentMessage('');
    await runTriage(msg, conversationHistory);
  };

  // At a limit the only way on is the safety form, which carries the
  // description so the tenant never types it twice.
  const openSafetyForm = () => {
    navigate('/portal/safety', { state: { description: pendingFirstMessage || '' } });
  };

  const submitFromChat = async () => {
    if (chatBusy || submitting || !isReadyToSubmit || intakeGate || closeCountdown !== null || currentMessage.trim()) return;
    const userMsgs = chatMessages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    // The submit button stays disabled until the tenant has said something.
    if (!userMsgs) return;
    setSubmitting(true);
    try {
      // Prefer the model's own short title. Falling back to a hard slice of the
      // summary cut mid-word, and summaries are now full recaps rather than 240
      // characters, so that fallback would fire on almost every request.
      const title =
        triage?.shortTitle?.trim() ||
        capTitle(triage?.summary || '') ||
        capTitle(userMsgs, 60) ||
        'Maintenance request';
      // Attach captured evidence to the last tenant turn so it is also recorded on
      // the chat transcript, not only on the incident record.
      const history = chatMessages.map((m) => ({ ...m }));
      if (evidence.length) {
        for (let i = history.length - 1; i >= 0; i -= 1) {
          if (history[i].role === 'user') {
            (history[i] as typeof history[number] & { attachments?: EvidenceAsset[] }).attachments =
              evidence;
            break;
          }
        }
      }
      const payload = {
        issueTitle: title,
        issueDescription: userMsgs,
        category: triage?.category || category,
        urgency: triage?.urgency || 'medium',
        source: 'chat',
        runTriage: !triage,
        triageSnapshot: triage || undefined,
        triageReceipt: triageReceipt || undefined,
        conversationHistory: history,
        photos: evidence.filter((a) => a.type === 'image').map((a) => a.url),
        evidence,
        intakeMode: 'routine' as const,
      };
      // An unchanged retry replays; a changed conversation is a new submission.
      await TenantAPI.createRequest({ ...payload, submissionId: submissionKey.idFor(payload) });
      toast.success('Request submitted');
      navigate('/portal');
    } catch (e) {
      // The server validated the "emergency" claim and disagreed while the tenant is
      // at their open-request limit: surface the explanation and send them back to
      // their requests rather than leaving them stuck in the chat.
      const code = e instanceof ApiError ? (e.payload as { code?: string })?.code : undefined;
      if (code === 'idempotency_conflict') submissionKey.reset();
      if (code === 'emergency_not_validated') {
        toast.error(e instanceof Error ? e.message : 'Request not submitted');
        navigate('/portal');
        return;
      }
      // Over the daily / weekly limit -- usually a second chat finished first.
      if (code === 'request_quota_reached' || code === 'request_open_cap_reached') {
        const next = ((e as ApiError).payload as { data?: { quota?: RequestQuota } })?.data?.quota?.nextAvailableAt;
        toast.error(
          next
            ? `${e instanceof Error ? e.message : 'Request limit reached'} You can send your next request at ${formatNextAvailable(next)}.`
            : 'Request limit reached.'
        );
        navigate('/portal');
        return;
      }
      toast.error(e instanceof Error ? e.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  // Reached by URL with no unit (moved out, or the unit was retired). The
  // layout banner explains it; the server would refuse the request anyway.
  if (!linked) {
    return (
      <TenantState><div className="flex justify-center">
        <Button variant="outline" className="border-slate-200 in-[.lichen-d5]:border-border" onClick={() => navigate('/portal')}>
          Back to your requests
        </Button>
      </div></TenantState>
    );
  }

  if (step === 'category') {
    // Reached by URL as well as by the button, so the same server verdict
    // guards the page before any intake starts.
    if (gate.status !== 'allowed') {
      return <TenantState><IntakeGuard gate={gate} quota={quota} onRetry={() => void reloadQuota()} onBack={closeFlow} /></TenantState>;
    }
    return <TenantState><CategoryPicker onSelect={handleCategorySelect} onCancel={closeFlow} quota={quota} /></TenantState>;
  }

  return (
    <TenantState><ChatPanel
      category={category}
      triageSource={triage?.source}
      messages={chatMessages}
      currentMessage={currentMessage}
      setCurrentMessage={setCurrentMessage}
      onUseDemoExample={() => setCurrentMessage(demoExampleDraft)}
      onSend={sendChat}
      busy={chatBusy}
      readyForSubmit={isReadyToSubmit}
      submitting={submitting}
      onSubmit={submitFromChat}
      onCancel={closeFlow}
      endRef={chatBottomRef}
      intakeGate={intakeGate}
      onOpenSafetyForm={openSafetyForm}
      similar={similar}
      carryTarget={carryTarget}
      onChooseCarry={setCarryTarget}
      onConfirmCarry={carryToExisting}
      onDismissSimilar={dismissSimilar}
      evidence={evidence}
      onEvidenceChange={setEvidence}
      closeCountdown={closeCountdown}
      onStayInChat={() => setCloseCountdown(null)}
    /></TenantState>
  );
}

const CATEGORY_HINTS: Record<string, string> = {
  Plumbing: 'Leaks, clogs & water issues',
  Electrical: 'Outlets, wiring & power',
  HVAC: 'Heating, cooling & airflow',
  Appliance: 'Fridge, oven, washer & more',
  Structural: 'Walls, floors, doors & ceilings',
  Pest: 'Insects & rodents',
  'Locks/Hardware': 'Keys, locks & handles',
  Other: 'Anything else in your unit',
};

/** Shown instead of the category picker until a routine request may start. */
function IntakeGuard({
  gate,
  quota,
  onRetry,
  onBack,
}: {
  gate: CreationGate;
  quota: RequestQuota | null;
  onRetry: () => void;
  onBack: () => void;
}) {
  if (gate.status === 'loading') {
    return (
      <div className="flex min-h-[calc(100vh-7rem)] items-center justify-center" data-testid="intake-guard-loading" aria-live="polite">
        <Loader2 className="mr-2 h-5 w-5 animate-spin text-slate-400 in-[.lichen-d5]:text-meta" />
        <span className="text-sm text-slate-500 in-[.lichen-d5]:text-meta">Checking your request limits…</span>
      </div>
    );
  }
  return (
    <div className="flex min-h-[calc(100vh-7rem)] flex-col items-center justify-center gap-4" data-testid="intake-guard">
      {gate.status === 'blocked' ? <RequestQuotaMeter quota={quota} className="w-full max-w-3xl" /> : null}
      <Card className="w-full max-w-3xl gap-4 border border-slate-100 p-6 shadow-sm sm:p-8 in-[.lichen-d5]:border-hairline in-[.lichen-d5]:shadow-none">
        <h3 className="text-xl font-bold tracking-tight text-slate-900 in-[.lichen-d5]:text-ink">
          {gate.status === 'error' ? 'We couldn’t check your request limits' : 'You can’t start a new request right now'}
        </h3>
        <CreationGateNotice gate={gate} onRetry={onRetry} />
        {gate.status === 'error' ? (
          <p className="text-sm text-slate-500 in-[.lichen-d5]:text-meta">
            If something in your unit is unsafe, you can still <SafetyConcernLink className="align-baseline" />.
          </p>
        ) : null}
        <div>
          <Button variant="outline" className="border-slate-200 in-[.lichen-d5]:border-border" onClick={onBack} data-testid="intake-guard-back">
            Back to your requests
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** Up to three open requests that may be the same problem. The tenant decides;
 *  nothing is merged, and "Different issue" hides one for this intake only. */
function SimilarRequests({
  items,
  carryTarget,
  disabled,
  onChoose,
  onConfirm,
  onDismiss,
}: {
  items: SimilarRequest[];
  carryTarget: SimilarRequest | null;
  disabled: boolean;
  onChoose: (item: SimilarRequest | null) => void;
  onConfirm: (item: SimilarRequest) => void;
  onDismiss: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <section
      aria-label="Possibly related open requests"
      className="shrink-0 border-t border-slate-100 bg-slate-50 px-4 py-3 in-[.lichen-d5]:border-hairline in-[.lichen-d5]:bg-well"
      data-testid="similar-requests"
    >
      <p className="text-xs font-semibold text-slate-600 in-[.lichen-d5]:text-meta">Is this one of your open requests?</p>
      <ul className="mt-2 space-y-2">
        {items.map((item) => {
          const confirming = carryTarget?.id === item.id;
          return (
            <li
              key={item.id}
              data-testid={`similar-request-${item.id}`}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-900 in-[.lichen-d5]:text-ink">{item.issueTitle}</div>
                  <div className="text-xs text-slate-500 in-[.lichen-d5]:text-meta">{item.reason}</div>
                </div>
                {!confirming ? (
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 border-slate-200 in-[.lichen-d5]:border-border"
                      disabled={disabled}
                      onClick={() => onChoose(item)}
                      data-testid={`similar-same-${item.id}`}
                    >
                      Same issue
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 gap-1 text-slate-500 in-[.lichen-d5]:text-meta"
                      onClick={() => onDismiss(item.id)}
                      aria-label={`Different issue from ${item.issueTitle}`}
                      data-testid={`similar-dismiss-${item.id}`}
                    >
                      <X className="h-3.5 w-3.5" /> Different issue
                    </Button>
                  </div>
                ) : null}
              </div>
              {confirming ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2 in-[.lichen-d5]:border-hairline" data-testid={`similar-confirm-${item.id}`}>
                  <span className="min-w-0 flex-1 text-xs text-slate-600 in-[.lichen-d5]:text-meta">
                    Add what you&rsquo;ve written as an update to this request instead? You&rsquo;ll review it before it&rsquo;s saved.
                  </span>
                  <Button
                    size="sm"
                    className="h-8 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90"
                    onClick={() => onConfirm(item)}
                    data-testid={`similar-confirm-yes-${item.id}`}
                  >
                    Continue to that request
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => onChoose(null)}>
                    Keep this new request
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CategoryPicker({
  onSelect,
  onCancel,
  quota,
}: {
  onSelect: (id: string) => void;
  onCancel: () => void;
  quota: RequestQuota | null;
}) {
  const tenantPresentation = useTenantPresentation();
  return (
    <div className="flex min-h-[calc(100vh-7rem)] flex-col items-center justify-center gap-4">
      <RequestQuotaMeter quota={quota} className="w-full max-w-3xl" />
      <Card className="w-full max-w-3xl border border-slate-100 p-6 shadow-sm sm:p-8 in-[.lichen-d5]:border-hairline in-[.lichen-d5]:shadow-none">
        <div className="mb-6 flex items-start justify-between gap-4 in-[.lichen-d5]:flex-wrap">
          <div className="flex items-center gap-4 in-[.lichen-d5]:min-w-0 in-[.lichen-d5]:flex-1 in-[.lichen-d5]:basis-56 in-[.lichen-d5]:flex-wrap">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#137fec] to-[#a855f7] text-white shadow-lg shadow-[#137fec]/20 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:shadow-none in-[.lichen-d5]:bg-none in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-chip-icon">
              <Wrench className="h-6 w-6" />
            </div>
            <div className="in-[.lichen-d5]:min-w-0 in-[.lichen-d5]:flex-1 in-[.lichen-d5]:basis-40 in-[.lichen-d5]:[overflow-wrap:anywhere]">
              <h3 className="text-xl font-bold tracking-tight text-slate-900 in-[.lichen-d5]:text-ink">Select a category</h3>
              <p className="mt-0.5 text-sm text-slate-500 in-[.lichen-d5]:text-meta">Choose the type of issue you'd like to report.</p>
            </div>
          </div>
          <Button data-testid="cancel-category-btn" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {CATEGORY_LIST.map((c) => {
            const Icon = c.icon;
            return (
              <motion.button
                whileHover={tenantPresentation ? undefined : { y: -2 }}
                whileTap={tenantPresentation ? undefined : { scale: 0.98 }}
                key={c.id}
                data-testid={`category-${c.id.replace('/', '-')}-btn`}
                onClick={() => onSelect(c.id)}
                className="group flex items-center gap-3.5 rounded-xl border border-slate-200 bg-white p-4 text-left transition-all hover:border-[#137fec] hover:bg-sky-50/40 hover:shadow-md in-[.lichen-d5]:min-w-0 in-[.lichen-d5]:flex-wrap in-[.lichen-d5]:rounded-md in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card in-[.lichen-d5]:hover:border-control-border in-[.lichen-d5]:hover:bg-well in-[.lichen-d5]:hover:shadow-none"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#137fec]/10 transition-colors group-hover:bg-[#137fec]/15 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-chip-icon in-[.lichen-d5]:group-hover:bg-chip">
                  <Icon className="h-[22px] w-[22px] text-[#137fec] in-[.lichen-d5]:text-chip-icon" />
                </div>
                <div className="min-w-0 flex-1 in-[.lichen-d5]:basis-40 in-[.lichen-d5]:[overflow-wrap:anywhere]">
                  <div className="text-sm font-semibold text-slate-900 in-[.lichen-d5]:text-ink">{c.name}</div>
                  <div className="truncate text-xs text-slate-500 in-[.lichen-d5]:text-meta in-[.lichen-d5]:whitespace-normal">{CATEGORY_HINTS[c.id] || 'Report an issue'}</div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-[#137fec] in-[.lichen-d5]:text-meta in-[.lichen-d5]:group-hover:text-ink" />
              </motion.button>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

function ChatPanel({
  category,
  triageSource,
  messages,
  currentMessage,
  setCurrentMessage,
  onUseDemoExample,
  onSend,
  busy,
  readyForSubmit,
  submitting,
  onSubmit,
  onCancel,
  endRef,
  intakeGate,
  onOpenSafetyForm,
  similar,
  carryTarget,
  onChooseCarry,
  onConfirmCarry,
  onDismissSimilar,
  evidence,
  onEvidenceChange,
  closeCountdown,
  onStayInChat,
}: {
  category: string;
  triageSource?: string;
  messages: { role: 'ai' | 'user'; content: string }[];
  currentMessage: string;
  setCurrentMessage: (s: string) => void;
  onUseDemoExample: () => void;
  onSend: () => void;
  busy: boolean;
  readyForSubmit: boolean;
  submitting: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  endRef: React.RefObject<HTMLDivElement | null>;
  intakeGate: IntakeGate | null;
  onOpenSafetyForm: () => void;
  similar: SimilarRequest[];
  carryTarget: SimilarRequest | null;
  onChooseCarry: (item: SimilarRequest | null) => void;
  onConfirmCarry: (item: SimilarRequest) => void;
  onDismissSimilar: (id: string) => void;
  evidence: EvidenceAsset[];
  onEvidenceChange: (assets: EvidenceAsset[]) => void;
  closeCountdown: number | null;
  onStayInChat: () => void;
}) {
  const manager = usePropertyManagerContact();
  const tenantPresentation = useTenantPresentation();
  const closing = closeCountdown !== null;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Effects run after React enables the textarea. Preserve deliberate focus on
  // another control while a request is pending (e.g. evidence or cancel).
  useEffect(() => {
    if (busy || submitting || intakeGate || closing) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === document.body || active === inputRef.current ||
          active?.getAttribute('data-testid') === 'chat-send-btn') {
        inputRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, submitting, intakeGate, closing]);

  // Grow the composer with its content (wrapping/stacking lines) up to a cap,
  // then let it scroll — instead of the text running past the box horizontally.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [currentMessage]);

  const gateCopy = (() => {
    if (!intakeGate) return null;
    if (intakeGate.type === 'quota') {
      const whenLabel = intakeGate.nextAvailableAt ? formatNextAvailable(intakeGate.nextAvailableAt) : 'later';
      const q = intakeGate.quota;
      const weekly = q?.blockedBy === 'weekly';
      const usage = q
        ? weekly
          ? `You've sent ${q.weekly.used} of your ${q.weekly.limit} requests this week.`
          : `You've sent ${q.daily.used} of your ${q.daily.limit} requests today.`
        : '';
      return {
        title: weekly ? "You've reached your weekly request limit" : "You've reached your daily request limit",
        body: `${usage} You can send your next request at ${whenLabel}. If something is unsafe, report it as a safety concern — those aren't limited.`,
      };
    }
    return {
      title: 'You already have open requests',
      body: `You have ${intakeGate.openCount} open requests, which is the maximum of ${intakeGate.cap}. Please wait until one is resolved before opening another. If something is unsafe, report it as a safety concern — those aren't limited.`,
    };
  })();
  return (
    <Card className="flex h-[calc(100vh-4rem)] w-full flex-col overflow-hidden border border-slate-100 p-0 shadow-sm in-[.lichen-d5]:h-auto in-[.lichen-d5]:min-h-[32rem] in-[.lichen-d5]:border-border in-[.lichen-d5]:shadow-none">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 bg-white px-4 py-3 in-[.lichen-d5]:border-hairline in-[.lichen-d5]:bg-card in-[.lichen-d5]:flex-wrap">
        <div className="flex items-center gap-3 in-[.lichen-d5]:min-w-0 in-[.lichen-d5]:flex-wrap">
          <div className="relative shrink-0">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#137fec] to-[#a855f7] text-white shadow-md shadow-[#137fec]/20 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:shadow-none in-[.lichen-d5]:bg-none in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-chip-icon">
              <Sparkles className="h-5 w-5" />
            </div>
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-white in-[.lichen-d5]:hidden" />
          </div>
          <div>
            <h3 className="text-sm font-bold leading-tight text-slate-900 in-[.lichen-d5]:text-ink">Iris</h3>
            <p className="flex items-center gap-1.5 text-xs text-slate-500 in-[.lichen-d5]:text-meta in-[.lichen-d5]:flex-wrap">
              AI Triage
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-meta">
                {category}
              </span>
              <MetaTriageHackathonBadge source={triageSource} />
            </p>
          </div>
        </div>
        <Button data-testid="chat-cancel-btn" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <div className="flex shrink-0 items-start gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2 text-[11px] leading-relaxed text-slate-400 in-[.lichen-d5]:border-hairline in-[.lichen-d5]:bg-well in-[.lichen-d5]:text-meta">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Your property manager can view the original messages you send in this chat.</span>
      </div>
      {/* Always visible, not only after the safety gate fires: a tenant with
          water coming through the ceiling should not have to describe it to a
          chat before learning who to call. */}
      <div
        className="flex shrink-0 items-start gap-2 border-b border-rose-100 bg-rose-50/70 px-4 py-2 text-[11px] leading-relaxed text-rose-900 in-[.lichen-d5]:border-alert-line in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text"
        data-testid="chat-urgent-contact"
      >
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          In danger? Call 911 first. Can&rsquo;t wait for a reply? Call your property manager
          {manager?.phone ? (
            <>
              {manager.name ? `, ${manager.name},` : ''} at{' '}
              <a href={`tel:${manager.phone.replace(/[^\d+]/g, '')}`} className="font-semibold underline underline-offset-2">
                {manager.phone}
              </a>
            </>
          ) : null}
          .
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-slate-50/40 px-4 py-5 in-[.lichen-d5]:bg-well in-[.lichen-d5]:[overflow-wrap:anywhere]" data-testid="chat-messages" role={tenantPresentation ? 'log' : undefined} aria-live={tenantPresentation ? 'polite' : undefined} aria-relevant={tenantPresentation ? 'additions text' : undefined}>
        {messages.map((m, i) =>
          m.role === 'ai' ? (
            <div key={i} className="flex items-end gap-2">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#137fec] to-[#a855f7] text-white shadow-sm in-[.lichen-d5]:shadow-none in-[.lichen-d5]:bg-none in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-chip-icon">
                <Sparkles className="h-3.5 w-3.5" />
              </div>
              <div className="max-w-[82%] whitespace-pre-line rounded-2xl rounded-bl-md bg-white px-3.5 py-2.5 text-sm text-slate-900 shadow-sm ring-1 ring-slate-100 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-card in-[.lichen-d5]:text-ink in-[.lichen-d5]:shadow-none">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} className="flex justify-end">
              <div className="max-w-[82%] whitespace-pre-line rounded-2xl rounded-br-md bg-[#137fec] px-3.5 py-2.5 text-sm text-white shadow-sm shadow-[#137fec]/20 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-ink in-[.lichen-d5]:shadow-none">
                {m.content}
              </div>
            </div>
          )
        )}
        {busy && (
          <div className="flex items-end gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#137fec] to-[#a855f7] text-white shadow-sm in-[.lichen-d5]:shadow-none in-[.lichen-d5]:bg-none in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-chip-icon">
              <Sparkles className="h-3.5 w-3.5" />
            </div>
            <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-white px-3.5 py-3 shadow-sm ring-1 ring-slate-100 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-card in-[.lichen-d5]:shadow-none">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {gateCopy && (
        <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-5 py-4 in-[.lichen-d5]:border-lichen-line in-[.lichen-d5]:bg-lichen-tint" data-testid="intake-gate">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-amber-900 in-[.lichen-d5]:text-lichen-text">
            <ShieldAlert className="h-4 w-4 shrink-0" /> {gateCopy.title}
          </div>
          <p className="mt-1 text-sm text-amber-800 in-[.lichen-d5]:text-lichen-text">{gateCopy.body}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              data-testid="intake-gate-proceed"
              size="sm"
              variant="outline"
              className="border-amber-300 bg-white text-amber-900 hover:bg-amber-100 in-[.lichen-d5]:bg-card in-[.lichen-d5]:border-control-border in-[.lichen-d5]:text-lichen-text"
              disabled={busy}
              onClick={onOpenSafetyForm}
            >
              Report a safety concern
            </Button>
            <Button size="sm" variant="ghost" className="text-slate-600 in-[.lichen-d5]:text-meta" onClick={onCancel}>
              Not now
            </Button>
          </div>
        </div>
      )}
      {!closing && !intakeGate ? (
        <SimilarRequests
          items={similar}
          carryTarget={carryTarget}
          disabled={busy || submitting}
          onChoose={onChooseCarry}
          onConfirm={onConfirmCarry}
          onDismiss={onDismissSimilar}
        />
      ) : null}
      {closing && (
        <div
          className="shrink-0 border-t border-emerald-200 bg-emerald-50 px-5 py-4 in-[.lichen-d5]:border-mist-line in-[.lichen-d5]:bg-mist-tint"
          data-testid="resolved-close"
        >
          <div className="flex items-center gap-1.5 text-sm font-semibold text-emerald-800 in-[.lichen-d5]:text-mist-text">
            <CheckCircle className="h-4 w-4 shrink-0" /> Issue resolved
          </div>
          <p className="mt-1 text-sm text-emerald-700 in-[.lichen-d5]:text-mist-text">
            Closing this chat in {closeCountdown}s and taking you back to your requests.
          </p>
          <div className="mt-3">
            <Button
              data-testid="resolved-stay-btn"
              size="sm"
              variant="outline"
              className="border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100 in-[.lichen-d5]:bg-card in-[.lichen-d5]:border-control-border in-[.lichen-d5]:text-mist-text"
              onClick={onStayInChat}
            >
              Stay in chat
            </Button>
          </div>
        </div>
      )}
      {!closing && !intakeGate && messages.filter((m) => m.role === 'user').length === 0 && (
        <div
          className="flex shrink-0 items-center gap-1.5 border-t border-slate-100 bg-white px-4 py-2 text-[11px] text-slate-400 in-[.lichen-d5]:border-hairline in-[.lichen-d5]:bg-card in-[.lichen-d5]:text-meta"
          data-testid="evidence-hint"
        >
          <Camera className="h-3.5 w-3.5 shrink-0" />
          Describe your issue first — Iris will then suggest photos that help diagnose it.
        </div>
      )}
      {!closing && !intakeGate && messages.filter((m) => m.role === 'user').length > 0 && (
        <div className="shrink-0 border-t border-slate-100 bg-white px-4 py-2 in-[.lichen-d5]:border-hairline in-[.lichen-d5]:bg-card" data-testid="evidence-panel">
          <EvidenceCapture
            category={category}
            assets={evidence}
            onChange={onEvidenceChange}
            disabled={submitting}
          />
        </div>
      )}
      <div className="shrink-0 border-t border-slate-100 bg-white px-4 pb-3 pt-2 in-[.lichen-d5]:border-hairline in-[.lichen-d5]:bg-card">
        <JudgeDemoExample value={currentMessage} onUse={onUseDemoExample} disabled={busy || submitting || Boolean(intakeGate) || closing} />
        <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm transition focus-within:border-[#137fec] focus-within:ring-2 focus-within:ring-[#137fec]/15 in-[.lichen-d5]:flex-wrap in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card in-[.lichen-d5]:shadow-none in-[.lichen-d5]:focus-within:border-control-border in-[.lichen-d5]:focus-within:ring-0">
          <textarea
            ref={inputRef}
            data-testid="chat-input"
            aria-label={tenantPresentation ? 'Message to Iris' : undefined}
            value={currentMessage}
            onChange={(e) => setCurrentMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder={
              intakeGate
                ? 'Choose an option above to continue...'
                : readyForSubmit
                ? 'Add any final details (optional)...'
                : 'Describe the issue...'
            }
            rows={1}
            disabled={busy || submitting || Boolean(intakeGate) || closing}
            className={`max-h-40 flex-1 resize-none self-center bg-transparent px-2.5 py-2 text-sm leading-relaxed text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:opacity-60 in-[.lichen-d5]:min-w-0 in-[.lichen-d5]:basis-56 ${TENANT_FIELD}`}
          />
          <Button
            data-testid="chat-send-btn"
            aria-label={tenantPresentation ? 'Send message' : undefined}
            onClick={onSend}
            disabled={busy || submitting || Boolean(intakeGate) || closing || !currentMessage.trim()}
            className="h-9 w-9 shrink-0 rounded-xl bg-[#137fec] p-0 hover:bg-[#137fec]/90 in-[.lichen-d5]:ml-auto in-[.lichen-d5]:rounded-md in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 in-[.lichen-d5]:flex-wrap">
          <span className="text-xs text-slate-400 in-[.lichen-d5]:text-meta" aria-live="polite">
            {readyForSubmit && currentMessage.trim()
              ? 'Send your final details before submitting.'
              : readyForSubmit
              ? 'Ready to submit — add optional details or send it over.'
              : 'Press Enter to send · Shift + Enter for a new line'}
          </span>
          <Button
            data-testid="chat-submit-btn"
            onClick={onSubmit}
            disabled={busy || submitting || closing || Boolean(intakeGate) || Boolean(currentMessage.trim()) || !readyForSubmit || messages.filter((m) => m.role === 'user').length === 0}
            className={`shrink-0 gap-2 ${
              readyForSubmit ? "bg-[#137fec] hover:bg-[#1171d2] in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90" : "bg-slate-300 text-slate-500 hover:bg-slate-300 in-[.lichen-d5]:text-meta"
            }`}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Submit Request
          </Button>
        </div>
      </div>
    </Card>
  );
}

