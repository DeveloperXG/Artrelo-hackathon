import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentProps, ReactElement } from 'react';
import { useLocation } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ConfirmDialog, FormDialog } from '../landlord/landlordUi';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { rememberD3Focus, restoreD3Focus, revealD3Focus } from '../request-detail/d3Presentation';
import { TENANT_PORTAL, useTenantPresentation } from './tenantPresentation';

/** Page-lifetime focus intent survives the existing list's loading return.
 * The dialog still owns confirmation, busy state and all close decisions. */
export function useTenantConfirmationFocus(loading: boolean): Pick<ComponentProps<typeof ConfirmDialog>, 'onOpenAutoFocus' | 'onCloseAutoFocus'> {
  const active = useTenantPresentation();
  const { key: locationKey } = useLocation();
  const opener = useRef<HTMLElement | null>(null);
  const identity = useRef<{ testId: string; tag: string; name: string } | null>(null);
  const completedDialog = useRef<HTMLElement | null>(null);
  const page = useRef<HTMLElement | null>(null);
  const waiting = useRef(false);
  const loadingNow = useRef(loading);
  const paint = useRef<number | undefined>(undefined);
  const removeListeners = useRef<(() => void) | undefined>(undefined);

  const cancel = useCallback(() => {
    waiting.current = false;
    if (paint.current !== undefined) cancelAnimationFrame(paint.current);
    paint.current = undefined;
    removeListeners.current?.();
    removeListeners.current = undefined;
  }, []);

  const restore = useCallback(() => {
    if (!waiting.current || loadingNow.current) return;
    const dialog = document.querySelector('[role=dialog],[role=alertdialog]');
    if (dialog) { if (dialog !== completedDialog.current) cancel(); return; }
    const current = document.activeElement;
    const meaningfulFocus = current instanceof HTMLElement && current.isConnected &&
      current !== document.body && current !== document.documentElement &&
      !current.hasAttribute('data-radix-focus-guard') && !completedDialog.current?.contains(current);
    if (meaningfulFocus) { cancel(); return; }
    let destination = opener.current?.isConnected ? opener.current : null;
    if (!destination && identity.current && page.current?.isConnected) {
      const known = identity.current;
      const matches = [...page.current.querySelectorAll<HTMLElement>(`[data-testid="${CSS.escape(known.testId)}"]`)]
        .filter(node => node.tagName === known.tag && (node.getAttribute('aria-label') || node.textContent?.trim() || '') === known.name);
      if (matches.length === 1) destination = matches[0];
    }
    // The removed row cannot receive focus. Use the current view, never change it.
    destination ||= page.current?.querySelector<HTMLElement>('[data-testid=tenant-request-view] [role=tab][aria-selected=true]') || null;
    // A failed reload replaces the view with its existing, labelled retry action.
    destination ||= page.current?.querySelector<HTMLElement>('[role=alert] button:not([disabled])') || null;
    cancel();
    destination?.focus();
  }, [cancel]);

  const schedule = useCallback(() => {
    if (paint.current !== undefined) cancelAnimationFrame(paint.current);
    paint.current = requestAnimationFrame(restore);
  }, [restore]);

  useLayoutEffect(() => {
    loadingNow.current = loading;
    if (active && !loading && waiting.current) schedule();
  }, [active, loading, schedule]);
  useEffect(() => { cancel(); return cancel; }, [active, locationKey, cancel]);

  if (!active) return {};
  return {
    onOpenAutoFocus: event => {
      cancel();
      opener.current = rememberD3Focus(opener);
      const target = opener.current;
      const testId = target?.getAttribute('data-testid');
      identity.current = target && testId ? { testId, tag: target.tagName, name: target.getAttribute('aria-label') || target.textContent?.trim() || '' } : null;
      page.current = target?.closest('main') || null;
      completedDialog.current = event.target instanceof HTMLElement ? event.target : null;
    },
    onCloseAutoFocus: event => {
      event.preventDefault();
      cancel();
      const current = document.activeElement;
      if (current instanceof HTMLElement && current.isConnected && current !== document.body &&
          current !== document.documentElement && !current.hasAttribute('data-radix-focus-guard') &&
          !completedDialog.current?.contains(current)) return;
      waiting.current = true;
      const newInteraction = (interaction: Event) => {
        if (!waiting.current) return;
        const target = interaction.target;
        if (target instanceof HTMLElement && (completedDialog.current?.contains(target) || target.hasAttribute('data-radix-focus-guard'))) return;
        if (interaction.type === 'focusin' && (target === document.body || target === document.documentElement)) return;
        cancel();
      };
      // Short-lived event listeners cancel intent; no global observer or timer.
      for (const type of ['pointerdown', 'keydown', 'focusin']) document.addEventListener(type, newInteraction, true);
      removeListeners.current = () => { for (const type of ['pointerdown', 'keydown', 'focusin']) document.removeEventListener(type, newInteraction, true); };
      schedule();
    },
  };
}

