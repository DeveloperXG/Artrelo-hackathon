import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { ScopeReviewReopenController, SCOPE_REOPEN_RECEIPT, type ScopeReviewReopenTarget, type CostAnalysis, type InvoiceReviewRow, type QuoteReviewRow, type QuoteReviews } from '../../lib/costReview';
import type { QuoteSnapshot } from '../../lib/itemization';

vi.mock('../../hooks/useLiveTopic', () => ({ useLiveTopic: () => {}, useLiveConnection: () => {} }));
const { QuoteReviewContent, CompletedCostReviewContent, CompletedCostWorkReview, ScopeReviewReopenScope, ScopeReviewReopenAction, ScopeReviewReopenNotices } = await import('./QuoteReviewPanel');

const HASH1 = '1'.repeat(64);
const HASH2 = '2'.repeat(64);
const snapshot = (revision: number, hash: string, items: QuoteSnapshot['itemization']['items'], mode: 'fixed' | 'range' = 'range'): QuoteSnapshot => {
  const lowMinor = items.reduce((sum, item) => sum + (mode === 'fixed' ? item.amountMinor! : item.lowMinor!), 0);
  const highMinor = items.reduce((sum, item) => sum + (mode === 'fixed' ? item.amountMinor! : item.highMinor!), 0);
  return { quoteContractVersion: 2, revision, hash, itemization: { pricingMode: mode, currency: 'CAD', items, totals: { lowMinor, highMinor } } };
};
const original = snapshot(1, HASH1, [
  { lineId: 'l1', description: 'Labour', category: 'labour', lowMinor: 10000, highMinor: 15000 },
  { lineId: 'l2', description: 'Callout fee', category: 'callout', lowMinor: 5000, highMinor: 5000 },
]);
const current = snapshot(2, HASH2, [
  { lineId: 'l1', description: 'Labour', category: 'labour', lowMinor: 10000, highMinor: 12000 },
  { lineId: 'l2', description: 'Callout fee', category: 'callout', lowMinor: 5000, highMinor: 5000 },
]);
const analysis = (patch: Partial<CostAnalysis>): CostAnalysis => ({
  status: 'ready', source: 'meta', simulated: false, result: null, errorCode: null, provider: 'meta', model: 'muse-spark-1.3', durationMs: 900, ...patch,
});
const quote = (patch: Partial<QuoteReviewRow> = {}): QuoteReviewRow => ({
  id: 'o1', vendorName: 'Northside Plumbing', status: 'accepted', revision: 2, original, current, approved: null,
  review: { state: 'needs_review', approvalId: 'ap1', resumePending: false },
  analysis: analysis({
    result: {
      schemaVersion: 1,
      summary: 'The call-out fee may duplicate travel already in labour.',
      flags: [{ code: 'possible_duplicate', lineIds: ['l2'], sourceRefs: ['quote:x'], explanation: 'Call-out and labour may overlap.' }],
      questions: [],
      reviewRecommendation: 'landlord_review',
    },
  }),
  clarification: null,
  ...patch,
});
const finalStatement = snapshot(1, '3'.repeat(64), [
  { lineId: 'f1', description: 'Labour 2h', category: 'labour', amountMinor: 16000 },
  { lineId: 'f2', description: 'Valve', category: 'materials', amountMinor: 4237 },
], 'fixed');
const invoice = (patch: Partial<InvoiceReviewRow> = {}): InvoiceReviewRow => ({
  id: 'c1', status: 'awaiting_tenant', finalStatement, invoiceReference: 'INV-1042', originalQuote: current,
  agreedAmount: 170, invoicedAmount: 202.37, approvedPayable: null,
  review: { state: 'pending', approvalId: null, resumePending: false },
  analysis: analysis({ status: 'pending', result: null }),
  clarification: null,
  ...patch,
});
const render = (reviews: QuoteReviews) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <QuoteReviewContent reviews={reviews} requestId="r1" />
    </MemoryRouter>
  );

