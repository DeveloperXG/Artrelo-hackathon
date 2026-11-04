import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import TenantSidebar from './TenantSidebar';
import { TenantPresentationProvider } from './tenantPresentation';

const captured=vi.hoisted(()=>({logout:undefined as undefined|(()=>void)}));
vi.mock('../FeedbackButton',()=>({default:({variant}:{variant:string})=><button data-feedback-variant={variant}>Send feedback</button>}));
vi.mock('../ui/button',()=>({Button:({children,onClick,...props}:{children:ReactNode;onClick:()=>void})=>{captured.logout=onClick;return <button data-testid={(props as any)['data-testid']}>{children}</button>;}}));
function render(active:boolean,path='/portal',onLogout=vi.fn()){
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><TenantPresentationProvider active={active}><TenantSidebar mobile userName="Synthetic Tenant With A Longer Family Name" onLogout={onLogout} badges={{schedule:1234}}/></TenantPresentationProvider></MemoryRouter>);
}
describe('tenant sidebar active presentation preserves role-only navigation',()=>{
  it('uses one native anchor per active item with the original routes, current state and accurate badge meaning',()=>{
    for(const path of ['/portal','/portal/new','/portal/safety','/portal/requests/owned','/portal/schedule','/portal/settings']){
      const html=render(true,path);
      expect(html.match(/<a /g)).toHaveLength(3);
      for(const href of ['/portal','/portal/schedule','/portal/settings'])expect(html).toContain(`href="${href}"`);
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).not.toContain('tabindex=');
      for(const label of ['Requests','Schedule','Settings','Send feedback','Logout','Tenant Portal'])expect(html).toContain(label);
      if(path==='/portal/schedule')expect(html).not.toContain('1234 waiting on you');
      else{expect(html).toContain('aria-label="1234 waiting on you"');expect(html).toContain('9+');}
      expect(html).not.toMatch(/Ask Iris|Wallet|Payments|Decisions Needed|Policy|Landlord/);
    }
  });
  it('retains the legacy default presentation while active scope has full labels and delegates logout unchanged',()=>{
    const logout=vi.fn();
    const active=render(true,'/portal',logout);
    expect(active).not.toContain('truncate');
    expect(active).toContain('Synthetic Tenant With A Longer Family Name');
    expect(active).toContain('data-feedback-variant="row"');
    expect(logout).not.toHaveBeenCalled();
    captured.logout?.(); expect(logout).toHaveBeenCalledTimes(1);
    const legacy=render(false);
    expect(legacy).toContain('bg-[#137fec]');
    expect(legacy).toContain('truncate');
    expect(legacy).toContain('data-feedback-variant="outline"');
    expect(legacy).not.toContain('aria-label="Tenant"');
  });
});
