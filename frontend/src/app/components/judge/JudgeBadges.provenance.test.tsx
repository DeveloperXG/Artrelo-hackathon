import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { JudgeSandboxController } from './judgeController';
import { JudgeSandboxProvider } from './JudgeSandboxProvider';
import { SANDBOX_OFF } from '../../contracts/judgeSandbox';
import { HackathonBadge, MetaTriageHackathonBadge } from './JudgeBadges';
import { QuoteReviewContent, AnalysisBlock, ClarificationBlock, CompletedCostWorkReview } from '../request-detail/QuoteReviewPanel';
import { CostReviewContext, CoordinationStepContext } from '../landlord/CostReviewDecision';
import ItemizationEditor from '../quotes/ItemizationEditor';
import RequestActivityPanel from '../request-detail/RequestActivityPanel';
import { IrisActivityCardView, IrisRequestActivityView, type FeedView } from '../iris-activity/IrisActivityViews';
import RescheduleCard from '../reschedule/RescheduleCard';
import RescheduleRequestForm from '../reschedule/RescheduleRequestForm';
import { change } from '../reschedule/rescheduleFixtures';
import { emptyLine, type QuoteSnapshot } from '../../lib/itemization';
import type { QuoteReviewRow, InvoiceReviewRow, CostAnalysis, ClarificationProjection } from '../../lib/costReview';
import type { ApprovalRequestItem } from '../../types/landlord';

const iris = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../iris/IrisProvider', () => ({ useIris: () => iris.value }));
const { IrisController } = await import('../iris/irisController');
const { IrisPanel } = await import('../iris/IrisPanel');

const text = 'Built during the hackathon';
const count = (markup: string) => markup.split(text).length - 1;
function render(element: ReactElement, enabled = true) {
  const api = { status: vi.fn(), start: vi.fn(), act: vi.fn() };
  const controller = new JudgeSandboxController({ api });
  controller.view = { ...controller.getView(), loaded: true, status: { ...SANDBOX_OFF, enabled, role: enabled ? 'landlord' : null, pairLabel: enabled ? 'Synthetic provenance test' : null } };
  const result = renderToStaticMarkup(<MemoryRouter><JudgeSandboxProvider controller={controller}>{element}</JudgeSandboxProvider></MemoryRouter>);
  expect(api.status).not.toHaveBeenCalled(); expect(api.start).not.toHaveBeenCalled(); expect(api.act).not.toHaveBeenCalled();
  return result;
}
const statement: QuoteSnapshot = { quoteContractVersion: 2, revision: 2, hash: 'a'.repeat(64), itemization: { pricingMode: 'fixed', currency: 'CAD', items: [
  { lineId: 'labour', description: 'Recorded labour', category: 'labour', amountMinor: 8000 },
  { lineId: 'part', description: 'Recorded part', category: 'materials', amountMinor: 2000 },
], totals: { lowMinor: 10000, highMinor: 10000 } } };
const review = { state: 'needs_review' as const, approvalId: 'review1', resumePending: false };
const quote: QuoteReviewRow = { id: 'quote1', vendorName: 'Synthetic vendor', status: 'accepted', revision: 2, original: statement, current: statement, approved: null, review, analysis: null, clarification: null };
const invoice: InvoiceReviewRow = { id: 'invoice1', status: 'confirmed', finalStatement: statement, invoiceReference: 'SYNTHETIC', originalQuote: statement, agreedAmount: 100, invoicedAmount: 100, approvedPayable: null, review, analysis: null, clarification: null };
const analysis: CostAnalysis = { status: 'unavailable', source: 'disabled', simulated: false, result: null, errorCode: null, provider: null, model: null, durationMs: null };
const clarification: ClarificationProjection = { state: 'draft', delivery: 'disabled', questions: [
  { id: 'question1', code: 'scope', lineIds: ['labour'], text: 'Which work does this labour cover?' },
  { id: 'question2', code: 'scope', lineIds: ['part'], text: 'Which part is listed?' },
], answers: [], expiresAt: null, quoteRevision: 2, quoteHash: statement.hash };
const approval: ApprovalRequestItem = { _id: 'decision1', requestId: 'request1', type: 'cost_review', status: 'pending', expiresAt: '2026-11-04T17:00:00Z',
  payload: { source: 'iris_cost_review', purpose: 'scope_review', stage: 'invoice', subjectId: 'invoice1', quoteRevision: 2, quoteHash: statement.hash, contextHash: 'b'.repeat(64), analysisId: 'analysis1' } };
const feed: FeedView = { loading: false, error: '', refreshError: '', nextCursor: null, loadingMore: false, loadMoreError: '', loadMore: vi.fn(), refresh: vi.fn() };

