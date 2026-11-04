import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ScheduleCalendar from './ScheduleCalendar';
import { CalendarEventBlock, LandlordSchedulePresentationContext, VisitSummary, landlordVisitClasses, LANDLORD_SCHEDULE_PORTAL, LandlordVisitPreviewFocus } from './CalendarEvent';
import { TenantPresentationProvider } from '../../tenant/tenantPresentation';
import type { AppointmentItem } from '../../../types/appointment';
import * as HoverPrimitives from '../../ui/hover-card';
import * as PopoverPrimitives from '../../ui/popover';

const start=new Date(2026,10,2,10);
const visit=(status:AppointmentItem['status']='scheduled',extra:Partial<AppointmentItem>={}):AppointmentItem=>({
 _id:status,status,confirmedStart:start.toISOString(),confirmedEnd:new Date(2026,10,2,11).toISOString(),
 requestId:{_id:'request_identity',issueTitle:'Inspect kitchen supply connection',propertyId:{name:'North Cedar Court'},unitId:{unitNumber:'412B'}},
 vendorId:{_id:'vendor_identity',name:'Cedar Plumbing Collective'},...extra,
});
const render=(props:Partial<React.ComponentProps<typeof ScheduleCalendar>>={})=>renderToStaticMarkup(<ScheduleCalendar appointments={[visit()]} initialView="day" onOpen={()=>{}} {...props}/>);
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(start);});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('landlord Schedule presentation boundary and calendar contract',()=>{
 it('identifies only the selected active landlord view with an existing-foreground shape cue without changing selection or inactive consumers',()=>{
  for(const initialView of ['day','week','month'] as const){
   const views=(html:string)=>[...html.matchAll(/aria-pressed="([^"]+)" data-testid="schedule-view-([^"]+)" class="([^"]+)"/g)].map(match=>({selected:match[1]==='true',view:match[2],classes:match[3].split(' ')}));
   const active=views(render({initialView,landlordPresentation:true}));expect(active).toHaveLength(3);
   for(const option of active){expect(option.selected).toBe(option.view===initialView);for(const cue of ['underline','decoration-current','decoration-2','underline-offset-4'])expect(option.classes.includes(cue)).toBe(option.selected);}
   for(const props of [{initialView},{initialView,landlordPresentation:false},{initialView,audience:'tenant' as const,landlordPresentation:true}])for(const option of views(render(props)))expect(option.classes).not.toContain('underline');
  }
 });
 it('adds discoverable keyboard preview help only in active landlord scope and keeps exact click navigation',()=>{
  const triggers:any[]=[],roots:any[]=[],opened=vi.fn();
  vi.spyOn(HoverPrimitives,'HoverCard').mockImplementation(({children,...props})=>{roots.push(props);return <>{children}</>;});
  vi.spyOn(HoverPrimitives,'HoverCardTrigger').mockImplementation(({children})=>{triggers.push(children);return <>{children}</>;});
  vi.spyOn(HoverPrimitives,'HoverCardContent').mockImplementation(()=>null);
  const appointments=[visit()];
  render({appointments,landlordPresentation:true,onOpen:opened});
  expect(roots[0].open).toBe(false);expect(roots[0].onOpenChange).toBeTypeOf('function');
  expect(triggers[0].props['aria-description']).toContain('Arrow Down');expect(triggers[0].props['aria-keyshortcuts']).toBe('ArrowDown');expect(triggers[0].props['aria-haspopup']).toBeUndefined();
  triggers[0].props.onClick();expect(opened).toHaveBeenLastCalledWith(appointments[0]);
  triggers.length=0;roots.length=0;render({appointments,initialView:'month',landlordPresentation:true,onOpen:opened});triggers[0].props.onClick();expect(opened).toHaveBeenLastCalledWith(appointments[0]);
  triggers.length=0;roots.length=0;render({appointments,landlordPresentation:false});
  // Noncompact legacy events do not gain a hover wrapper or shortcut.
  expect(triggers).toHaveLength(0);expect(roots).toHaveLength(0);
 });
 it('constrains actual active day/month/hover portal props to matching Radix space while leaving legacy props unchanged',()=>{
  const hover=vi.spyOn(HoverPrimitives,'HoverCardContent').mockImplementation(()=>null);
  const popover=vi.spyOn(PopoverPrimitives,'PopoverContent').mockImplementation(()=>null);
  const appointments=Array.from({length:10},(_,i)=>visit('scheduled',{_id:'overlap_'+i}));
  const check=()=>{
   expect(hover.mock.calls.length).toBeGreaterThan(0);expect(popover.mock.calls.length).toBeGreaterThan(0);
   for(const[props]of hover.mock.calls){expect(props.side).toBe('bottom');expect(props.collisionPadding).toBe(16);expect(props.style?.maxWidth).toContain('--radix-hover-card-content-available-width');expect(props.style?.maxHeight).toContain('--radix-hover-card-content-available-height');}
   for(const[props]of popover.mock.calls){expect(props.collisionPadding).toBe(16);expect(props.style?.maxWidth).toContain('--radix-popover-content-available-width');expect(props.style?.maxHeight).toContain('--radix-popover-content-available-height');}
  };
  render({appointments,landlordPresentation:true});check();
  hover.mockClear();popover.mockClear();render({appointments,initialView:'month',landlordPresentation:true});check();
  hover.mockClear();popover.mockClear();render({appointments});
  for(const[props]of hover.mock.calls){expect(props.side).toBe('right');expect(props.collisionPadding).toBeUndefined();expect(props.style).toBeUndefined();}
  for(const[props]of popover.mock.calls){expect(props.collisionPadding).toBeUndefined();expect(props.style).toBeUndefined();}
 });
 it('supplies explicit light theme, Plex, focus and motion scope at detached portal roots',()=>{
  const classes=LANDLORD_SCHEDULE_PORTAL.split(' ');
  for(const token of ['lichen','lichen-light','lichen-d4-calendar','font-sans','text-ink','motion-reduce:animate-none!','motion-reduce:transition-none!','[&_button]:focus-visible:outline-ring'])expect(classes).toContain(token);
  expect(classes).toContain('max-w-[calc(100vw-32px)]');expect(classes).toContain('overflow-y-auto');
 });
 it('leaves omitted/default-false landlord markup identical and rejects tenant audience scope',()=>{
  expect(render()).toBe(render({landlordPresentation:false}));
  expect(render()).not.toContain('lichen-d4-calendar');
  expect(render({audience:'tenant',landlordPresentation:true})).toBe(render({audience:'tenant'}));
  const tenant=(enabled:boolean)=>renderToStaticMarkup(<TenantPresentationProvider active><ScheduleCalendar appointments={[visit('awaiting_tenant')]} initialView="day" audience="landlord" landlordPresentation={enabled} onOpen={()=>{}}/></TenantPresentationProvider>);
  expect(tenant(true)).toBe(tenant(false));expect(tenant(true)).toContain('in-[.lichen-d5]');
 });
 it('retains day/week/month date labels, event identity and canonical geometry under active presentation',()=>{
  for(const initialView of ['day','week','month'] as const){
   const legacy=render({initialView}),active=render({initialView,landlordPresentation:true});
   const title=(html:string)=>html.match(/data-testid="schedule-range-title">([^<]+)/)?.[1];
   expect(title(active)).toBe(title(legacy));
   expect(active).toContain('data-testid="schedule-event-scheduled"');
   const controls=(html:string)=>[...html.matchAll(/aria-pressed="([^"]+)" data-testid="schedule-view-([^"]+)"/g)].map(match=>[match[2],match[1]]);
   expect(controls(active)).toHaveLength(3);expect(controls(active)).toEqual(controls(legacy));
   if(initialView!=='month'){
    const geometry=(html:string)=>html.match(/data-testid="schedule-event-scheduled" style="([^"]+)"/)?.[1];
    expect(geometry(active)).toBe(geometry(legacy));expect(geometry(active)).toContain('height:61px');
    expect(active).toContain('aria-label="Appointment time grid"');
   }else expect(active).toContain('aria-label="Appointment month grid"');
  }
 });
 it('keeps unplaced/invalid visits off the calendar without inventing a time',()=>{
  const html=render({landlordPresentation:true,appointments:[visit(),visit('awaiting_vendor',{confirmedStart:null}),visit('failed',{confirmedStart:'invalid'})]});
  expect(html).toContain('schedule-event-scheduled');expect(html).not.toContain('schedule-event-awaiting_vendor');expect(html).not.toContain('schedule-event-failed');
 });
 it('preserves exact status labels and gives confirmed/completed calendar graphics Mist roles',()=>{
  const statuses:AppointmentItem['status'][]=['scheduled','completed','awaiting_tenant','awaiting_vendor','work_verifying','in_review','disputed','cancelled','failed','proposed'];
  for(const status of statuses){
   const appointment=visit(status);
   const legacy=renderToStaticMarkup(<VisitSummary appointment={appointment} start={start}/>);
   const active=renderToStaticMarkup(<LandlordSchedulePresentationContext.Provider value><VisitSummary appointment={appointment} start={start}/></LandlordSchedulePresentationContext.Provider>);
   const text=(html:string)=>html.replace(/<[^>]+>/g,'');expect(text(active)).toBe(text(legacy));
  }
  expect(landlordVisitClasses(visit()).block).toContain('bg-mist-tint');
  expect(landlordVisitClasses(visit('completed'))).toMatchObject({block:'border-mist-text bg-mist-tint',pill:'bg-pill-neutral text-chip-icon'});
  expect(landlordVisitClasses(visit('proposed',{tenantConfirmation:{respondedAt:start.toISOString()}})).pill).toBe('bg-lichen-tint text-lichen-text');
 });
 it('retains full summary text and event button geometry/accessibility identity for long labels',()=>{
  const long='Cedar'.repeat(80),appointment=visit('scheduled',{requestId:{_id:'original',issueTitle:long,propertyId:{name:long},unitId:{unitNumber:long}},vendorId:{_id:'vendor',name:long}});
  const html=renderToStaticMarkup(<LandlordSchedulePresentationContext.Provider value><VisitSummary appointment={appointment} start={start}/></LandlordSchedulePresentationContext.Provider>);
  expect(html.match(new RegExp(long,'g'))).toHaveLength(4);expect(html).toContain('whitespace-normal');
  const block=renderToStaticMarkup(<LandlordSchedulePresentationContext.Provider value><CalendarEventBlock appointment={appointment} start={start} compact={false} style={{top:17,height:61,left:'3px',width:'calc(100% - 6px)'}} onOpen={()=>{}}/></LandlordSchedulePresentationContext.Provider>);
  expect(block).toContain('top:17px;height:61px;left:3px;width:calc(100% - 6px)');expect(block).toContain('data-testid="schedule-event-scheduled"');expect(block).toContain('aria-label="');expect(block).toContain('bg-mist-tint');
 });
});

