import { REMAINDER_PORTAL } from './remainderPresentation';
import { useEffect, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { AlertTriangle, Loader2, RefreshCcw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card } from '../ui/card';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { cn } from '../ui/utils';

// Shared with every landlord page. The lichen: variants take effect only on
// pages already migrated to the Lichen scope (lib/lichenRoutes); the others
// keep their legacy light look.

/**
 * Shared building blocks for the landlord dashboard pages so that
 * Requests, Policy, Properties, Tenants and Vendors all share one
 * consistent, polished visual language built around the brand blue
 * (#137fec) and accent purple (#a855f7).
 */

export const BRAND = '#137fec';
export const ACCENT = '#a855f7';

/** Soft entrance animation reused across the landlord pages. */
export function useLandlordEntrance() {
  useEffect(() => {
    if (document.getElementById('landlord-entrance-styles')) return;
    const style = document.createElement('style');
    style.id = 'landlord-entrance-styles';
    style.textContent = `
      @keyframes llFadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
      .ll-fade-up { animation: llFadeUp 0.5s cubic-bezier(0.16, 0.84, 0.44, 1) both; }
      @media (prefers-reduced-motion: reduce) { .ll-fade-up { animation: none !important; } }
    `;
    document.head.appendChild(style);
  }, []);
}

/** Shared classes for native inputs / selects so they match the design system. */
export const fieldClass =
  'h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-[#137fec] focus:ring-2 focus:ring-[#137fec]/15 in-[.lichen-remainder]:rounded-md in-[.lichen-remainder]:border-control-border in-[.lichen-remainder]:bg-input-background in-[.lichen-remainder]:text-ink in-[.lichen-remainder]:shadow-none in-[.lichen-remainder]:placeholder:text-meta in-[.lichen-remainder]:focus:border-control-border in-[.lichen-remainder]:focus:ring-0 in-[.lichen-remainder]:focus-visible:outline-solid in-[.lichen-remainder]:focus-visible:outline-2 in-[.lichen-remainder]:focus-visible:outline-offset-2 in-[.lichen-remainder]:focus-visible:outline-ring';

/** Small uppercase eyebrow label used above form controls and section meta. */
export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 in-[.lichen-remainder]:text-xs in-[.lichen-remainder]:normal-case in-[.lichen-remainder]:tracking-normal in-[.lichen-remainder]:text-meta', className)}>
      {children}
    </span>
  );
}

