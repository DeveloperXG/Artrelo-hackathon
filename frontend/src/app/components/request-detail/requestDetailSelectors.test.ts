import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import VendorRoutingSummary from './VendorRoutingSummary';
import {
  describeClosedRound,
  getLandlordActivityItems,
  getLiveRoutingAction,
  getRequestHeadline,
  getRequestCostDisplay,
  getRequestWorkflowStage,
  getRoundVendorBudget,
  isManuallySelectable,
} from './requestDetailSelectors';
import type {
  RequestDetailRecord,
  VendorRecommendationCandidate,
  VendorRecommendationSnapshot,
} from './requestDetailTypes';

const request = (overrides: Partial<RequestDetailRecord> = {}): RequestDetailRecord => ({
  _id: 'r1',
  issueTitle: 'Leaking sink',
  issueDescription: 'Water under the kitchen sink',
  status: 'queued',
  urgency: 'medium',
  category: 'plumbing',
  ai: { summary: 'Kitchen sink leak' },
  ...overrides,
});

const candidate = (
  overrides: Partial<VendorRecommendationCandidate>
): VendorRecommendationCandidate => ({
  candidateKey: 'v-1',
  providerName: 'preset',
  providerVendorId: 'pv-1',
  name: 'Vendor',
  ...overrides,
});

// The shape generateVendorRecommendations writes when nobody offers the service.
const noEligibleSnapshot = (
  overrides: Partial<VendorRecommendationSnapshot> = {}
): VendorRecommendationSnapshot => ({
  generatedAt: '2026-10-01T12:00:00.000Z',
  decision: { actionType: 'manual_vendor_assignment_required' },
  diagnostics: { outcomeCode: 'no_service_matches', eligibleCount: 0, serviceMatchedCount: 0 },
  candidateLedger: [candidate({ name: 'Off-trade Vendor', state: 'excluded' })],
  recommendations: [],
  activeCandidateKey: null,
  selectedCandidateKey: null,
  ...overrides,
});

const stageOf = (overrides: Partial<RequestDetailRecord>) =>
  getRequestWorkflowStage(request(overrides));

describe('emergency escalation is not an invented Decision', () => {
  it.each([undefined, { status: 'approved', approvalRequestId: 'old' }, { status: 'rejected', approvalRequestId: 'old' }, { status: 'pending' }])('keeps escalation and ordinary review without a Decisions CTA: %j', approvalRequest => {
    const snapshot = noEligibleSnapshot({ decision: { approvalRequired: true }, lastRound: { resolution: 'escalated', vendorName: 'Recorded vendor' }, approvalRequest });
    const record = request({ urgency: 'emergency', vendorRecommendationSnapshot: snapshot });
    const action = getLiveRoutingAction(record);
    expect(action.approvalPending).toBe(false); expect(action.label).toContain('Emergency outreach closed');
    expect(action.summary).toContain('Activity'); expect(action.summary).toContain('ordinary routing');
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(VendorRoutingSummary, { request: record, snapshot, activeCandidate: null })));
    expect(markup).not.toContain('Review in Decisions'); expect(markup).not.toContain('Approval needed');
    expect(markup).toContain('No pending Decision has been identified');
  });

  it('preserves the genuine pending Decision and does not change quote amount or safety facts', () => {
    const snapshot = noEligibleSnapshot({ decision: { approvalRequired: true, quotaLimit: 275 }, lastRound: { resolution: 'escalated', vendorName: 'Recorded vendor' }, approvalRequest: { status: 'pending', approvalRequestId: 'actual_pending' } });
    const record = request({ urgency: 'emergency', vendorRecommendationSnapshot: snapshot }), before = JSON.stringify(record);
    expect(getLiveRoutingAction(record).approvalPending).toBe(true);
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(VendorRoutingSummary, { request: record, snapshot, activeCandidate: null })));
    expect(markup).toContain('Review in Decisions'); expect(markup).toContain('Approval needed');
    expect(markup).toContain('Emergency requests never auto-advance'); expect(JSON.stringify(record)).toBe(before);
  });
});

describe('request detail cost labels', () => {
  it('does not present the zero defaults of unfinished work as a final or free cost', () => {
    expect(getRequestCostDisplay(request({ finalCost: 0, estimatedCost: 0 }))).toEqual({ label: 'Estimated cost', value: 'Pending' });
    expect(getRequestCostDisplay(request({ finalCost: 170, estimatedCost: 200 }))).toEqual({ label: 'Estimated cost', value: '$200.00' });
  });
  it('preserves verified completed costs, including genuinely free work', () => {
    for (const finalCost of [170, 0]) expect(getRequestCostDisplay(request({ status: 'completed', finalCost })))
      .toEqual({ label: 'Final cost', value: `$${finalCost.toFixed(2)}` });
  });
});

