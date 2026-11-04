import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NegotiatedReturnPanel from './NegotiatedReturnPanel';
import { VisitSchedule } from './BookingCoordinationPanel';

const history = [{ ref: 'old-offer', vendorName: 'Previous plumber', previousQuote: 20 }];

describe('return to a previous vendor', () => {
  it.each(['completed', 'cancelled', 'rejected'])('hides new agreements on %s requests despite eligible offer history', requestStatus => {
    expect(renderToStaticMarkup(<NegotiatedReturnPanel requestId="request" requestStatus={requestStatus} history={history} />)).toBe('');
  });

  it('hides new agreements on archived requests', () => {
    expect(renderToStaticMarkup(<NegotiatedReturnPanel requestId="request" requestStatus="approved" archivedAt="2026-10-20T00:00:00Z" history={history} />)).toBe('');
  });

  it('keeps negotiated return available for an open request with closed offers', () => {
    const html = renderToStaticMarkup(<NegotiatedReturnPanel requestId="request" requestStatus="approved" history={history} />);
    expect(html).toContain('Record a new agreement');
    expect(html).toContain('Return to a previous vendor');
  });
});

describe('visit schedule summary', () => {
  it.each([
    ['closed', 'Previous arrival'], ['expired', 'Previous arrival'],
    ['awaiting_tenant', 'Proposed arrival'], ['scheduled', 'Confirmed arrival'],
  ] as const)('labels the %s arrival accurately with a readable date, timezone and duration', (phase, label) => {
    const arrivalAt = '2026-10-20T15:00:00Z';
    const html = renderToStaticMarkup(<VisitSchedule phase={phase} arrivalAt={arrivalAt} durationMinutes={90} />);
    expect(html).toContain(`${label}:`);
    expect(html).toContain(`dateTime="${new Date(arrivalAt).toISOString()}"`);
    expect(html).toContain(new Date(arrivalAt).toLocaleString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }));
    expect(html).toContain('Duration: 1 hour 30 minutes');
    expect(html).not.toContain('local time');
  });

  it('does not invent an arrival or show an invalid date', () => {
    expect(renderToStaticMarkup(<VisitSchedule phase="preparing" durationMinutes={60} />)).toBe('');
    expect(renderToStaticMarkup(<VisitSchedule phase="closed" arrivalAt="invalid" />)).toBe('');
  });
});
