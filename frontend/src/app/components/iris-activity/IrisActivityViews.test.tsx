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
import { irisEvent, irisSummary } from '../../lib/irisActivity.fixtures';

const html = (element: ReactElement) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);

function feed(overrides: Partial<FeedView> = {}): FeedView {
  return {
    loading: false,
    error: '',
    refreshError: '',
    nextCursor: null,
    loadingMore: false,
    loadMoreError: '',
    loadMore: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  };
}

const waiting = irisSummary({
  requestId: 'req-a',
  stage: 'outreach',
  state: 'waiting',
  waitingFor: 'the plumber to respond',
  actionRequired: false,
});
const needsYou = irisSummary({
  requestId: 'req-b',
  title: 'Water heater pilot will not stay lit',
  stage: 'routing',
  state: 'needs_attention',
  waitingFor: 'your approval to contact a new vendor',
  actionRequired: true,
  latestEvent: irisEvent({
    id: 'evt-b',
    requestId: 'req-b',
    title: 'Approval requested to contact a first-time vendor',
    state: 'needs_attention',
  }),
});

describe('one projection across the three views', () => {
  it('shows the same stage, state, wait and action flag on the card, the page and the request tab', () => {
    const card = html(<IrisActivityCardView feed={feed()} requests={[waiting, needsYou]} />);
    const page = html(<IrisActivityListView feed={feed()} requests={[waiting, needsYou]} activeOnly />);
    const tab = html(<IrisRequestActivityView feed={feed()} summary={needsYou} events={[needsYou.latestEvent!]} />);
    for (const view of [card, page, tab]) {
      expect(view).toContain('Needs attention');
      expect(view).toContain('Waiting for your approval to contact a new vendor');
      expect(view).toContain('Your action needed');
    }
    expect(card).toContain('Choosing a vendor');
    expect(page).toContain('Choosing a vendor');
    expect(tab).toContain('Choosing a vendor');
  });

  it('drops a narrow row\'s badges onto their own line instead of squeezing the text', () => {
    const page = html(<IrisActivityListView feed={feed()} requests={[waiting]} activeOnly />);
    const row = page.match(/<div data-testid="iris-request-row"[^>]*class="([^"]*)"/)?.[1] ?? '';
    expect(row.split(' ')).toContain('flex-wrap');
    expect(page).toMatch(/<span class="min-w-0 flex-1 basis-24 /);
    expect(page).toMatch(/<span class="ml-auto flex shrink-0 flex-col items-end/);
  });

  it('keeps two requests apart, each linking to its own Activity tab', () => {
    const page = html(<IrisActivityListView feed={feed()} requests={[waiting, needsYou]} activeOnly />);
    expect(page.match(/data-testid="iris-request-row"/g)).toHaveLength(2);
    expect(page).toContain('href="/dashboard/requests/req-a?tab=activity"');
    expect(page).toContain('href="/dashboard/requests/req-b?tab=activity"');
    // The action pill belongs to req-b only.
    expect(page.match(/iris-action-required/g)).toHaveLength(1);
  });
});

describe('states', () => {
  it('renders loading, error with retry, and empty for each view without placeholder rows', () => {
    expect(html(<IrisActivityCardView feed={feed({ loading: true })} requests={[]} />)).toContain('iris-loading');
    const error = html(<IrisActivityListView feed={feed({ error: 'Activity could not be loaded.' })} requests={[]} activeOnly />);
    expect(error).toContain('role="alert"');
    expect(error).toContain('Try again');
    expect(error).not.toContain('iris-request-row');
    expect(html(<IrisActivityListView feed={feed()} requests={[]} activeOnly />)).toContain('No active requests');
    expect(html(<IrisActivityListView feed={feed()} requests={[]} activeOnly={false} />)).toContain('No activity yet');
    expect(html(<IrisActivityCardView feed={feed()} requests={[]} />)).toContain('No active requests right now.');
    expect(html(<IrisRequestActivityView feed={feed()} summary={waiting} events={[]} />)).toContain('No events recorded yet.');
  });

  it('labels failed, completed and unknown truthfully, as the server sent them', () => {
    const events = [
      irisEvent({ id: 'e1', title: 'Vendor declined the job', state: 'failed', actor: 'vendor' }),
      irisEvent({ id: 'e2', title: 'Outreach email could not be delivered', state: 'failed', actor: 'system' }),
      irisEvent({ id: 'e3', title: 'Repair confirmed by tenant', state: 'completed', actor: 'tenant' }),
      irisEvent({ id: 'e4', title: 'Outreach status not confirmed', state: 'unknown', actor: null }),
    ];
    const summary = { ...waiting, summary: 'Outreach could not be confirmed.' };
    const tab = html(<IrisRequestActivityView feed={feed()} summary={summary} events={events} />);
    expect(tab).toContain('Vendor declined the job');
    expect(tab).toContain('Outreach email could not be delivered');
    expect(tab.match(/data-state="failed"/g)).toHaveLength(2);
    expect(tab).toContain('Status unknown');
    expect(tab).not.toMatch(/\bsent\b/i);
  });

  it('says when a time was not recorded instead of showing "just now"', () => {
    const tab = html(
      <IrisRequestActivityView feed={feed()} summary={{ ...waiting, updatedAt: null }} events={[irisEvent({ at: null })]} />
    );
    expect(tab).toContain('Time not recorded');
    expect(tab).not.toContain('Just now');
  });

  it('keeps shown rows and a quiet note when a refresh fails', () => {
    const page = html(
      <IrisActivityListView feed={feed({ refreshError: 'Could not refresh. Showing the last activity loaded.' })} requests={[waiting]} activeOnly />
    );
    expect(page).toContain('iris-request-row');
    expect(page).toContain('Could not refresh.');
  });
});

describe('request timeline', () => {
  it('labels the full feed Newest first without reversing server order or requiring additive provenance', () => {
    const events = [irisEvent({ id: 'domain', at: '2026-11-03T15:00:00Z', recordedAt: '2026-11-03T16:00:00Z', timeBasis: 'domain' }), irisEvent({ id: 'legacy', at: null })];
    const out = html(<IrisRequestActivityView feed={feed({ nextCursor: 'opaque/older?cursor' })} summary={waiting} events={events} />);
    expect(out).toContain('Newest first');
    expect([...out.matchAll(/data-event-id="([^"]+)"/g)].map((m) => m[1])).toEqual(['domain', 'legacy']);
    expect(out).toContain('Load older activity');
    expect(out).toContain('Time not recorded');
  });
  it('renders events in the order given with stable ids', () => {
    const events = [irisEvent({ id: 'new' }), irisEvent({ id: 'tie-1', at: null }), irisEvent({ id: 'tie-0', at: null })];
    const tab = html(<IrisRequestActivityView feed={feed()} summary={waiting} events={events} />);
    const order = [...tab.matchAll(/data-event-id="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['new', 'tie-1', 'tie-0']);
  });

  it('puts recorded details behind a native disclosure and shows nothing it was not given', () => {
    const event = irisEvent({
      type: 'internal_raw_type_code',
      details: [
        { label: 'Vendors considered', value: '3 plumbers in your network' },
        { label: '', value: 'unlabelled value is dropped' },
      ],
    });
    const tab = html(<IrisRequestActivityView feed={feed()} summary={waiting} events={[event]} />);
    expect(tab).toContain('<details');
    expect(tab).toContain('<summary');
    expect(tab).toContain('Show details');
    expect(tab).toContain('(1)');
    expect(tab).toContain('<dt');
    expect(tab).toContain('3 plumbers in your network');
    expect(tab).not.toContain('unlabelled value is dropped');
    expect(tab).not.toContain('internal_raw_type_code');
  });

  it('has no disclosure for an event without details', () => {
    const tab = html(<IrisRequestActivityView feed={feed()} summary={waiting} events={[irisEvent({ details: [] })]} />);
    expect(tab).not.toContain('<details');
  });

  it('keeps the tabpanel wiring the tab strip points at', () => {
    const tab = html(<IrisRequestActivityView feed={feed()} summary={waiting} events={[]} />);
    expect(tab).toContain('id="request-detail-tab-activity"');
    expect(tab).toContain('role="tabpanel"');
    expect(tab).toContain('aria-labelledby="request-detail-tab-button-activity"');
  });

  it('escapes recorded text and wraps long unbroken labels', () => {
    const long = 'x'.repeat(240);
    const tab = html(
      <IrisRequestActivityView
        feed={feed()}
        summary={{ ...waiting, summary: long }}
        events={[irisEvent({ title: '<img src=x onerror=alert(1)>', summary: long })]}
      />
    );
    expect(tab).not.toContain('<img');
    expect(tab).toContain('&lt;img');
    expect(tab).toContain('[overflow-wrap:anywhere]');
  });
});

describe('pagination control', () => {
  it('appears only while the server returned a cursor', () => {
    expect(html(<IrisActivityListView feed={feed()} requests={[waiting]} activeOnly />)).not.toContain('iris-load-more');
    expect(html(<IrisActivityListView feed={feed({ nextCursor: 'c2' })} requests={[waiting]} activeOnly />)).toContain('Load more requests');
    expect(html(<IrisRequestActivityView feed={feed({ nextCursor: 'c2' })} summary={waiting} events={[irisEvent()]} />)).toContain(
      'Load older activity'
    );
  });

  it('disables while loading and offers a retry with the error after a failure', () => {
    const loading = html(<IrisActivityListView feed={feed({ nextCursor: 'c2', loadingMore: true })} requests={[waiting]} activeOnly />);
    expect(loading).toContain('aria-disabled="true"');
    expect(loading).not.toMatch(/<button[^>]*\sdisabled/);
    expect(loading).toContain('aria-busy="true"');
    const failed = html(
      <IrisActivityListView feed={feed({ nextCursor: 'c2', loadMoreError: 'Activity could not be loaded.' })} requests={[waiting]} activeOnly />
    );
    expect(failed).toContain('Try again');
    expect(failed).toContain('role="alert"');
  });
});
