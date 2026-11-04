import {describe,expect,it,vi} from 'vitest';
import {isValidElement,type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import AppointmentCard from './AppointmentCard';
import type {AppointmentItem} from '../types/appointment';

const appointment:AppointmentItem={_id:'synthetic_visit',status:'work_verifying',requestId:{_id:'synthetic_request',issueTitle:'Synthetic kitchen repair'},completion:{status:'submitted',needsVerification:true,workPerformed:'First work note.\nSecond complete work note.',partsUsed:'A connection seal',photos:[{url:'data:image/png;base64,AA==',label:'Finished connection',stage:'after'}],followUpNeeded:true,followUpNotes:'Inspect after ordinary use.',autoConfirmAt:'2099-11-04T12:00:00Z'}};
const render=(next=appointment,audience:'tenant'|'landlord'='tenant')=>renderToStaticMarkup(<AppointmentCard appointment={next} audience={audience}/>);
function nodes(node:ReactNode):ReactElement<any>[]{if(Array.isArray(node))return node.flatMap(nodes);if(!isValidElement(node))return[];const e=node as ReactElement<any>;return[e,...nodes(e.props.children)];}

describe('tenant work evidence grouping',()=>{
 it('can omit only the demo dispute action while retaining verification, rating, evidence and busy guards',()=>{
  const onVerify=vi.fn(),onDispute=vi.fn(),onRatingChange=vi.fn();
  for(const busy of [false,true]){
   const elements=nodes(AppointmentCard({appointment,audience:'tenant',hideCompletionDispute:true,busy,onVerify,onDispute,onRatingChange}));
   expect(elements.some(e=>e.props['data-testid']==='appointment-dispute-synthetic_visit')).toBe(false);
   const verify=elements.find(e=>e.props['data-testid']==='appointment-verify-synthetic_visit')!;
   expect(verify.props.disabled).toBe(busy);
   expect(elements.find(e=>e.props['data-testid']==='appointment-rate-4')).toBeDefined();
   if(!busy){verify.props.onClick();expect(onVerify).toHaveBeenCalledOnce();}
  }
  expect(onDispute).not.toHaveBeenCalled();
  const out=renderToStaticMarkup(<AppointmentCard appointment={appointment} audience="tenant" hideCompletionDispute/>);
  expect(out).toContain('Photos supplied');expect(out).toContain('First work note.');expect(out).not.toContain('No, still broken');
 });
 it('provides native work/evidence headings with complete supplied notes and original image link',()=>{
  const out=render();expect(out).toMatch(/<h4[^>]*>.*?Was this fixed\?/s);expect(out).toContain('aria-label="Work notes"');expect(out).toMatch(/<h5[^>]*>Work notes<\/h5>/);expect(out).toContain('First work note.\nSecond complete work note.');expect(out).toContain('Parts used: A connection seal');expect(out).toMatch(/<h5[^>]*>Photos supplied<\/h5>/);expect(out).toContain('alt="Finished connection"');expect(out).toContain('href="data:image/png;base64,AA=="');expect(out).toContain('Follow-up needed: Inspect after ordinary use.');expect(out).toContain('otherwise your manager will review it.');
 });
 it('does not manufacture work notes, photos, or a financial result when evidence is absent',()=>{
  const next={...appointment,finalCost:240,completion:{...appointment.completion!,workPerformed:'',partsUsed:'',photos:[],followUpNeeded:false}} as AppointmentItem;
  const out=render(next);expect(out).not.toContain('aria-label="Work notes"');expect(out).not.toContain('Photos supplied');expect(out).not.toMatch(/Final payable|Approved booking cap|CAD|\$240|paid|settled/i);expect(out).toContain('Yes, it');
 });
 it('keeps verification/rating/dispute callbacks and their busy protection on the existing controls',()=>{
  const onVerify=vi.fn(),onDispute=vi.fn(),onRatingChange=vi.fn();
  const get=(busy:boolean)=>nodes(AppointmentCard({appointment,audience:'tenant',busy,onVerify,onDispute,onRatingChange}));
  const enabled=get(false),verify=enabled.find(e=>e.props['data-testid']==='appointment-verify-synthetic_visit')!,dispute=enabled.find(e=>e.props['data-testid']==='appointment-dispute-synthetic_visit')!,rating=enabled.find(e=>e.props['data-testid']==='appointment-rate-4')!;
  verify.props.onClick();dispute.props.onClick();rating.props.onClick();expect(onVerify).toHaveBeenCalledOnce();expect(onDispute).toHaveBeenCalledOnce();expect(onRatingChange).toHaveBeenCalledExactlyOnceWith(4);
  const disabled=get(true);expect(disabled.find(e=>e.props['data-testid']==='appointment-verify-synthetic_visit')!.props.disabled).toBe(true);expect(disabled.find(e=>e.props['data-testid']==='appointment-dispute-synthetic_visit')!.props.disabled).toBe(true);
 });
 it('retains server-driven action availability and the landlord read-only presentation',()=>{
  const next={...appointment,completion:{...appointment.completion!,needsVerification:false,confirmation:{outcome:'confirmed',respondedAt:'2026-11-03T12:00:00Z',rating:4,autoConfirmed:false}}} as AppointmentItem;
  const out=render(next);expect(out).not.toContain('appointment-verify-synthetic_visit');expect(out).not.toContain('Rate this job');expect(out).toContain('Confirmed by the tenant');
  const landlord=render(appointment,'landlord');expect(landlord).not.toContain('Photos supplied');expect(landlord).not.toContain('aria-label="Work notes"');expect(landlord).not.toContain('appointment-verify-synthetic_visit');
 });
});
