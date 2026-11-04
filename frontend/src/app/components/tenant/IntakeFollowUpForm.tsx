import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ListChecks, Loader2 } from 'lucide-react';
import { TenantAPI } from '../../api/client';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { fieldClass } from '../landlord/landlordUi';
import { TENANT_FIELD, useTenantPresentation } from './tenantPresentation';
import {
  ANSWER_STATE_LABEL,
  applyIntakeOptimistically,
  emptyIntakeDraft,
  incompleteTopics,
  intakeAnswersPayload,
  outstandingQuestions,
  revisableQuestions,
  workflowConflict,
  type IntakeDraft,
} from '../../lib/requestWorkflow';
import type { IntakeAnswerState, IntakeFollowUp } from '../../types/requestWorkflow';
import type { RequestDetailRecord } from '../request-detail/requestDetailTypes';
import { useSubmissionKey } from '../../hooks/useSubmissionKey';

const CHOICES: { state: IntakeAnswerState; label: string }[] = [
  { state: 'answered', label: 'I can answer' },
  { state: 'unknown', label: 'I don’t know' },
  { state: 'declined', label: 'Can’t safely check / prefer not to say' },
];

/**
 * "Add missing details": the essential questions intake couldn't settle, asked
 * once. "I don't know" and "Can't safely check / prefer not to say" are
 * complete answers. Nothing is saved until Send details, which spends no
 * request quota and leaves the request waiting for the property manager's
 * review.
 */
