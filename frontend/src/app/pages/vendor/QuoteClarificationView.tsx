import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, CheckCircle2, Loader2, Lock, MessageSquareText } from 'lucide-react';
import { ApiError, VendorPortalAPI, type QuoteClarificationData } from '../../api/client';
import ItemizationBreakdown from '../../components/quotes/ItemizationBreakdown';
import ItemizationEditor from '../../components/quotes/ItemizationEditor';
import { FieldError, invalidFieldClass } from '../../components/ui/FieldError';
import {
  buildItemization,
  itemizationErrorMessage,
  lineErrorFromServer,
  linesFromItemization,
  type DraftLine,
  type ItemizationInput,
  type LineErrors,
  type PricingMode,
} from '../../lib/itemization';
import { lineDescriptions } from '../../lib/costReview';

/**
 * The vendor side of a bounded quote follow-up: answer the property manager's
 * line-specific questions and, once and only before booking, revise the quote.
 * A separate capability from the original job link -- it never calls the
 * brief or the single-use /respond, and it can't reopen that response.
 */

export const MAX_ANSWER = 800;

export function isClarificationLink(token: string, mode: string | null): boolean {
  return mode === 'quote-clarification' || token.startsWith('qc_');
}

export type ClarificationFailure = { title: string; message: string; kind: 'invalid' | 'expired' | 'changed' };

/** Every refusal is final. Nothing is retried or submitted twice on the vendor's behalf. */
export function clarificationFailure(status: number | undefined): ClarificationFailure {
  if (status === 410) {
    return {
      kind: 'expired',
      title: 'This follow-up has expired',
      message: 'No answer can be sent now. The property manager will review the costs as they are.',
    };
  }
  if (status === 409) {
    return {
      kind: 'changed',
      title: 'This follow-up was already answered or has changed',
      message: 'Nothing more is needed from this link. If the job needs anything else, you’ll hear from the property manager.',
    };
  }
  return {
    kind: 'invalid',
    title: 'This link is not valid',
    message: 'It may have been replaced or already used.',
  };
}

export type ClarificationSubmission =
  | {
      ok: true;
      body: {
        expectedQuoteRevision: number;
        expectedQuoteHash: string;
        answers: { questionId: string; answer: string }[];
        itemization?: ItemizationInput;
      };
    }
  | { ok: false; answerErrors: Record<string, string>; lineErrors: Record<string, LineErrors>; message: string };

/**
 * The exact reply: the revision and hash the questions were asked about, one
 * answer per question, and an itemization only when a revision is allowed AND
 * chosen. A final statement is never repriced here.
 */
export function buildClarificationSubmission(
  data: QuoteClarificationData,
  answers: Record<string, string>,
  revision: { revise: boolean; mode: PricingMode; lines: DraftLine[] }
): ClarificationSubmission {
  const answerErrors: Record<string, string> = {};
  for (const question of data.questions) {
    const text = (answers[question.id] || '').trim();
    if (!text) answerErrors[question.id] = 'Answer this question.';
    else if ((answers[question.id] || '').length > MAX_ANSWER) answerErrors[question.id] = `Keep this under ${MAX_ANSWER} characters.`;
  }
  let itemization: ItemizationInput | undefined;
  let lineErrors: Record<string, LineErrors> = {};
  let itemizationMessage = '';
  if (revision.revise && data.allowRevision && data.stage === 'quote') {
    const built = buildItemization(revision.mode, revision.lines);
    if (built.ok) itemization = built.itemization;
    else {
      lineErrors = built.lineErrors;
      itemizationMessage = built.message;
    }
  }
  if (Object.keys(answerErrors).length || itemizationMessage) {
    return {
      ok: false,
      answerErrors,
      lineErrors,
      message: Object.keys(answerErrors).length ? 'Answer every question.' : itemizationMessage,
    };
  }
  return {
    ok: true,
    body: {
      expectedQuoteRevision: data.quoteRevision,
      expectedQuoteHash: data.quoteHash,
      answers: data.questions.map((question) => ({ questionId: question.id, answer: (answers[question.id] || '').trim() })),
      ...(itemization ? { itemization } : {}),
    },
  };
}

