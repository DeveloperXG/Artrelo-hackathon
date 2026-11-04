import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM package is installed. These are deterministic hook/scheduler host
// fixtures, not native keyboard or browser focus evidence.
const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], effects: [] as { deps: unknown[]; cleanup?: () => void }[], pending: [] as (() => void)[], refIndex: 0, effectIndex: 0 }));
vi.mock('react', () => ({
  useRef: (value: unknown) => hooks.refs[hooks.refIndex++] ?? (hooks.refs[hooks.refIndex - 1] = { current: value }),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const i = hooks.effectIndex++;
    const old = hooks.effects[i];
    if (!old || deps.some((value, j) => value !== old.deps[j])) hooks.pending.push(() => {
      old?.cleanup?.(); hooks.effects[i] = { deps, cleanup: effect() || undefined };
    });
  },
}));
import { rescueTenantRouteFocus, useTenantRouteFocus } from './useTenantRouteFocus';
import { isLichenTenantPath } from '../../lib/lichenRoutes';

class Node extends EventTarget {
  isConnected = true; shown = true; hiddenAncestor = false;
  tagName = 'DIV'; disabled = false; fieldsetDisabled = false; visibility = 'visible'; value = '';
  attrs = new Map<string, string>(); headings: Node[] = []; fields: Node[] = []; calls = 0;
  getClientRects() { return this.shown ? [{}] : []; }
  closest() { return this.hiddenAncestor ? this : null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string) { this.attrs.delete(name); }
  matches(selector: string) {
    if (selector === ':disabled') return this.disabled || this.fieldsetDisabled || this.attrs.has('disabled');
    throw Error('Unexpected host-fixture match selector');
  }
  querySelectorAll(selector: string) {
    if (selector === 'h1') return this.headings;
    if (selector === 'textarea[data-tenant-route-focus="carried-update"]') return this.fields.filter(field => field.tagName === 'TEXTAREA' && field.getAttribute('data-tenant-route-focus') === 'carried-update');
    throw Error('Unexpected host-fixture destination selector');
  }
  focus() {
    const previous = doc.activeElement;
    doc.activeElement = this; this.calls++;
    previous?.dispatchEvent(new Event('blur'));
    doc.dispatchEvent(new Event('focusin'));
  }
}
let doc: EventTarget & { body: Node; activeElement: Node; querySelectorAll: (selector: string) => Node[] };
let main: Node;
let overlays: Node[];
let outsideFields: Node[];
let frames: Map<number, () => void>;
let observers: { callback: () => void; connected: boolean; target?: Node; options?: MutationObserverInit }[];
let id = 0;
const asElement = (node: Node) => node as unknown as HTMLElement;
const flush = () => { const work = [...frames.values()]; frames.clear(); work.forEach(callback => callback()); };
const mutation = (attribute?: string) => observers.filter(o => o.connected && (!attribute || o.options?.attributeFilter?.includes(attribute))).forEach(o => o.callback());
const lost = () => { const control = new Node(); control.focus(); control.isConnected = false; doc.activeElement = doc.body; return control; };
const ref = { current: null as HTMLElement | null };
const render = (path: string, active = true) => {
  hooks.refIndex = 0; hooks.effectIndex = 0;
  useTenantRouteFocus(active, path, ref);
  hooks.pending.splice(0).forEach(effect => effect());
};
beforeEach(() => {
  hooks.refs = []; hooks.effects = []; hooks.pending = []; hooks.refIndex = 0; hooks.effectIndex = 0;
  main = new Node(); ref.current = asElement(main); overlays = []; outsideFields = []; frames = new Map(); observers = [];
  const body = new Node();
  doc = Object.assign(new EventTarget(), { body, activeElement: body, querySelectorAll: (selector: string) => selector === 'textarea[data-tenant-route-focus="carried-update"]' ? [...outsideFields, ...main.querySelectorAll(selector)] : overlays });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('getComputedStyle', (node: Node) => ({ visibility: node.visibility }));
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
  vi.stubGlobal('MutationObserver', class {
    entry: (typeof observers)[number];
    constructor(callback: () => void) { this.entry = { callback, connected: false }; observers.push(this.entry); }
    observe(target: Node, options: MutationObserverInit) { this.entry.connected = true; this.entry.target = target; this.entry.options = options; }
    disconnect() { this.entry.connected = false; }
  });
});
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });

