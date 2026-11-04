import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  IrisActivityCardView,
  IrisActivityListView,
  IrisRequestActivityView,
  type FeedView,
} from './IrisActivityViews';
import { irisSummary } from '../../lib/irisActivity.fixtures';
import { automationStateOf, isIrisExecuting, pendingApprovalOf } from '../../lib/irisActivity';
import { decisionsFocusHref } from '../landlord/decisionHref';
import RequestActivityPanel from '../request-detail/RequestActivityPanel';
import { getTimelineActivityItems } from '../request-detail/requestDetailSelectors';
import type { IrisAutomationState, IrisRequestSummary } from '../../types/irisActivity';

const html = (element: ReactElement) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);

const feed: FeedView = {
  loading: false,
  error: '',
  refreshError: '',
  nextCursor: null,
  loadingMore: false,
  loadMoreError: '',
  loadMore: vi.fn(),
  refresh: vi.fn(),
};

/** The same summary through all three views. */
function threeViews(summary: IrisRequestSummary) {
  return {
    card: html(<IrisActivityCardView feed={feed} requests={[summary]} />),
    page: html(<IrisActivityListView feed={feed} requests={[summary]} activeOnly />),
    tab: html(<IrisRequestActivityView feed={feed} summary={summary} events={[]} />),
  };
}

const automationOf = (markup: string) => [...markup.matchAll(/data-automation="([^"]+)"/g)].map((m) => m[1]);

describe('automation state is separate from maintenance state', () => {
  it('says Automation is working only for the server running state', () => {
    const running = threeViews(irisSummary({ state: 'waiting', automationState: 'running' }));
    for (const view of Object.values(running)) {
      expect(automationOf(view)).toEqual(['running']);
      expect(view).toContain('Automation is working on this');
    }
  });

  it('does not imply the automation is running for maintenance in_progress', () => {
    for (const automationState of ['idle', 'awaiting_vendor', undefined] as const) {
      const views = threeViews(irisSummary({ state: 'in_progress', automationState }));
      for (const view of Object.values(views)) {
        expect(view).toContain('In progress');
        expect(view).not.toContain('Automation is working on this');
        expect(view).not.toContain('Automation working');
      }
    }
    expect(isIrisExecuting({ automationState: undefined })).toBe(false);
  });

  it('labels each non-running state for who or what it waits on', () => {
    const expected: Record<Exclude<IrisAutomationState, 'running'>, string> = {
      awaiting_landlord: 'Automation is waiting on you',
      awaiting_vendor: 'Automation is waiting on the vendor',
      awaiting_tenant: 'Automation is waiting on the tenant',
      completed: 'Automation has finished its part',
      failed: 'Automation could not finish',
      escalated: 'Automation handed this to you',
      idle: 'Automation is not doing anything now',
      unknown: 'Automation status not available',
    };
    for (const [state, label] of Object.entries(expected)) {
      const { page } = threeViews(irisSummary({ automationState: state as IrisAutomationState }));
      expect(automationOf(page)).toEqual([state]);
      expect(page).toContain(label);
    }
  });

  it('reads a missing or unrecognised field from older data as unknown', () => {
    const legacy = irisSummary();
    delete legacy.automationState;
    delete legacy.pendingApproval;
    for (const view of Object.values(threeViews(legacy))) {
      expect(automationOf(view)).toEqual(['unknown']);
      expect(view).not.toContain('iris-decision-link');
    }
    expect(automationStateOf({ automationState: 'toString' })).toBe('unknown');
    expect(automationStateOf({ automationState: 'busy' as IrisAutomationState })).toBe('unknown');
  });

  it('gives the compact card a full accessible name, not just the short label', () => {
    const { card } = threeViews(irisSummary({ automationState: 'awaiting_landlord' }));
    expect(card).toContain('Waiting on you');
    expect(card).toContain('<span class="sr-only">Automation is waiting on you</span>');
  });

  it('animates nothing: no spinner or pulse on any automation state', () => {
    for (const automationState of ['running', 'awaiting_landlord', 'idle'] as const) {
      for (const view of Object.values(threeViews(irisSummary({ automationState })))) {
        expect(view).not.toMatch(/animate-(spin|pulse|ping|bounce)/);
      }
    }
  });
});

describe('pending approval links to the existing Decisions page', () => {
  const pending = irisSummary({
    requestId: 'req/with space',
    automationState: 'awaiting_landlord',
    actionRequired: true,
    pendingApproval: { approvalId: 'appr-1', type: 'vendor_contact_approval', status: 'pending' },
  });

  it('shows the same focused link in all three views', () => {
    const href = decisionsFocusHref('req/with space');
    expect(href).toBe('/dashboard/decisions?request=req%2Fwith+space');
    for (const view of Object.values(threeViews(pending))) {
      expect(view).toContain(`href="${href}"`);
      expect(view).toContain('data-approval-id="appr-1"');
      expect(view).toContain('Review decision: Vendor contact');
    }
  });

  it('never nests the decision link inside the row link', () => {
    for (const view of [threeViews(pending).card, threeViews(pending).page]) {
      // Every <a> closes before the next opens.
      const tags = [...view.matchAll(/<a\b|<\/a>/g)].map((m) => m[0]);
      for (let i = 0; i < tags.length; i += 2) {
        expect(tags[i]).toBe('<a');
        expect(tags[i + 1]).toBe('</a>');
      }
      expect(view).toContain('data-testid="iris-request-link"');
      expect(view).toContain('data-testid="iris-decision-link"');
    }
  });

  it('offers no link for none, a non-pending status or a malformed reference', () => {
    const cases: unknown[] = [
      null,
      { approvalId: 'appr-1', type: 'quota_increase', status: 'expired' },
      { approvalId: '', type: 'quota_increase', status: 'pending' },
      { type: 'quota_increase', status: 'pending' },
    ];
    for (const pendingApproval of cases) {
      const summary = { ...pending, pendingApproval } as IrisRequestSummary;
      expect(pendingApprovalOf(summary)).toBeNull();
      for (const view of Object.values(threeViews(summary))) expect(view).not.toContain('iris-decision-link');
    }
  });

  it('names an unfamiliar approval type plainly', () => {
    const { tab } = threeViews({ ...pending, pendingApproval: { approvalId: 'a2', type: 'future_kind', status: 'pending' } });
    expect(tab).toContain('Review decision: Future kind');
  });
});

describe('tenant timeline stays simple', () => {
  it('renders the tenant lifecycle timeline with no automation or decision detail', () => {
    const items = getTimelineActivityItems([
      { status: 'submitted', at: '2026-10-27T09:00:00.000Z', note: 'Request received' },
      { status: 'scheduled', at: '2026-10-27T10:00:00.000Z', note: 'Visit booked' },
    ] as never);
    const markup = renderToStaticMarkup(<RequestActivityPanel items={items} />);
    expect(markup.match(/data-testid="activity-item"/g)).toHaveLength(2);
    expect(markup).not.toContain('iris-automation');
    expect(markup).not.toContain('iris-decision-link');
    expect(markup).not.toContain('/dashboard/decisions');
  });
});
