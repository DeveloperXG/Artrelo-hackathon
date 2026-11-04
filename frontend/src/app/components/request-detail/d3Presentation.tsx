import { createContext, useContext, useRef } from 'react';
import type { ComponentProps, ReactNode, RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import { isLichenLandlordPath } from '../../lib/lichenRoutes';
import { FormDialog, PageContainer } from '../landlord/landlordUi';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { AlertDialogContent } from '../ui/alert-dialog';
import './d3Presentation.css';

// Presentation only. The shared owner must activate the route before this
// becomes true. Context follows React portals; it defaults off for the tenant,
// Activity, Wallet, Vendors and every other existing shared-component consumer.
const D3PresentationContext = createContext(false);
const D3ReturnFocusContext = createContext<RefObject<HTMLElement | null> | null>(null);
export const useD3Presentation = () => useContext(D3PresentationContext);
export const useD3ReturnFocus = () => useContext(D3ReturnFocusContext);
export const useD3PageActive = () => isLichenLandlordPath(useLocation().pathname);

function D3Provider({ active, children }: { active: boolean; children: ReactNode }) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return <D3PresentationContext.Provider value={active}><D3ReturnFocusContext.Provider value={returnFocus}>{children}</D3ReturnFocusContext.Provider></D3PresentationContext.Provider>;
}

// These controls keep their full labels when text grows. Fixed-height controls
// would clip at 200% root text, especially inside the narrow record column.
const D3_CONTROLS = '[&_[data-slot=button]]:max-w-full [&_[data-slot=button]]:h-auto [&_[data-slot=button]]:min-h-9 [&_[data-slot=button]]:whitespace-normal [&_[data-slot=button]]:[overflow-wrap:anywhere] [&_[data-slot=button]]:rounded-md [&_button]:motion-reduce:transition-none [&_:is(button,a,input,textarea,select,summary)]:focus-visible:outline-solid [&_:is(button,a,input,textarea,select,summary)]:focus-visible:outline-2 [&_:is(button,a,input,textarea,select,summary)]:focus-visible:outline-offset-2 [&_:is(button,a,input,textarea,select,summary)]:focus-visible:outline-ring';
export const D3_PORTAL = `lichen lichen-light lichen-d3 font-sans text-ink ${D3_CONTROLS} motion-reduce:animate-none! [&_*]:motion-reduce:animate-none!`;
export const D3_PAGE = `lichen-d3 ${D3_CONTROLS} lichen:[&_.ll-fade-up]:animate-none! lichen:[&_.ll-fade-up]:hover:translate-y-0 [&_*]:motion-reduce:animate-none! [&_*]:motion-reduce:transition-none`;
export const D3_FIELD = 'in-[.lichen-d3]:text-base in-[.lichen-d3]:rounded-md in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-input-background in-[.lichen-d3]:text-ink in-[.lichen-d3]:shadow-none in-[.lichen-d3]:placeholder:text-meta in-[.lichen-d3]:focus:border-control-border in-[.lichen-d3]:focus:ring-0 in-[.lichen-d3]:focus-visible:outline-solid in-[.lichen-d3]:focus-visible:outline-2 in-[.lichen-d3]:focus-visible:outline-offset-2 in-[.lichen-d3]:focus-visible:outline-ring in-[.lichen-d3]:aria-invalid:border-alert-text in-[.lichen-d3]:motion-reduce:transition-none';
export const D3_PRIMARY = 'in-[.lichen-d3]:bg-primary in-[.lichen-d3]:text-primary-foreground in-[.lichen-d3]:shadow-none in-[.lichen-d3]:hover:bg-primary/90';
export const D3_LINK = 'in-[.lichen-d3]:text-lichen-text';

export function D3PresentationScope({ children }: { children: ReactNode }) {
  const active = useD3PageActive();
  return <D3Provider active={active}>{children}</D3Provider>;
}

// A presentation adapter around the existing accessible primitive. Busy-state
// close guards, focus management, labels and events remain with each caller.
export function revealD3Focus(target: EventTarget | null) {
  if (typeof window === 'undefined' || !(target instanceof HTMLElement)) return;
  window.requestAnimationFrame(() => {
    if (target.isConnected) target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  });
}

const focusIdentity = new WeakMap<HTMLElement, { scope: string; tag: string; name: string; route: string }>();

export function rememberD3Focus(shared: RefObject<HTMLElement | null> | null) {
  const current = document.activeElement;
  const outside = current instanceof HTMLElement && current !== document.body && current !== document.documentElement && !current.closest('[role=dialog],[role=alertdialog]');
  if (outside) {
    if (shared) shared.current = current;
    const scope = current.closest('[data-testid]')?.getAttribute('data-testid');
    if (scope) focusIdentity.set(current, { scope, tag: current.tagName, name: current.getAttribute('aria-label') || current.textContent?.trim() || '', route: window.location.href });
  }
  return outside ? current : shared?.current || null;
}

