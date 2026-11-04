import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import CarriedUpdateCard from './CarriedUpdateCard';
import { TenantPresentationProvider } from './tenantPresentation';
import type { RequestDetailRecord } from '../request-detail/requestDetailTypes';

const fixture=vi.hoisted(()=>({stored:null as null | {body:string;submissionId:string;savedAt:string}}));
vi.mock('../../api/client',()=>({TenantAPI:{}}));
vi.mock('../../auth/AuthContext',()=>({useAuth:()=>({user:{id:'synthetic_tenant'}})}));
vi.mock('../../lib/requestWorkflow',()=>({readCarriedDraft:()=>fixture.stored,clearCarriedDraft:vi.fn(),workflowConflict:()=>null}));
vi.mock('../../hooks/useSubmissionKey',()=>({useSubmissionKey:()=>({idFor:()=> 'synthetic_submission',reset:vi.fn()})}));
const draft={body:'Complete original unsaved tenant update.',submissionId:'synthetic_submission',savedAt:'2026-11-01T08:00:00Z'};
const request={_id:'synthetic_request'} as RequestDetailRecord;
const replaced=vi.fn();
const render=(active:boolean,carryover?:typeof draft)=>renderToStaticMarkup(
 <MemoryRouter initialEntries={[{pathname:'/portal/requests/synthetic_request',state:carryover?{carryover}:null}]}>
  <TenantPresentationProvider active={active}><CarriedUpdateCard request={request} onRequestReplaced={replaced}/></TenantPresentationProvider>
 </MemoryRouter>);
beforeEach(()=>{fixture.stored=null;replaced.mockClear();});
describe('carried-update route arrival intent',()=>{
 it('offers only the explicit active route draft as a preferred enabled textarea while preserving its complete body',()=>{
  const html=render(true,draft);
  expect(html).toMatch(/<textarea[^>]*data-tenant-route-focus="carried-update"/);
  expect(html).toContain(draft.body);expect(html).toContain('Nothing is saved until you choose Add update.');
  expect(html).not.toMatch(/<textarea[^>]*disabled=/);expect(replaced).not.toHaveBeenCalled();
 });
 it('does not mark a storage-only restored draft as explicit route arrival intent',()=>{
  fixture.stored=draft;const html=render(true);
  expect(html).toContain(draft.body);expect(html).not.toContain('data-tenant-route-focus');
  expect(replaced).not.toHaveBeenCalled();
 });
 it('preserves inactive and absent-draft behavior without a route focus marker',()=>{
  expect(render(false,draft)).not.toContain('data-tenant-route-focus');
  expect(render(true)).not.toContain('carried-update-body');expect(replaced).not.toHaveBeenCalled();
 });
});
