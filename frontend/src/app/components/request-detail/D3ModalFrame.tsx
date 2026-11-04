import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { rememberD3Focus, restoreD3Focus, revealD3Focus, useD3Presentation, useD3ReturnFocus } from './d3Presentation';

/** Adds the installed dialog primitive's focus and Escape behavior to the
 * existing D3 modal markup. Legacy tenant consumers retain their existing frame.
 * The caller still owns its busy/close guard and every business operation. */
export function D3ModalFrame({ children, busy, onClose }: {
  children: ReactElement;
  busy: boolean;
  onClose: () => void;
}) {
  const active = useD3Presentation();
  const shared = useD3ReturnFocus();
  const frame = useRef<HTMLDivElement>(null);
  const [returnFocus] = useState(() => typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    if (!active || !busy) return;
    // Disabling the focused submit can move focus to BODY. Keep keyboard users
    // in the modal while the caller's existing async/busy guard is active.
    const paint = window.requestAnimationFrame(() => {
      if (frame.current && !frame.current.contains(document.activeElement)) frame.current.focus();
    });
    return () => window.cancelAnimationFrame(paint);
  }, [active, busy]);
  if (!active) return children;
  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Content ref={frame} asChild aria-describedby={undefined}
        onOpenAutoFocus={() => { rememberD3Focus(shared); if (shared && returnFocus) shared.current = returnFocus; }}
        onFocusCapture={(event) => revealD3Focus(event.target)} onCloseAutoFocus={(event) => {
        event.preventDefault();
        restoreD3Focus(returnFocus);
      }}>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

export function D3ModalTitle({ children }: { children: ReactElement }) {
  const active = useD3Presentation();
  return active ? <DialogPrimitive.Title asChild>{children}</DialogPrimitive.Title> : children;
}
