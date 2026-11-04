import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import type { ApprovalRequestItem } from '../../types/landlord';
import { COST_REVIEW_COPY, costReviewExpectation, otherDecisionKind } from '../../lib/costReview';
import { HackathonBadge } from '../judge/JudgeBadges';

/**
 * Decisions for an Iris cost review and for a coordination step ("Other").
 * Both live on the existing Decisions page and use the existing decision
 * endpoint; nothing here can authorize an amount.
 */

export type DecideFn = (
  id: string,
  status: 'approved' | 'rejected',
  approvedAmount?: number,
  outcome?: 'cost_permission' | 'cost_review' | 'step',
  expected?: { expectedQuoteRevision: number; expectedQuoteHash: string }
) => Promise<void>;

const primary =
  'inline-flex min-h-8 items-center gap-1 rounded-md bg-slate-900 px-3 text-xs font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-slate-900/40 focus-visible:ring-offset-1 disabled:opacity-50 in-[.lichen-d3]:h-auto in-[.lichen-d3]:max-w-full in-[.lichen-d3]:whitespace-normal in-[.lichen-d3]:bg-primary in-[.lichen-d3]:text-primary-foreground in-[.lichen-d3]:hover:bg-primary/90';
const secondary =
  'inline-flex min-h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 outline-none hover:border-slate-400 focus-visible:ring-2 focus-visible:ring-slate-900/30 disabled:opacity-50 in-[.lichen-d3]:h-auto in-[.lichen-d3]:max-w-full in-[.lichen-d3]:whitespace-normal in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink';

/** What is being reviewed, under the card's reason. */
export function CostReviewContext({ approval }: { approval: ApprovalRequestItem }) {
  const expected = costReviewExpectation(approval.payload);
  const stage = approval.payload?.stage === 'invoice' ? 'Final charges' : 'Itemized quote';
  return (
    <div className="mt-2 space-y-1.5" data-testid={`cost-review-context-${approval._id}`}>
      {approval.type === 'cost_review' && expected ? <HackathonBadge /> : null}
      <p className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{expected ? COST_REVIEW_COPY[expected.purpose].question : 'This cost review can’t be decided here.'}</p>
      <p className="text-xs text-slate-500 in-[.lichen-d3]:text-meta">
        {stage}
        {expected ? ` · revision ${expected.expectedQuoteRevision}` : ''}
      </p>
      <Link
        to={`/dashboard/requests/${approval.requestId}`}
        className="inline-flex text-xs font-medium text-slate-900 underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-slate-900/30 in-[.lichen-d3]:text-ink"
      >
        See the itemized costs
      </Link>
    </div>
  );
}

export function CostReviewActions({ approval, onDecide, busy }: { approval: ApprovalRequestItem; onDecide: DecideFn; busy: boolean }) {
  const [pending, setPending] = useState<'approved' | 'rejected' | null>(null);
  const expected = costReviewExpectation(approval.payload);
  if (!expected) {
    // Missing stored preconditions: deciding would be a guess at what was
    // reviewed. Send the landlord to the request instead.
    return (
      <p className="max-w-[16rem] text-xs leading-5 text-slate-600 sm:text-right in-[.lichen-d3]:text-meta" data-testid={`cost-review-undecidable-${approval._id}`}>
        Open the request to review its current costs.
      </p>
    );
  }
  const copy = COST_REVIEW_COPY[expected.purpose];
  const outcome = expected.purpose === 'clarification_permission' ? 'cost_permission' : 'cost_review';
  const decide = async (status: 'approved' | 'rejected') => {
    setPending(status);
    try {
      await onDecide(approval._id, status, undefined, outcome, {
        expectedQuoteRevision: expected.expectedQuoteRevision,
        expectedQuoteHash: expected.expectedQuoteHash,
      });
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <div className="flex flex-wrap gap-1.5 sm:justify-end">
        <button
          type="button"
          className={primary}
          disabled={busy || pending !== null}
          onClick={() => void decide('approved')}
          data-testid={`cost-review-approve-${approval._id}`}
        >
          {pending === 'approved' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {copy.approve}
        </button>
        <button
          type="button"
          className={secondary}
          disabled={busy || pending !== null}
          onClick={() => void decide('rejected')}
          data-testid={`cost-review-reject-${approval._id}`}
        >
          {pending === 'rejected' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {copy.reject}
        </button>
      </div>
      <p className="max-w-[16rem] text-[11px] leading-4 text-slate-500 sm:text-right in-[.lichen-d3]:text-meta">{copy.note}</p>
    </div>
  );
}

/** The step an Other decision asks about, or why an older one can't be decided here. */
export function CoordinationStepContext({ approval }: { approval: ApprovalRequestItem }) {
  if (otherDecisionKind(approval.payload) === 'coordination_step') {
    return (
      <p className="mt-2 break-words text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink" data-testid={`coordination-step-${approval._id}`}>
        {approval.payload?.question || approval.reason || 'Allow this coordination step?'}
      </p>
    );
  }
  return (
    <div className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-700 in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink" data-testid={`coordination-unknown-${approval._id}`}>
      This older decision doesn&rsquo;t name a coordination step, so it can&rsquo;t approve anything here.{' '}
      <Link
        to={`/dashboard/requests/${approval.requestId}?tab=routing`}
        className="font-medium text-slate-900 underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-slate-900/30 in-[.lichen-d3]:text-ink"
      >
        Review intake and routing
      </Link>
    </div>
  );
}

export function CoordinationStepActions({ approval, onDecide, busy }: { approval: ApprovalRequestItem; onDecide: DecideFn; busy: boolean }) {
  const [pending, setPending] = useState<'approved' | 'rejected' | null>(null);
  if (otherDecisionKind(approval.payload) !== 'coordination_step') return null;
  const decide = async (status: 'approved' | 'rejected') => {
    setPending(status);
    try {
      await onDecide(approval._id, status, undefined, 'step');
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="flex flex-col gap-2 sm:items-end">
      <div className="flex flex-wrap gap-1.5 sm:justify-end">
        <button type="button" className={primary} disabled={busy || pending !== null} onClick={() => void decide('approved')} data-testid={`step-allow-${approval._id}`}>
          {pending === 'approved' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          Allow this step
        </button>
        <button type="button" className={secondary} disabled={busy || pending !== null} onClick={() => void decide('rejected')} data-testid={`step-pause-${approval._id}`}>
          {pending === 'rejected' ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          Pause this step
        </button>
      </div>
      <p className="max-w-[16rem] text-[11px] leading-4 text-slate-500 sm:text-right in-[.lichen-d3]:text-meta">
        Covers this step only. It doesn&rsquo;t cancel the request or approve any spending.
      </p>
    </div>
  );
}
