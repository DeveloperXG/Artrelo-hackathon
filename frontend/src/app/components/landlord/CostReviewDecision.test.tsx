import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ApprovalRequestItem } from '../../types/landlord';
import { CoordinationStepActions, CoordinationStepContext, CostReviewActions, CostReviewContext } from './CostReviewDecision';

const HASH = 'd'.repeat(64);
const approval = (patch: Partial<ApprovalRequestItem>): ApprovalRequestItem => ({
  _id: 'ap1', requestId: 'r1', type: 'cost_review', status: 'pending', expiresAt: '2026-10-29T17:00:00.000Z', ...patch,
});
const cost = (purpose: 'clarification_permission' | 'scope_review' | 'analysis_unavailable', extra = {}) =>
  approval({ payload: { source: 'iris_cost_review', purpose, stage: 'quote', subjectId: 's1', quoteRevision: 2, quoteHash: HASH, contextHash: 'c', analysisId: 'a', ...extra } });
const html = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
const decide = async () => {};

describe('cost review Decision card', () => {
  it('asks permission to follow up with the exact labels', () => {
    const out = html(<><CostReviewContext approval={cost('clarification_permission')} /><CostReviewActions approval={cost('clarification_permission')} onDecide={decide} busy={false} /></>);
    expect(out).toContain('Allow one routine follow-up question to the vendor?');
    expect(out).toContain('Allow one follow-up');
    expect(out).toContain('Decline follow-up');
    expect(out).toContain('This permits one question only. It does not approve any cost.');
    expect(out).toContain('revision 2');
    expect(out).not.toContain(HASH);
    expect(out).not.toMatch(/\$|amount/i);
  });

  it.each(['scope_review', 'analysis_unavailable'] as const)('%s confirms review without replacing other gates', (purpose) => {
    const out = html(<CostReviewActions approval={cost(purpose)} onDecide={decide} busy={false} />);
    expect(out).toContain('Confirm scope review');
    expect(out).toContain('Decline scope review');
    expect(out).toContain('Quota, overage and tenant checks still apply');
    expect(out).toContain('authorizes no spending or payment');
    expect(out).toContain('requires explicit reopening');
  });

  it('a Decision without its stored revision/hash offers no buttons', () => {
    const out = html(<CostReviewActions approval={cost('scope_review', { quoteHash: undefined })} onDecide={decide} busy={false} />);
    expect(out).toContain('cost-review-undecidable-ap1');
    expect(out).not.toContain('cost-review-approve');
  });

  it('links to the itemized costs on the request', () => {
    expect(html(<CostReviewContext approval={cost('scope_review')} />)).toContain('href="/dashboard/requests/r1"');
  });
});

describe('Other Decision card', () => {
  const step = approval({ type: 'other', reason: 'Ask the tenant for access', payload: { actionScope: 'coordination_step', stepId: 'review_coordination', question: 'Ask the tenant to confirm access for Thursday?' } });
  const legacy = approval({ _id: 'ap2', type: 'other', reason: 'Proceed?', payload: {} });

  it('a named coordination step reads Allow this step / Pause this step and nothing about the whole request', () => {
    const out = html(<><CoordinationStepContext approval={step} /><CoordinationStepActions approval={step} onDecide={decide} busy={false} /></>);
    expect(out).toContain('Ask the tenant to confirm access for Thursday?');
    expect(out).toContain('Allow this step');
    expect(out).toContain('Pause this step');
    expect(out).toContain('cancel the request or approve any spending');
    expect(out).not.toMatch(/Approve request|Reject request|Cancel request/);
  });

  it('an older Other with no named step links to intake and routing review and offers no approval', () => {
    const out = html(<><CoordinationStepContext approval={legacy} /><CoordinationStepActions approval={legacy} onDecide={decide} busy={false} /></>);
    expect(out).toContain('Review intake and routing');
    expect(out).toContain('href="/dashboard/requests/r1?tab=routing"');
    expect(out).not.toContain('step-allow');
    expect(out).not.toMatch(/>Approve</);
  });
});
