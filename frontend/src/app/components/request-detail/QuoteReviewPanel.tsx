import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { HackathonBadge } from '../judge/JudgeBadges';
import { SimulatedVendorBadge } from '../judge/JudgeBadges';
import { Link } from 'react-router-dom';
import { Receipt } from 'lucide-react';
import { LandlordAPI } from '../../api/client';
import { useLiveTopic } from '../../hooks/useLiveTopic';
import { decisionsFocusHref } from '../landlord/decisionHref';
import ItemizationBreakdown from '../quotes/ItemizationBreakdown';
import { DetailCard } from './detailUi';
import {
  CLARIFICATION_STATE_LABELS,
  DELIVERY_LABELS,
  FLAG_LABELS,
  RECOMMENDATION_LABELS,
  analysisHeading,
  lineDescriptions,
  reviewStateLabel,
  canReopenScope,
  eligibleScopeReopen,
  scopeReopenAttempt,
  ScopeReviewReopenController,
  CostReviewReadOrder,
  SupersededCostReviewRead,
  type ScopeReopenView,
  type ScopeReviewReopenTarget,
  type ClarificationProjection,
  type CostAnalysis,
  type InvoiceReviewRow,
  type QuoteReviewRow,
  type QuoteReviews,
  type ReviewStatus,
} from '../../lib/costReview';
import {
  dollarsToMinor,
  formatCAD,
  formatSignedCAD,
  formatTotals,
  quoteDeltas,
  type Itemization,
} from '../../lib/itemization';

/**
 * Landlord-only cost review for one request: every itemized quote and final
 * statement, the advisory analysis of each, and any follow-up with the vendor.
 *
 * Original, current, agreed and final amounts are kept apart on purpose. A
 * booking cap or an approved payable is not what the vendor invoiced, and a
 * quoted range is never collapsed to a midpoint.
 */

const TONES = {
  neutral: 'bg-slate-100 text-slate-700',
  attention: "bg-amber-100 text-amber-900 in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text",
  done: "bg-emerald-50 text-emerald-800 in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text",
  stopped: "bg-rose-50 text-rose-800 in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text",
} as const;

const humanize = (value: string) => value.replace(/_/g, ' ');

function Figure({ label, value, note, testId }: { label: string; value: string; note?: string; testId?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-slate-50 px-3 py-2 in-[.lichen-d3]:bg-well" data-testid={testId}>
      <dt className="text-xs text-slate-500 in-[.lichen-d3]:text-meta">{label}</dt>
      <dd className="mt-0.5 break-words text-sm font-semibold tabular-nums text-slate-900 in-[.lichen-d3]:text-ink">{value}</dd>
      {note ? <dd className="mt-0.5 text-xs text-slate-500 in-[.lichen-d3]:text-meta">{note}</dd> : null}
    </div>
  );
}