describe('getRequestWorkflowStage', () => {
  it('stays at vendor review when no vendor is eligible', () => {
    expect(stageOf({ vendorRecommendationSnapshot: noEligibleSnapshot() })).toEqual({
      key: 'vendor_review',
      stepIndex: 0,
    });
  });

  it('does not treat a closed outreach round as an approved contact', () => {
    for (const resolution of ['awaiting_approval', 'auto_advanced', 'escalated', 'exhausted'] as const) {
      const snapshot = noEligibleSnapshot({ lastRound: { candidateKey: 'v-1', resolution } });
      expect(stageOf({ vendorRecommendationSnapshot: snapshot }).key).toBe('vendor_review');
    }
  });

  it('does not let an unset activeCandidateKey match a keyless candidate', () => {
    // undefined === undefined used to pick the keyless excluded row as "active",
    // hiding the candidate that really is approved.
    const snapshot = noEligibleSnapshot({
      activeCandidateKey: undefined,
      selectedCandidateKey: undefined,
      candidateLedger: [
        candidate({ candidateKey: undefined, state: 'excluded' }),
        candidate({ candidateKey: 'v-2', state: 'approved_for_contact' }),
      ],
    });
    expect(stageOf({ vendorRecommendationSnapshot: snapshot }).key).toBe('contact_approved');
  });

  it('reaches contact approved once a candidate is approved_for_contact', () => {
    const snapshot = noEligibleSnapshot({
      candidateLedger: [candidate({ candidateKey: 'v-2', state: 'approved_for_contact' })],
      activeCandidateKey: 'v-2',
    });
    expect(stageOf({ vendorRecommendationSnapshot: snapshot })).toEqual({
      key: 'contact_approved',
      stepIndex: 1,
    });
  });

  it('moves past contact approved once a candidate is selected', () => {
    const snapshot = noEligibleSnapshot({
      candidateLedger: [candidate({ candidateKey: 'v-2', state: 'selected' })],
      selectedCandidateKey: 'v-2',
    });
    expect(stageOf({ vendorRecommendationSnapshot: snapshot }).key).toBe('selected_or_scheduled');
  });

  it('starts before the first step until a vendor search has run', () => {
    // Received and AI triage were always green on arrival, so they are gone;
    // before a search, Vendor review is the NEXT step, not a reached one.
    expect(stageOf({ ai: undefined })).toEqual({ key: 'not_started', stepIndex: -1 });
    expect(stageOf({})).toEqual({ key: 'not_started', stepIndex: -1 });
  });

  it('keeps the later stages, indexed into the four remaining steps', () => {
    expect(stageOf({ status: 'completed' })).toEqual({ key: 'completed', stepIndex: 3 });
    expect(
      stageOf({ status: 'cancelled', vendorRecommendationSnapshot: noEligibleSnapshot() })
    ).toEqual({ key: 'vendor_review', stepIndex: 0, terminalStatus: 'cancelled' });
  });
});

describe('a scheduled send', () => {
  // Approved while the vendor was closed: nothing has gone out yet.
  const scheduled = candidate({
    name: 'Reads',
    state: 'approved_for_contact',
    displayGroup: 'active',
    outreach: { status: 'scheduled', scheduledFor: '2026-10-05T15:00:00.000Z' },
    sendTiming: {
      openNow: false,
      nextOpenAt: '2026-10-05T15:00:00.000Z',
      nextOpenLabel: 'Mon, Oct 5, 9:00 a.m.',
      hoursLabel: 'Mon 9:00–17:00',
      sendNow: false,
      scheduledFor: '2026-10-05T15:00:00.000Z',
      scheduledForLabel: 'Mon, Oct 5, 9:00 a.m.',
    },
  } as Partial<VendorRecommendationCandidate>);
  const scheduledRequest = request({
    status: 'approved',
    // The server's label for this state (requestLifecycle.service).
    lifecycleStatus: 'outreach_scheduled',
    vendorRecommendationSnapshot: {
      candidateLedger: [scheduled],
      recommendations: [],
      activeCandidateKey: 'v-1',
      selectedCandidateKey: null,
    } as VendorRecommendationSnapshot,
  });

  it('says when it goes, not "outreach pending"', () => {
    const action = getLiveRoutingAction(scheduledRequest);
    expect(action.label).toBe('Outreach scheduled');
    expect(JSON.stringify(action)).toContain('Mon, Oct 5, 9:00 a.m.');
  });

  // The lock itself ("... is scheduled for Mon, Oct 5 — cancel the scheduled
  // send first.") is the server's: request.controller.manualAssign.test.js.
  it('points at the scheduled send in the headline', () => {
    expect(getRequestHeadline(scheduledRequest, true)).toMatch(/outreach scheduled$/);
  });
});

