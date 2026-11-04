import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { TenantPresentationProvider } from './tenantPresentation';
import RequestOverviewPanel from '../request-detail/RequestOverviewPanel';
import RequestMessagesPanel from '../request-detail/RequestMessagesPanel';
import RequestActivityPanel from '../request-detail/RequestActivityPanel';
import AppointmentCard from '../AppointmentCard';
import ArchivedRequestRow from '../archive/ArchivedRequestRow';
import RescheduleCard from '../reschedule/RescheduleCard';
import EvidenceCapture from './EvidenceCapture';
import { NewRequestButton, CreationGateNotice, SafetyConcernLink } from './NewRequestGate';
import type { RequestDetailRecord } from '../request-detail/requestDetailTypes';
import type { AppointmentItem } from '../../types/appointment';
import type { RescheduleView } from '../../types/booking';

vi.mock('../../api/client',()=>({TenantAPI:{},BookingAPI:{},EvidenceAPI:{},ApiError:class extends Error{}}));
vi.mock('../judge/JudgeSandboxProvider',()=>({useIsSimulatedVendor:()=>false,useJudgeSandboxEnabled:()=>false}));
const render=(child:ReactNode,active=false)=>renderToStaticMarkup(<MemoryRouter><TenantPresentationProvider active={active}>{child}</TenantPresentationProvider></MemoryRouter>);
const text=(html:string)=>html.replace(/<[^>]*>/g,'');
const request={_id:'synthetic_request',issueTitle:'Sink leak',issueDescription:'Original tenant words. '.repeat(30),status:'queued',urgency:'medium',category:'Plumbing',createdAt:'2026-10-31T12:00:00Z',ai:{summary:'Synthetic assessment.',suggestedVendorType:'Landlord-only trade',suggestedResponsibility:'Landlord-only responsibility',severity:3}} as RequestDetailRecord;
const visit:AppointmentItem={_id:'synthetic_visit',status:'awaiting_tenant',requestId:{_id:request._id,issueTitle:request.issueTitle},confirmedStart:'2099-11-03T14:00:00Z',confirmedEnd:'2099-11-03T16:00:00Z',vendorContact:{channel:'in_app',provider:'fixture',available:true,label:'Message the vendor in your request',phone:null}};
const change:RescheduleView={ref:'synthetic_change',revision:1,status:'awaiting_tenant',active:true,reason:'Vendor proposed another arrival.',original:{start:'2099-11-03T14:00:00Z',end:'2099-11-03T16:00:00Z'},proposed:{start:'2099-11-04T14:00:00Z',end:'2099-11-04T16:00:00Z'},outsideSuggestedWindows:true,slotKey:'synthetic_exact_candidate',windows:[],expiresAt:'2099-11-02T14:00:00Z',vendorResponse:'accepted',tenantResponse:'pending',canVendorConfirm:false,canTenantRespond:true,canDecline:true,delivery:[],events:[]};

