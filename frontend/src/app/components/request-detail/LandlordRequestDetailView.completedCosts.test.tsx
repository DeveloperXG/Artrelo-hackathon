import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuoteReviews } from '../../lib/costReview';
import type { WorkVisit } from './workRecordTypes';
import type { RequestDetailRecord, RequestDetailTab } from './requestDetailTypes';

const scene = vi.hoisted(() => ({ reviews: { quotes: [], invoices: [] } as QuoteReviews, error: '', d3: false, costProps: vi.fn(), workProps: vi.fn() }));
vi.mock('./d3Presentation', async () => ({ ...await vi.importActual('./d3Presentation'), useD3Presentation: () => scene.d3 }));
vi.mock('./RequestDetailHero', () => ({ default: ({ metrics }: { metrics: { label: string; value: string }[] }) => <header data-testid="hero-facts">{metrics.map(m => <p key={m.label}>{m.label}: {m.value}</p>)}</header> }));
// Isolate composition from unrelated providers/transports, not the cost UI.
vi.mock('./RequestWorkflowProgress', () => ({ default: () => null }));
vi.mock('./RequestContextSidebar', () => ({ default: () => null }));
vi.mock('./RequestOverviewPanel', () => ({ default: () => <p>Existing request overview</p> }));
vi.mock('./VendorRoutingPanel', () => ({ default: () => <p>Existing routing</p> }));
vi.mock('./RequestMessagesPanel', () => ({ default: () => <p>Existing messages</p> }));
vi.mock('../iris-activity/IrisRequestActivityPanel', () => ({ default: () => <p>Existing activity</p> }));
vi.mock('./IntakeSafetyReviewPanel', () => ({ default: () => null }));
vi.mock('../BookingCoordinationPanel', () => ({ default: () => null }));
vi.mock('../landlord/OutreachSummaryLine', () => ({ default: () => null }));
vi.mock('../../hooks/useLiveTopic', () => ({ useLiveTopic: () => {}, useLiveConnection: () => {} }));
vi.mock('./QuoteReviewPanel', async () => {
  const actual = await vi.importActual<typeof import('./QuoteReviewPanel')>('./QuoteReviewPanel');
  return { ...actual, default: (props: Parameters<typeof actual.default>[0]) => {
    scene.costProps(props);
    // Fake loaded transport data; execute the actual production presenters.
    if (props.completed?.view === 'overview') return <actual.CompletedCostReviewContent requestId={props.requestId} finalCost={props.completed.finalCost} reviews={scene.reviews} error={scene.error} onRetry={() => {}} onViewWorkRecord={props.completed.onViewWorkRecord} />;
    if (props.completed?.view === 'work') return <actual.CompletedCostWorkReview requestId={props.requestId} reviews={scene.reviews} error={scene.error} onRetry={() => {}} />;
    return <actual.QuoteReviewContent requestId={props.requestId} reviews={scene.reviews} />;
  } };
});
vi.mock('./WorkRecordPanel', async () => {
  const actual = await vi.importActual<typeof import('./WorkRecordPanel')>('./WorkRecordPanel');
  return { ...actual, default: (props: { requestId: string; revision?: string }) => {
    scene.workProps(props);
    return <section aria-label="Work record" data-request-id={props.requestId}><actual.WorkVisitCard visit={visit} number={1} /></section>;
  } };
});

