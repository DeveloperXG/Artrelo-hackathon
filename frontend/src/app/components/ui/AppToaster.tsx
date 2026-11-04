import type { CSSProperties } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { Toaster } from 'sonner';

// The one toast surface for the app, mounted once in App.tsx.
//
// Toasts are for outcomes the user cannot see on screen -- a message went to a
// vendor, a payment was accepted, a request was submitted -- and for failures
// with no form field to sit beside. Validation belongs inline (FieldError), and
// anything the page already shows changing needs no toast at all.
//
// The look is deliberately quiet: a white card with a coloured icon carrying the
// meaning, rather than sonner's richColors full-colour fills. The theme goes in
// through sonner's own CSS variables so its default layout, stacking and swipe
// handling stay intact.
const theme = {
  '--normal-bg': '#ffffff',
  '--normal-border': 'rgb(226 232 240)', // slate-200
  '--normal-text': 'rgb(30 41 59)', // slate-800
  '--border-radius': '12px',
  fontFamily: 'inherit',
} as CSSProperties;

export function AppToaster() {
  return (
    <Toaster
      position="top-right"
      duration={3500}
      visibleToasts={3}
      closeButton
      style={theme}
      icons={{
        success: <CheckCircle2 className="h-[18px] w-[18px] text-emerald-600" />,
        error: <AlertCircle className="h-[18px] w-[18px] text-rose-600" />,
        warning: <AlertTriangle className="h-[18px] w-[18px] text-amber-500" />,
        info: <Info className="h-[18px] w-[18px] text-slate-500" />,
        loading: <Loader2 className="h-[18px] w-[18px] animate-spin text-slate-400" />,
      }}
      toastOptions={{
        classNames: {
          toast: 'group gap-3 px-4 py-3 text-sm shadow-[0_10px_30px_-12px_rgba(15,23,42,0.28)]',
          title: 'font-medium leading-5',
          description: 'text-[13px] leading-5 text-slate-500',
          icon: 'self-start mt-px',
          // Errors are the ones worth reading twice, so only they can be
          // dismissed by hand; the rest simply time out.
          closeButton: 'hidden! group-data-[type=error]:flex! border-slate-200! bg-white! text-slate-500!',
        },
      }}
    />
  );
}
