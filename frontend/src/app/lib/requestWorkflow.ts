import { ApiError, type RequestQuota } from '../api/client';
import type {
  CreationBlockReason,
  IntakeAnswerState,
  IntakeFollowUp,
  IntakeFollowUpQuestion,
  OutreachSummary,
  SafetyAssessment,
  TenantSafetyAssessment,
  SimilarRequest,
  WorkflowConflictCode,
} from '../types/requestWorkflow';

/** A client id the server uses to make a submission idempotent. Generated once
 *  per attempt and reused on retry, so a double tap can't file twice. */
export function newSubmissionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Old Safari: still RFC 4122 shaped, still unique enough for one tenant.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * The submission id for one piece of content. A retry of the same content
 * reuses the id, so the server replays a send that did land; editing the
 * content after a failed attempt makes it a different submission with a new
 * id, which the server would otherwise reject as `idempotency_conflict`.
 * `reset()` after a success (or a conflict) starts the next submission fresh.
 */
export function createSubmissionKey(seed?: { id: string; payload: unknown }) {
  let id = seed?.id || newSubmissionId();
  let content: string | null = seed ? JSON.stringify(seed.payload) : null;
  return {
    idFor(payload: unknown) {
      const next = JSON.stringify(payload);
      if (content !== null && content !== next) id = newSubmissionId();
      content = next;
      return id;
    },
    reset() {
      id = newSubmissionId();
      content = null;
    },
  };
}

// ------- Creation eligibility -------

export type CreationGate =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'allowed' }
  | { status: 'blocked'; reasons: CreationBlockReason[]; message: string };

const formatWhen = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: 'numeric',
    minute: '2-digit',
  });
};

/**
 * Whether the normal New Request flow may open. Only a loaded, server-decided
 * `allowed: true` opens it: a failed load, or an older server that sends no
 * eligibility, keeps the button grey rather than guessing in the tenant's
 * favour and failing at the end of a conversation.
 */
export function creationGate(
  quota: RequestQuota | null,
  loadState: 'loading' | 'error' | 'ready'
): CreationGate {
  if (loadState === 'loading') return { status: 'loading' };
  if (loadState === 'error' || !quota?.creationEligibility) return { status: 'error' };
  const eligibility = quota.creationEligibility;
  if (eligibility.allowed) return { status: 'allowed' };
  return { status: 'blocked', reasons: eligibility.reasons, message: blockedMessage(eligibility) };
}

function blockedMessage(eligibility: NonNullable<RequestQuota['creationEligibility']>) {
  const reasons = new Set(eligibility.reasons);
  const when = eligibility.nextAvailableAt ? formatWhen(eligibility.nextAvailableAt) : null;
  if (reasons.has('unit_unlinked')) return 'Your account isn’t linked to a unit, so new requests are paused.';
  if (reasons.has('open_cap')) {
    return `You have ${eligibility.openCount} open requests, the most your unit allows at once (${eligibility.openCap}). You can start a new one when one closes.`;
  }
  const window = reasons.has('weekly_limit') ? 'weekly' : 'daily';
  return when
    ? `You’ve reached your ${window} request limit. You can start a new request at ${when}.`
    : `You’ve reached your ${window} request limit.`;
}

// ------- Model acknowledgement -------

/**
 * Remove a model-written acknowledgement from the chat reply. The contract
 * drops the field; an older server still prepends it to the message, so strip
 * that leading paragraph when the triage still carries it.
 */
export function stripAcknowledgment(message: string | undefined, acknowledgment?: string | null) {
  const text = String(message || '');
  const ack = String(acknowledgment || '').trim();
  if (!ack) return text.trim();
  const trimmed = text.trim();
  if (!trimmed.startsWith(ack)) return trimmed;
  return trimmed.slice(ack.length).replace(/^\s+/, '');
}

// ------- Similar requests -------

/** Max suggestions shown at once (the server sends at most three too). */
export const SIMILAR_LIMIT = 3;

/**
 * Fold the latest similarity suggestions into what the tenant sees. Each
 * triage turn may refine them; a candidate the tenant dismissed as a
 * different issue stays gone for the rest of this intake.
 */
export function mergeSimilarRequests(
  incoming: SimilarRequest[] | undefined | null,
  dismissed: ReadonlySet<string>
): SimilarRequest[] {
  const seen = new Set<string>();
  const out: SimilarRequest[] = [];
  for (const item of incoming || []) {
    if (!item?.id || dismissed.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= SIMILAR_LIMIT) break;
  }
  return out;
}

/** sessionStorage key for a draft carried to an existing request. Scoped by
 *  tenant and request so it can never surface on someone else's request. */