describe('proven hackathon sections retain judge-only provenance', () => {
  it('keeps the exact accessible label in normal flow, without a new control', () => {
    const out = render(<HackathonBadge />);
    expect(count(out)).toBe(1); expect(out).toContain('aria-hidden="true"'); expect(out).not.toContain('<button');
    expect(render(<HackathonBadge />, false)).toBe(''); expect(renderToStaticMarkup(<HackathonBadge />)).toBe('');
  });

  it.each(['meta', 'openai', 'gpt', 'deterministic', 'unknown', undefined])('labels only actual recorded Meta triage: %s', source => {
    expect(count(render(<MetaTriageHackathonBadge source={source} />))).toBe(source === 'meta' ? 1 : 0);
    expect(count(render(<MetaTriageHackathonBadge source={source} />, false))).toBe(0);
  });

  it('marks v2 quote and final statement panels once each, not every line or revision comparison', () => {
    const out = render(<QuoteReviewContent reviews={{ quotes: [quote], invoices: [invoice] }} requestId="request1" />);
    expect(count(out)).toBe(2); expect(out).toContain('Recorded labour'); expect(out).toContain('Recorded part');
    expect(out).toContain('Tenant confirmation does not confirm scope review');
    expect(count(render(<QuoteReviewContent reviews={{ quotes: [quote], invoices: [invoice] }} requestId="request1" />, false))).toBe(0);
    const legacy = { ...quote, original: null, current: null, revision: null };
    expect(count(render(<QuoteReviewContent reviews={{ quotes: [legacy], invoices: [{ ...invoice, finalStatement: null, originalQuote: null }] }} requestId="request1" />))).toBe(0);
    expect(count(render(<QuoteReviewContent reviews={{ quotes: [], invoices: [] }} requestId="request1" />))).toBe(0);
  });

  it('labels new advisory and bounded follow-up sections without implying a model call or vendor send', () => {
    const out = render(<><AnalysisBlock analysis={analysis} itemization={statement.itemization} /><ClarificationBlock clarification={clarification} itemization={statement.itemization} /></>);
    expect(count(out)).toBe(2); expect(out).toContain('Advisory'); expect(out).toContain('Follow-up with the vendor');
    expect(out).toContain('Which work'); expect(out).toContain('Which part');
    expect(count(render(<><AnalysisBlock analysis={null} itemization={null} /><ClarificationBlock clarification={null} itemization={null} /></>))).toBe(0);
    expect(count(render(<><AnalysisBlock analysis={analysis} itemization={statement.itemization} /><ClarificationBlock clarification={clarification} itemization={statement.itemization} /></>, false))).toBe(0);
  });

  it('labels valid typed cost-review Decisions, never generic approval or unknown legacy Other', () => {
    expect(count(render(<CostReviewContext approval={approval} />))).toBe(1);
    expect(count(render(<CostReviewContext approval={approval} />, false))).toBe(0);
    expect(count(render(<CostReviewContext approval={{ ...approval, type: 'financial' }} />))).toBe(0);
    expect(count(render(<CostReviewContext approval={{ ...approval, payload: {} }} />))).toBe(0);
    expect(count(render(<CoordinationStepContext approval={{ ...approval, type: 'other', payload: {} }} />))).toBe(0);
  });

  it('keeps legacy/error-only completed cost attention untagged and marks recorded v2 review gates', () => {
    expect(count(render(<CompletedCostWorkReview requestId="r" reviews={null} error="Read unavailable" onRetry={vi.fn()} />))).toBe(0);
    expect(count(render(<CompletedCostWorkReview requestId="r" reviews={{ quotes: [quote], invoices: [] }} onRetry={vi.fn()} />))).toBe(1);
  });

  it('marks the dedicated v2 editor once, retaining editable lines and existing controls', () => {
    const editor = <ItemizationEditor idPrefix="provenance" mode="fixed" lines={[{ ...emptyLine(), description: 'Labour', amount: '100' }]} onLinesChange={vi.fn()} />;
    expect(count(render(editor))).toBe(1); expect(render(editor)).toContain('Labour'); expect(count(render(editor, false))).toBe(0);
  });

  it('marks the new M2 feed chrome, not the pre-existing generic activity timeline', () => {
    for (const element of [<IrisActivityCardView feed={feed} requests={[]} />, <IrisRequestActivityView feed={feed} summary={null} events={[]} />]) {
      expect(count(render(element))).toBe(1); expect(count(render(element, false))).toBe(0);
    }
    expect(count(render(<RequestActivityPanel items={[]} />))).toBe(0);
  });

  it('marks reasoned reschedule forms/records while preserving exact consent and deadline copy', () => {
    for (const element of [<RescheduleCard change={change()} audience="tenant" />, <RescheduleRequestForm requestId="r" revision={2} onSent={vi.fn()} onReconcile={async () => {}} onCancel={vi.fn()} />]) {
      expect(count(render(element))).toBe(1); expect(count(render(element, false))).toBe(0);
    }
    expect(render(<RescheduleRequestForm requestId="r" revision={2} onSent={vi.fn()} onReconcile={async () => {}} onCancel={vi.fn()} />)).toContain('two hours');
  });

  it('retains a single existing M5 workflow label on the actual Iris dock, only for judges', () => {
    const state = { ...new IrisController({} as never).getState(), open: true };
    iris.value = { state, dock: { docked: true, width: 560, min: 400, max: 760 }, setPanelWidth: vi.fn(), mainRef: { current: null }, draft: { current: '' }, openPanel: vi.fn(), closePanel: vi.fn(), takeCloseFocus: () => 'launcher', follow: vi.fn(), controller: { canSend: () => true, newConversation: async () => {} } };
    expect(count(render(<IrisPanel />))).toBe(1); expect(count(render(<IrisPanel />, false))).toBe(0);
  });
});
