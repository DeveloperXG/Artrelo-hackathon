import { useState, type FormEvent } from 'react';
import { ClipboardCheck, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { LandlordAPI } from '../../api/client';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { FieldError, invalidFieldClass } from '../ui/FieldError';
import { fieldClass } from '../landlord/landlordUi';
import { refreshLandlordBadges } from '../../hooks/landlord/useLandlordBadges';
import { ANSWER_STATE_LABEL, TOPIC_LABEL, safetyPendingReview, workflowConflict } from '../../lib/requestWorkflow';
import type { IntakeAnswerState, IntakeFollowUp, SafetyAssessment, SafetyReviewDisposition } from '../../types/requestWorkflow';
import type { RequestDetailRecord } from './requestDetailTypes';
import { D3_FIELD, D3_PRIMARY } from './d3Presentation';

const PROVENANCE_LABEL: Record<string, string> = {
  rules: 'safety rules',
  tenant: 'the tenant',
  model: 'the AI intake',
  landlord: 'you',
};

function conflictMessage(error: unknown, fallback: string) {
  const conflict = workflowConflict(error);
  if (conflict?.code === 'stale_revision') return 'This request changed since you opened it. It has been refreshed — check it and try again.';
  if (conflict?.code === 'request_not_editable') return 'This request can no longer be reviewed here.';
  return error instanceof Error ? error.message : fallback;
}

const formatAt = (iso: string | null | undefined) => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};


/**
 * Human decisions the request is held for: a safety concern awaiting an
 * assessment, and tenant follow-up details awaiting review. Neither control
 * sends outreach; they work whether or not vendor recommendations exist.
 */
export default function IntakeSafetyReviewPanel({
  request,
  onRequestReplaced,
}: {
  request: RequestDetailRecord;
  onRequestReplaced: (next: RequestDetailRecord) => void;
}) {
  const safety = (request.safetyAssessment as SafetyAssessment | null | undefined) ?? null;
  const followUp = request.intakeFollowUp ?? null;
  const safetyPending = safetyPendingReview(safety);
  const safetyReviewed = Boolean(safety?.reviewedAt);
  // Review is open while details are outstanding too: the landlord may accept
  // the uncertainty (with a reason) rather than wait on the tenant.
  const intakePending = followUp?.state === 'awaiting_answers' || followUp?.state === 'ready_for_review';
  const intakeReviewed = followUp?.state === 'reviewed';
  if (!safetyPending && !safetyReviewed && !intakePending && !intakeReviewed) return null;

  return (
    <div className="space-y-4" data-testid="landlord-review-panel">
      {safetyPending ? <SafetyReview request={request} safety={safety!} onRequestReplaced={onRequestReplaced} /> : null}
      {intakePending ? (
        <IntakeReview request={request} blockedBySafety={safetyPending} onRequestReplaced={onRequestReplaced} />
      ) : null}
      {safetyReviewed || intakeReviewed ? (
        <ReviewHistory safety={safetyReviewed ? safety : null} followUp={intakeReviewed ? followUp : null} />
      ) : null}
    </div>
  );
}

const DISPOSITION_RESULT: Record<SafetyAssessment['state'], string> = {
  needs_review: 'kept as urgent',
  confirmed_hazard: 'kept as urgent',
  none: 'handled as routine, not a safety issue',
};

/** What was decided, when and why, kept on the request after the forms are
 *  gone. Only fields the server recorded are shown. */
function ReviewHistory({ safety, followUp }: { safety: SafetyAssessment | null; followUp: IntakeFollowUp | null }) {
  return (
    <Card className="gap-2 border border-slate-200 p-4 shadow-sm in-[.lichen-d3]:border-border in-[.lichen-d3]:shadow-none" data-testid="review-history">
      <h2 className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">Reviews recorded</h2>
      <ul className="space-y-2 text-sm">
        {safety ? (
          <li className="flex items-start gap-2" data-testid="review-history-safety" data-state={safety.state}>
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 in-[.lichen-d3]:text-meta" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-slate-800 in-[.lichen-d3]:text-ink">
                Safety assessment: {DISPOSITION_RESULT[safety.state]}
                {formatAt(safety.reviewedAt) ? <span className="text-slate-500 in-[.lichen-d3]:text-meta"> · {formatAt(safety.reviewedAt)}</span> : null}
              </p>
              {safety.reviewReason ? <p className="break-words text-slate-600 in-[.lichen-d3]:text-meta">Reason: {safety.reviewReason}</p> : null}
            </div>
          </li>
        ) : null}
        {followUp ? (
          <li className="flex items-start gap-2" data-testid="review-history-intake">
            <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 in-[.lichen-d3]:text-meta" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-slate-800 in-[.lichen-d3]:text-ink">
                Details reviewed
                {followUp.remainingTopics.length
                  ? ` with ${followUp.remainingTopics.length} unresolved (${followUp.remainingTopics.map((t) => TOPIC_LABEL[t] || t).join(', ')})`
                  : ''}
                {formatAt(followUp.reviewedAt) ? <span className="text-slate-500 in-[.lichen-d3]:text-meta"> · {formatAt(followUp.reviewedAt)}</span> : null}
              </p>
              {followUp.reviewReason ? <p className="break-words text-slate-600 in-[.lichen-d3]:text-meta">Reason: {followUp.reviewReason}</p> : null}
            </div>
          </li>
        ) : null}
      </ul>
    </Card>
  );
}