describe('scope-review reopen action and inline receipt', () => {
  const target = (): ScopeReviewReopenTarget => ({ stage: 'quote', subjectId: 'b'.repeat(24), label: 'Quote · Synthetic vendor', statement: current, review: { state: 'rejected', approvalId: 'a'.repeat(24), resumePending: false, reopen: { expectedReviewRevision: 0, expectedQuoteRevision: 2, expectedQuoteHash: HASH2, expectedContextHash: 'c'.repeat(64), declinedApprovalId: 'a'.repeat(24) } } });
  const renderNode = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
  const setup = (t: ScopeReviewReopenTarget, post = vi.fn(async () => ({ data: {} }))) => new ScopeReviewReopenController({ requestId: 'r1', post, read: async () => ({ quotes: [quote({ review: t.review })], invoices: [] }), newKey: () => 'scope_attempt_0001' });
  it('shows the rejected label and exact action only for current descriptor-bound statements, never on legacy missing descriptor', () => {
    const t = target(), controller = setup(t);const node = (review = t.review) => <ScopeReviewReopenScope controller={controller} view={controller.getView()}><QuoteReviewContent reviews={{ quotes: [quote({ review })], invoices: [] }} requestId="r1" /></ScopeReviewReopenScope>;
    expect(renderNode(node())).toContain('Review declined');expect(renderNode(node())).toContain('Reopen scope review');expect(renderNode(node()).replace(/<[^>]+>/g, '')).toContain('Current quote revision 2');
    expect(renderNode(node({ ...t.review, reopen: null }))).not.toContain('scope-review-reopen-control');
    expect(renderNode(node({ ...t.review, reopen: { ...t.review.reopen!, expectedQuoteRevision: 1 } }))).not.toContain('scope-review-reopen-control');
  });
  it('uses a native explicit action and disables duplicate sends while pending', async () => {
    const t = target();let resolve!: (value: { data: unknown }) => void;const post = vi.fn(() => new Promise<{ data: unknown }>(r => { resolve = r; })), controller = setup(t, post);
    const tree = ScopeReviewReopenAction({ target: t, controller, view: controller.getView() });const button = nativeButton(tree, 'Reopen scope review');expect(button).toBeDefined();button!.props.onClick();button!.props.onClick();expect(post).toHaveBeenCalledTimes(1);
    const pending = renderNode(<ScopeReviewReopenAction target={t} controller={controller} view={controller.getView()} />);expect(pending).toContain('disabled=""');expect(pending).toContain('aria-busy="true"');
    resolve({ data: {} });await post.mock.results[0].value;
  });
  it('keeps replay receipt inspectable without claiming current pending, payment or redirect', async () => {
    const t = target(), controller = setup(t, vi.fn(async () => ({ data: { stage: t.stage, subjectId: t.subjectId, approvalId: 'd'.repeat(24), reviewRevision: 1, state: 'needs_review', replayed: true, message: SCOPE_REOPEN_RECEIPT } })));
    await controller.reopen(t);const out = renderNode(<ScopeReviewReopenNotices controller={controller} view={controller.getView()} requestId="r1" />);
    expect(out).toContain('Scope review reopened');expect(out).toContain('same-attempt receipt replay');expect(out).toContain('not proof that the review is still pending');expect(out).toContain('does not authorize spending or payment');expect(out).toContain('href="/dashboard/decisions?request=r1"');expect(out).not.toContain('Navigate');expect(out).not.toContain('Mark paid');
  });
  it('offers invoice reopening against its final statement without erasing a recorded payable or implying tenant confirmation settles review', () => {
    const t = target(), row = invoice({ review: { ...t.review, reopen: { ...t.review.reopen!, expectedQuoteRevision: finalStatement.revision, expectedQuoteHash: finalStatement.hash } }, approvedPayable: 175 }), controller = setup(t);
    const out = renderNode(<ScopeReviewReopenScope controller={controller} view={controller.getView()}><QuoteReviewContent reviews={{ quotes: [], invoices: [row] }} requestId="r1" /></ScopeReviewReopenScope>);
    expect(out).toContain('Reopen scope review');expect(out).toContain('Final statement revision 1');expect(out).toContain('$175.00');expect(out).not.toContain('>Paid<');expect(out).toContain('Review declined');
  });
  it('distinguishes tenant-confirmed work from a declined scope review, undecided payable and reopening', () => {
    const t = target(), row = invoice({ status: 'confirmed', approvedPayable: null, review: { ...t.review, reopen: { ...t.review.reopen!, expectedQuoteRevision: finalStatement.revision, expectedQuoteHash: finalStatement.hash } } }), controller = setup(t);
    const out = renderNode(<ScopeReviewReopenScope controller={controller} view={controller.getView()}><QuoteReviewContent reviews={{ quotes: [], invoices: [row] }} requestId="r1" /></ScopeReviewReopenScope>);
    for (const text of ['Completion status: Tenant confirmed work', 'Review declined', 'Approved payable', 'Not decided', 'Reopen scope review', 'does not confirm scope review, decide approved payable or establish payment']) expect(out).toContain(text);
    expect(out).not.toContain('>Paid<');expect(out).not.toContain('$0.00');
  });
});