function focusHost(){
 let active:any=null;const changes=vi.fn(),controller=new LandlordVisitPreviewFocus(changes);
 const element=()=>{const node:any={focus:vi.fn((options:unknown)=>{active=node;}),contains:(other:unknown)=>other===node};return node;};
 const trigger=element(),content=element(),outside=element();controller.setTrigger(trigger);controller.setContent(content);
 vi.stubGlobal('document',{get activeElement(){return active;}});
 const key=(value='ArrowDown',extra:Record<string,unknown>={})=>({key:value,defaultPrevented:false,preventDefault:vi.fn(),altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,...extra});
 return{controller,changes,trigger,content,outside,key,setActive:(node:unknown)=>{active=node;},getActive:()=>active};
}
describe('landlord visit preview focus lifecycle',()=>{
 it('opens on ArrowDown, waits for actual content mounting and focuses it without body scrolling',()=>{
  const h=focusHost();h.controller.setContent(null);const event=h.key();h.controller.onTriggerKeyDown(event as never);
  expect(event.preventDefault).toHaveBeenCalledOnce();expect(h.changes).toHaveBeenLastCalledWith(true);expect(h.content.focus).not.toHaveBeenCalled();
  h.controller.setContent(h.content);expect(h.content.focus).toHaveBeenCalledWith({preventScroll:true});expect(h.getActive()).toBe(h.content);
  const count=h.changes.mock.calls.length;h.controller.onOpenChange(false);expect(h.changes).toHaveBeenCalledTimes(count);
 });
 it('closes on Escape, restores the exact trigger and suppresses the delayed focus reopen without suppressing a fresh pointer entry',()=>{
  const h=focusHost();h.controller.onTriggerKeyDown(h.key() as never);const escape=h.key('Escape');h.controller.onEscapeKeyDown(escape as never);
  expect(escape.preventDefault).toHaveBeenCalledOnce();expect(h.changes).toHaveBeenLastCalledWith(false);expect(h.trigger.focus).toHaveBeenCalledWith({preventScroll:true});expect(h.getActive()).toBe(h.trigger);
  h.controller.onTriggerFocus({relatedTarget:h.content} as never);const count=h.changes.mock.calls.length;h.controller.onOpenChange(true);expect(h.changes).toHaveBeenCalledTimes(count);
  h.controller.onPointerEnter();h.controller.onOpenChange(true);expect(h.changes).toHaveBeenLastCalledWith(true);h.controller.onOpenChange(false);expect(h.changes).toHaveBeenLastCalledWith(false);
 });
 it('lets Tab/ShiftTab leave naturally and closes without trapping or stealing outside focus',()=>{
  const h=focusHost();h.controller.onTriggerKeyDown(h.key() as never);h.setActive(h.outside);
  const blur={currentTarget:h.content,relatedTarget:h.outside,preventDefault:vi.fn()};h.controller.onContentBlur(blur as never);
  expect(h.changes).toHaveBeenLastCalledWith(false);expect(h.getActive()).toBe(h.outside);expect(blur.preventDefault).not.toHaveBeenCalled();expect(h.trigger.focus).not.toHaveBeenCalled();
  h.controller.onTriggerKeyDown(h.key() as never);h.setActive(h.trigger);h.controller.onContentBlur({currentTarget:h.content,relatedTarget:h.trigger} as never);h.controller.onTriggerFocus({relatedTarget:h.content} as never);
  const count=h.changes.mock.calls.length;h.controller.onOpenChange(true);expect(h.changes).toHaveBeenCalledTimes(count);
  h.controller.onTriggerFocus({relatedTarget:h.outside} as never);h.controller.onOpenChange(true);expect(h.changes).toHaveBeenLastCalledWith(true);
 });
 it('leaves Enter, Space, Tab and modified arrows to their original handlers',()=>{
  const h=focusHost();for(const event of [h.key('Enter'),h.key(' '),h.key('Tab'),h.key('ArrowUp'),h.key('ArrowDown',{ctrlKey:true}),h.key('ArrowDown',{shiftKey:true})]){h.controller.onTriggerKeyDown(event as never);expect(event.preventDefault).not.toHaveBeenCalled();}
  expect(h.changes).not.toHaveBeenCalled();expect(h.content.focus).not.toHaveBeenCalled();
 });
 it('ignores late events after disposal, clears pending focus and supports effect remount without timers',()=>{
  const h=focusHost();h.controller.setContent(null);h.controller.onTriggerKeyDown(h.key() as never);h.controller.dispose();h.changes.mockClear();h.controller.setContent(h.content);
  h.controller.onOpenChange(true);h.controller.onTriggerKeyDown(h.key() as never);h.controller.onEscapeKeyDown(h.key('Escape') as never);expect(h.changes).not.toHaveBeenCalled();expect(h.content.focus).not.toHaveBeenCalled();
  h.controller.mount();h.controller.onTriggerKeyDown(h.key() as never);expect(h.changes).toHaveBeenLastCalledWith(true);expect(h.content.focus).toHaveBeenCalledWith({preventScroll:true});expect(vi.getTimerCount()).toBe(0);
 });
});