function SafetyReview({
  request,
  safety,
  onRequestReplaced,
}: {
  request: RequestDetailRecord;
  safety: SafetyAssessment;
  onRequestReplaced: (next: RequestDetailRecord) => void;
}) {
  const [disposition, setDisposition] = useState<SafetyReviewDisposition | null>(null);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = safety.state === 'confirmed_hazard';
  const raisedBy = safety.provenance.map((p) => PROVENANCE_LABEL[p] || p).join(', ');
  const reasonError = touched && !reason.trim() ? 'Say why — it is kept with the request.' : null;
  const choiceError = touched && !disposition ? 'Choose an assessment.' : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!disposition || !reason.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await LandlordAPI.reviewSafety(request._id, {
        revision: safety.revision,
        disposition,
        reason: reason.trim(),
      });
      if (res.data) onRequestReplaced(res.data as RequestDetailRecord);
      void refreshLandlordBadges();
    } catch (e) {
      const latest = workflowConflict<RequestDetailRecord>(e)?.latest;
      if (latest) onRequestReplaced(latest);
      setError(conflictMessage(e, 'The assessment was not saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      className={`gap-3 border p-5 shadow-sm in-[.lichen-d3]:shadow-none ${confirmed ? "border-rose-300 bg-rose-50/40 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint" : "border-rose-200 in-[.lichen-d3]:border-alert-line"}`}
      data-testid="safety-review"
      data-state={safety.state}
    >
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-rose-600 in-[.lichen-d3]:text-alert-text" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-rose-900 in-[.lichen-d3]:text-alert-text">
            {confirmed ? 'Confirmed safety hazard' : 'Urgent safety concern — needs your review'}
          </h2>
          <p className="text-sm text-rose-800 in-[.lichen-d3]:text-alert-text">
            {confirmed ? 'Matched a known hazard. Treat this as urgent. ' : `Raised by ${raisedBy || 'intake'}. `}
            Nothing is sent to a vendor until you decide.
          </p>
          {safety.ruleCodes.length ? (
            <p className="mt-1 text-xs text-rose-700 in-[.lichen-d3]:text-alert-text">Rules: {safety.ruleCodes.join(', ')}</p>
          ) : null}
        </div>
      </div>
      {/* A rule-confirmed hazard is assessed too: the server holds intake
          review and routing until a person has looked at it. */}
      <form onSubmit={submit} className="space-y-3" noValidate>
          <fieldset aria-describedby={choiceError ? 'safety-choice-error' : undefined}>
            <legend className="text-sm font-medium text-slate-800 in-[.lichen-d3]:text-ink">Your assessment</legend>
            <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2">
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`safety-${request._id}`}
                  checked={disposition === 'retain_urgent'}
                  onChange={() => setDisposition('retain_urgent')}
                  data-testid="safety-retain-urgent"
                  className="h-4 w-4 accent-rose-600 in-[.lichen-d3]:accent-alert-text"
                />
                Keep as urgent
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`safety-${request._id}`}
                  checked={disposition === 'classify_routine'}
                  onChange={() => setDisposition('classify_routine')}
                  data-testid="safety-classify-routine"
                  className="h-4 w-4 accent-[#137fec] in-[.lichen-d3]:accent-lichen-text"
                />
                Not a safety issue — handle as routine
              </label>
            </div>
            <FieldError id="safety-choice-error">{choiceError}</FieldError>
          </fieldset>
          <div className="space-y-1">
            <label htmlFor={`safety-reason-${request._id}`} className="text-sm font-medium text-slate-800 in-[.lichen-d3]:text-ink">
              Reason
            </label>
            <textarea
              id={`safety-reason-${request._id}`}
              data-testid="safety-review-reason"
              value={reason}
              rows={2}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={Boolean(reasonError)}
              aria-describedby={reasonError ? 'safety-reason-error' : undefined}
              className={`${fieldClass} ${D3_FIELD} h-auto py-2 ${reasonError ? invalidFieldClass : ''}`}
            />
            <FieldError id="safety-reason-error">{reasonError}</FieldError>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-amber-800 in-[.lichen-d3]:text-alert-text" data-testid="safety-review-error">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={busy} className={`gap-2 bg-slate-900 hover:bg-slate-800 ${D3_PRIMARY}`} data-testid="safety-review-submit">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Record assessment
            </Button>
          </div>
      </form>
    </Card>
  );
}