describe('landlord cost review panel', () => {
  it('shows original, current and agreed separately, with deterministic deltas', () => {
    const html = render({ quotes: [quote()], invoices: [] });
    expect(html).toContain('$150.00–$200.00'); // original 100–150 + 50
    expect(html).toContain('$150.00–$170.00'); // current
    expect(html).toContain('Low $0.00, high −$30.00 vs original');
    expect(html).toContain('Not agreed yet');
    expect(html).toContain('Original quote (revision 1)');
  });

  it('itemizes every line and marks the lines the analysis cites', () => {
    const html = render({ quotes: [quote()], invoices: [] });
    expect(html).toContain('Labour');
    expect(html).toContain('Callout fee');
    expect(html).toContain('· Flagged');
    expect(html).toContain('Lines: Callout fee');
  });

  it('labels model output as advisory and needs_review links to the existing Decisions page', () => {
    const html = render({ quotes: [quote()], invoices: [] });
    expect(html).toContain('Model analysis');
    expect(html).toContain('Advisory');
    expect(html).toContain('Suggests your review');
    expect(html).toContain('href="/dashboard/decisions?request=r1"');
    expect(html).toContain('Needs your review');
  });

  it('a development simulation is never presented as a model', () => {
    const html = render({ quotes: [quote({ analysis: analysis({ source: 'development_stub', simulated: true, result: {
      schemaVersion: 1, summary: 'Development simulation: review the submitted breakdown.', flags: [], questions: [], reviewRecommendation: 'landlord_review' } }) })], invoices: [] });
    expect(html).toContain('Development simulation');
    expect(html).toContain('not a model result');
    expect(html).not.toContain('>Model analysis<');
  });

  it.each(['pending', 'unavailable', 'stale'] as const)('a %s analysis never looks approved', (status) => {
    const html = render({ quotes: [quote({ analysis: analysis({ status, result: null, errorCode: status === 'unavailable' ? 'analysis_timeout' : null }), review: { state: 'pending', approvalId: null, resumePending: false } })], invoices: [] });
    // "Nothing has been approved" is the honest copy; no approval-like state is.
    expect(html).not.toMatch(/Cost review complete|No additional flags|Model analysis|>Agreed<\/dt><dd[^>]*>\$/);
    expect(html).toMatch(/Analysis (pending|unavailable|out of date)/);
    expect(html).not.toContain('cost-review-decide');
  });

  it('keeps the invoice, the agreed cap and the approved payable apart', () => {
    const html = render({ quotes: [], invoices: [invoice()] });
    expect(html).toContain('Agreed booking amount');
    expect(html).toContain('A cap, not the invoice');
    expect(html).toContain('$170.00');
    expect(html).toContain('$202.37');
    expect(html).toContain('+$32.37 vs agreed (+19.0412%)');
    expect(html).toContain('Not decided');
    expect(html).toContain('Invoice INV-1042');
    // vs both ends of the agreed quote range, never a midpoint
    expect(html).toContain('+$52.37 against its low');
    expect(html).toContain('+$32.37 against its high');
    expect(html).toContain('Analysis pending');
  });

  it('an unknown agreed basis is shown as unknown, not invented', () => {
    const html = render({ quotes: [], invoices: [invoice({ agreedAmount: null, originalQuote: null })] });
    expect(html).toContain('Unknown');
    expect(html).toContain('No agreed amount to compare');
    expect(html).not.toContain('against its low');
  });

  it('shows the follow-up honestly: preview delivery is not sent, answers are attributed', () => {
    const html = render({ quotes: [quote({
      review: { state: 'pending', approvalId: null, resumePending: false },
      clarification: {
        state: 'answered', delivery: 'development_preview', expiresAt: '2026-10-29T17:00:00.000Z', quoteRevision: 1, quoteHash: HASH1,
        questions: [{ id: 'q1', code: 'possible_duplicate', lineIds: ['l2'], text: 'Explain how these charges differ and what each covers.' }],
        answers: [{ questionId: 'q1', answer: 'The call-out covers the van and first 30 minutes.' }],
      },
    })], invoices: [] });
    expect(html).toContain('Development preview, not sent');
    expect(html).not.toContain('Sent to the vendor');
    expect(html).toContain('Vendor answered');
    expect(html).toContain('Vendor: The call-out covers the van');
  });

  it('never renders a quote hash or context hash', () => {
    const html = render({ quotes: [quote()], invoices: [invoice()] });
    for (const hash of [HASH1, HASH2, '3'.repeat(64)]) expect(html).not.toContain(hash);
  });
});