const carried = (overrides: Partial<Node> = {}) => {
  const field = Object.assign(new Node(), { tagName: 'TEXTAREA', value: 'Exact unsaved carried body.\nNothing saved yet.' }, overrides);
  field.setAttribute('data-tenant-route-focus', 'carried-update');
  return field;
};

describe('active tenant route focus lifecycle (synthetic host)', () => {
  it('excludes initial mount, query-only rerender and activation without a pathname change', () => {
    render('/portal'); lost(); render('/portal'); flush(); expect(main.calls).toBe(0);
    render('/portal', false); render('/portal', true); flush(); expect(main.calls).toBe(0);
  });
  it('takes default-enabled eligibility only from the existing matcher and preserves explicit-OFF/aliases', () => {
    for (const path of ['/portal', '/portal/new', '/portal/safety', '/portal/schedule', '/portal/settings', '/portal/requests/owned/']) {
      expect(isLichenTenantPath(path)).toBe(true);
      expect(isLichenTenantPath(path, false)).toBe(false);
    }
    for (const path of ['/portal/unknown', '/portal/requests/a/deeper', '/tenant', '/vendor', '/dashboard']) {
      render('/portal'); lost(); render(path, isLichenTenantPath(path, true)); flush(); expect(main.calls).toBe(0);
    }
    render('/portal'); lost(); render('/portal/new', isLichenTenantPath('/portal/new', false)); flush(); expect(main.calls).toBe(0);
    render('/portal'); lost(); render('/portal/new', isLichenTenantPath('/portal/new')); flush(); expect(main.calls).toBe(1);
  });
  it('rescues a removed control to the visible loaded heading once and restores its temporary tabindex', () => {
    render('/portal/safety'); lost(); const heading = new Node(); main.headings = [heading];
    render('/portal/requests/owned'); flush();
    expect(doc.activeElement).toBe(heading); expect(heading.getAttribute('tabindex')).toBe('-1'); expect(heading.calls).toBe(1);
    mutation(); expect(heading.calls).toBe(1);
    new Node().focus(); expect(heading.hasAttribute('tabindex')).toBe(false);
  });
  it('remembers real keyboard-origin activeElement without focusin, and removes the listener when disabled', () => {
    render('/portal/safety'); const control = new Node();
    doc.activeElement = control; // Host sets DOM focus but emits no focusin.
    doc.dispatchEvent(new Event('keydown'));
    control.isConnected = false; doc.activeElement = doc.body;
    const heading = new Node(); main.headings = [heading];
    render('/portal/requests/owned'); flush(); expect(doc.activeElement).toBe(heading);
    render('/portal/requests/owned', false);
    const other = new Node(); doc.activeElement = other; doc.dispatchEvent(new Event('keydown'));
    other.isConnected = false; doc.activeElement = doc.body;
    render('/portal/new', false); flush(); expect(heading.calls).toBe(1);
  });
  it('focuses labelled main while loading, skips hidden headings, then hands off to visible loaded heading', () => {
    lost(); const stop = rescueTenantRouteFocus(asElement(main)); flush();
    expect(doc.activeElement).toBe(main); expect(observers[0].target).toBe(main);
    const hidden = new Node(); hidden.hiddenAncestor = true; main.headings = [hidden]; mutation(); expect(hidden.calls).toBe(0);
    const loaded = new Node(); main.headings.push(loaded); mutation();
    expect(doc.activeElement).toBe(loaded); expect(observers[0].connected).toBe(false); stop();
  });
  it('keeps main as the error fallback without repeatedly focusing it', () => {
    lost(); const stop = rescueTenantRouteFocus(asElement(main)); flush(); mutation(); mutation();
    expect(main.calls).toBe(1); expect(doc.activeElement).toBe(main); stop();
    expect(observers[0].connected).toBe(false);
  });
  it.each(['keydown', 'pointerdown', 'focusin'])('cancels pending load handoff on %s', event => {
    lost(); const stop = rescueTenantRouteFocus(asElement(main)); flush();
    doc.dispatchEvent(new Event(event)); const heading = new Node(); main.headings = [heading]; mutation();
    expect(heading.calls).toBe(0); expect(observers[0].connected).toBe(false); stop();
  });
  it('preserves Menu and deliberate focus both before and after the route effect', () => {
    render('/portal/safety'); lost(); const menu = new Node(); menu.focus(); render('/portal/new'); flush(); expect(doc.activeElement).toBe(menu);
    lost(); render('/portal/schedule'); menu.focus(); flush(); expect(doc.activeElement).toBe(menu); expect(main.calls).toBe(0);
  });
  it.each(['dialog', 'popover'])('does not steal focus when a visible %s is opening', () => {
    lost(); overlays = [new Node()]; const stop = rescueTenantRouteFocus(asElement(main)); flush(); expect(main.calls).toBe(0); stop();
    overlays = []; lost(); const cancel = rescueTenantRouteFocus(asElement(main)); flush(); overlays = [new Node()]; main.headings = [new Node()]; mutation(); expect(main.headings[0].calls).toBe(0); cancel();
  });
  it('cancels obsolete frames and observers on rapid routes, disable and unmount', () => {
    render('/portal/safety'); lost(); render('/portal/new'); render('/portal/requests/owned');
    const heading = new Node(); main.headings = [heading]; flush(); expect(heading.calls).toBe(1);
    lost(); main.headings = []; render('/portal/schedule'); flush(); expect(observers.at(-1)?.connected).toBe(true);
    render('/portal/schedule', false); expect(observers.at(-1)?.connected).toBe(false);
    lost(); const stop = rescueTenantRouteFocus(asElement(main)); stop(); flush(); expect(frames.size).toBe(0);
  });
  it('does not focus an intentional body blur, a hidden main or a disconnected destination', () => {
    render('/portal'); const control = new Node(); control.focus(); doc.activeElement = doc.body; render('/portal/new'); flush(); expect(main.calls).toBe(0);
    lost(); main.shown = false; const stop = rescueTenantRouteFocus(asElement(main)); flush(); expect(main.calls).toBe(0); stop();
  });
});