const finalStatement = { quoteContractVersion: 2 as const, revision: 1, hash: 'a'.repeat(64), itemization: {
  pricingMode: 'fixed' as const, currency: 'CAD' as const, items: [{ lineId: 'work-line', description: 'Final repair labour', category: 'labour' as const, amountMinor: 31000 }], totals: { lowMinor: 31000, highMinor: 31000 },
} };
const visit: WorkVisit = { id: 'visit_a', status: 'completed', vendorName: 'Synthetic repair vendor', scheduledStart: null, scheduledEnd: null, createdAt: null, completedAt: null, failureReason: null, noShow: null,
  payment: { mode: 'platform', status: 'recorded', amountCents: null, paidAt: null, payouts: [{ id: 'payout_a', amountCents: 24000, status: 'pending_manual', clearsOn: null }] },
  report: { id: 'completion_a', status: 'closed', source: 'vendor_portal', submittedAt: null, completedAt: null, workPerformed: 'Retained final work notes', partsUsed: '', followUpNeeded: false, followUpNotes: '', reportedCost: 310, finalCost: 240, currency: 'CAD', approvedCeiling: 275, approvedOverage: null, closedAt: null, closeReason: 'tenant_confirmed', needsReview: false, checkIn: null, checkOut: null, evidenceVerdict: 'pass', evidenceReasons: [], evidenceReviewedAt: null, photos: [], confirmation: null, itemization: finalStatement.itemization, originalQuote: null, invoiceReference: 'TEST-FINAL', invoiceReviewState: 'cleared' },
};
const { default: LandlordRequestDetailView } = await import('./LandlordRequestDetailView');
const { getVisibleLandlordMetrics, getRequestWorkflowStage } = await import('./requestDetailSelectors');
type Props = Parameters<typeof LandlordRequestDetailView>[0];
const request = (patch: Partial<RequestDetailRecord> = {}) => ({ _id: 'request_a', issueTitle: 'Synthetic completed repair', issueDescription: 'Synthetic source test only', category: 'Plumbing', urgency: 'medium', status: 'completed', lifecycleStatus: 'completed', finalCost: 240, estimatedCost: 275, createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T13:00:00Z', comments: [], ...patch } as RequestDetailRecord);
function props(record = request(), activeTab: RequestDetailTab = 'overview'): Props {
  const noop = () => {};
  return { request: record, headline: record.issueTitle, propertyLabel: 'Synthetic property', unitLabel: '4B', lifecycleStatus: record.lifecycleStatus || record.status, workflowStage: getRequestWorkflowStage(record), metrics: getVisibleLandlordMetrics(record), activeCandidate: null, activeTab, onTabChange: vi.fn(), onBack: noop, onOpenRejectRequest: noop, onReopen: noop, onDeclineAppeal: noop, comment: '', onCommentChange: noop, onSubmitComment: noop, sendingComment: false, snapshot: null, routeabilityBlockReason: '', vendorActionBusy: '', draftValues: {}, draftEditorOpen: {}, onGenerateRecommendations: noop, onManualAssign: noop, onToggleDraft: noop, onChangeDraft: noop, onSaveDraft: noop, onApproveContact: noop, routingSetup: null, onAddVendor: noop, onRequestReplaced: noop };
}
const render = (p: Props) => renderToStaticMarkup(<MemoryRouter><LandlordRequestDetailView {...p} /></MemoryRouter>);
function costNode(node: ReactNode): ReactElement<{ completed: { onViewWorkRecord: () => void } }> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ completed?: unknown; children?: ReactNode }>(child)) continue;
    if (child.props.completed) return child as ReactElement<{ completed: { onViewWorkRecord: () => void } }>;
    const found = costNode(child.props.children);if (found) return found;
  }
}
beforeEach(() => {
  scene.costProps.mockClear();scene.workProps.mockClear();scene.error = '';scene.d3 = false;
  scene.reviews = { quotes: [], invoices: [{ id: 'completion_a', status: 'closed', finalStatement, invoiceReference: 'TEST-FINAL', originalQuote: null, agreedAmount: 275, invoicedAmount: 310, approvedPayable: 240, review: { state: 'cleared', approvalId: null, resumePending: false }, analysis: { status: 'ready', source: 'disabled', simulated: false, result: null, errorCode: null, provider: null, model: null, durationMs: null }, clarification: null }] };
});