export function restoreD3Focus(target: HTMLElement | null) {
  if (!target) return;
  const identity = focusIdentity.get(target);
  let observer: MutationObserver | undefined;
  let timeout: number | undefined;
  const stop = () => { observer?.disconnect(); if (timeout) window.clearTimeout(timeout); };
  const restore = () => {
    // A replacement dialog owns focus during a handoff. Never focus beneath it.
    if (document.querySelector('[role=dialog],[role=alertdialog]')) { stop(); return; }
    if (identity && window.location.href !== identity.route) { stop(); return; }
    const current = document.activeElement;
    if (current instanceof HTMLElement && current !== document.body && current !== document.documentElement && current !== target && !current.hasAttribute('data-radix-focus-guard')) { stop(); return; }
    let destination = target.isConnected ? target : null;
    if (!destination && identity) {
      const scope = document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(identity.scope)}"]`);
      const candidates = scope ? [scope, ...scope.querySelectorAll<HTMLElement>(identity.tag)] : [];
      const matches = candidates.filter(node => node.tagName === identity.tag && (node.getAttribute('aria-label') || node.textContent?.trim() || '') === identity.name);
      if (matches.length === 1) destination = matches[0];
    }
    if (destination) { stop(); destination.focus(); }
    return Boolean(destination);
  };
  window.requestAnimationFrame(() => {
    if (restore() || !identity || document.querySelector('[role=dialog],[role=alertdialog]')) return;
    // The existing save handler briefly unmounts the detail while reloading.
    // Restore only the same uniquely identified control after that DOM returns.
    observer = new MutationObserver(() => { restore(); });
    observer.observe(document.body, { childList: true, subtree: true });
    timeout = window.setTimeout(stop, 1500);
  });
}

export function D3DialogContent({ className, onFocusCapture, onOpenAutoFocus, onCloseAutoFocus, ...props }: ComponentProps<typeof DialogContent>) {
  const active = useD3Presentation();
  const shared = useD3ReturnFocus();
  const opener = useRef<HTMLElement | null>(null);
  return <DialogContent {...props}
    onOpenAutoFocus={(event) => { if (active) opener.current = rememberD3Focus(shared); onOpenAutoFocus?.(event); }}
    onCloseAutoFocus={(event) => { onCloseAutoFocus?.(event); if (active && !event.defaultPrevented) { event.preventDefault(); restoreD3Focus(opener.current); } }}
    onFocusCapture={(event) => { onFocusCapture?.(event); if (active) revealD3Focus(event.target); }}
    className={`${className || ''} ${active ? `${D3_PORTAL} w-[calc(100%-2rem)] sm:w-full max-h-[calc(100dvh-2rem)]` : ''}`} />;
}

export function D3AlertDialogContent({ className, onFocusCapture, onOpenAutoFocus, onCloseAutoFocus, ...props }: ComponentProps<typeof AlertDialogContent>) {
  const active = useD3Presentation();
  const shared = useD3ReturnFocus();
  const opener = useRef<HTMLElement | null>(null);
  return <AlertDialogContent {...props}
    onOpenAutoFocus={(event) => { if (active) opener.current = rememberD3Focus(shared); onOpenAutoFocus?.(event); }}
    onCloseAutoFocus={(event) => { onCloseAutoFocus?.(event); if (active && !event.defaultPrevented) { event.preventDefault(); restoreD3Focus(opener.current); } }}
    onFocusCapture={(event) => { onFocusCapture?.(event); if (active) revealD3Focus(event.target); }}
    className={`${className || ''} ${active ? `${D3_PORTAL} max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto overscroll-contain` : ''}`} />;
}

export function D3FormDialog(props: ComponentProps<typeof FormDialog>) {
  const active = useD3Presentation();
  if (!active) return <FormDialog {...props} />;
  const { open, onOpenChange, icon: Icon, title, description, children, className } = props;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <D3DialogContent className={`sm:max-w-lg ${className || ''}`}>
      <DialogHeader><div className="flex min-w-0 flex-wrap items-center gap-3 text-left">
        {Icon ? <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-chip text-chip-icon"><Icon className="h-5 w-5" /></div> : null}
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]"><DialogTitle>{title}</DialogTitle>{description ? <DialogDescription className="mt-0.5">{description}</DialogDescription> : null}</div>
      </div></DialogHeader>
      <div className="mt-1 min-w-0">{children}</div>
    </D3DialogContent>
  </Dialog>;
}

export function D3Page({ children }: { children: ReactNode }) {
  const active = useD3PageActive();
  return <D3Provider active={active}>
    <PageContainer className={active ? D3_PAGE : undefined}>{children}</PageContainer>
  </D3Provider>;
}

export function D3State({ children }: { children: ReactNode }) {
  const active = useD3PageActive();
  return active ? <div className={D3_PAGE}>{children}</div> : children;
}

// Display roles only: the existing domain helper still supplies the status.
// Maintenance Completed retains the approved neutral pill; confirmed workflow
// states use Mist. Labels/meaning are never manufactured from a color.
export function d3StatusClass(status: string) {
  if (['in_progress', 'needs_approval', 'needs_vendor', 'appeal_pending'].includes(status))
    return 'in-[.lichen-d3]:border-transparent in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-pill in-[.lichen-d3]:ring-0';
  if (['approved', 'contacting_vendor'].includes(status))
    return 'in-[.lichen-d3]:border-transparent in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text in-[.lichen-d3]:ring-0';
  if (status === 'rejected')
    return 'in-[.lichen-d3]:border-transparent in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:ring-0';
  if (status === 'completed') return 'in-[.lichen-d3]:border-transparent in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-meta in-[.lichen-d3]:ring-0';
  return 'in-[.lichen-d3]:border-transparent in-[.lichen-d3]:bg-pill-neutral in-[.lichen-d3]:text-chip-icon in-[.lichen-d3]:ring-0';
}

export function d3PriorityClass(priority: string) {
  if (['emergency', 'high'].includes(priority)) return 'in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text';
  if (priority === 'medium') return 'in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text';
  return 'in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-chip-icon';
}

export function d3CandidateClass(state?: string) {
  if (['approved_for_contact', 'selected'].includes(state || ''))
    return 'in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text';
  if (state === 'manager_rejected') return 'in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text';
  if (['recommended', 'held'].includes(state || ''))
    return 'in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-pill';
  return 'in-[.lichen-d3]:bg-pill-neutral in-[.lichen-d3]:text-chip-icon';
}
