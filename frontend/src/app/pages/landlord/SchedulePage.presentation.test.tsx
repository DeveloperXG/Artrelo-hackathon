import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import type { AppointmentItem } from '../../types/appointment';

// Deterministic page/hook host: actual page selectors and handlers execute.
// Native routing, layout, calendar interaction and focus are browser QA work.
const host=vi.hoisted(()=>({
 active:true,wide:true,path:'/dashboard/schedule',filter:null as string|null,
 appointments:[] as AppointmentItem[],loading:false,error:'',
 effects:[] as (()=>void|(()=>void))[],stats:[] as Record<string,any>[],calendar:null as Record<string,any>|null,
 roleCalls:[] as string[],queries:[] as string[],retry:null as null|(()=>void),
 navigate:vi.fn(),reload:vi.fn(),seen:vi.fn(),
}));
vi.mock('react',async importOriginal=>{
 const actual=await importOriginal<typeof import('react')>();
 return {...actual,useState:()=>[host.filter,(next:unknown)=>{host.filter=typeof next==='function'?(next as (value:string|null)=>string|null)(host.filter):next as string|null;}],useEffect:(effect:()=>void|(()=>void))=>{host.effects.push(effect);}};
});
vi.mock('react-router-dom',()=>({useNavigate:()=>host.navigate,useLocation:()=>({pathname:host.path}),Link:({to,children,...props}:{to:string;children:ReactNode})=><a {...props} href={to}>{children}</a>}));
vi.mock('../../lib/lichenRoutes',()=>({isLichenLandlordPath:()=>host.active}));
vi.mock('../../hooks/useAppointments',()=>({useAppointments:(role:string)=>{host.roleCalls.push(role);return{appointments:host.appointments,loading:host.loading,error:host.error,reload:host.reload};}}));
vi.mock('../../hooks/useMediaQuery',()=>({useMediaQuery:(query:string)=>{host.queries.push(query);return host.wide;}}));
vi.mock('../../hooks/landlord/useLandlordBadges',()=>({markScheduleSeen:()=>host.seen()}));
vi.mock('../../components/landlord/StatCard',()=>({default:(props:Record<string,any>)=>{host.stats.push(props);return <button data-testid={props.testId}>{props.label}:{props.value}</button>;},StatGrid:({children}:{children:ReactNode})=><div>{children}</div>}));
vi.mock('../../components/landlord/schedule/ScheduleCalendar',()=>({default:(props:Record<string,any>)=>{host.calendar=props;return <div data-testid="actual-calendar-inputs"/>;}}));
vi.mock('../../components/landlord/landlordUi',()=>({
 useLandlordEntrance:()=>{},PageContainer:({children,className}:{children:ReactNode;className?:string})=><div className={className}>{children}</div>,
 LandlordLoading:({label}:{label:string})=><div role="status">{label}</div>,
 LandlordError:({title,message,onRetry}:{title:string;message:string;onRetry:()=>void})=>{host.retry=onRetry;return <div role="alert">{title}:{message}</div>;},
 EmptyState:({title,description,testId}:{title:string;description:string;testId:string})=><div data-testid={testId}>{title}:{description}</div>,
}));
import LandlordSchedulePage from './SchedulePage';

