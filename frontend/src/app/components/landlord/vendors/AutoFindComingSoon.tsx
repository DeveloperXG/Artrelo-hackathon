import { Sparkles } from 'lucide-react';
import { cn } from '../../ui/utils';

/**
 * Finding vendors outside the landlord's own network is not built yet. It is
 * shown, disabled and labelled, so the feature is discoverable without a
 * landlord believing it works -- recommendations today come only from the
 * vendors they added themselves.
 */
export default function AutoFindComingSoon({ className = '' }: { className?: string }) {
  return (
    <span
      // cn, not concatenation: a caller's `hidden` must beat the base
      // `inline-flex`, and plain strings leave that to stylesheet order.
      className={cn('inline-flex', className)}
      title="Coming soon: Artrelo will be able to find vetted vendors near your property. Today, recommendations come from the vendors you add."
    >
      <button
        type="button"
        disabled
        aria-disabled="true"
        data-testid="auto-find-vendors"
        className="inline-flex h-9 cursor-not-allowed items-center gap-1.5 rounded-lg border border-dashed border-slate-300 bg-white px-3 text-sm font-medium text-slate-400 lichen:rounded-lg lichen:border-hairline lichen:bg-card lichen:text-meta"
      >
        <Sparkles className="h-4 w-4" />
        Auto-find vendors
        <span className="ml-0.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 lichen:bg-chip lichen:text-xs lichen:normal-case lichen:tracking-normal lichen:text-meta">
          Coming soon
        </span>
      </button>
    </span>
  );
}
