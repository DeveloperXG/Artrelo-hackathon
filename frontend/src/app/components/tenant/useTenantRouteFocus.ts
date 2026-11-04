import { useEffect, useRef, type RefObject } from 'react';

const OVERLAY = '[role="dialog"], [role="alertdialog"], [data-slot="popover-content"][data-state="open"]';
const visible = (element: HTMLElement) =>
  element.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
  element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';

/** Presentation only: the shell supplies its authoritative active-route result. */
export function useTenantRouteFocus(active: boolean, pathname: string, mainRef: RefObject<HTMLElement | null>) {
  const previousPath = useRef(pathname);
  const lastControl = useRef<Element | null>(null);

  useEffect(() => {
    if (!active) { lastControl.current = null; return; }
    const remember = () => {
      const control = document.activeElement;
      if (control && control !== document.body && control !== document.documentElement && control.isConnected) lastControl.current = control;
    };
    lastControl.current = null;
    remember();
    document.addEventListener('focusin', remember);
    // A real keyboard activation can identify the focused control even when
    // an unfocused host does not emit focusin. Never infer it from event.target.
    document.addEventListener('keydown', remember, true);
    return () => {
      document.removeEventListener('focusin', remember);
      document.removeEventListener('keydown', remember, true);
    };
  }, [active]);

  useEffect(() => {
    const changed = previousPath.current !== pathname;
    previousPath.current = pathname;
    if (!active || !changed || !mainRef.current) return;
    const previous = lastControl.current;
    // Only an observed control that vanished is loss: a surviving control's
    // intentional blur, or no observed control at all, does not trigger rescue.
    if (!previous || previous === document.body || previous.isConnected) return;
    return rescueTenantRouteFocus(mainRef.current);
  }, [active, pathname, mainRef]);
}

// Exported for deterministic lifecycle checks; no routing/data authority lives here.
export function rescueTenantRouteFocus(main: HTMLElement): () => void {
  let frame: number | null = null;
  let observer: MutationObserver | null = null;
  let stopped = false;
  let ownFocus = false;
  const cleanups: (() => void)[] = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    observer?.disconnect();
    document.removeEventListener('keydown', stop, true);
    document.removeEventListener('pointerdown', stop, true);
    document.removeEventListener('focusin', onFocus, true);
  };
  const onFocus = () => { if (!ownFocus) stop(); };
  const focus = (element: HTMLElement) => {
    // A native textarea already accepts focus; keep its normal tab order.
    const temporary = element.tagName !== 'TEXTAREA' && !element.hasAttribute('tabindex');
    if (temporary) element.setAttribute('tabindex', '-1');
    const restore = () => {
      if (temporary && element.getAttribute('tabindex') === '-1') element.removeAttribute('tabindex');
      element.removeEventListener('blur', restore);
    };
    element.addEventListener('blur', restore, { once: true });
    cleanups.push(restore);
    ownFocus = true;
    element.focus({ preventScroll: false });
    ownFocus = false;
  };
  const hasOverlay = () => Array.from(document.querySelectorAll<HTMLElement>(OVERLAY)).some(visible);
  const destination = () =>
    // The owned carried card marks only an explicit, enabled draft arrival.
    // This fixed presentation intent never reads, changes or saves its value.
    Array.from(main.querySelectorAll<HTMLTextAreaElement>('textarea[data-tenant-route-focus="carried-update"]'))
      .find(element => visible(element) && !element.matches(':disabled')) ??
    Array.from(main.querySelectorAll<HTMLElement>('h1')).find(visible);
  const handoff = () => {
    if (stopped) return;
    if (!main.isConnected || document.activeElement !== main || hasOverlay()) { stop(); return; }
    const target = destination();
    if (target) { focus(target); stop(); }
  };
  document.addEventListener('keydown', stop, true);
  document.addEventListener('pointerdown', stop, true);
  document.addEventListener('focusin', onFocus, true);
  frame = requestAnimationFrame(() => {
    frame = null;
    const current = document.activeElement;
    if (stopped || !visible(main) || (current && current !== document.body && current.isConnected) || hasOverlay()) { stop(); return; }
    const target = destination();
    if (target) { focus(target); stop(); return; }
    focus(main);
    // Observe only this route's main while it owns focus, never the whole body.
    observer = new MutationObserver(handoff);
    observer.observe(main, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'inert', 'style', 'class', 'data-tenant-route-focus', 'disabled'] });
  });
  return () => { stop(); cleanups.forEach(cleanup => cleanup()); };
}