const ReopenScope = createContext<{ controller: ScopeReviewReopenController; view: ScopeReopenView } | null>(null);
export function ScopeReviewReopenScope({ controller, view, children }: { controller: ScopeReviewReopenController; view: ScopeReopenView; children: ReactNode }) {
  return <ReopenScope.Provider value={{ controller, view }}>{children}</ReopenScope.Provider>;
}
const reopenButtonClass = 'inline-flex min-h-9 max-w-full items-center gap-2 whitespace-normal rounded-md border border-slate-300 bg-white px-3 py-2 text-left text-sm font-medium text-slate-900 outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50 in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink';
export function ScopeReviewReopenAction({ target, controller, view }: { target: ScopeReviewReopenTarget; controller: ScopeReviewReopenController; view: ScopeReopenView }) {
  const descriptor = eligibleScopeReopen(target);if (!descriptor) return null;
  const attempt = scopeReopenAttempt(view, target), pending = attempt?.phase === 'sending';
  return <div className="min-w-0 space-y-1" data-testid="scope-review-reopen-control">
    <p className="text-xs text-slate-600 in-[.lichen-d3]:text-meta">{target.stage === 'quote' ? 'Current quote' : 'Final statement'} revision {descriptor.expectedQuoteRevision} · review revision {descriptor.expectedReviewRevision}</p>
    <button type="button" className={reopenButtonClass} disabled={!canReopenScope(view, target)} aria-busy={pending} onClick={() => void controller.reopen(target)}>
      {pending ? 'Reopening scope review…' : attempt?.phase === 'unknown' && attempt.basis === JSON.stringify(descriptor) ? 'Retry same reopen attempt' : 'Reopen scope review'}
    </button>
    <p className="text-xs text-slate-600 in-[.lichen-d3]:text-meta">Reopening creates a new human review only. It authorizes no spending or payment.</p>
  </div>;
}
export function ScopeReviewReopenNotices({ controller, view, requestId }: { controller: ScopeReviewReopenController; view: ScopeReopenView; requestId: string }) {
  const attempts = Object.entries(view.attempts);if (!attempts.length && !view.localError) return null;
  return <section aria-label="Scope review reopen receipts and outcomes" className="mb-4 min-w-0 space-y-3">
    {view.localError ? <p role="alert">{view.localError}</p> : null}
    {attempts.map(([key, a]) => <div key={key} className="min-w-0 rounded-md border border-slate-200 p-3 text-sm [overflow-wrap:anywhere] in-[.lichen-d3]:border-border" data-testid="scope-review-reopen-outcome">
      <p className="font-medium">{a.target.label} · statement revision {a.input.expectedQuoteRevision}</p>
      <p role={a.phase === 'refused' ? 'alert' : 'status'} className="mt-1 text-slate-600 in-[.lichen-d3]:text-meta">{a.phase === 'sending' ? 'Reopening scope review…' : a.message}</p>
      {a.receipt ? <><p className="mt-1 text-xs text-slate-600 in-[.lichen-d3]:text-meta">Recorded review revision {a.receipt.reviewRevision}{a.receipt.replayed ? ' · same-attempt receipt replay' : ''}. This receipt is not proof that the review is still pending. Read the current review before acting.</p><Link to={decisionsFocusHref(requestId)} className="mt-2 inline-flex min-h-9 items-center rounded-md font-medium text-slate-900 underline in-[.lichen-d3]:text-ink">Open Decisions</Link></> : null}
      <p className="mt-1 text-xs text-slate-600 in-[.lichen-d3]:text-meta">{a.readback === 'ok' ? 'Current cost reviews refreshed from the server; no scope confirmation, spend or payment was submitted here.' : a.readback === 'failed' ? 'The latest review could not be verified. No retry is available until an authoritative refresh succeeds.' : a.phase === 'sending' ? 'An authoritative readback will follow this attempt.' : 'Checking current cost reviews…'}</p>
    </div>)}
    <button type="button" className={reopenButtonClass} disabled={view.reading || attempts.some(([, a]) => a.phase === 'sending')} onClick={() => void controller.refresh()}>{view.reading ? 'Refreshing cost reviews…' : 'Refresh cost reviews'}</button>
  </section>;
}