describe('getRoundVendorBudget', () => {
  it('reports the reachable cap, not the raw policy cap', () => {
    expect(getRoundVendorBudget({ maxVendors: 3, effectiveMaxVendors: 2 })).toBe(2);
  });

  it('falls back to the policy cap on rounds recorded before the effective cap', () => {
    expect(getRoundVendorBudget({ maxVendors: 3 })).toBe(3);
    expect(getRoundVendorBudget(null)).toBeUndefined();
  });
});

describe('isManuallySelectable', () => {
  const vendor = (overrides: Partial<VendorRecommendationCandidate> = {}) =>
    ({ candidateKey: 'v1', name: 'Reads', state: 'recommended', ...overrides }) as VendorRecommendationCandidate;

  it('offers a vendor who is still in the queue', () => {
    expect(isManuallySelectable(vendor(), {})).toBe(true);
  });

  it('does not offer a vendor who already declined', () => {
    expect(isManuallySelectable(vendor({ state: 'excluded', outreach: { status: 'declined' } }), {})).toBe(false);
  });
});

describe('the landlord headline', () => {
  it('says a request waiting on the manager needs their approval', () => {
    expect(getRequestHeadline(request({ status: 'approved', lifecycleStatus: 'needs_approval' }), true)).toMatch(
      /needs your approval$/
    );
  });

  it('says a request with nobody left to contact needs a vendor', () => {
    expect(getRequestHeadline(request({ status: 'approved', lifecycleStatus: 'needs_vendor' }), true)).toMatch(
      /needs a vendor$/
    );
  });
});

describe('describeClosedRound', () => {
  it('says the manager turned a quote down, not that the vendor declined', () => {
    const closed = describeClosedRound({
      lastRound: { vendorName: 'New Test Vendor', reason: 'manager_dismissed', detail: null },
    });
    expect(`${closed.subject} ${closed.verbLong}`).toBe('New Test Vendor’s quote was turned down');
  });

  it("drops the placeholder reason but keeps the manager's own", () => {
    const placeholder = describeClosedRound({
      candidateLedger: [
        candidate({ name: 'Reads', state: 'excluded', outreach: { status: 'declined', decision: { declineReason: 'Dismissed by the property manager' } } } as Partial<VendorRecommendationCandidate>),
      ],
    } as VendorRecommendationSnapshot);
    expect(placeholder.why).toBe('');
    expect(placeholder.verb).toBe('was turned down');

    const vendorDecline = describeClosedRound({
      lastRound: { vendorName: 'Reads', reason: 'declined', detail: 'Fully booked' },
    });
    expect(`${vendorDecline.subject} ${vendorDecline.verbLong}`).toBe('Reads declined this request');
    expect(vendorDecline.why).toBe('Fully booked');
  });
});

describe('getLandlordActivityItems', () => {
  const log = (id: string, createdAt: string) => ({
    _id: id,
    requestId: 'r1',
    actor: 'agent',
    actionType: 'vendor_outreach_expired',
    summary: id,
    createdAt,
  });

  it('orders lifecycle and audit newest first by millisecond, invalid times last', () => {
    const items = getLandlordActivityItems(
      [
        { status: 'queued', at: '2026-10-22T00:40:00.000Z' },
        { status: 'needs_vendor', at: '2026-10-22T00:49:11.150Z' },
        { status: 'cancelled', at: 'bogus' },
      ],
      [log('b', '2026-10-22T00:49:11.200Z'), log('a', '2026-10-22T00:49:11.100Z')]
    );
    expect(items.map((item) => item.description || item.title)).toEqual(['b', 'needs vendor', 'a', 'queued', 'cancelled']);
  });

  it('keeps same-instant lifecycle events newest first and stable', () => {
    const at = '2026-10-20T18:00:00.000Z';
    const timeline = [
      { status: 'in_progress', at },
      { status: 'completed', at },
    ];
    const first = getLandlordActivityItems(timeline, []);
    expect(first.map((item) => item.title)).toEqual(['completed', 'in progress']);
    expect(getLandlordActivityItems(timeline, []).map((item) => item.id)).toEqual(first.map((item) => item.id));
  });
});
