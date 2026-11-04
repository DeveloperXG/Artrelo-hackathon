import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { D3Page, D3PresentationScope, d3PriorityClass, d3StatusClass, useD3Presentation } from './d3Presentation';

const activation = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('../../lib/lichenRoutes', () => ({ isLichenLandlordPath: (path: string) => activation.allowed.has(path) }));

function SharedConsumer() {
  return <span data-d3={useD3Presentation() ? 'active' : 'legacy'}>Shared child</span>;
}
const render = (path: string, children: React.ReactNode) => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>);

describe('D3 presentation scope isolation', () => {
  beforeEach(() => activation.allowed.clear());
  it('requires authoritative shared-route activation before restyling the page', () => {
    const html = render('/dashboard/requests', <D3Page><SharedConsumer /></D3Page>);
    expect(html).not.toContain('lichen-d3');
    expect(html).toContain('data-d3="legacy"');
  });
  it('carries the active page scope to shared children', () => {
    activation.allowed.add('/dashboard/requests');
    const html = render('/dashboard/requests', <D3Page><SharedConsumer /></D3Page>);
    expect(html).toContain('lichen-d3');
    expect(html).toContain('data-d3="active"');
  });
  it('defaults off outside the D3 page even on an already Lichen screen', () => {
    activation.allowed.add('/dashboard/activity');
    expect(render('/dashboard/activity', <SharedConsumer />)).toContain('data-d3="legacy"');
  });
  it('leaves tenant shared descendants off while the landlord detail provider follows activation', () => {
    activation.allowed.add('/dashboard/requests/owned');
    expect(render('/tenant/requests/owned', <D3PresentationScope><SharedConsumer /></D3PresentationScope>)).toContain('data-d3="legacy"');
    expect(render('/dashboard/requests/owned', <D3PresentationScope><SharedConsumer /></D3PresentationScope>)).toContain('data-d3="active"');
  });
  it('preserves the distinct approved maintenance pill roles', () => {
    expect(d3StatusClass('approved')).toContain('bg-mist-tint');
    expect(d3StatusClass('contacting_vendor')).toContain('text-mist-text');
    expect(d3StatusClass('assigned')).toContain('bg-pill-neutral');
    expect(d3StatusClass('completed')).toContain('bg-chip');
    expect(d3StatusClass('completed')).not.toContain('mist');
    expect(d3StatusClass('needs_approval')).toContain('text-lichen-pill');
    expect(d3StatusClass('rejected')).toContain('text-alert-text');
    expect(d3PriorityClass('high')).toContain('text-alert-text');
    expect(d3PriorityClass('medium')).toContain('text-lichen-text');
    expect(d3PriorityClass('low')).toContain('text-chip-icon');
  });
});