function formatExpiry(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function FinalCard({ icon: Icon, title, children, testId }: { icon: typeof Lock; title: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6 text-center" data-testid={testId}>
      <Icon className="mx-auto h-8 w-8 text-slate-500" aria-hidden="true" />
      <h1 className="mt-3 text-lg font-semibold text-slate-900">{title}</h1>
      <div className="mt-2 text-sm leading-6 text-slate-600">{children}</div>
    </section>
  );
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'failed'; failure: ClarificationFailure }
  | { kind: 'ready'; data: QuoteClarificationData }
  | { kind: 'answered'; revision: number; revised: boolean };

export function ClarificationContent({
  phase,
  answers,
  onAnswer,
  answerErrors,
  revise,
  onReviseChange,
  mode,
  lines,
  onLinesChange,
  lineErrors,
  onClearLineError,
  formError,
  busy,
  onSubmit,
}: {
  phase: Phase;
  answers: Record<string, string>;
  onAnswer: (questionId: string, value: string) => void;
  answerErrors: Record<string, string>;
  revise: boolean;
  onReviseChange: (value: boolean) => void;
  mode: PricingMode;
  lines: DraftLine[];
  onLinesChange: (lines: DraftLine[]) => void;
  lineErrors: Record<string, LineErrors>;
  onClearLineError: (key: string, field: keyof LineErrors) => void;
  formError: string;
  busy: boolean;
  onSubmit: () => void;
}) {
  if (phase.kind === 'loading') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-slate-500" role="status">
        <Loader2 className="mr-2 h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Loading the follow-up…
      </div>
    );
  }
  if (phase.kind === 'failed') {
    return (
      <FinalCard
        icon={phase.failure.kind === 'expired' ? CalendarClock : Lock}
        title={phase.failure.title}
        testId={`clarification-final-${phase.failure.kind}`}
      >
        {phase.failure.message}
      </FinalCard>
    );
  }
  if (phase.kind === 'answered') {
    return (
      <FinalCard icon={CheckCircle2} title="Answers sent" testId="clarification-answered">
        <p>
          {phase.revised ? `Your revised quote (revision ${phase.revision}) and answers` : 'Your answers'} are with the
          property manager for review. Nothing is approved or booked yet.
        </p>
        <p className="mt-2 text-slate-500">This link can’t be used again.</p>
      </FinalCard>
    );
  }

  const { data } = phase;
  const descriptions = lineDescriptions(data.quote?.itemization);
  const asked = new Set(data.questions.flatMap((question) => question.lineIds));
  const expiry = formatExpiry(data.expiresAt);
  const invoice = data.stage === 'invoice';

  return (
    <div className="space-y-5" data-testid="clarification-form">
      <section className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <MessageSquareText className="h-4 w-4 text-slate-700" aria-hidden="true" />
          <h1 className="text-lg font-semibold text-slate-900">
            {invoice ? 'Questions about your final charges' : 'Questions about your quote'}
          </h1>
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          The property manager has a question about specific lines. Your answer goes to them for review; it doesn’t
          approve or change anything on its own.
        </p>
        {expiry ? (
          <p className="mt-2 text-xs text-slate-500" data-testid="clarification-expiry">
            Answer by {expiry}. After that this link stops working.
          </p>
        ) : null}
      </section>

      {data.quote?.itemization ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
          <ItemizationBreakdown
            itemization={data.quote.itemization}
            title={invoice ? 'Your final charges' : 'Your current quote'}
            caption={`Revision ${data.quoteRevision}. Flagged lines are the ones asked about.`}
            highlight={asked}
            testId="clarification-quote"
          />
        </section>
      ) : null}

      <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
        {data.questions.map((question, index) => {
          const id = `clarification-answer-${question.id}`;
          const error = answerErrors[question.id];
          const value = answers[question.id] || '';
          return (
            <div key={question.id} data-testid="clarification-question">
              <label htmlFor={id} className="block text-sm font-semibold text-slate-900">
                {index + 1}. {question.text}
              </label>
              {question.lineIds.length ? (
                <p className="mt-1 text-xs text-slate-500">
                  About: {question.lineIds.map((lineId) => descriptions.get(lineId) || 'a line no longer shown').join('; ')}
                </p>
              ) : null}
              <textarea
                id={id}
                rows={3}
                value={value}
                maxLength={MAX_ANSWER}
                disabled={busy}
                onChange={(event) => onAnswer(question.id, event.target.value)}
                className={`mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus-visible:border-slate-900 focus-visible:ring-2 focus-visible:ring-slate-900/20 ${
                  error ? invalidFieldClass : ''
                }`}
                aria-invalid={Boolean(error)}
                aria-describedby={`${id}-count${error ? ` ${id}-error` : ''}`}
                data-testid="clarification-answer"
              />
              <div className="mt-1 flex items-start justify-between gap-3">
                <FieldError id={`${id}-error`}>{error}</FieldError>
                <span id={`${id}-count`} className="ml-auto text-[11px] text-slate-500">
                  {value.length}/{MAX_ANSWER}
                </span>
              </div>
            </div>
          );
        })}
      </section>

      {/* One pre-booking revision, offered only when the server says it's
          allowed. A final statement is never repriced here. */}
      {data.allowRevision && !invoice ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6" data-testid="clarification-revision">
          <label className="flex items-start gap-3 text-sm text-slate-800">
            <input
              type="checkbox"
              checked={revise}
              disabled={busy}
              onChange={(event) => onReviseChange(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-400"
              data-testid="clarification-revise"
            />
            <span>
              <span className="font-semibold">Also revise my quote</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Allowed once, before booking. The revised quote goes back to the property manager for review.
              </span>
            </span>
          </label>
          {revise ? (
            <div className="mt-4">
              <ItemizationEditor
                idPrefix="clarification-quote"
                mode={mode}
                lines={lines}
                onLinesChange={onLinesChange}
                lineErrors={lineErrors}
                onClearError={onClearLineError}
                disabled={busy}
                totalLabel="Revised total"
              />
            </div>
          ) : null}
        </section>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-600" data-testid="clarification-revision-locked">
          {invoice ? 'Final charges can’t be changed here. Answer the questions only.' : 'This quote can’t be revised here. Answer the questions only.'}
        </p>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-5 sm:p-6">
        <FieldError id="clarification-form-error" className="mb-3">
          {formError}
        </FieldError>
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 text-base font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-900/40 focus-visible:ring-offset-2 disabled:opacity-60"
          data-testid="clarification-submit"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          Send answers
        </button>
      </section>
    </div>
  );
}

export default function QuoteClarificationView({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});
  const [revise, setRevise] = useState(false);
  const [mode, setMode] = useState<PricingMode>('fixed');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [lineErrors, setLineErrors] = useState<Record<string, LineErrors>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Quote follow-up · Artrelo';
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await VendorPortalAPI.getQuoteClarification(token);
      const data = res.data as QuoteClarificationData;
      if (data.quote?.itemization) {
        setMode(data.quote.itemization.pricingMode);
        setLines(linesFromItemization(data.quote.itemization));
      }
      setPhase({ kind: 'ready', data });
    } catch (err) {
      setPhase({ kind: 'failed', failure: clarificationFailure((err as ApiError).status) });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (phase.kind !== 'ready' || busy) return;
    const built = buildClarificationSubmission(phase.data, answers, { revise, mode, lines });
    if (!built.ok) {
      setAnswerErrors(built.answerErrors);
      setLineErrors(built.lineErrors);
      setFormError(built.message);
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      const res = await VendorPortalAPI.submitQuoteClarification(token, built.body);
      const result = res.data as { revision: number; state: string };
      setPhase({ kind: 'answered', revision: result.revision, revised: Boolean(built.body.itemization) });
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.status === 400) {
        // A refused reply keeps everything typed; the vendor fixes and resends.
        const body = apiError.payload as { field?: string; code?: string } | undefined;
        const target = lineErrorFromServer(body?.field, lines, mode);
        if (target) setLineErrors({ [target.key]: { [target.field]: itemizationErrorMessage(body?.code) } });
        setFormError(apiError.message || 'Check the answers and itemized amounts.');
      } else {
        // Used, changed, expired or invalid: an honest final state, never a
        // second automatic submission.
        setPhase({ kind: 'failed', failure: clarificationFailure(apiError.status) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ClarificationContent
      phase={phase}
      answers={answers}
      onAnswer={(questionId, value) => {
        setAnswers((current) => ({ ...current, [questionId]: value }));
        setAnswerErrors((current) => (current[questionId] ? { ...current, [questionId]: '' } : current));
      }}
      answerErrors={answerErrors}
      revise={revise}
      onReviseChange={(value) => {
        setRevise(value);
        setLineErrors({});
        setFormError('');
      }}
      mode={mode}
      lines={lines}
      onLinesChange={setLines}
      lineErrors={lineErrors}
      onClearLineError={(key, field) =>
        setLineErrors((current) => (current[key]?.[field] ? { ...current, [key]: { ...current[key], [field]: undefined } } : current))
      }
      formError={formError}
      busy={busy}
      onSubmit={() => void submit()}
    />
  );
}