describe('completed landlord cost composition', () => {
  it.each([false, true])('Overview owns one compact final total and native history, with D3=%s', (d3) => {
    scene.d3 = d3;const p = props();const original = JSON.stringify(p.request);const html = render(p);
    expect(html).toContain('CAD $240.00');
    expect(html).toContain('View Work record');
    expect(html).toContain('Quote history, comparisons and advisory analysis');
    expect(html).not.toContain('cost-invoice-breakdown');
    expect(html).not.toContain('work-record-final-statement');
    const hero = html.match(/<header data-testid="hero-facts">(.*?)<\/header>/)?.[1];
    expect(hero).not.toContain('Final cost:');expect(hero).toContain('Submitted:');
    expect(scene.costProps).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'request_a', revision: p.request.updatedAt, completed: expect.objectContaining({ view: 'overview', finalCost: 240 }) }));
    expect(p.onTabChange).not.toHaveBeenCalled();expect(scene.workProps).not.toHaveBeenCalled();expect(JSON.stringify(p.request)).toBe(original);
  });

  it('uses the existing tab callback, then renders one full final statement in Work record with actual pending payment wording', () => {
    const p = props();const tree = LandlordRequestDetailView(p);costNode(tree)!.props.completed.onViewWorkRecord();
    expect(p.onTabChange).toHaveBeenCalledTimes(1);expect(p.onTabChange).toHaveBeenCalledWith('work');
    const html = render({ ...p, activeTab: 'work' });
    expect(html.match(/data-testid="work-record-final-statement"/g)).toHaveLength(1);
    expect(html).not.toContain('cost-invoice-breakdown');expect(html).not.toContain('completed-request-cost');
    expect(html).toContain('Retained final work notes');expect(html).toContain('pending manual');expect(html).toContain('Bank receipt needs separate confirmation');
    expect(html).not.toContain('>Paid<');expect(scene.workProps).toHaveBeenCalledWith({ requestId: 'request_a', revision: p.request.updatedAt });
    expect(html).toContain('id="request-detail-tab-button-work"');
  });

  it.each(['in_progress', 'rejected', 'cancelled'])('preserves full quote/invoice review for noncompleted %s', (status) => {
    const html = render(props(request({ status, lifecycleStatus: status })));
    expect(html).toContain('cost-invoice-breakdown');expect(html).toContain('Final charges');
    expect(html).not.toContain('completed-request-cost');expect(scene.costProps.mock.calls.at(-1)?.[0].completed).toBeUndefined();
  });

  it('does not treat a lifecycle label or archive flag as completed request status', () => {
    const html = render(props(request({ status: 'rejected', lifecycleStatus: 'completed', archivedAt: '2026-11-01T14:00:00Z' })));
    expect(html).toContain('cost-invoice-breakdown');expect(html).not.toContain('completed-request-cost');
  });

  it.each(['routing', 'messages', 'activity'] as const)('keeps completed %s content and review reachable without forced navigation', (tab) => {
    const p = props(request(), tab),html = render(p);expect(html).toContain('cost-invoice-breakdown');expect(html).toContain('Final cost:');expect(p.onTabChange).not.toHaveBeenCalled();expect(scene.costProps.mock.calls.at(-1)?.[0].completed).toBeUndefined();
  });

  it('retains decision/resume warnings beside Work record without a second final breakdown', () => {
    scene.reviews.invoices[0].review = { state: 'needs_review', approvalId: 'approval_a', resumePending: true };
    const html = render(props(request(), 'work'));expect(html).toContain('href="/dashboard/decisions?request=request_a"');expect(html).toContain('still being processed');expect(html).not.toContain('cost-invoice-breakdown');expect(html.match(/data-testid="work-record-final-statement"/g)).toHaveLength(1);
  });

  it('shows a recorded legacy zero without manufacturing itemized reviews, and keeps absent cost unknown', () => {
    scene.reviews = { quotes: [], invoices: [] };
    expect(render(props(request({ finalCost: 0 })))).toContain('CAD $0.00');
    const html = render(props(request({ finalCost: undefined })));
    expect(html).toContain('Unknown');expect(html).toContain('No itemized cost review recorded');expect(html).not.toContain('completed-cost-history');
  });

  it('passes a changed request identity and revision through unchanged', () => {
    const p = props(request({ _id: 'request_b', updatedAt: '2026-11-02T03:00:00Z' }), 'work');render(p);expect(scene.costProps.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ requestId: 'request_b', revision: p.request.updatedAt }));expect(scene.workProps).toHaveBeenCalledWith({ requestId: 'request_b', revision: p.request.updatedAt });
  });
});