function ReviewLine({ review, requestId, reopenTarget }: { review: ReviewStatus; requestId: string; reopenTarget?: ScopeReviewReopenTarget }) {
  const state = reviewStateLabel(review.state);
  const reopen = useContext(ReopenScope);
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONES[state.tone]}`} data-testid="cost-review-state">
          {state.label}
        </span>
        {state.detail ? <p className="mt-1 text-xs leading-5 text-slate-600 in-[.lichen-d3]:text-meta">{state.detail}</p> : null}
        {review.resumePending ? (
          <p className="mt-1 text-xs leading-5 text-slate-600 in-[.lichen-d3]:text-meta">The next step after this review is still being processed.</p>
        ) : null}
      </div>
      {review.state === 'needs_review' && review.approvalId ? (
        <Link
          to={decisionsFocusHref(requestId)}
          className="inline-flex min-h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 outline-none hover:border-slate-400 focus-visible:ring-2 focus-visible:ring-slate-900/30 in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink"
          data-testid="cost-review-decide"
        >
          Decide in Decisions
        </Link>
      ) : null}
      {reopen && reopenTarget ? <ScopeReviewReopenAction target={reopenTarget} controller={reopen.controller} view={reopen.view} /> : null}
    </div>
  );
}

export function AnalysisBlock({ analysis, itemization }: { analysis: CostAnalysis | null; itemization: Itemization | null }) {
  const heading = analysisHeading(analysis);
  const descriptions = lineDescriptions(itemization);
  const lines = (ids: string[]) => ids.map((lineId) => descriptions.get(lineId) || 'a line no longer shown').join('; ');
  const result = analysis?.status === 'ready' ? analysis.result : null;
  return (
    <section className="rounded-md border border-slate-200 p-3 in-[.lichen-d3]:border-border" data-testid="cost-analysis">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 break-words text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink" data-testid="cost-analysis-heading">
          {heading.label}
        </h4>
        <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] font-semibold text-slate-600 in-[.lichen-d3]:border-control-border in-[.lichen-d3]:text-meta">Advisory</span>
        {analysis && itemization ? <HackathonBadge /> : null}
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-600 in-[.lichen-d3]:text-meta">{heading.detail}</p>
      {analysis?.errorCode && analysis.status !== 'ready' ? (
        <p className="mt-1 text-xs text-slate-500 in-[.lichen-d3]:text-meta">Reason recorded: {humanize(analysis.errorCode)}</p>
      ) : null}
      {result ? (
        <div className="mt-3 space-y-3">
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-800 in-[.lichen-d3]:text-ink">{result.summary}</p>
          <p className="text-xs font-medium text-slate-700 in-[.lichen-d3]:text-ink" data-testid="cost-analysis-recommendation">
            {RECOMMENDATION_LABELS[result.reviewRecommendation] || humanize(result.reviewRecommendation)}
          </p>
          {result.flags.length ? (
            <ul className="space-y-2">
              {result.flags.map((flag, index) => (
                <li key={`${flag.code}-${index}`} className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-950 in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text">
                  <span className="font-semibold">{FLAG_LABELS[flag.code] || humanize(flag.code)}</span>
                  <span className="block break-words">{flag.explanation}</span>
                  {flag.lineIds.length ? <span className="mt-0.5 block text-xs text-amber-900 in-[.lichen-d3]:text-lichen-text">Lines: {lines(flag.lineIds)}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {result.questions.length ? (
            <div>
              <h5 className="text-xs font-semibold text-slate-700 in-[.lichen-d3]:text-ink">Suggested questions</h5>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700 in-[.lichen-d3]:text-ink">
                {result.questions.map((question, index) => (
                  <li key={`${question.code}-${index}`} className="break-words">
                    {question.suggestedQuestion}
                    {question.lineIds.length ? <span className="block text-xs text-slate-500 in-[.lichen-d3]:text-meta">Lines: {lines(question.lineIds)}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function ClarificationBlock({ clarification, itemization }: { clarification: ClarificationProjection | null; itemization: Itemization | null }) {
  if (!clarification) return null;
  const descriptions = lineDescriptions(itemization);
  const answerFor = (id: string) => clarification.answers.find((answer) => answer.questionId === id)?.answer;
  const expiry = clarification.expiresAt ? new Date(clarification.expiresAt) : null;
  return (
    <section className="rounded-md border border-slate-200 p-3 in-[.lichen-d3]:border-border" data-testid="cost-clarification">
      <h4 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink"><span>Follow-up with the vendor</span>{itemization ? <HackathonBadge /> : null}</h4>
      <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-slate-500 in-[.lichen-d3]:text-meta">Status</dt>
          <dd className="font-medium text-slate-800 in-[.lichen-d3]:text-ink" data-testid="cost-clarification-state">
            {CLARIFICATION_STATE_LABELS[clarification.state] || humanize(clarification.state)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500 in-[.lichen-d3]:text-meta">Delivery</dt>
          <dd className="font-medium text-slate-800 in-[.lichen-d3]:text-ink" data-testid="cost-clarification-delivery">
            {DELIVERY_LABELS[clarification.delivery] || humanize(clarification.delivery)}
          </dd>
        </div>
        {expiry && !Number.isNaN(expiry.getTime()) && clarification.state !== 'answered' ? (
          <div>
            <dt className="text-slate-500 in-[.lichen-d3]:text-meta">{expiry.getTime() > Date.now() ? 'Expires' : 'Expired'}</dt>
            <dd className="font-medium text-slate-800 in-[.lichen-d3]:text-ink">{expiry.toLocaleString()}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-slate-500 in-[.lichen-d3]:text-meta">Asked about</dt>
          <dd className="font-medium text-slate-800 in-[.lichen-d3]:text-ink">Revision {clarification.quoteRevision}</dd>
        </div>
      </dl>
      <ol className="mt-3 space-y-2">
        {clarification.questions.map((question, index) => {
          const answer = answerFor(question.id);
          return (
            <li key={question.id} className="rounded-md bg-slate-50 px-3 py-2 text-sm in-[.lichen-d3]:bg-well">
              <p className="font-medium text-slate-900 in-[.lichen-d3]:text-ink">
                {index + 1}. {question.text}
              </p>
              {question.lineIds.length ? (
                <p className="mt-0.5 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                  Lines: {question.lineIds.map((lineId) => descriptions.get(lineId) || 'a line no longer shown').join('; ')}
                </p>
              ) : null}
              <p className={`mt-1 whitespace-pre-wrap break-words ${answer ? "text-slate-800 in-[.lichen-d3]:text-ink" : "text-slate-500 in-[.lichen-d3]:text-meta"}`}>
                {answer ? `Vendor: ${answer}` : 'No answer yet.'}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function QuoteCard({ row, requestId }: { row: QuoteReviewRow; requestId: string }) {
  const current = row.current?.itemization || null;
  const original = row.original?.itemization || null;
  const revised = Boolean(row.original && row.current && row.original.revision !== row.current.revision);
  const deltas = revised && original && current
    ? {
        low: current.totals.lowMinor - original.totals.lowMinor,
        high: current.totals.highMinor - original.totals.highMinor,
      }
    : null;
  const flagged = new Set([
    ...(row.analysis?.result?.flags || []).flatMap((flag) => flag.lineIds),
    ...(row.clarification?.questions || []).flatMap((question) => question.lineIds),
  ]);
  return (
    <article className="min-w-0 space-y-4 rounded-lg border border-slate-200 p-4 in-[.lichen-d3]:border-border" data-testid="cost-quote">
      <header>
        <h3 className="flex flex-wrap items-center gap-2 break-words text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">
          <span className="min-w-0">Quote · {row.vendorName || 'Vendor'}</span>
          <SimulatedVendorBadge vendorId={row.vendorId} />
          {row.current?.quoteContractVersion === 2 ? <HackathonBadge /> : null}
        </h3>
        <p className="mt-0.5 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
          {row.current ? `Revision ${row.current.revision}` : 'No current revision'} · {humanize(row.status)}
        </p>
      </header>
      <ReviewLine review={row.review} requestId={requestId} reopenTarget={{ stage: 'quote', subjectId: row.id, label: `Quote · ${row.vendorName || 'Vendor'}`, review: row.review, statement: row.current }} />
      <dl className="grid gap-2 sm:grid-cols-3">
        <Figure label="Original estimate" value={original ? formatTotals(original) : 'Not recorded'} testId="cost-quote-original" />
        <Figure
          label="Current quote"
          value={current ? formatTotals(current) : 'Not recorded'}
          note={
            deltas
              ? current?.pricingMode === 'fixed' && original?.pricingMode === 'fixed'
                ? `${formatSignedCAD(deltas.high)} vs original`
                : `Low ${formatSignedCAD(deltas.low)}, high ${formatSignedCAD(deltas.high)} vs original`
              : revised
                ? undefined
                : 'Unchanged since sent'
          }
          testId="cost-quote-current"
        />
        <Figure
          label="Agreed"
          value={row.approved ? formatTotals(row.approved.itemization) : 'Not agreed yet'}
          note={row.approved ? `Revision ${row.approved.revision}` : undefined}
          testId="cost-quote-agreed"
        />
      </dl>
      {current ? (
        <ItemizationBreakdown
          itemization={current}
          title="Current itemized quote"
          highlight={flagged}
          testId="cost-quote-breakdown"
        />
      ) : null}
      {revised && original ? (
        <details className="text-sm">
          <summary className="cursor-pointer rounded-md py-1 font-medium text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-slate-900/30 in-[.lichen-d3]:text-ink">
            Original quote (revision {row.original?.revision})
          </summary>
          <div className="mt-2">
            <ItemizationBreakdown itemization={original} testId="cost-quote-original-breakdown" />
          </div>
        </details>
      ) : null}
      <AnalysisBlock analysis={row.analysis} itemization={current} />
      <ClarificationBlock clarification={row.clarification} itemization={current} />
    </article>
  );
}

function InvoiceCard({ row, requestId, includeFinalItemization = true }: { row: InvoiceReviewRow; requestId: string; includeFinalItemization?: boolean }) {
  const final = row.finalStatement?.itemization || null;
  const originalQuote = row.originalQuote?.itemization || null;
  // A stored dollar figure that isn't a whole cent is shown as unknown, not
  // rounded into a basis it never was.
  const agreedMinor = dollarsToMinor(row.agreedAmount);
  const payableMinor = dollarsToMinor(row.approvedPayable);
  const deltas = quoteDeltas({
    originalLowMinor: originalQuote?.totals.lowMinor,
    originalHighMinor: originalQuote?.totals.highMinor,
    agreedMinor,
    finalMinor: final?.totals.highMinor ?? null,
  });
  const flagged = new Set([
    ...(row.analysis?.result?.flags || []).flatMap((flag) => flag.lineIds),
    ...(row.clarification?.questions || []).flatMap((question) => question.lineIds),
  ]);
  return (
    <article className="min-w-0 space-y-4 rounded-lg border border-slate-200 p-4 in-[.lichen-d3]:border-border" data-testid="cost-invoice">
      <header>
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink"><span>Final statement</span>{row.finalStatement?.quoteContractVersion === 2 ? <HackathonBadge /> : null}</h3>
        <p className="mt-0.5 break-words text-xs text-slate-500 in-[.lichen-d3]:text-meta">
          {row.invoiceReference ? `Invoice ${row.invoiceReference} · ` : ''}
          Completion status: {row.status === 'confirmed' ? 'Tenant confirmed work' : humanize(row.status)}
        </p>
        {row.status === 'confirmed' ? <p className="mt-1 text-xs text-slate-600 in-[.lichen-d3]:text-meta">Tenant confirmation does not confirm scope review, decide approved payable or establish payment.</p> : null}
      </header>
      <ReviewLine review={row.review} requestId={requestId} reopenTarget={{ stage: 'invoice', subjectId: row.id, label: row.invoiceReference ? `Invoice ${row.invoiceReference}` : 'Final statement', review: row.review, statement: row.finalStatement }} />
      <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Figure label="Original estimate" value={originalQuote ? formatTotals(originalQuote) : 'Not recorded'} testId="cost-invoice-original" />
        <Figure
          label="Agreed booking amount"
          value={agreedMinor === null ? 'Unknown' : formatCAD(agreedMinor)}
          note="A cap, not the invoice"
          testId="cost-invoice-agreed"
        />
        <Figure
          label="Invoiced"
          value={final ? formatCAD(final.totals.highMinor) : 'Not submitted'}
          note={
            deltas.finalVsAgreed
              ? `${formatSignedCAD(deltas.finalVsAgreed.amountMinor)} vs agreed${
                  deltas.finalVsAgreed.percent === null ? '' : ` (${deltas.finalVsAgreed.percent > 0 ? '+' : ''}${deltas.finalVsAgreed.percent}%)`
                }`
              : 'No agreed amount to compare'
          }
          testId="cost-invoice-final"
        />
        <Figure
          label="Approved payable"
          value={payableMinor === null ? 'Not decided' : formatCAD(payableMinor)}
          note="What may be paid, once decided"
          testId="cost-invoice-payable"
        />
      </dl>
      {deltas.finalVsEstimate ? (
        <p className="text-xs text-slate-600 in-[.lichen-d3]:text-meta" data-testid="cost-invoice-vs-estimate">
          Invoiced vs original estimate: {formatSignedCAD(deltas.finalVsEstimate.versusLowMinor)} against its low,{' '}
          {formatSignedCAD(deltas.finalVsEstimate.versusHighMinor)} against its high.
        </p>
      ) : null}
      {final && includeFinalItemization ? (
        <ItemizationBreakdown itemization={final} title="Final charges" caption="As submitted by the vendor. It can't be changed." highlight={flagged} testId="cost-invoice-breakdown" />
      ) : null}
      {originalQuote ? (
        <details className="text-sm">
          <summary className="cursor-pointer rounded-md py-1 font-medium text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-slate-900/30 in-[.lichen-d3]:text-ink">
            Agreed quote breakdown (revision {row.originalQuote?.revision})
          </summary>
          <div className="mt-2">
            <ItemizationBreakdown itemization={originalQuote} testId="cost-invoice-quote-breakdown" />
          </div>
        </details>
      ) : null}
      <AnalysisBlock analysis={row.analysis} itemization={final} />
      <ClarificationBlock clarification={row.clarification} itemization={final} />
    </article>
  );
}

export function QuoteReviewContent({ reviews, requestId, includeFinalItemization = true }: { reviews: QuoteReviews; requestId: string; includeFinalItemization?: boolean }) {
  return (
    <div className="space-y-4">
      {reviews.quotes.map((row) => (
        <QuoteCard key={row.id} row={row} requestId={requestId} />
      ))}
      {reviews.invoices.map((row) => (
        <InvoiceCard key={row.id} row={row} requestId={requestId} includeFinalItemization={includeFinalItemization} />
      ))}
    </div>
  );
}

function hasItemizedReview(reviews: QuoteReviews | null): boolean {
  return Boolean(reviews && (reviews.quotes.some(row => row.current?.quoteContractVersion === 2) || reviews.invoices.some(row => row.finalStatement?.quoteContractVersion === 2)));
}

export interface CompletedCostPresentation {
  view: 'overview' | 'work';
  finalCost?: number;
  onViewWorkRecord: () => void;
}

function attentionRows(reviews: QuoteReviews) {
  const rows = [
    ...reviews.quotes.map((row) => ({
      key: `quote-${row.id}`, label: `Quote · ${row.vendorName || 'Vendor'}`, vendorId: row.vendorId,
      review: row.review, analysis: row.analysis, clarification: row.clarification,
    })),
    ...reviews.invoices.map((row) => ({
      key: `invoice-${row.id}`, label: row.invoiceReference ? `Invoice ${row.invoiceReference}` : 'Final statement', vendorId: undefined,
      review: row.review, analysis: row.analysis, clarification: row.clarification,
    })),
  ];
  return rows.filter((row) => row.review.state !== 'cleared' || row.review.resumePending ||
    (row.analysis && row.analysis.status !== 'ready') ||
    (row.clarification && row.clarification.state !== 'answered'));
}

function CostReviewAttention({ reviews, requestId }: { reviews: QuoteReviews; requestId: string }) {
  const rows = attentionRows(reviews);
  if (!rows.length) return null;
  return (
    <section aria-label="Cost review needs attention" className="min-w-0 space-y-3" data-testid="completed-cost-attention">
      {rows.map((row) => (
        <div key={row.key} className="min-w-0 space-y-2 border-t border-slate-200 pt-3 in-[.lichen-d3]:border-hairline">
          <p className="flex flex-wrap items-center gap-2 break-words text-sm font-medium text-slate-900 in-[.lichen-d3]:text-ink">
            {row.label}<SimulatedVendorBadge vendorId={row.vendorId} />
          </p>
          <ReviewLine review={row.review} requestId={requestId} />
          {row.analysis && row.analysis.status !== 'ready' ? (
            <p className="text-sm text-slate-600 in-[.lichen-d3]:text-meta">{analysisHeading(row.analysis).label}. Analysis is advisory; the recorded detail is in Quote history on Overview.</p>
          ) : null}
          {row.clarification && row.clarification.state !== 'answered' ? (
            <p className="text-sm text-slate-600 in-[.lichen-d3]:text-meta">
              Follow-up: {CLARIFICATION_STATE_LABELS[row.clarification.state] || humanize(row.clarification.state)}.{' '}
              {DELIVERY_LABELS[row.clarification.delivery] || humanize(row.clarification.delivery)}.
            </p>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function CompletedReviewError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-rose-700 in-[.lichen-d3]:text-alert-text">{error}</p>
      <button type="button" onClick={onRetry} className="inline-flex min-h-9 items-center rounded-md border border-slate-300 px-3 py-1 text-sm font-medium text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-current in-[.lichen-d3]:border-control-border in-[.lichen-d3]:text-ink">
        Try again
      </button>
    </div>
  );
}

/** The request's persisted closing amount, never an invoice sum or payment claim. */
export function CompletedCostReviewContent({ requestId, finalCost, reviews, error = '', onRetry, onViewWorkRecord }: {
  requestId: string;
  finalCost?: number;
  reviews: QuoteReviews | null;
  error?: string;
  onRetry: () => void;
  onViewWorkRecord: () => void;
}) {
  const minor = dollarsToMinor(finalCost);
  const hasReviews = Boolean(reviews && (reviews.quotes.length || reviews.invoices.length));
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <dl className="min-w-0">
          <Figure label="Final request cost" value={minor === null ? 'Unknown' : `CAD ${formatCAD(minor)}`} testId="completed-request-cost" />
        </dl>
        <button type="button" onClick={onViewWorkRecord} className="inline-flex min-h-9 max-w-full items-center rounded-md border border-slate-300 px-3 py-2 text-left text-sm font-medium text-slate-900 outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-current in-[.lichen-d3]:border-control-border in-[.lichen-d3]:text-ink">
          View Work record
        </button>
      </div>
      <p className="text-sm text-slate-600 in-[.lichen-d3]:text-meta">Recorded request amount. Each visit, final statement and payment status remain in Work record.</p>
      {error ? <CompletedReviewError error={error} onRetry={onRetry} /> : !reviews ? (
        <p role="status" className="text-sm text-slate-600 in-[.lichen-d3]:text-meta">Loading cost review…</p>
      ) : hasReviews ? (
        <>
          <CostReviewAttention reviews={reviews} requestId={requestId} />
          {!attentionRows(reviews).length ? <p className="text-sm text-slate-600 in-[.lichen-d3]:text-meta">Cost review complete. This records the review, not payment or bank receipt.</p> : null}
          <details className="min-w-0 text-sm" data-testid="completed-cost-history">
            <summary className="cursor-pointer rounded-md py-2 font-medium text-slate-700 outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-current in-[.lichen-d3]:text-ink">
              Quote history, comparisons and advisory analysis
            </summary>
            <div className="mt-3 space-y-3">
              <p className="text-sm text-slate-600 in-[.lichen-d3]:text-meta">Full final itemization and actual payment status are in Work record. Analysis never approves a cost.</p>
              <QuoteReviewContent reviews={reviews} requestId={requestId} includeFinalItemization={false} />
            </div>
          </details>
        </>
      ) : <p className="text-sm text-slate-600 in-[.lichen-d3]:text-meta">No itemized cost review recorded for this request.</p>}
    </div>
  );
}

export function CompletedCostWorkReview({ requestId, reviews, error = '', onRetry }: {
  requestId: string;
  reviews: QuoteReviews | null;
  error?: string;
  onRetry: () => void;
}) {
  if (!error && (!reviews || !attentionRows(reviews).length)) return null;
  return (
    <DetailCard icon={Receipt} iconColor="#334155" title="Cost review needs attention" action={hasItemizedReview(reviews) ? <HackathonBadge /> : null} className="rounded-lg in-[.lichen-d3]:[overflow-wrap:anywhere]" data-testid="completed-cost-work-attention">
      {error ? <CompletedReviewError error={error} onRetry={onRetry} /> : reviews ? <CostReviewAttention reviews={reviews} requestId={requestId} /> : null}
    </DetailCard>
  );
}

export default function QuoteReviewPanel({ requestId, revision, completed }: { requestId: string; revision?: string; completed?: CompletedCostPresentation }) {
  const [reviews, setReviews] = useState<{ requestId: string; data: QuoteReviews } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const loaded = useRef<string | null>(null);
  const readOrder = useMemo(() => new CostReviewReadOrder(), [requestId]);
  const applyRead = (data: QuoteReviews) => { loaded.current = requestId;setError('');setReviews({ requestId, data }); };
  const reopenController = useMemo(() => new ScopeReviewReopenController({ requestId,
    post: (id, stage, subjectId, input) => LandlordAPI.reopenScopeReview(id, stage, subjectId, input),
    read: id => readOrder.read(async () => (await LandlordAPI.getQuoteReviews(id)).data as QuoteReviews, applyRead),
  }), [requestId, readOrder]);
  const reopenView = useSyncExternalStore(reopenController.subscribe, reopenController.getView, reopenController.getView);
  useEffect(() => { reopenController.activate();return () => { reopenController.dispose();readOrder.invalidate(); }; }, [reopenController, readOrder]);
  const decorate = (children: ReactNode) => <ScopeReviewReopenScope controller={reopenController} view={reopenView}><ScopeReviewReopenNotices controller={reopenController} view={reopenView} requestId={requestId} />{children}</ScopeReviewReopenScope>;
  useLiveTopic(`request:${requestId}`, () => setRetry((value) => value + 1));
  useEffect(() => {
    let current = true;
    if (loaded.current !== requestId) setReviews(null);
    readOrder.read(async () => (await LandlordAPI.getQuoteReviews(requestId)).data as QuoteReviews, data => { if (current) applyRead(data); })
      .catch(error => {
        if (current && !(error instanceof SupersededCostReviewRead)) setError('Itemized costs could not be loaded.');
      });
    return () => {
      current = false;
    };
  }, [requestId, revision, retry, readOrder]);

  const data = reviews?.requestId === requestId ? reviews.data : null;
  // Keep this fetch/live owner mounted across tabs. Only the completed
  // presentation changes; WorkRecordPanel remains the full statement owner.
  if (completed?.view === 'work') {
    return decorate(<CompletedCostWorkReview requestId={requestId} reviews={data} error={error} onRetry={() => setRetry((value) => value + 1)} />);
  }
  if (completed?.view === 'overview') {
    return decorate(
      <DetailCard icon={Receipt} iconColor="#334155" title="Final cost and review" description="Visible to you only. Analysis is advisory and never approves a cost." action={hasItemizedReview(data) ? <HackathonBadge /> : null} className="rounded-lg in-[.lichen-d3]:[overflow-wrap:anywhere]" data-testid="quote-review-panel">
        <CompletedCostReviewContent requestId={requestId} finalCost={completed.finalCost} reviews={data} error={error} onRetry={() => setRetry((value) => value + 1)} onViewWorkRecord={completed.onViewWorkRecord} />
      </DetailCard>
    );
  }
  // Requests priced the older way have nothing here; say nothing.
  if (!error && (!data || (!data.quotes.length && !data.invoices.length))) return Object.keys(reopenView.attempts).length ? decorate(null) : null;
  return decorate(
    <DetailCard
      icon={Receipt}
      iconColor="#334155"
      title="Itemized costs"
      description="Visible to you only. Analysis is advisory and never approves a cost."
      action={hasItemizedReview(data) ? <HackathonBadge /> : null}
      className="rounded-lg in-[.lichen-d3]:[overflow-wrap:anywhere]"
      data-testid="quote-review-panel"
    >
      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-rose-700 in-[.lichen-d3]:text-alert-text">{error}</p>
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="inline-flex min-h-9 items-center rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-slate-900/30 in-[.lichen-d3]:border-control-border in-[.lichen-d3]:text-ink"
          >
            Try again
          </button>
        </div>
      ) : data ? (
        <QuoteReviewContent reviews={data} requestId={requestId} />
      ) : null}
    </DetailCard>
  );
}