describe('fixed carried-arrival presentation intent (synthetic host)', () => {
  it('prefers the marked textarea over h1 after a removed-control route arrival, without changing its body or tab order', () => {
    render('/portal/new'); lost();
    const field = carried(); const heading = new Node();
    main.fields = [field]; main.headings = [heading];
    const exactBody = field.value;
    render('/portal/requests/owned'); flush();
    expect(doc.activeElement).toBe(field); expect(heading.calls).toBe(0);
    expect(field.value).toBe(exactBody); expect(field.hasAttribute('tabindex')).toBe(false);
    new Node().focus(); expect(field.hasAttribute('tabindex')).toBe(false);
  });

  it.each([
    ['hidden rectangle', (field: Node) => { field.shown = false; }],
    ['hidden/inert ancestor', (field: Node) => { field.hiddenAncestor = true; }],
    ['hidden visibility', (field: Node) => { field.visibility = 'hidden'; }],
    ['disconnected field', (field: Node) => { field.isConnected = false; }],
    ['disabled field', (field: Node) => { field.disabled = true; }],
    ['disabled attribute', (field: Node) => { field.setAttribute('disabled', ''); }],
    ['disabled fieldset', (field: Node) => { field.fieldsetDisabled = true; }],
    ['unmarked storage-only draft', (field: Node) => { field.removeAttribute('data-tenant-route-focus'); }],
    ['wrong marker content', (field: Node) => { field.setAttribute('data-tenant-route-focus', 'carried-update, input'); }],
    ['marked non-textarea', (field: Node) => { field.tagName = 'INPUT'; }],
  ])('keeps h1 fallback for %s', (_label, configure) => {
    lost(); const field = carried(); configure(field);
    const heading = new Node(); main.fields = [field]; main.headings = [heading];
    const stop = rescueTenantRouteFocus(asElement(main)); flush();
    expect(doc.activeElement).toBe(heading); expect(field.calls).toBe(0);
    expect(field.value).toBe('Exact unsaved carried body.\nNothing saved yet.');
    stop();
  });

  it('ignores marked fields outside the current main and preserves an existing textarea tabindex', () => {
    lost(); const outside = carried(); outsideFields = [outside];
    const heading = new Node(); main.headings = [heading];
    const stop = rescueTenantRouteFocus(asElement(main)); flush();
    expect(doc.activeElement).toBe(heading); expect(outside.calls).toBe(0); stop();
    lost(); const inside = carried(); inside.setAttribute('tabindex', '0'); main.fields = [inside];
    const cancel = rescueTenantRouteFocus(asElement(main)); flush(); new Node().focus(); cancel();
    expect(inside.getAttribute('tabindex')).toBe('0');
  });

  it('prefers a late marked arrival over a simultaneous h1 only while main still owns focus', () => {
    lost(); const stop = rescueTenantRouteFocus(asElement(main)); flush(); expect(doc.activeElement).toBe(main);
    const field = carried(); const heading = new Node(); main.fields = [field]; main.headings = [heading]; mutation();
    expect(doc.activeElement).toBe(field); expect(heading.calls).toBe(0); expect(observers[0].connected).toBe(false);
    mutation(); expect(field.calls).toBe(1); stop();
  });

  it('observes an exact marker added to an existing unmarked field during main-owned loading', () => {
    lost(); const field = carried(); field.removeAttribute('data-tenant-route-focus'); main.fields = [field];
    const stop = rescueTenantRouteFocus(asElement(main)); flush(); expect(doc.activeElement).toBe(main);
    field.setAttribute('data-tenant-route-focus', 'carried-update'); mutation('data-tenant-route-focus');
    expect(doc.activeElement).toBe(field); stop();
  });

  it('waits on labelled main until a marked textarea becomes enabled', () => {
    lost(); const field = carried({ disabled: true }); main.fields = [field];
    const stop = rescueTenantRouteFocus(asElement(main)); flush(); expect(doc.activeElement).toBe(main);
    field.disabled = false; mutation('disabled'); expect(doc.activeElement).toBe(field); stop();
  });

  it.each(['keydown', 'pointerdown', 'focusin'])('cancels a late carried arrival on %s', type => {
    lost(); const stop = rescueTenantRouteFocus(asElement(main)); flush();
    doc.dispatchEvent(new Event(type)); const field = carried(); main.fields = [field]; mutation();
    expect(field.calls).toBe(0); expect(observers[0].connected).toBe(false); stop();
  });

  it('preserves deliberate focus before the frame and during a delayed arrival', () => {
    lost(); const field = carried(); main.fields = [field]; const stop = rescueTenantRouteFocus(asElement(main));
    const deliberate = new Node(); deliberate.focus(); flush(); expect(doc.activeElement).toBe(deliberate); expect(field.calls).toBe(0); stop();
    lost(); main.fields = []; const cancel = rescueTenantRouteFocus(asElement(main)); flush();
    deliberate.focus(); main.fields = [field]; mutation(); expect(doc.activeElement).toBe(deliberate); expect(field.calls).toBe(0); cancel();
  });

  it.each(['dialog', 'popover'])('preserves a newly opened %s instead of either carried or h1 focus', () => {
    lost(); const field = carried(); main.fields = [field]; main.headings = [new Node()]; overlays = [new Node()];
    const stop = rescueTenantRouteFocus(asElement(main)); flush(); expect(field.calls).toBe(0); stop();
    overlays = []; lost(); main.fields = []; main.headings = []; const cancel = rescueTenantRouteFocus(asElement(main)); flush();
    overlays = [new Node()]; main.fields = [field]; mutation(); expect(field.calls).toBe(0); expect(observers.at(-1)?.connected).toBe(false); cancel();
  });

  it('never revisits a completed h1 fallback when the carried marker arrives later', () => {
    lost(); const heading = new Node(); main.headings = [heading]; const stop = rescueTenantRouteFocus(asElement(main)); flush();
    const field = carried(); main.fields = [field]; mutation();
    expect(doc.activeElement).toBe(heading); expect(field.calls).toBe(0); stop();
  });

  it('cancels obsolete carried handoffs on navigation and disable/unmount', () => {
    render('/portal/new'); lost(); render('/portal/requests/old'); flush();
    const oldMain = main; const oldField = carried(); oldMain.fields = [oldField]; const oldObserver = observers[0];
    const departing = new Node(); departing.focus(); departing.isConnected = false; doc.activeElement = doc.body;
    oldMain.isConnected = false; main = new Node(); ref.current = asElement(main); const nextField = carried(); main.fields = [nextField];
    render('/portal/requests/next'); oldObserver.callback(); flush();
    expect(oldField.calls).toBe(0); expect(doc.activeElement).toBe(nextField);
    render('/portal/requests/next', false); hooks.effects.forEach(effect => effect.cleanup?.()); mutation();
    expect(nextField.calls).toBe(1);
  });

  it('does not turn a marker into autofocus on initial/query-only/explicit-OFF/unknown routes', () => {
    const field = carried(); main.fields = [field];
    render('/portal/requests/owned'); flush(); expect(field.calls).toBe(0);
    lost(); render('/portal/requests/owned'); flush(); expect(field.calls).toBe(0);
    render('/portal/requests/owned', false); lost(); render('/portal/new', false); flush(); expect(field.calls).toBe(0);
    render('/portal/new'); lost(); render('/portal/unknown', isLichenTenantPath('/portal/unknown', true)); flush(); expect(field.calls).toBe(0);
  });
});