// Read-only reuse of already tested generic focus helpers. D3 context, route
// activation, styling and landlord modal behavior are never enabled or edited.
export function restoreTenantCalendarFocus(destination: HTMLElement, closing: HTMLElement | null) {
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, cancel, true);
  requestAnimationFrame(() => {
    for (const type of ['pointerdown', 'keydown']) document.removeEventListener(type, cancel, true);
    const current = document.activeElement;
    if (cancelled || !destination.isConnected ||
        document.querySelector('[role=dialog],[role=alertdialog],[data-slot=popover-content][data-state=open]')) return;
    if (current instanceof HTMLElement && current.isConnected && current !== document.body &&
        current !== document.documentElement && !closing?.contains(current) && !current.hasAttribute('data-radix-focus-guard')) return;
    destination.focus();
  });
}

export function TenantDialogContent({
  className, onFocusCapture, onOpenAutoFocus, onCloseAutoFocus, returnFocusFallback, ...props
}: ComponentProps<typeof DialogContent> & { returnFocusFallback?: () => HTMLElement | null }) {
  const active = useTenantPresentation();
  const opener = useRef<HTMLElement | null>(null);
  const fallback = useRef<HTMLElement | null>(null);
  return <DialogContent {...props}
    className={`${className || ''} ${active ? `${TENANT_PORTAL} w-[calc(100%-2rem)] sm:w-full max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto overscroll-contain` : ''}`}
    onFocusCapture={event => {
      onFocusCapture?.(event);
      if (active) revealD3Focus(event.target);
    }}
    onOpenAutoFocus={event => {
      if (active) {
        opener.current = rememberD3Focus(opener);
        fallback.current = returnFocusFallback?.() || null;
      }
      onOpenAutoFocus?.(event);
    }}
    onCloseAutoFocus={event => {
      onCloseAutoFocus?.(event);
      if (active && !event.defaultPrevented) {
        event.preventDefault();
        if (!opener.current?.isConnected && fallback.current?.isConnected) {
          // A calendar action closed its visit dialog before opening this form.
          // Keep only the exact surviving event, never reopen or navigate a view.
          const closing = event.target instanceof HTMLElement ? event.target : null;
          restoreTenantCalendarFocus(fallback.current, closing);
        } else restoreD3Focus(opener.current);
      }
    }} />;
}

export function TenantFormDialog({ returnFocusFallback, ...props }: ComponentProps<typeof FormDialog> & { returnFocusFallback?: () => HTMLElement | null }) {
  const active = useTenantPresentation();
  if (!active) return <FormDialog {...props} />;
  const { open, onOpenChange, icon: Icon, title, description, children, className } = props;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <TenantDialogContent returnFocusFallback={returnFocusFallback} className={`sm:max-w-lg ${className || ''}`}>
      <DialogHeader>
        <div className="flex min-w-0 flex-wrap items-start gap-3 text-left">
          {Icon ? <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-chip text-chip-icon">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span> : null}
          <div className="min-w-0 flex-1 basis-40 [overflow-wrap:anywhere]">
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription className="mt-1">{description}</DialogDescription> : null}
          </div>
        </div>
      </DialogHeader>
      <div className="mt-1 min-w-0">{children}</div>
    </TenantDialogContent>
  </Dialog>;
}