export default function IntakeFollowUpForm({
  request,
  onRequestReplaced,
}: {
  request: RequestDetailRecord;
  onRequestReplaced: (next: RequestDetailRecord) => void;
}) {
  const followUp = request.intakeFollowUp ?? null;
  const [optimistic, setOptimistic] = useState<IntakeFollowUp | null>(null);
  const shown = optimistic ?? followUp;
  // Revising: the tenant chose to supply a fact they had left unknown/declined.
  const [revising, setRevising] = useState(false);
  const questions = useMemo(
    () => (revising ? revisableQuestions(followUp) : outstandingQuestions(followUp)),
    [followUp, revising]
  );
  const [draft, setDraft] = useState<IntakeDraft>(() => emptyIntakeDraft(questions));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const submissionKey = useSubmissionKey();
  const tenantPresentation = useTenantPresentation();
  const sentPanel = useRef<HTMLDivElement>(null);
  const formPanel = useRef<HTMLDivElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  const focusIntent = useRef(false);
  const sentHeadingId = useId();
  // Optimistic status replaces the form. Keep an intentional keyboard action
  // with its status, or return to the retry control when the form comes back.
  // No initial/background update or deliberate outside focus is redirected.
  useEffect(() => {
    if (!tenantPresentation || !focusIntent.current) return;
    const frame = requestAnimationFrame(() => {
      if ([document.body, document.documentElement].includes(document.activeElement as HTMLElement)) {
        const destination = sentPanel.current ||
          (revising && !error ? formPanel.current?.querySelector<HTMLElement>('input') : sendButton.current);
        destination?.focus();
      }
      if (!sending) focusIntent.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [tenantPresentation, sending, optimistic, shown?.state, error, revising]);

  // A new revision from the server (another tab, a stale-revision reply) asks
  // a possibly different set of questions: keep answers to ones still asked.
  const questionKey = questions.map((q) => q.topicId).join('|');
  useEffect(() => {
    setDraft((current) => {
      const next = emptyIntakeDraft(questions);
      for (const q of questions) if (current[q.topicId]) next[q.topicId] = current[q.topicId];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionKey, followUp?.revision, revising]);

  if (!shown) return null;

  const sent = !revising && (Boolean(optimistic) || shown.state !== 'awaiting_answers');
  if (!sent && !questions.length) return null;
  if (sent) {
    const answered = shown.questions.filter((q) => q.state !== 'missing');
    const canRevise = !optimistic && revisableQuestions(shown).length > 0;
    return (
      <Card ref={sentPanel} tabIndex={tenantPresentation ? -1 : undefined} role={tenantPresentation ? 'status' : undefined} aria-labelledby={tenantPresentation ? sentHeadingId : undefined} className="gap-3 border border-slate-100 p-5 shadow-sm in-[.lichen-d5]:border-hairline in-[.lichen-d5]:shadow-none" data-testid="intake-followup-sent" data-state={shown.state}>
        <div id={tenantPresentation ? sentHeadingId : undefined} className="flex items-center gap-2 text-sm font-semibold text-slate-900 in-[.lichen-d5]:text-ink">
          <CheckCircle2 className="h-4 w-4 text-emerald-600 in-[.lichen-d5]:text-mist-text" aria-hidden="true" />
          {shown.state === 'reviewed'
            ? 'Your property manager reviewed your details'
            : shown.submittedAt || optimistic
              ? 'Details sent'
              : 'Details from your report'}
        </div>
        {shown.state !== 'reviewed' ? (
          <p className="text-sm text-slate-600 in-[.lichen-d5]:text-meta">
            Your property manager will review them before anything else happens on this request.
          </p>
        ) : null}
        {answered.length ? (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {answered.map((q) => (
              <div key={q.topicId} className="rounded-lg bg-slate-50 px-3 py-2 in-[.lichen-d5]:bg-well">
                <dt className="text-xs text-slate-500 in-[.lichen-d5]:text-meta">{q.question}</dt>
                <dd className="text-slate-800 in-[.lichen-d5]:text-ink">
                  {q.state === 'answered' ? q.value : <span className="italic text-slate-500 in-[.lichen-d5]:text-meta">{ANSWER_STATE_LABEL[q.state as IntakeAnswerState]}</span>}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {canRevise ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500 in-[.lichen-d5]:text-meta">Found out something you didn&rsquo;t know? You can still add it.</p>
            <Button
              variant="outline"
              size="sm"
              className="border-slate-200 in-[.lichen-d5]:border-border"
              onClick={() => {
                setError(null);
                setShowMissing(false);
                setRevising(true);
              }}
              data-testid="intake-followup-revise"
              onClickCapture={tenantPresentation ? () => { focusIntent.current = true; } : undefined}
            >
              Update an answer
            </Button>
          </div>
        ) : null}
      </Card>
    );
  }

  const missing = incompleteTopics(questions, draft);

  const choose = (topicId: string, state: IntakeAnswerState) =>
    setDraft((current) => ({ ...current, [topicId]: { ...current[topicId], state } }));
  const type = (topicId: string, value: string) =>
    setDraft((current) => ({ ...current, [topicId]: { state: 'answered', value } }));

  const send = async () => {
    if (sending || !followUp) return;
    if (missing.length) {
      setShowMissing(true);
      return;
    }
    const answers = intakeAnswersPayload(questions, draft);
    setSending(true);
    setError(null);
    setOptimistic(applyIntakeOptimistically(followUp, answers));
    try {
      const body = { revision: followUp.revision, answers };
      const res = await TenantAPI.submitIntakeDetails(request._id, { ...body, submissionId: submissionKey.idFor(body) });
      submissionKey.reset();
      setOptimistic(null);
      setRevising(false);
      if (res.data) onRequestReplaced(res.data as RequestDetailRecord);
    } catch (e) {
      setOptimistic(null);
      const conflict = workflowConflict<RequestDetailRecord>(e);
      if (conflict?.code === 'stale_revision') {
        // Answers to questions still asked survive the swap (effect above).
        if (conflict.latest) onRequestReplaced(conflict.latest);
        setError('This request changed while you were answering. Check the questions below and send again.');
      } else if (conflict?.code === 'request_not_editable') {
        if (conflict.latest) onRequestReplaced(conflict.latest);
        setError('This request can no longer take new details.');
      } else if (conflict?.code === 'idempotency_conflict') {
        submissionKey.reset();
        setError('Those details didn’t match an earlier send. Please send again.');
      } else {
        // An unchanged retry reuses the id, so a send that did land replays;
        // editing an answer first makes it a new submission (useSubmissionKey).
        setError(`${e instanceof Error ? e.message : 'Your details were not sent.'} Your answers are still here.`);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Card ref={formPanel} className="gap-4 border border-sky-100 p-5 shadow-sm in-[.lichen-d5]:border-border in-[.lichen-d5]:shadow-none" data-testid="intake-followup-form">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-700 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-lichen-text">
          <ListChecks className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <h2 className="text-base font-semibold text-slate-900 in-[.lichen-d5]:text-ink">{revising ? 'Update your answers' : 'Add missing details'}</h2>
          {revising ? (
            <p className="text-sm text-slate-600 in-[.lichen-d5]:text-meta">
              Change any answer you now know. Your property manager reviews the update before anything else happens.
            </p>
          ) : (
            <p className="text-sm text-slate-600 in-[.lichen-d5]:text-meta">
              {questions.length === 1 ? 'One question' : `${questions.length} questions`} your property manager needs. It&rsquo;s
              fine to say you don&rsquo;t know. This doesn&rsquo;t count as a new request.
            </p>
          )}
        </div>
      </div>

      {questions.map((q, index) => {
        const answer = draft[q.topicId] || { state: null, value: '' };
        const invalid = showMissing && missing.includes(q.topicId);
        const name = `intake-${q.topicId}`;
        return (
          <fieldset
            key={q.topicId}
            className={`rounded-xl border px-4 py-3 in-[.lichen-d5]:rounded-lg ${invalid ? "border-rose-300 in-[.lichen-d5]:border-alert-text" : "border-slate-200 in-[.lichen-d5]:border-border"}`}
            data-testid={`intake-question-${q.topicId}`}
            aria-describedby={invalid ? `${name}-error` : undefined}
          >
            <legend className="px-1 text-sm font-medium text-slate-900 in-[.lichen-d5]:text-ink">
              {index + 1}. {q.question}
            </legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-2" role="radiogroup" aria-label={q.question}>
              {CHOICES.map((choice) => (
                <label key={choice.state} className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700 in-[.lichen-d5]:text-ink">
                  <input
                    type="radio"
                    name={name}
                    value={choice.state}
                    checked={answer.state === choice.state}
                    onChange={() => choose(q.topicId, choice.state)}
                    data-testid={`intake-${q.topicId}-${choice.state}`}
                    className="h-4 w-4 accent-[#137fec] in-[.lichen-d5]:accent-lichen-text"
                  />
                  {choice.label}
                </label>
              ))}
            </div>
            {answer.state === 'answered' ? (
              <textarea
                aria-label={`Your answer: ${q.question}`}
                data-testid={`intake-${q.topicId}-value`}
                value={answer.value}
                rows={2}
                maxLength={1000}
                onChange={(e) => type(q.topicId, e.target.value)}
                className={`${fieldClass} ${TENANT_FIELD} mt-2 h-auto py-2`}
              />
            ) : null}
            {invalid ? (
              <p id={`${name}-error`} role="alert" className="mt-1 text-xs text-rose-600 in-[.lichen-d5]:text-alert-text">
                {answer.state === 'answered' ? 'Type your answer, or choose another option.' : 'Choose an option.'}
              </p>
            ) : null}
          </fieldset>
        );
      })}

      {error ? (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-lichen-text" data-testid="intake-followup-error">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-xs text-slate-500 in-[.lichen-d5]:text-meta" aria-live="polite">
          {missing.length ? `${missing.length} left to answer` : 'Ready to send'}
        </span>
        {revising ? (
          <Button
            variant="outline"
            className="border-slate-200 in-[.lichen-d5]:border-border"
            disabled={sending}
            onClick={() => {
              setRevising(false);
              setError(null);
            }}
            data-testid="intake-followup-cancel"
            onClickCapture={tenantPresentation ? () => { focusIntent.current = true; } : undefined}
          >
            Cancel
          </Button>
        ) : null}
        <Button
          ref={sendButton}
          onClickCapture={tenantPresentation ? () => { focusIntent.current = true; } : undefined}
          onClick={() => void send()}
          disabled={sending}
          data-testid="intake-followup-send"
          className="gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Send details
        </Button>
      </div>
    </Card>
  );
}