describe('D5 shared presentation preserves authoritative audience and state',()=>{
 it('scopes evidence disclosure semantics while preserving disabled removal and original assets',()=>{
  const onChange=vi.fn(),assets=[{url:'/synthetic-qa-only.svg',type:'image' as const,label:'Synthetic evidence'}];
  const legacy=render(<EvidenceCapture category="Plumbing" assets={assets} onChange={onChange} disabled/>);
  const tenant=render(<EvidenceCapture category="Plumbing" assets={assets} onChange={onChange} disabled/>,true);
  expect(legacy).not.toContain('aria-expanded=');expect(legacy).not.toContain('aria-controls=');
  expect(tenant).toContain('aria-expanded="false"');expect(tenant).toContain('aria-controls=');
  for(const html of [legacy,tenant]){
   expect(html).toContain('alt="Synthetic evidence"');
   expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove"/);
  }
  expect(onChange).not.toHaveBeenCalled();
 });
 it('retains the full native disclosure, original label and Show affordance without exposing landlord assessments',()=>{
  for(const active of [false,true]){
   const html=render(<RequestOverviewPanel request={request} isLandlord={false}/>,active);
   expect(html).toContain('<details');expect(html).toContain('<summary');expect(html).toContain('Original tenant note');expect(html).toContain('Show');expect(html).toContain(request.issueDescription);
   expect(html).not.toContain('Landlord-only trade');expect(html).not.toContain('Landlord-only responsibility');
   expect(html).toContain(active?'role="region"':'role="tabpanel"');
  }
 });
 it('retains complete unbroken messages and disabled sending semantics in both scopes',()=>{
  const props={comments:[{authorId:'synthetic_tenant',authorRole:'tenant',body:'UnbrokenSyntheticTenantMessage'.repeat(10),at:'2026-10-31T12:00:00Z'}],comment:'',onCommentChange:vi.fn(),onSubmit:vi.fn(),sending:false,isLandlord:false};
  const legacy=render(<RequestMessagesPanel {...props}/>),tenant=render(<RequestMessagesPanel {...props}/>,true);
  expect(text(tenant)).toBe(text(legacy));expect(tenant).toContain(props.comments[0].body);
  expect(tenant).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Send comment"/);
  expect(tenant).toContain('aria-label="Add a comment as tenant"');
  expect(props.onSubmit).not.toHaveBeenCalled();
 });
 it('gives tenant sections independent accessible names while retaining landlord tab relationships',()=>{
  const props={items:[],error:'Synthetic activity read failed.'};
  expect(render(<RequestActivityPanel {...props}/>)).toContain('aria-labelledby="request-detail-tab-button-activity"');
  const html=render(<RequestActivityPanel {...props}/>,true);
  expect(html).toContain('role="region"');expect(html).toContain('aria-label="Activity"');expect(html).not.toContain('aria-labelledby="request-detail-tab-button-activity"');expect(html).toContain(props.error);
 });
 it.each(['tenant','landlord'] as const)('keeps %s appointment content and permitted controls unchanged',audience=>{
  const props={appointment:visit,audience,busy:true,onConfirm:vi.fn(),onDecline:vi.fn()};
  const legacy=render(<AppointmentCard {...props}/>),tenant=render(<AppointmentCard {...props}/>,true);
  expect(text(tenant)).toBe(text(legacy));
  expect(tenant.includes('This works')).toBe(audience==='tenant');expect(tenant.includes('Request another time')).toBe(audience==='tenant');
  if(audience==='tenant')expect(tenant).toMatch(/<button[^>]*disabled=""[^>]*data-testid="appointment-confirm-synthetic_visit"/);
  expect(props.onConfirm).not.toHaveBeenCalled();
 });
 it('keeps tenant completion review distinct from permission to confirm a visit',()=>{
  const appointment={...visit,status:'work_verifying',completion:{status:'submitted',needsVerification:true,workPerformed:'Synthetic work report.',partsUsed:'One seal.',followUpNeeded:false,followUpNotes:'',photos:[],autoConfirmAt:'2099-11-05T12:00:00Z'}} as AppointmentItem;
  const html=render(<AppointmentCard appointment={appointment} audience="tenant"/>,true);
  expect(html).toContain('Yes, it');expect(html).toContain('still broken');expect(html).toContain('otherwise your manager will review it.');expect(html).not.toContain('This works');
 });
 it('preserves exact-party response guards, original booking and cutoff copy under tenant styling',()=>{
  for(const active of [false,true]){
   const html=render(<RescheduleCard change={change} audience="tenant" busy/>,active);
   expect(html).toContain('Only you can confirm this time.');expect(html).toContain('Booked visit (unchanged for now)');expect(html).toContain('Accept new time');expect(html).toContain('Keep the original time');expect(html).toContain('two hours before the booked visit or the proposed time, whichever is earlier');
   expect(render(<RescheduleCard change={{...change,slotKey:null}} audience="tenant"/>,active)).not.toContain('Accept new time');
   expect(render(<RescheduleCard change={change} audience="landlord"/>,active)).not.toContain('Accept new time');
  }
 });
 it('retains archive destinations and tenant cost exclusion while leaving landlord work links intact',()=>{
  const archived={...request,status:'completed',finalCost:275,archivedAt:'2026-10-31T12:00:00Z'};
  for(const active of [false,true]){
   const html=render(<ArchivedRequestRow request={archived} to="/portal/requests/synthetic_request"/>,active);
   expect(html).toContain('href="/portal/requests/synthetic_request"');expect(html).not.toContain('$275');
   const manager=render(<ArchivedRequestRow request={archived} to="/dashboard/requests/synthetic_request" showCost/>,active);
   expect(manager).toContain('?tab=work');expect(manager).toContain('$275');
  }
 });
 it('keeps routine creation disabled until the authoritative gate allows it and preserves safety access',()=>{
  for(const active of [false,true]){
   const html=render(<><NewRequestButton linked gate={{status:'error'}} onClick={vi.fn()}/><CreationGateNotice gate={{status:'error'}} onRetry={vi.fn()}/><SafetyConcernLink/></>,active);
   expect(html).toContain('disabled=""');expect(html).toContain('aria-describedby="new-request-gate"');expect(html).toContain('href="/portal/safety"');expect(html).toContain('Retry');
  }
 });
});
