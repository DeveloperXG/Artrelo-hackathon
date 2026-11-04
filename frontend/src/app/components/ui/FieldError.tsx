import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * The inline error for one form field. Validation messages belong next to the
 * field they are about, not in a toast in the far corner of the screen that is
 * gone before the user finds the field.
 *
 * Pair it with the control: give the control `aria-invalid` and
 * `aria-describedby={id}`, plus `invalidFieldClass` for the error border.
 * Renders nothing when there is no message, so it can sit in the markup
 * unconditionally.
 */
export function FieldError({ id, children, className = '' }: { id: string; children?: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className={`flex items-start gap-1 text-xs text-rose-600 lichen:text-destructive ${className}`}>
      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * Border and focus ring for a control whose value is invalid. Inside a Lichen
 * scope it is a solid Alert border with no glow (the focus cue there is the
 * separate Lichen outline); elsewhere the pre-Lichen rose. Marked important
 * (trailing `!`) because it is appended to controls that already carry a base
 * border colour -- fieldClass's border-slate-200 on native selects -- and two
 * same-property utilities are decided by stylesheet order, not class order, so
 * without it the error border silently lost on every select.
 */
export const invalidFieldClass = 'border-rose-300! focus:border-rose-400! focus:ring-rose-300/30! lichen:border-destructive! lichen:focus:border-destructive! lichen:focus:ring-0!';
