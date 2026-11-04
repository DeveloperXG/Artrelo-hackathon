import { Loader2, RefreshCcw, Signpost, UserPlus, UserRoundCheck } from 'lucide-react';
import AutoFindComingSoon from '../landlord/vendors/AutoFindComingSoon';
import { Button } from '../ui/button';
import type { RoutingPauseKind } from './requestDetailSelectors';

const COPY: Record<RoutingPauseKind, { title: (trade: string) => string; body: string }> = {
  vendors_exhausted: {
    title: () => 'Every vendor in line has been tried',
    body:
      'Bring in someone new and Artrelo will search again straight away. Vendors who already declined stay out of the search.',
  },
  no_eligible_vendors: {
    title: (trade) => `No vendor in your network covers ${trade}`,
    body: 'Add a vendor who does this work and Artrelo will search again straight away.',
  },
  manager_rejected: {
    title: () => 'You turned down the recommended vendor',
    body: 'Pick another vendor yourself, add a new one, or search your network again.',
  },
  paused: {
    title: () => 'Routing is paused',
    body: 'Choose how to keep this request moving.',
  },
};

/**
 * The way forward when routing has paused and nobody is being contacted.
 * Before this, "All vendors declined — assign manually" pointed at a dialog
 * with nobody in it and a Regenerate that refused, so the request sat still.
 *
 * Every pause offers adding a vendor (in place, then an automatic search) and
 * searching again; "Assign manually" appears only when the dialog would have
 * someone to offer. Decisions Needed deep-links here (?focus=next-steps).
 */
export default function RoutingNextSteps({
  kind,
  trade,
  onAddVendor,
  onSearchAgain,
  searchBlockReason,
  searching,
  canAssign,
  onAssign,
}: {
  kind: RoutingPauseKind;
  /** The trade the job needs, for the no-coverage title. */
  trade: string;
  onAddVendor: () => void;
  onSearchAgain: () => void;
  searchBlockReason: string;
  searching: boolean;
  canAssign: boolean;
  onAssign: () => void;
}) {
  const copy = COPY[kind];

  return (
    <div
      className="scroll-mt-24 rounded-xl border border-[#137fec]/20 bg-white px-5 py-4 shadow-sm transition-shadow in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:bg-card in-[.lichen-d3]:border-control-border in-[.lichen-d3]:shadow-none"
      data-testid="routing-next-steps"
      data-pause-kind={kind}
      data-focus-target="next-steps"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#137fec]/10 text-[#137fec] in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text">
          <Signpost className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 in-[.lichen-d3]:text-meta">Next steps</div>
          <div className="mt-0.5 text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{copy.title(trade)}</div>
          <p className="mt-1 text-sm text-slate-500 in-[.lichen-d3]:text-meta">{copy.body}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          onClick={onAddVendor}
          className="gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
          data-testid="routing-next-add-vendor"
        >
          <UserPlus className="h-4 w-4" />
          Add a vendor
        </Button>
        <Button
          variant="outline"
          onClick={onSearchAgain}
          disabled={Boolean(searchBlockReason) || searching}
          title={searchBlockReason || undefined}
          className="gap-2 border-slate-200 in-[.lichen-d3]:border-border"
          data-testid="routing-next-search-again"
        >
          {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          Search again
        </Button>
        {canAssign ? (
          <Button
            variant="outline"
            onClick={onAssign}
            className="gap-2 border-slate-200 in-[.lichen-d3]:border-border"
            data-testid="routing-next-assign"
          >
            <UserRoundCheck className="h-4 w-4" />
            Assign manually
          </Button>
        ) : null}
        <AutoFindComingSoon />
      </div>
      {searchBlockReason ? <p className="mt-2 text-xs text-amber-700 in-[.lichen-d3]:text-lichen-text">{searchBlockReason}</p> : null}
    </div>
  );
}
