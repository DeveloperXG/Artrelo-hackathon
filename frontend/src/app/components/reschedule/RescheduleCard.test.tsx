import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RescheduleCard from './RescheduleCard';
import { PreviewResult, SOURCE_LABEL } from './AvailabilityPreview';
import { tenantDeadlineCopy } from '../AppointmentCard';
import { change } from './rescheduleFixtures';

const html = (props: Parameters<typeof RescheduleCard>[0]) => renderToStaticMarkup(<RescheduleCard {...props} />);

describe('visit change card', () => {
  it('separates tenant visit times from responses/deadline without changing original or proposed evidence', () => {
    const out = html({ change: change(), audience: 'tenant' });
    expect(out).toMatch(/<h4[^>]*>Visit times<\/h4>/);
    expect(out).toContain('aria-label="Visit times"');
    expect(out).toMatch(/<h4[^>]*>Responses and deadline<\/h4>/);
    expect(out).toContain('aria-label="Responses and deadline"');
    expect(out).toContain('Booked visit (unchanged for now)');
    expect(out).toContain('Proposed new time');
    expect(out).toContain('If the vendor and the tenant have not both confirmed by then');
    expect(html({ change: change(), audience: 'landlord' })).not.toContain('Responses and deadline');
    expect(html({ change: change(), audience: 'vendor' })).not.toContain('Responses and deadline');
  });
  it('lets only the tenant accept or keep the original, and never prints the candidate digest', () => {
    const tenant = html({ change: change(), audience: 'tenant' });
    expect(tenant).toContain('visit-change-accept');
    expect(tenant).toContain('Keep the original time');
    expect(tenant).toContain('Tenant asked for an afternoon visit.');
    expect(tenant).toContain('Booked visit (unchanged for now)');
    expect(tenant).not.toContain('a'.repeat(64));
    expect(tenant).not.toContain('6ae2c0000000000000000001');
  });

  it('shows the manager a waiting state with withdraw, and no way to confirm for the tenant', () => {
    const owner = html({ change: change(), audience: 'landlord' });
    expect(owner).not.toContain('visit-change-accept');
    expect(owner).not.toContain('type="checkbox"');
    expect(owner).toContain('You cannot confirm it for the tenant.');
    expect(owner).toContain('Withdraw change request');
    expect(owner).toContain('It does not cancel the visit.');
  });

  it('gives the vendor a decline that keeps the original visit', () => {
    const vendor = html({ change: change({ status: 'awaiting_vendor', proposed: null, slotKey: null, tenantResponse: 'pending', vendorResponse: 'pending' }), audience: 'vendor' });
    expect(vendor).toContain('Decline the change and keep the original visit');
    expect(vendor).toContain('No new time proposed yet');
  });

  it('hides answers the server does not allow', () => {
    const tenant = html({ change: change({ canTenantRespond: false, canDecline: false }), audience: 'tenant' });
    expect(tenant).not.toContain('visit-change-accept');
    expect(tenant).not.toContain('visit-change-decline');
  });

  it.each([
    ['expired', 'Expired; the original visit is kept'],
    ['declined', 'Declined; the original visit is kept'],
    ['conflict', 'The new time was unavailable; the original visit is kept'],
    ['invalidated', 'No longer valid; the original visit is kept'],
  ] as const)('labels a %s change and offers no actions', (status, label) => {
    const out = html({ change: change({ status, active: false, canTenantRespond: false, canDecline: false }), audience: 'tenant' });
    expect(out).toContain(label);
    expect(out).toContain('Earlier change request');
    expect(out).not.toContain('<button');
  });

  it('calls the replaced slot previous once the change committed', () => {
    const out = html({ change: change({ status: 'committed', active: false, canTenantRespond: false, canDecline: false }), audience: 'landlord' });
    expect(out).toContain('Previous visit');
    expect(out).toContain('New visit');
  });

  it('flags a candidate outside the suggested windows', () => {
    expect(html({ change: change({ outsideSuggestedWindows: true }), audience: 'tenant' })).toContain('Outside the windows the property manager suggested.');
  });

  it('names actual actors in history and separates delivery from in-app notices for the manager only', () => {
    const view = change({ delivery: [{ audience: 'tenant', status: 'disabled', inAppRecorded: true }, { audience: 'vendor', status: 'disabled', inAppRecorded: false }],
      events: [{ type: 'requested', revision: 1, actor: 'landlord', at: '2026-10-29T12:00:00Z' },
        { type: 'vendor_confirmed_slot', revision: 2, actor: 'vendor', at: '2026-10-29T13:00:00Z', proposed: change().proposed }] });
    const owner = html({ change: view, audience: 'landlord' });
    expect(owner).toContain('Tenant: Not sent: delivery is off · In-app notice recorded');
    expect(owner).toContain('Vendor: Not sent: delivery is off');
    expect(owner).toContain('Property manager');
    expect(owner).toContain('Vendor confirmed a new time');
    expect(html({ change: view, audience: 'tenant' })).not.toContain('visit-change-delivery');
  });

  it('shows the two-hour cutoff and a shortened deadline in history as a system step', () => {
    const view = change({ events: [{ type: 'response_deadline_shortened', revision: 3, actor: 'system', at: '2026-10-29T13:00:00Z',
      deadlineAt: '2026-10-30T13:00:00Z', previousDeadlineAt: '2026-10-30T17:00:00Z', responseBufferMinutes: 120 }] });
    const out = html({ change: view, audience: 'tenant' });
    expect(out).toContain('two hours before the booked visit or the proposed time');
    expect(out).toContain('Answer deadline moved earlier');
    expect(out).toContain('Artrelo (automatic check)');
    expect(out).toMatch(/Answer by .+ \(was .+\)\./);
  });
});