describe('role privacy', () => {
  it('only the landlord request view mounts the panel; the tenant view never reads cost reviews', () => {
    const tenant = readFileSync(new URL('./TenantRequestDetailView.tsx', import.meta.url), 'utf8');
    const landlord = readFileSync(new URL('./LandlordRequestDetailView.tsx', import.meta.url), 'utf8');
    expect(tenant).not.toMatch(/QuoteReviewPanel|quote-reviews|getQuoteReviews/);
    expect(landlord).toContain('<QuoteReviewPanel');
  });
});

const settled = (): QuoteReviews => ({
  quotes: [quote({ review: { state: 'cleared', approvalId: null, resumePending: false }, analysis: analysis({ result: null }) })],
  invoices: [invoice({ status: 'closed', approvedPayable: 190, review: { state: 'cleared', approvalId: null, resumePending: false }, analysis: analysis({ result: null }) })],
});
const completed = (patch: Partial<Parameters<typeof CompletedCostReviewContent>[0]> = {}) => renderToStaticMarkup(
  <MemoryRouter><CompletedCostReviewContent requestId="r1" finalCost={240} reviews={settled()} onRetry={() => {}} onViewWorkRecord={() => {}} {...patch} /></MemoryRouter>,
);
const amount = (html: string) => html.match(/data-testid="completed-request-cost"[^>]*>[\s\S]*?<dd[^>]*>(.*?)<\/dd>/)?.[1];
function nativeButton(node: ReactNode, label: string): ReactElement<{ onClick: () => void }> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === 'button' && child.props.children === label) return child as ReactElement<{ onClick: () => void }>;
    const nested = nativeButton(child.props.children, label);
    if (nested) return nested;
  }
}

