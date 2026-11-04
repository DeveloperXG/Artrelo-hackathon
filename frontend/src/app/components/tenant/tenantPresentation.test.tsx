import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TenantPage, TenantPageHeader, TenantPresentationProvider, useTenantPresentation } from './tenantPresentation';
import { useD3Presentation } from '../request-detail/d3Presentation';

function SharedConsumer() { return <span data-tenant={useTenantPresentation()} data-landlord={useD3Presentation()}>Shared consumer</span>; }
describe('tenant presentation boundary', () => {
  it('defaults off for shared consumers outside the authoritative shell scope', () => {
    expect(renderToStaticMarkup(<TenantPage><SharedConsumer /></TenantPage>)).toContain('data-tenant="false"');
    expect(renderToStaticMarkup(<TenantPage><SharedConsumer /></TenantPage>)).not.toContain('lichen-d5');
  });
  it('propagates only the supplied tenant scope without enabling landlord D3', () => {
    const html=renderToStaticMarkup(<TenantPresentationProvider active><TenantPage><SharedConsumer /></TenantPage></TenantPresentationProvider>);
    expect(html).toContain('data-tenant="true"');
    expect(html).toContain('data-landlord="false"');
    expect(renderToStaticMarkup(<TenantPresentationProvider active={false}><SharedConsumer /></TenantPresentationProvider>)).toContain('data-tenant="false"');
  });
  it('retains the caller title, description, actions and disabled state in its tenant header', () => {
    const html=renderToStaticMarkup(<TenantPresentationProvider active><TenantPageHeader title="Settings" description="Preferences stay unavailable until implemented." titleTestId="owned-title" actions={<button disabled>Unavailable</button>} /></TenantPresentationProvider>);
    expect(html).toContain('data-testid="owned-title">Settings</h1>');
    expect(html).toContain('Preferences stay unavailable until implemented.');
    expect(html).toContain('<button disabled="">Unavailable</button>');
  });
});