describe('availability preview result', () => {
  const preview = { source: 'local_rules' as const, timeZone: 'America/Regina', asOf: '2026-10-29T12:00:00Z',
    windows: [{ start: '2026-10-30T20:00:00Z', end: '2026-10-30T22:00:00Z' }], needsClarification: false, question: null };

  it('shows exact times in the named zone and says no AI was used', () => {
    const out = renderToStaticMarkup(<PreviewResult preview={preview} mode="windows" onApply={() => undefined} />);
    expect(out).toContain('(America/Regina)');
    expect(out).toContain('No AI was used.');
    expect(out).toContain('Put these times in the form');
    expect(SOURCE_LABEL.development_stub).toMatch(/not a live AI model/);
  });

  it('asks for clarification and offers nothing to apply', () => {
    const out = renderToStaticMarkup(<PreviewResult preview={{ ...preview, windows: [], needsClarification: true,
      question: 'Include am/pm for both times, or use 24-hour times such as 14:00 to 16:00.' }} mode="windows" onApply={() => undefined} />);
    expect(out).toContain('No times were read from that text.');
    expect(out).toContain('Include am/pm');
    expect(out).not.toContain('<button');
  });

  it('offers one start per window to the vendor', () => {
    expect(renderToStaticMarkup(<PreviewResult preview={preview} mode="start" onApply={() => undefined} />)).toContain('Use this start time');
  });
});

describe('repair response deadline', () => {
  it('makes automatic resolution conditional and names manager review, with no payment claim', () => {
    const copy = tenantDeadlineCopy('2026-11-04T18:00:00Z');
    expect(copy).toMatch(/^Please respond by .+\. If you do not respond, the repair may be resolved automatically when verification checks allow; otherwise your manager will review it\.$/);
    expect(copy).not.toMatch(/pa(id|y)/i);
    expect(tenantDeadlineCopy('2026-11-04T18:00:00Z', 'landlord')).toMatch(/comes to you for review/);
    expect(tenantDeadlineCopy('nonsense')).toBe('');
  });
});
