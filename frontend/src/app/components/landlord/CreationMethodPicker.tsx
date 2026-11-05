import type { LucideIcon } from 'lucide-react';

/**
 * Progressive disclosure, in one component. Used by both "Add units" and
 * "Add properties".
 *
 * Each of those used to open a form. The form was fine for a landlord with four
 * units and useless for one with four hundred, and there was nowhere to put the
 * bulk tools without putting them in front of the person who needs just one.
 *
 * The picker is the fix: everyone reads a few short sentences and picks the one
 * that describes their situation. Nobody adding a single unit meets a floor
 * pattern builder, and nobody onboarding a tower meets a form they would have to
 * fill in 400 times.
 */
export interface CreationMethod<Id extends string = string> {
  id: Id;
  icon: LucideIcon;
  title: string;
  /** One line, in the landlord's terms, describing when to pick this. */
  description: string;
  accent: string;
}

export interface CreationMethodPickerProps<Id extends string = string> {
  methods: CreationMethod<Id>[];
  onSelect: (id: Id) => void;
  disabled?: boolean;
  /** Shown under the list when a prerequisite is missing (e.g. no property). */
  hint?: string;
}

export default function CreationMethodPicker<Id extends string = string>({
  methods,
  onSelect,
  disabled,
  hint,
}: CreationMethodPickerProps<Id>) {
  return (
    <div className="space-y-3">
      <div className="grid gap-2.5">
        {methods.map((method) => (
          <button
            key={method.id}
            type="button"
            data-testid={`unit-method-${method.id}`}
            disabled={disabled}
            onClick={() => onSelect(method.id)}
            className="group flex w-full items-center gap-3.5 rounded-xl border border-slate-200 bg-white p-3.5 text-left transition hover:-translate-y-0.5 hover:border-[#137fec]/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]/40 disabled:pointer-events-none disabled:opacity-50 lichen:rounded-lg lichen:border-hairline lichen:bg-card lichen:hover:translate-y-0 lichen:hover:border-lichen-line lichen:hover:shadow-lichen-card"
          >
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition lichen:rounded-lg"
              style={{ backgroundColor: 'var(--color-chip)', color: 'var(--color-chip-icon)' }}
            >
              <method.icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 lichen:text-ink">{method.title}</div>
              <div className="text-sm text-slate-500 lichen:text-meta">{method.description}</div>
            </div>
          </button>
        ))}
      </div>
      {hint ? <p className="text-xs text-slate-400 lichen:text-meta">{hint}</p> : null}
    </div>
  );
}
