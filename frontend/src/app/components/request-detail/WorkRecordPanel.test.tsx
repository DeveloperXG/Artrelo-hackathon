import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkVisitCard } from './WorkRecordPanel';
import type { WorkVisit } from './workRecordTypes';
import { JudgeSandboxController } from '../judge/judgeController';
import { JudgeSandboxProvider } from '../judge/JudgeSandboxProvider';
import { SANDBOX_OFF } from '../../contracts/judgeSandbox';
const visit: WorkVisit = { id: '507f191e810c19729de860eb', status: 'completed', vendorName: 'Test plumber',
  scheduledStart: null, scheduledEnd: null, createdAt: null, completedAt: null, failureReason: null, noShow: null,
  payment: { mode: 'platform', status: 'recorded', amountCents: null, paidAt: null,
    payouts: [{ id: 'p1', amountCents: 2000, status: 'paid', clearsOn: null }] },
  report: { id: 'c1', status: 'closed', source: 'vendor_portal', submittedAt: null, completedAt: null,
    workPerformed: 'Replaced <script>trap</script>', partsUsed: 'P-trap', followUpNeeded: true, followUpNotes: 'Recheck next week',
    reportedCost: 20, finalCost: 20, currency: 'CAD', approvedCeiling: 25, approvedOverage: null, closedAt: null, closeReason: 'tenant_confirmed',
    needsReview: false, checkIn: null, checkOut: null, evidenceVerdict: 'review', evidenceReasons: ['missing_check_in'],
    evidenceReviewedAt: null, photos: [], confirmation: { outcome: 'confirmed', rating: 5, comment: 'Fixed', respondedAt: '2026-10-20T00:00:00Z', autoConfirmed: false } },
};
describe('permanent work visit card', () => {
  it('marks only the new itemized final-statement section, not legacy work/payment or ordinary users', () => {
    const controller = new JudgeSandboxController({ api: { status: async () => { throw Error('No requests'); }, start: async () => { throw Error('No writes'); }, act: async () => { throw Error('No writes'); } } });
    controller.view = { ...controller.getView(), loaded: true, status: { ...SANDBOX_OFF, enabled: true, role: 'landlord' } };
    const itemized = { ...visit, report: { ...visit.report!, itemization: { pricingMode: 'fixed' as const, currency: 'CAD' as const, items: [{ lineId: 'line1', category: 'labour' as const, description: 'Recorded work', amountMinor: 2000 }], totals: { lowMinor: 2000, highMinor: 2000 } } } };
    const marked = renderToStaticMarkup(<JudgeSandboxProvider controller={controller}><WorkVisitCard visit={itemized} number={1} /></JudgeSandboxProvider>);
    expect(marked.split('Built during the hackathon')).toHaveLength(2); expect(marked).toContain('Final statement');
    expect(marked).toContain('Bank receipt needs separate confirmation');
    expect(renderToStaticMarkup(<JudgeSandboxProvider controller={controller}><WorkVisitCard visit={visit} number={1} /></JudgeSandboxProvider>)).not.toContain('Built during the hackathon');
    expect(renderToStaticMarkup(<WorkVisitCard visit={itemized} number={1} />)).not.toContain('Built during the hackathon');
  });
  it('retains absent evidence warnings on a completed job and distinguishes transfer status from receipt', () => {
    const html = renderToStaticMarkup(<WorkVisitCard visit={visit} number={2} />);
    expect(html).toContain('Visit 2'); expect(html).toContain('missing check in');
    expect(html).toContain('No photos or videos recorded'); expect(html).toContain('Location not recorded');
    expect(html).toContain('Bank receipt needs separate confirmation'); expect(html).toContain('paid');
    expect(html).toContain('Replaced &lt;script&gt;trap&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('Follow-up recommended'); expect(html).toContain('Tenant review');
  });
  it('keeps failed visits visible without inventing a vendor report', () => {
    const html = renderToStaticMarkup(<WorkVisitCard visit={{ ...visit, status: 'failed', report: null, failureReason: 'no_show' }} number={1} />);
    expect(html).toContain('no show'); expect(html).toContain('No vendor work report');
  });
  it('labels vendor GPS honestly and preserves original evidence links and upload times', () => {
    const html = renderToStaticMarkup(<WorkVisitCard visit={{ ...visit, report: { ...visit.report!,
      checkIn: { source: 'client_reported', at: '2026-10-20T00:00:00Z', lat: 51, lng: -104,
        accuracyMeters: 45, distanceMeters: 80, verdict: 'review' },
      photos: [{ url: 'https://evidence.test/before.jpg', type: 'image', stage: 'before', label: 'Drain', receivedAt: '2026-10-20T00:00:00Z', exifTakenAt: null }] } }} number={1} />);
    expect(html).toContain('not independent proof'); expect(html).toContain('±45 m');
    expect(html).toContain('https://evidence.test/before.jpg'); expect(html).toContain('Open original'); expect(html).toContain('Uploaded');
  });
});
