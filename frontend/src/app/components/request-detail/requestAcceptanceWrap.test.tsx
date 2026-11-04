import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import RequestDetailHero from './RequestDetailHero';
import RequestDetailTabs from './RequestDetailTabs';
import RequestOverviewPanel from './RequestOverviewPanel';
import type { RequestDetailRecord } from './requestDetailTypes';

vi.mock('../judge/JudgeSandboxProvider', () => ({ useIsSimulatedVendor: () => false, useJudgeSandboxEnabled: () => false }));
const request = {
  _id: 'wrap_fixture', status: 'queued', urgency: 'medium', category: 'Plumbing',
  issueTitle: 'Synthetic request', issueDescription: 'Original tenant words stay visible.',
  createdAt: '2026-10-31T12:00:00.000Z',
} as RequestDetailRecord;
const render = (children: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{children}</MemoryRouter>);

// Geometry is measured in the rendered fixture and connected acceptance. These
// assertions protect audience, content and marker meaning, not CSS spellings.
describe('request labels and states without D3 activation', () => {
  it('keeps tenant urgency separate from a pending safety assessment', () => {
    for (const safetyAssessment of [undefined, { state: 'needs_review', nextActor: 'landlord' }]) {
      const markup = render(<RequestDetailHero request={{ ...request, safetyAssessment } as RequestDetailRecord}
        headline="Tenant headline" propertyLabel="Cedar Court" unitLabel="4B" lifecycleStatus="queued" metrics={[]} isLandlord={false} />);
      const opening = markup.match(/<span[^>]*data-testid="tenant-(?:urgency|safety-review)"[^>]*>/)?.[0];
      expect(opening).toBeDefined();
      if (safetyAssessment) expect(opening).toContain('data-pending="true"');
      else expect(opening).not.toContain('data-pending');
      expect(markup).toContain('Tenant headline');
    }
  });
  it('retains all five controls, one selected tab and accessible update-marker meanings', () => {
    const markup = render(<RequestDetailTabs activeTab="overview" onChange={() => {}} indicators={{ routing: true, activity: true, messages: 12 }} routingNeedsManager />);
    expect(markup.match(/role="tab"/g)).toHaveLength(5);
    for (const key of ['overview','routing','work','messages','activity']) expect(markup).toContain(`data-testid="detail-tab-${key}"`);
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup).toContain('(needs your attention)');
    expect(markup).toContain('(updated)');
    expect(markup).toContain('9+');
    expect(markup).toContain('new messages');
  });
  it('retains full assessment qualifications for landlords and withholds their badges from tenants', () => {
    const vendor = 'LongUnbrokenSpecialistTradeLabelForContainment';
    const responsibility = 'Landlord responsibility with the original authoritative qualification';
    const assessed = { ...request, ai: { summary: 'Assessment fixture', suggestedVendorType: vendor, suggestedResponsibility: responsibility, severity: 3 } };
    const markup = render(<RequestOverviewPanel request={assessed} isLandlord />);
    expect(markup).toContain(vendor); expect(markup).toContain(responsibility); expect(markup).toContain('Severity: 3/5');
    expect(markup).toContain('Original tenant words stay visible.');
    const tenant = render(<RequestOverviewPanel request={assessed} isLandlord={false} />);
    expect(tenant).toContain('Assessment fixture');
    expect(tenant).not.toContain(vendor);
    expect(tenant).not.toContain(responsibility);
    expect(tenant).not.toContain('Severity:');
  });
});