const item=(id:string,status:AppointmentItem['status'],date:string|null,extra:Partial<AppointmentItem>={}):AppointmentItem=>({_id:id,status,confirmedStart:date,requestId:'request_'+id,...extra});
const fixtures=()=>[
 item('unscheduled','awaiting_vendor',null),
 item('scheduled','scheduled','2099-11-03T14:00:00Z'),
 item('tenant','awaiting_tenant','2099-11-03T14:00:00Z'),
 item('signoff','work_verifying','2000-11-03T14:00:00Z'),
 item('review','in_review','2099-11-04T14:00:00Z'),
 item('declined','proposed','2099-11-03T14:00:00Z',{tenantConfirmation:{respondedAt:'2026-11-01T10:00:00Z'}}),
];
const render=()=>{host.stats=[];host.effects=[];host.calendar=null;return renderToStaticMarkup(<LandlordSchedulePage/>);};
beforeEach(()=>{
 host.active=true;host.wide=true;host.filter=null;host.loading=false;host.error='';host.appointments=fixtures();
 host.roleCalls=[];host.queries=[];host.retry=null;host.navigate.mockClear();host.reload.mockClear();host.seen.mockClear();
});
describe('landlord Schedule preserves its read-only scheduling contract',()=>{
 it('keeps the four canonical counts, all calendar inputs and unscheduled-first chronological attention order',()=>{
  const html=render();
  expect(host.stats.map(stat=>[stat.label,stat.value])).toEqual([['Upcoming visits',2],['Awaiting tenant',1],['Awaiting sign-off',1],['Needs review',2]]);
  expect(host.calendar?.appointments).toEqual(host.appointments);
  expect([...html.matchAll(/data-testid="schedule-attention-([^"]+)"/g)].map(match=>match[1])).toEqual(['unscheduled','signoff','tenant','declined','review']);
  expect(html).toContain('Time to be confirmed');expect(html).toContain('Needs a new time');
  expect(host.roleCalls).toEqual(['landlord']);
 });
 it('executes the existing toggle semantics, including same-tile clear and switching filters',()=>{
  render();host.stats.find(stat=>stat.testId==='schedule-filter-awaiting_tenant')!.onClick();render();
  expect(host.calendar?.appointments.map((row:AppointmentItem)=>row._id)).toEqual(['tenant']);
  expect(host.stats.find(stat=>stat.testId==='schedule-filter-awaiting_tenant')!.active).toBe(true);
  host.stats.find(stat=>stat.testId==='schedule-filter-review')!.onClick();render();
  expect(host.calendar?.appointments.map((row:AppointmentItem)=>row._id)).toEqual(['review','declined']);
  host.stats.find(stat=>stat.testId==='schedule-filter-review')!.onClick();render();
  expect(host.filter).toBeNull();expect(host.calendar?.appointments).toEqual(host.appointments);
 });
 it('preserves request-id guards, exact navigation destination and property history link without new actions',()=>{
  const html=render();const open=host.calendar!.onOpen;
  open(item('raw','scheduled',null));expect(host.navigate).toHaveBeenLastCalledWith('/dashboard/requests/request_raw');
  open(item('populated','scheduled',null,{requestId:{_id:'original_request_identity'}}));expect(host.navigate).toHaveBeenLastCalledWith('/dashboard/requests/original_request_identity');
  host.navigate.mockClear();open(item('missing','scheduled',null,{requestId:null}));expect(host.navigate).not.toHaveBeenCalled();
  expect(html).toContain('href="/dashboard/properties"');
  for(const action of ['Confirm visit','This works','Approve','Report it','Send request'])expect(html).not.toContain('>'+action+'<');
 });
 it('preserves wide/phone initial calendar view and mark-seen mount/cleanup effect',()=>{
  render();expect(host.calendar?.initialView).toBe('week');expect(host.queries).toEqual(['(min-width: 768px)']);
  expect(host.effects).toHaveLength(1);const cleanup=host.effects[0]();expect(host.seen).toHaveBeenCalledTimes(1);
  expect(cleanup).toBeTypeOf('function');(cleanup as ()=>void)();expect(host.seen).toHaveBeenCalledTimes(2);
  host.wide=false;render();expect(host.calendar?.initialView).toBe('day');
 });
 it('preserves loading/error retry and original empty-state authority copy',()=>{
  host.loading=true;expect(render()).toContain('Loading the schedule...');expect(host.calendar).toBeNull();
  host.loading=false;host.error='Synthetic schedule refusal.';expect(render()).toContain('Schedule unavailable:Synthetic schedule refusal.');host.retry!();expect(host.reload).toHaveBeenCalledTimes(1);
  host.error='';host.appointments=[];expect(render()).toContain('Nothing booked');
  host.appointments=[item('scheduled','scheduled','2099-11-03T14:00:00Z')];expect(render()).toContain('Nothing waiting on anyone');
 });
 it('keeps complete authoritative long labels and scopes the presentation to the supplied route result',()=>{
  const issue='Inspect the kitchen supply connection and adjoining residential plumbing';
  const vendor='Cedar Residential Maintenance and Plumbing Collective';
  const property='North Cedar Residential Court and Garden Apartments';
  host.appointments=[item('long','awaiting_tenant',null,{requestId:{_id:'request_long',issueTitle:issue,propertyId:{name:property},unitId:{unitNumber:'Residential Suite 412B'}},vendorId:{_id:'vendor_long',name:vendor}})];
  const active=render();for(const label of [issue,vendor,property,'Residential Suite 412B'])expect(active).toContain(label);
  expect(active).toContain('lichen-d4-schedule');expect(host.stats.every(stat=>stat.wrap===true)).toBe(true);
  host.active=false;const legacy=render();expect(legacy).not.toContain('lichen-d4-schedule');expect(host.stats.every(stat=>stat.wrap===false)).toBe(true);
  expect(host.calendar?.appointments).toEqual(host.appointments);expect(host.navigate).not.toHaveBeenCalled();
 });
});