export function TenantModalFrame({ children, busy, onClose }: {
  children: ReactElement<{ className?: string }>;
  busy: boolean;
  onClose: () => void;
}) {
  const active = useTenantPresentation();
  const frame = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [returnFocus] = useState(() => typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    if (!active || !busy) return;
    // A disabled submit may move focus to BODY. Keep it inside the pending dialog.
    const paint = requestAnimationFrame(() => {
      if (frame.current && !frame.current.contains(document.activeElement)) frame.current.focus();
    });
    return () => cancelAnimationFrame(paint);
  }, [active, busy]);
  if (!active) return children;
  return <DialogPrimitive.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Content asChild ref={frame} aria-describedby={undefined}
        onOpenAutoFocus={() => { opener.current = rememberD3Focus(opener) || returnFocus; }}
        onFocusCapture={event => revealD3Focus(event.target)}
        onCloseAutoFocus={event => {
          event.preventDefault();
          restoreD3Focus(opener.current || returnFocus);
        }}>
        {cloneElement(children, {
          className: `${children.props.className || ''} ${TENANT_PORTAL} bg-black/50! backdrop-blur-none [&>div]:min-w-0 [&>div]:max-h-[calc(100dvh-2rem)] [&>div]:overflow-y-auto`,
        })}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

export function TenantModalTitle({ children }: { children: ReactElement }) {
  const active = useTenantPresentation();
  return active ? <DialogPrimitive.Title asChild>{children}</DialogPrimitive.Title> : children;
}

// Keep the shared confirmation's async busy guard and exact action semantics.
// Only its reviewed class/focus seam is supplied for an active tenant scope.
export function TenantConfirmDialog(props: ComponentProps<typeof ConfirmDialog>) {
  const active = useTenantPresentation();
  const opener = useRef<HTMLElement | null>(null);
  const focusObserver = useRef<MutationObserver | null>(null);
  useEffect(() => {
    if (!active || !props.open) focusObserver.current?.disconnect();
  }, [active, props.open]);
  useEffect(() => () => focusObserver.current?.disconnect(), []);
  if (!active) return <ConfirmDialog {...props} />;
  return <ConfirmDialog {...props}
    className={`${TENANT_PORTAL} tenant-confirm-dialog w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto! ${props.className || ''}`}
    onOpenAutoFocus={event => {
      opener.current = rememberD3Focus(opener);
      // The shared dialog owns its busy state. Observe only its rendered
      // disabled attributes so disabling the focused submit cannot strand
      // keyboard focus on BODY; do not wrap or duplicate its action handler.
      focusObserver.current?.disconnect();
      const content = event.target;
      if (content instanceof HTMLElement) {
        focusObserver.current = new MutationObserver(() => {
          if (content.isConnected && content.querySelector('button[disabled]') &&
              [document.body, document.documentElement].includes(document.activeElement as HTMLElement)) {
            content.focus({ preventScroll: true });
          }
        });
        focusObserver.current.observe(content, { subtree: true, attributes: true, attributeFilter: ['disabled'] });
      }
      props.onOpenAutoFocus?.(event);
    }}
    onCloseAutoFocus={event => {
      focusObserver.current?.disconnect();
      props.onCloseAutoFocus?.(event);
      if (!event.defaultPrevented) {
        event.preventDefault();
        restoreD3Focus(opener.current);
      }
    }}
    onFocusCapture={event => {
      props.onFocusCapture?.(event);
      revealD3Focus(event.target);
    }} />;
}
