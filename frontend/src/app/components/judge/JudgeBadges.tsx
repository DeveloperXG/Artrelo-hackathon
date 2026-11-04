import { FlaskConical, Hammer } from 'lucide-react';
import { HACKATHON_BADGE, SIMULATED_VENDOR } from './judgeCopy';
import { useIsSimulatedVendor, useJudgeSandboxEnabled } from './JudgeSandboxProvider';

// Two small pills. They carry their own colours so they read the same inside
// and outside the Lichen scope, and their text says what they mean (colour is
// never the only cue).

export function SimulatedVendorPill({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex max-w-full shrink-0 items-center gap-1 whitespace-normal rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 [overflow-wrap:anywhere] ${className}`}
      data-testid="simulated-vendor"
    >
      <FlaskConical className="h-3 w-3 shrink-0" aria-hidden="true" />
      {SIMULATED_VENDOR}
    </span>
  );
}

export function HackathonPill({ className = '' }: { className?: string }) {
  return (
    <span
      className={`lichen lichen-light inline-flex max-w-full shrink-0 items-center gap-1 whitespace-normal rounded-full border border-lichen-line bg-lichen-tint px-2 py-0.5 font-sans text-xs font-medium text-lichen-text [overflow-wrap:anywhere] ${className}`}
      data-testid="hackathon-badge"
    >
      <Hammer className="h-3 w-3 shrink-0" aria-hidden="true" />
      {HACKATHON_BADGE}
    </span>
  );
}

/** "Simulated vendor" next to a vendor the server lists as this pair's simulated vendor. */
export function SimulatedVendorBadge({ vendorId, className }: { vendorId: string | null | undefined; className?: string }) {
  return useIsSimulatedVendor(vendorId) ? <SimulatedVendorPill className={className} /> : null;
}

/** Marks a proven new feature section; visibility remains judge-sandbox-only. */
export function HackathonBadge({ className }: { className?: string }) {
  return useJudgeSandboxEnabled() ? <HackathonPill className={className} /> : null;
}

/** Existing GPT intake is not new; only recorded Meta triage gets this label. */
export function MetaTriageHackathonBadge({ source }: { source: string | undefined }) {
  return source === 'meta' ? <HackathonBadge /> : null;
}