describe('completed request compact cost review', () => {
  it('uses the persisted request amount, keeps comparisons/advisory history and gives final itemization to Work record', () => {
    const html = completed();
    expect(amount(html)).toBe('CAD $240.00');
    expect(html).toContain('View Work record');
    expect(html).toContain('Quote history, comparisons and advisory analysis');
    expect(html).toContain('<details');
    expect(html).not.toMatch(/<details[^>]*\sopen(?:=|>)/);
    expect(html).toContain('Original estimate');
    expect(html).toContain('Current quote');
    expect(html).toContain('Agreed booking amount');
    expect(html).toContain('Approved payable');
    expect(html).toContain('Advisory');
    expect(html).toContain('cost-quote-breakdown');
    expect(html).not.toContain('cost-invoice-breakdown');
    expect(html).not.toContain('Final charges');
    expect(html).toContain('Full final itemization and actual payment status are in Work record');
    expect(html).not.toMatch(/>Paid<|>Settled<|>Bank receipt confirmed</);
  });

  it.each([undefined, null, '240', -1, NaN, Infinity, 1.005, 1000000.01])('does not invent or round a final amount from %s', (finalCost) => {
    expect(amount(completed({ finalCost: finalCost as number | undefined }))).toBe('Unknown');
  });

  it.each([[0, 'CAD $0.00'], [240.17, 'CAD $240.17'], [1000000, 'CAD $1,000,000.00']] as const)('preserves a recorded valid amount %s, including genuine zero', (finalCost, expected) => {
    expect(amount(completed({ finalCost }))).toBe(expected);
  });

  it('never chooses or sums invoices/payables into the request amount and retains every record', () => {
    const reviews = { quotes: [quote()], invoices: [invoice({ id: 'c1', invoiceReference: 'FIRST', approvedPayable: 100 }), invoice({ id: 'c2', invoiceReference: 'SECOND', approvedPayable: 120 })] };
    const html = completed({ finalCost: 777.88, reviews });
    expect(amount(html)).toBe('CAD $777.88');
    expect(html).toContain('Invoice FIRST');
    expect(html).toContain('Invoice SECOND');
    expect(html.match(/data-testid="cost-invoice"/g)).toHaveLength(2);
    expect(amount(completed({ finalCost: undefined, reviews }))).toBe('Unknown');
  });

  it('keeps decisions/resume/analysis and delivery warnings outside the closed history', () => {
    const reviews = { quotes: [quote({ review: { state: 'needs_review', approvalId: 'ap1', resumePending: true }, analysis: analysis({ status: 'stale', result: null }), clarification: {
      state: 'delivery_unknown' as const, delivery: 'unknown' as const, expiresAt: null, quoteRevision: 2, quoteHash: HASH2, questions: [], answers: [],
    } })], invoices: [] };
    const html = completed({ reviews });
    const outside = html.slice(0, html.indexOf('<details'));
    expect(outside).toContain('Needs your review');
    expect(outside).toContain('href="/dashboard/decisions?request=r1"');
    expect(outside).toContain('The next step after this review is still being processed');
    expect(outside).toContain('Analysis out of date');
    expect(outside).toContain('Delivery unknown, not confirmed sent');
    expect(outside).not.toContain('Sent to the vendor');
  });

  it('keeps loading, empty legacy reviews and errors distinct without inventing review history', () => {
    const loading = completed({ reviews: null });
    expect(loading).toContain('role="status"');
    expect(loading).toContain('Loading cost review');
    expect(loading).not.toContain('Cost review complete');
    const legacy = completed({ reviews: { quotes: [], invoices: [] } });
    expect(amount(legacy)).toBe('CAD $240.00');
    expect(legacy).toContain('No itemized cost review recorded');
    expect(legacy).not.toContain('<details');
    expect(legacy).not.toContain('Model analysis');
    const error = completed({ error: 'Itemized costs could not be loaded.' });
    expect(error).toContain('role="alert"');
    expect(error).toContain('Try again');
    expect(error).not.toContain('<details');
    expect(error).not.toContain('Cost review complete');
  });

  it('binds the labelled native Work record button to the supplied tab action exactly once', () => {
    const navigate = vi.fn();
    const tree = CompletedCostReviewContent({ requestId: 'r1', finalCost: 240, reviews: settled(), onRetry: () => {}, onViewWorkRecord: navigate });
    const button = nativeButton(tree, 'View Work record');
    expect(button).toBeDefined();
    button!.props.onClick();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('leaves completed Work record with no full cost panel but preserves review/resume and error cues', () => {
    const work = (reviews: QuoteReviews | null, error = '') => renderToStaticMarkup(<MemoryRouter><CompletedCostWorkReview requestId="r1" reviews={reviews} error={error} onRetry={() => {}} /></MemoryRouter>);
    expect(work(settled())).toBe('');
    expect(work({ quotes: [], invoices: [] })).toBe('');
    expect(work(null)).toBe('');
    const attention = work({ quotes: [], invoices: [invoice({ review: { state: 'needs_review', approvalId: 'a', resumePending: true } })] });
    expect(attention).toContain('Needs your review');
    expect(attention).toContain('Decide in Decisions');
    expect(attention).toContain('still being processed');
    expect(attention).not.toContain('cost-invoice-breakdown');
    expect(attention).not.toContain('Final charges');
    expect(attention).not.toContain('Approved payable');
    expect(work(settled(), 'Itemized costs could not be loaded.')).toContain('Try again');
  });

  it('retains a cleared review whose next step is pending, including an unavailable advisory analysis', () => {
    const reviews = settled();
    reviews.invoices[0].review.resumePending = true;
    reviews.invoices[0].analysis = analysis({ status: 'unavailable', result: null, errorCode: 'analysis_timeout' });
    const html = renderToStaticMarkup(<MemoryRouter><CompletedCostWorkReview requestId="r1" reviews={reviews} onRetry={() => {}} /></MemoryRouter>);
    expect(html).toContain('Cost review complete');
    expect(html).toContain('still being processed');
    expect(html).toContain('Analysis unavailable');
    expect(html).not.toContain('cost-invoice-breakdown');
  });

  it('keeps an unknown review status visible instead of declaring review complete', () => {
    const reviews = settled();reviews.invoices[0].review.state = 'unknown_server_state' as never;
    const html = renderToStaticMarkup(<MemoryRouter><CompletedCostWorkReview requestId="r1" reviews={reviews} onRetry={() => {}} /></MemoryRouter>);
    expect(html).toContain('Review status unknown');
    expect(html).not.toContain('completed-request-cost');
    expect(html).not.toContain('cost-invoice-breakdown');
  });
});