export const carryoverKey = (userId: string, requestId: string) => `artrelo:carryover:${userId}:${requestId}`;

export type CarriedDraft = { body: string; submissionId: string; savedAt: string };

export function readCarriedDraft(userId: string | undefined, requestId: string | undefined): CarriedDraft | null {
  if (!userId || !requestId) return null;
  try {
    const raw = sessionStorage.getItem(carryoverKey(userId, requestId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CarriedDraft;
    return parsed && typeof parsed.body === 'string' && parsed.body.trim() ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCarriedDraft(userId: string, requestId: string, body: string) {
  const draft: CarriedDraft = { body, submissionId: newSubmissionId(), savedAt: new Date().toISOString() };
  try {
    sessionStorage.setItem(carryoverKey(userId, requestId), JSON.stringify(draft));
  } catch {
    // Storage blocked: the draft still travels in navigation state.
  }
  return draft;
}

export function clearCarriedDraft(userId: string | undefined, requestId: string | undefined) {
  if (!userId || !requestId) return;
  try {
    sessionStorage.removeItem(carryoverKey(userId, requestId));
  } catch {
    // Nothing to clear.
  }
}

// ------- Intake follow-up -------

export type IntakeDraftAnswer = { state: IntakeAnswerState | null; value: string };
export type IntakeDraft = Record<string, IntakeDraftAnswer>;

const isKnown = (q: IntakeFollowUpQuestion) => q.state === 'answered' && Boolean(q.value?.trim());

/**
 * The questions Send details must cover. A known fact is never asked again;
 * one intake already left as unknown/declined is still asked, prefilled with
 * that choice, because the server takes one response per outstanding topic.
 */
export const outstandingQuestions = (followUp: IntakeFollowUp | null | undefined): IntakeFollowUpQuestion[] =>
  followUp?.state === 'awaiting_answers' ? followUp.questions.filter((q) => !isKnown(q)) : [];

/** Facts the tenant left as unknown/declined, which they may still supply
 *  voluntarily until a vendor is contacted (the server refuses after that). */
export const revisableQuestions = (followUp: IntakeFollowUp | null | undefined): IntakeFollowUpQuestion[] =>
  followUp ? followUp.questions.filter((q) => q.state === 'unknown' || q.state === 'declined') : [];

export function emptyIntakeDraft(questions: IntakeFollowUpQuestion[]): IntakeDraft {
  return Object.fromEntries(
    questions.map((q) => [
      q.topicId,
      { state: q.state === 'unknown' || q.state === 'declined' ? q.state : null, value: '' },
    ])
  );
}

/** Topic ids that still need a response before Send details enables. */
export function incompleteTopics(questions: IntakeFollowUpQuestion[], draft: IntakeDraft): string[] {
  return questions
    .filter((q) => {
      const answer = draft[q.topicId];
      if (!answer?.state) return true;
      return answer.state === 'answered' && !answer.value.trim();
    })
    .map((q) => q.topicId);
}

export function intakeAnswersPayload(questions: IntakeFollowUpQuestion[], draft: IntakeDraft) {
  return questions.map((q) => {
    const answer = draft[q.topicId];
    const state = (answer?.state || 'unknown') as IntakeAnswerState;
    return state === 'answered'
      ? { topicId: q.topicId, state, value: answer.value.trim() }
      : { topicId: q.topicId, state };
  });
}

/** The optimistic view right after Send details: answers shown as given and
 *  the form replaced by the "waiting for review" state. */
export function applyIntakeOptimistically(
  followUp: IntakeFollowUp,
  answers: ReturnType<typeof intakeAnswersPayload>
): IntakeFollowUp {
  const byTopic = new Map(answers.map((a) => [a.topicId, a]));
  return {
    ...followUp,
    revision: followUp.revision + 1,
    state: 'ready_for_review',
    submittedAt: new Date().toISOString(),
    questions: followUp.questions.map((q) => {
      const a = byTopic.get(q.topicId);
      return a ? { ...q, state: a.state, value: 'value' in a ? a.value || '' : '' } : q;
    }),
    answers: answers.map((a) => ({ topicId: a.topicId, state: a.state, value: 'value' in a ? a.value || '' : '' })),
    remainingTopics: answers.filter((a) => a.state !== 'answered').map((a) => a.topicId),
  };
}

export const ANSWER_STATE_LABEL: Record<IntakeAnswerState, string> = {
  answered: 'Answered',
  unknown: 'Not sure',
  declined: 'Can’t safely check / prefer not to say',
};

export const TOPIC_LABEL: Record<string, string> = {
  location: 'Where in the unit',
  timeline: 'When it started',
  impact: 'How it affects you',
  safety: 'Safety',
};

/** The 409 code on a workflow write, and the latest record the server sent. */
export function workflowConflict<T = unknown>(error: unknown): { code: WorkflowConflictCode; latest: T | null } | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const payload = error.payload as { code?: string; data?: T } | undefined;
  const code = payload?.code as WorkflowConflictCode | undefined;
  if (code !== 'stale_revision' && code !== 'request_not_editable' && code !== 'idempotency_conflict') return null;
  return { code, latest: payload?.data ?? null };
}

// ------- Safety -------

export const TENANT_SAFETY_REVIEW_LABEL = 'Urgent safety concern — awaiting review';
export const TENANT_SAFETY_REVIEWED_LABEL = 'Urgent safety concern — reviewed by your property manager';

/** The tenant-facing safety label: pending until a person has assessed it,
 *  then reviewed (a concern kept urgent stays needs_review after review). */
export function tenantSafetyLabel(safety: TenantSafetyAssessment | null | undefined): string | null {
  if (safety?.state !== 'needs_review') return null;
  return safety.reviewedAt ? TENANT_SAFETY_REVIEWED_LABEL : TENANT_SAFETY_REVIEW_LABEL;
}

/** A concern is pending until a person records an assessment. "Keep as
 *  urgent" leaves the state flagged but stamps reviewedAt, so the state alone
 *  can't say whether the form is still owed. */
export const safetyPendingReview = (safety: SafetyAssessment | TenantSafetyAssessment | null | undefined) =>
  Boolean(safety && (safety.state === 'needs_review' || safety.state === 'confirmed_hazard') && !safety.reviewedAt);


// ------- Outreach visibility -------

export type OutreachLine = { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; testState: string };

const INITIATION_PREFIX: Record<OutreachSummary['initiation'], string> = {
  policy_auto_start: 'Auto',
  policy_auto_advance: 'Auto (next vendor)',
  landlord: 'Manual',
  unknown: '',
};

/** Outcomes that end an attempt without the vendor replying. */
const CLOSED_OUTCOMES = new Set(['expired', 'revoked', 'superseded']);

/**
 * The state the summary actually describes. Older servers file expiry,
 * revocation and supersession under `responded`; none of them is a reply.
 */
export function outreachState(summary: OutreachSummary): OutreachSummary['state'] {
  if (summary.state === 'responded' && CLOSED_OUTCOMES.has(summary.responseStatus || '')) return 'closed';
  return summary.state;
}

/**
 * One quiet line for a row, card or timeline: who started it, which vendor,
 * and only what the persisted outreach result establishes. "Sent" is the
 * provider accepting the email, never the vendor reading it. Only an
 * acceptance reads as success.
 */
export function outreachLine(summary: OutreachSummary | null | undefined, now: Date = new Date()): OutreachLine | null {
  if (!summary) return null;
  const who = INITIATION_PREFIX[summary.initiation] ?? '';
  const vendor = summary.vendorName || 'vendor';
  const withWho = (text: string) => (who ? `${who}: ${text}` : text.charAt(0).toUpperCase() + text.slice(1));
  const at = (iso: string | null) => (iso ? formatWhen(iso) : null);
  switch (outreachState(summary)) {
    case 'preparing':
      return { label: withWho(`preparing outreach to ${vendor}`), tone: 'neutral', testState: 'preparing' };
    case 'scheduled': {
      const when = at(summary.scheduledFor);
      const future = summary.scheduledFor ? new Date(summary.scheduledFor).getTime() > now.getTime() : false;
      return {
        label: withWho(`outreach to ${vendor} scheduled${when ? ` for ${when}` : ''}${future ? '' : ' (not yet confirmed sent)'}`),
        tone: 'info',
        testState: 'scheduled',
      };
    }
    case 'sent': {
      const when = at(summary.sentAt);
      return {
        label: withWho(`email to ${vendor} sent${when ? ` ${when}` : ''} · awaiting reply`),
        tone: 'info',
        testState: 'sent',
      };
    }
    case 'failed':
      return { label: withWho(`outreach to ${vendor} failed to send`), tone: 'danger', testState: 'failed' };
    case 'unconfirmed':
      return {
        label: withWho(`outreach to ${vendor} unconfirmed — delivery not verified`),
        tone: 'warning',
        testState: 'unconfirmed',
      };
    case 'responded':
      if (summary.responseStatus === 'accepted') {
        return { label: withWho(`${vendor} accepted`), tone: 'success', testState: 'accepted' };
      }
      if (summary.responseStatus === 'declined') {
        return { label: withWho(`${vendor} declined`), tone: 'warning', testState: 'declined' };
      }
      return {
        label: withWho(`${vendor} responded${summary.responseStatus ? ` (${summary.responseStatus})` : ''}`),
        tone: 'info',
        testState: 'responded',
      };
    case 'closed':
      if (summary.responseStatus === 'expired') {
        return { label: withWho(`outreach to ${vendor} expired — no reply`), tone: 'neutral', testState: 'expired' };
      }
      return {
        label: withWho(
          `outreach to ${vendor} closed${
            summary.responseStatus === 'superseded'
              ? ' — replaced by a newer attempt'
              : summary.responseStatus === 'revoked'
                ? ' — withdrawn'
                : ''
          }`
        ),
        tone: 'neutral',
        testState: 'closed',
      };
    default:
      return null;
  }
}

/** Requests whose lifecycle is over. The outreach line describes the latest
 *  attempt on a live request, so it is hidden on these; the activity keeps it. */
const TERMINAL_REQUEST_STATUSES = new Set(['completed', 'rejected', 'cancelled', 'archived']);

export const isTerminalRequest = (request: {
  status?: string | null;
  lifecycleStatus?: string | null;
  archivedAt?: string | null;
}) =>
  Boolean(request.archivedAt) ||
  TERMINAL_REQUEST_STATUSES.has(request.status || '') ||
  TERMINAL_REQUEST_STATUSES.has(request.lifecycleStatus || '');

/** Manual outreach and legacy outreach with unknown provenance read neutral. */
export const isAutomaticOutreach = (summary: OutreachSummary | null | undefined) =>
  summary?.initiation === 'policy_auto_start' || summary?.initiation === 'policy_auto_advance';

// Values are DETAIL_STATUS_COLORS keys, keyed by OutreachLine.testState.
const OUTREACH_COLOR: Record<string, string> = {
  preparing: 'queued',
  scheduled: 'outreach_scheduled',
  sent: 'contacting_vendor',
  failed: 'rejected',
  unconfirmed: 'needs_approval',
  accepted: 'completed',
  declined: 'rejected',
  responded: 'contacting_vendor',
  expired: 'cancelled',
  closed: 'cancelled',
};

// ------- Activity order -------

/** Epoch ms of a recorded time, or null when missing or unparseable. Keeps
 *  millisecond precision. */
export function activityTime(at: string | null | undefined): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

const isRecorded = (at: string | null | undefined): at is string => activityTime(at) !== null;

/**
 * When the summarised outreach event was recorded. Prefers the server's
 * eventAt; an older envelope falls back to the field that state records.
 * Never scheduledFor (a planned delivery, possibly in the future) and never
 * the current time: with nothing recorded the answer is null. A closed
 * attempt is dated by updatedAt only: a legacy row closed later can still
 * carry an older respondedAt that does not describe the closure.
 */
export function outreachEventAt(summary: OutreachSummary): string | null {
  if (isRecorded(summary.eventAt)) return summary.eventAt;
  const state = outreachState(summary);
  const candidates =
    state === 'sent'
      ? [summary.sentAt, summary.updatedAt]
      : state === 'responded'
        ? [summary.respondedAt, summary.updatedAt]
        : [summary.updatedAt];
  return candidates.find(isRecorded) ?? null;
}

/**
 * Newest first by recorded time. Equal times keep their input order (the sort
 * is stable), so feed sources newest-first for ties to read naturally; missing
 * or invalid times go last, still in input order.
 */
export function sortActivityNewestFirst<T extends { at: string | null | undefined }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index, time: activityTime(item.at) }))
    .sort((a, b) => {
      if (a.time === null || b.time === null) {
        if (a.time !== b.time) return a.time === null ? 1 : -1;
      } else if (a.time !== b.time) {
        return b.time - a.time;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

/**
 * Merge the outreach summary into the activity as one more entry, then order
 * the whole list by recorded time, so an old decline sits below the payment
 * and completion that followed it. Adds no entry when there is no outreach.
 */
export function withOutreachActivity<T extends { id: string; at: string }>(
  items: T[],
  summary: OutreachSummary | null | undefined
): (T | { id: string; source: 'audit'; title: string; description?: string; at: string; colorKey?: string })[] {
  const line = outreachLine(summary);
  if (!line || !summary) return sortActivityNewestFirst(items);
  return sortActivityNewestFirst([
    ...items,
    {
      id: `outreach-summary-${summary.outreachId}`,
      source: 'audit' as const,
      title: 'Vendor outreach',
      description: line.label,
      at: outreachEventAt(summary) ?? '',
      colorKey: OUTREACH_COLOR[line.testState],
    },
  ]);
}