/** A card with a tinted icon chip header, title, optional description and action slot. */
export function SectionCard({
  icon: Icon,
  iconColor = BRAND,
  title,
  description,
  action,
  children,
  className,
  delay = 0,
  entrance = true,
}: {
  icon?: LucideIcon;
  iconColor?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  delay?: number;
  entrance?: boolean;
}) {
  return (
    <Card
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
      className={cn(
        entrance && 'll-fade-up',
        'gap-0 border border-slate-100 p-5 shadow-sm transition duration-300 hover:shadow-md lichen:border-border lichen:shadow-lichen-card lichen:hover:shadow-lichen-card',
        className
      )}
    >
      {/* The action drops below the title only when it cannot fit beside the title's longest word. */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        {/* Likewise the icon sits above the title only when the two cannot share a row. */}
        <div className="flex min-w-min flex-1 basis-0 in-[.lichen-remainder]:min-w-0 in-[.lichen-remainder]:[overflow-wrap:anywhere] flex-wrap items-center gap-3">
          {Icon ? (
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl in-[.lichen-remainder]:rounded-md in-[.lichen-remainder]:bg-chip! in-[.lichen-remainder]:text-chip-icon!"
              style={{ backgroundColor: `${iconColor}1a`, color: iconColor }}
            >
              <Icon className="h-5 w-5" />
            </div>
          ) : null}
          <div className="min-w-min flex-1 basis-0 in-[.lichen-remainder]:min-w-0 in-[.lichen-remainder]:[overflow-wrap:anywhere]">
            <h3 className="font-semibold text-slate-900 lichen:text-ink">{title}</h3>
            {description ? <p className="text-sm text-slate-500 lichen:text-meta">{description}</p> : null}
          </div>
        </div>
        {action ? <div className="ml-auto shrink-0">{action}</div> : null}
      </div>
      {children ? <div className="mt-5">{children}</div> : null}
    </Card>
  );
}

/** Consistent empty-state placeholder. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  className,
  testId,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-6 py-10 text-center lichen:rounded-lg lichen:border-chip-ring lichen:bg-well',
        className
      )}
    >
      {Icon ? (
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400 lichen:bg-chip lichen:text-chip-icon">
          <Icon className="h-5 w-5" aria-hidden />
        </div>
      ) : null}
      <p className="text-sm font-medium text-slate-600 lichen:text-ink">{title}</p>
      {description ? <p className="max-w-xs text-xs text-slate-400 lichen:text-meta">{description}</p> : null}
    </div>
  );
}

/**
 * Page content wrapper. Landlord pages fill the main column by default (the
 * layout caps it); pass a `width` for a page that reads better narrow, as the
 * tenant portal does.
 */
export function PageContainer({
  children,
  className,
  width = 'max-w-none',
}: {
  children: ReactNode;
  className?: string;
  width?: string;
}) {
  return <div className={cn('mx-auto w-full', width, className)}>{children}</div>;
}

/** Consistent modal used to host the landlord "add / create" forms. */
export function FormDialog({
  open,
  onOpenChange,
  icon: Icon,
  iconColor = BRAND,
  title,
  description,
  children,
  className,
  presentation = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon?: LucideIcon;
  iconColor?: string;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  presentation?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-lg', presentation && REMAINDER_PORTAL, className)}>
        <DialogHeader>
          <div className="flex items-center gap-3 text-left in-[.lichen-remainder]:min-w-0 in-[.lichen-remainder]:flex-wrap">
            {Icon ? (
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl in-[.lichen-remainder]:rounded-md in-[.lichen-remainder]:bg-chip! in-[.lichen-remainder]:text-chip-icon!"
                style={{ backgroundColor: `${iconColor}1a`, color: iconColor }}
              >
                <Icon className="h-5 w-5" />
              </div>
            ) : null}
            <div className="in-[.lichen-remainder]:min-w-0 in-[.lichen-remainder]:flex-1 in-[.lichen-remainder]:[overflow-wrap:anywhere]">
              <DialogTitle>{title}</DialogTitle>
              {description ? <DialogDescription className="mt-0.5">{description}</DialogDescription> : null}
            </div>
          </div>
        </DialogHeader>
        {/* min-w-0 so wide children (a Stripe country select, a long select
            option) shrink instead of forcing the dialog wider than its max. */}
        <div className="mt-1 min-w-0">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

/** Destructive confirmation modal used before deleting records. Handles its own busy state. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  className,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onFocusCapture,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  className?: string;
  onOpenAutoFocus?: ComponentProps<typeof DialogContent>['onOpenAutoFocus'];
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
  onFocusCapture?: ComponentProps<typeof DialogContent>['onFocusCapture'];
}) {
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    try {
      setBusy(true);
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? null : onOpenChange(next))}>
      <DialogContent
        className={cn('gap-0 overflow-hidden p-0 sm:max-w-md', className)}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
        onFocusCapture={onFocusCapture}
      >
        <div className="flex flex-col items-center gap-4 px-6 pb-6 pt-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-50 text-rose-600 ring-8 ring-rose-50/60 in-[.lichen-remainder]:rounded-md in-[.lichen-remainder]:bg-alert-tint in-[.lichen-remainder]:text-alert-text in-[.lichen-remainder]:ring-0">
            <AlertTriangle className="h-7 w-7" />
          </div>
          <div className="space-y-1.5">
            <DialogTitle className="text-lg font-semibold text-slate-900 in-[.lichen-remainder]:text-ink">{title}</DialogTitle>
            {description ? (
              <DialogDescription className="text-sm leading-relaxed text-slate-500 in-[.lichen-remainder]:text-meta">
                {description}
              </DialogDescription>
            ) : null}
          </div>
        </div>
        <DialogFooter className="gap-2 border-t border-slate-100 bg-slate-50/60 in-[.lichen-remainder]:border-hairline in-[.lichen-remainder]:bg-well px-6 py-4 sm:gap-3">
          <Button
            variant="outline"
            className="flex-1 border-slate-200 bg-white"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            className="flex-1 bg-rose-600 text-white hover:bg-rose-700 in-[.lichen-remainder]:bg-alert-text in-[.lichen-remainder]:text-white in-[.lichen-remainder]:hover:bg-alert-text/90"
            disabled={busy}
            onClick={() => void handleConfirm()}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Centered loading state shared by all landlord pages. */
export function LandlordLoading({ label }: { label: string }) {
  return (
    <div role="status" className="flex min-h-[40vh] items-center justify-center text-slate-500 lichen:text-meta">
      <Loader2 className="mr-2 h-5 w-5 animate-spin text-[#137fec] motion-reduce:animate-none lichen:text-lichen-icon" aria-hidden />
      {label}
    </div>
  );
}

/** Shared error panel with retry. */
export function LandlordError({
  title,
  message,
  onRetry,
}: {
  title: string;
  message?: string;
  onRetry: () => void;
}) {
  return (
    <Card role="alert" className="border border-slate-100 p-8 shadow-sm lichen:border-border lichen:shadow-lichen-card">
      <div className="mx-auto max-w-sm space-y-3 text-center">
        <h3 className="text-lg font-semibold text-slate-900 lichen:text-ink">{title}</h3>
        <p className="text-sm text-slate-500 lichen:text-meta">{message || 'Something went wrong.'}</p>
        <Button className="bg-[#137fec] hover:bg-[#137fec]/90 lichen:bg-primary lichen:text-primary-foreground lichen:hover:bg-primary/90" onClick={onRetry}>
          <RefreshCcw className="mr-2 h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    </Card>
  );
}