function IntakeReview({
  request,
  blockedBySafety,
  onRequestReplaced,
}: {
  request: RequestDetailRecord;
  blockedBySafety: boolean;
  onRequestReplaced: (next: RequestDetailRecord) => void;
}) {
  const followUp = request.intakeFollowUp!;
  const awaiting = followUp.state === 'awaiting_answers';
  const uncertain = followUp.remainingTopics.length > 0;
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonError =
    touched && uncertain && !reason.trim()
      ? awaiting
        ? 'Some details are still unanswered — say why it can proceed.'
        : 'Some answers are unknown or declined — say why it can proceed.'
      : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if ((uncertain && !reason.trim()) || busy || blockedBySafety) return;
    setBusy(true);
    setError(null);
    try {
      const res = await LandlordAPI.reviewIntake(request._id, {
        revision: followUp.revision,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      if (res.data) onRequestReplaced(res.data as RequestDetailRecord);
      void refreshLandlordBadges();
    } catch (e) {
      const latest = workflowConflict<RequestDetailRecord>(e)?.latest;
      if (latest) onRequestReplaced(latest);
      setError(conflictMessage(e, 'The review was not saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="gap-3 border border-sky-200 p-5 shadow-sm in-[.lichen-d3]:border-border in-[.lichen-d3]:shadow-none" data-testid="intake-review" data-state={followUp.state}>
      <div className="flex items-start gap-3">
        <ClipboardCheck className="mt-0.5 h-5 w-5 shrink-0 text-sky-700 in-[.lichen-d3]:text-ink" aria-hidden="true" />
        <div>
          <h2 className="text-base font-semibold text-slate-900 in-[.lichen-d3]:text-ink">
            {awaiting ? 'Essential details are outstanding' : 'Tenant sent follow-up details'}
          </h2>
          <p className="text-sm text-slate-600 in-[.lichen-d3]:text-meta">
            {awaiting
              ? 'The tenant has been asked for these. You can wait for their answers, or review the remaining uncertainty now. '
              : 'Routing is on hold until you review them. '}
            Reviewing doesn&rsquo;t contact a vendor.
          </p>
        </div>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        {followUp.questions.map((q) => (
          <div key={q.topicId} className="rounded-lg bg-slate-50 px-3 py-2 in-[.lichen-d3]:bg-well" data-testid={`intake-review-${q.topicId}`}>
            <dt className="text-xs text-slate-500 in-[.lichen-d3]:text-meta">{TOPIC_LABEL[q.topicId] || q.question}</dt>
            <dd className="text-slate-800 in-[.lichen-d3]:text-ink">
              {q.state === 'answered' ? (
                q.value
              ) : q.state === 'missing' ? (
                <span className="italic text-slate-500 in-[.lichen-d3]:text-meta">Not answered</span>
              ) : (
                <span className="italic text-amber-700 in-[.lichen-d3]:text-lichen-text">{ANSWER_STATE_LABEL[q.state as IntakeAnswerState]}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {blockedBySafety ? (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800 in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text" data-testid="intake-review-blocked">
          Record the safety assessment above first.
        </p>
      ) : null}
      <form onSubmit={submit} className="space-y-2" noValidate>
        {uncertain ? (
          <div className="space-y-1">
            <label htmlFor={`intake-reason-${request._id}`} className="text-sm font-medium text-slate-800 in-[.lichen-d3]:text-ink">
              Why vendor contact can proceed without {awaiting ? 'waiting for ' : ''}those answers
            </label>
            <textarea
              id={`intake-reason-${request._id}`}
              data-testid="intake-review-reason"
              value={reason}
              rows={2}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={Boolean(reasonError)}
              aria-describedby={reasonError ? 'intake-reason-error' : undefined}
              className={`${fieldClass} ${D3_FIELD} h-auto py-2 ${reasonError ? invalidFieldClass : ''}`}
            />
            <FieldError id="intake-reason-error">{reasonError}</FieldError>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-amber-800 in-[.lichen-d3]:text-alert-text" data-testid="intake-review-error">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={busy || blockedBySafety}
            className="gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
            data-testid="intake-review-submit"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {awaiting ? 'Review remaining uncertainty' : 'Mark details reviewed'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
