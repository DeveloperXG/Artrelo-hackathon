import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {restoreTenantCalendarFocus} from './TenantDialogs';

// Deterministic host for the one-frame handoff guard only. These checks are
// separate from real-component browser/keyboard evidence and claim no native UI.
class HostElement extends EventTarget {
 isConnected=true; calls=0; guard=false; children:HostElement[]=[];
 contains(element:unknown){return this.children.includes(element as HostElement);}
 hasAttribute(name:string){return name==='data-radix-focus-guard'&&this.guard;}
 focus(){this.calls++;doc.activeElement=this;}
}
let doc:EventTarget&{body:HostElement;documentElement:HostElement;activeElement:HostElement;querySelector:()=>HostElement|null};
let frames:(()=>void)[],overlay:HostElement|null;
const element=(host:HostElement)=>host as unknown as HTMLElement;
const flush=()=>frames.splice(0).forEach(frame=>frame());
beforeEach(()=>{
 frames=[];overlay=null;
 const body=new HostElement();
 doc=Object.assign(new EventTarget(),{body,documentElement:new HostElement(),activeElement:body,querySelector:()=>overlay});
 vi.stubGlobal('HTMLElement',HostElement);vi.stubGlobal('document',doc);
 vi.stubGlobal('requestAnimationFrame',(callback:()=>void)=>{frames.push(callback);return frames.length;});
});
afterEach(()=>vi.unstubAllGlobals());
describe('tenant exact-calendar return guard (synthetic host)',()=>{
 it('restores the exact surviving calendar destination after lost focus, once',()=>{
  const target=new HostElement();restoreTenantCalendarFocus(element(target),null);flush();flush();
  expect(doc.activeElement).toBe(target);expect(target.calls).toBe(1);
 });
 it('accepts focus still held by the closing form and restores only its supplied event',()=>{
  const target=new HostElement(),closing=new HostElement(),oldButton=new HostElement();closing.children=[oldButton];doc.activeElement=oldButton;
  restoreTenantCalendarFocus(element(target),element(closing));flush();expect(doc.activeElement).toBe(target);
 });
 it.each(['pointerdown','keydown'])('cancels return on a new %s even when focus remains BODY',type=>{
  const target=new HostElement();restoreTenantCalendarFocus(element(target),null);doc.dispatchEvent(new Event(type));flush();expect(target.calls).toBe(0);
 });
 it('preserves deliberate focus on a surviving control',()=>{
  const target=new HostElement(),other=new HostElement();restoreTenantCalendarFocus(element(target),null);doc.activeElement=other;flush();
  expect(doc.activeElement).toBe(other);expect(target.calls).toBe(0);
 });
 it.each(['dialog','alertdialog','popover'])('does not focus below a newly open %s',()=>{
  const target=new HostElement();restoreTenantCalendarFocus(element(target),null);overlay=new HostElement();flush();expect(target.calls).toBe(0);
 });
 it('drops the return when the page/event is removed by navigation or unmount',()=>{
  const target=new HostElement();restoreTenantCalendarFocus(element(target),null);target.isConnected=false;flush();expect(target.calls).toBe(0);
 });
 it('allows only the latest repeated handoff after new user input',()=>{
  const first=new HostElement(),second=new HostElement();restoreTenantCalendarFocus(element(first),null);
  doc.dispatchEvent(new Event('keydown'));restoreTenantCalendarFocus(element(second),null);flush();
  expect(first.calls).toBe(0);expect(second.calls).toBe(1);
 });
});
