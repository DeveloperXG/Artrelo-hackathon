import { AlertTriangle, ArrowUpRight, ClipboardCheck } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import type {
  RequestDetailRecord,
  VendorRecommendationCandidate,
  VendorRecommendationSnapshot,
} from './requestDetailTypes';
import {
  formatDecisionLabel,
  describeClosedRound,
  getLiveRoutingAction,
  getRoundVendorBudget,
} from './requestDetailSelectors';
import { decisionsFocusHref } from '../landlord/decisionHref';
import { Eyebrow, InfoTile } from './detailUi';

const TONE_STYLES: Record<string, { container: string; badge: string }> = {
  pending: { container: "border-amber-200 bg-amber-50/60 in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint", badge: "bg-amber-100 text-amber-700 in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text" },
  good: { container: "border-emerald-200 bg-emerald-50/50 in-[.lichen-d3]:border-mist-line in-[.lichen-d3]:bg-mist-tint", badge: "bg-emerald-100 text-emerald-700 in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text" },
  bad: { container: "border-rose-200 bg-rose-50/50 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint", badge: "bg-rose-100 text-rose-700 in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text" },
  neutral: { container: 'border-slate-200 bg-slate-50/70', badge: 'bg-slate-100 text-slate-700' },
};

export default function VendorRoutingSummary({
  request,
  snapshot,
  activeCandidate,
}: {
  request: RequestDetailRecord;
  snapshot: VendorRecommendationSnapshot;
  activeCandidate: VendorRecommendationCandidate | null;
}) {
  const navigate = useNavigate();
  const { id: requestId } = useParams<{ id: string }>();
  const decision = snapshot.decision;
  // Derived from live state, not the frozen snapshot.decision — see
  // getLiveRoutingAction for why.
  const action = getLiveRoutingAction(request);
  const approvalNeeded = action.approvalPending;
  const tone = TONE_STYLES[action.tone] || TONE_STYLES.neutral;
  const summaryText = (action.summary || 'No routing summary available yet.')
    .replace(/\s+/g, ' ')
    .trim();

  // The round that just closed, rendered ABOVE the tile -- only once every
  // vendor in line has been tried (the server's pauseKind), which is when the
  // manager has to bring in someone new and needs to know why. It used to stay
  // up after routing had moved on to the next vendor, describing a round that
  // no longer mattered; the tile and the vendor's own card already say it then.
  const closedRound = snapshot.lastRound || null;
  const closed = describeClosedRound(snapshot);
  const showClosedRound = Boolean(
    request.routingGuidance?.pauseKind === 'vendors_exhausted' && !activeCandidate && closed.name
  );
  const vendorsContacted = closedRound?.vendorsContacted;
  const maxVendors = getRoundVendorBudget(closedRound);

  const metaBadges = [
    snapshot.defaultProvider ? { label: 'Provider', value: snapshot.defaultProvider } : null,
    typeof action.quotaLimit === 'number'
      ? {
          label: request.quotaOverride ? 'Quota (raised)' : 'Quota',
          value: `$${action.quotaLimit.toLocaleString()}`,
        }
      : null,
    snapshot.generatedAt
      ? { label: 'Generated', value: new Date(snapshot.generatedAt).toLocaleString() }
      : null,
  ].filter((entry): entry is { label: string; value: string } => entry !== null);

  // Laid out by its own width, not the viewport: the record column it sits in
  // can be narrow on a wide screen (side column beside it, Iris docked).
  return (
    <div className="@container space-y-4">
      {showClosedRound ? (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-3 text-sm text-rose-900 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-alert-text"
          data-testid="routing-previous-round"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500 in-[.lichen-d3]:text-alert-text" />
          <span>
            <span className="font-semibold">{closed.subject}</span> {closed.verbLong}
            {closed.why ? <span className="text-rose-700 in-[.lichen-d3]:text-alert-text"> — {closed.why}</span> : null}
          </span>
          {typeof vendorsContacted === 'number' && typeof maxVendors === 'number' ? (
            <span className="ml-auto whitespace-nowrap text-xs text-rose-600 in-[.lichen-d3]:text-alert-text">
              vendor {Math.min(vendorsContacted, maxVendors)} of {maxVendors} contacted
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        className={`scroll-mt-24 rounded-xl border px-5 py-4 transition-shadow in-[.lichen-d3]:rounded-lg ${tone.container}`}
        data-testid="routing-action"
      >
        <div className="flex flex-col gap-3 @lg:flex-row @lg:items-start @lg:justify-between">
          <div className="min-w-0">
            <Eyebrow>Current routing action</Eyebrow>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{action.label}</span>
              {approvalNeeded ? (
                <Badge className={`border-transparent ${tone.badge}`}>Approval needed</Badge>
              ) : null}
            </div>
          </div>
          {approvalNeeded ? (
            <Button
              size="sm"
              data-testid="routing-open-decisions"
              className="shrink-0 gap-1.5 bg-[#137fec] text-white hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
              onClick={() =>
                navigate(
                  requestId ? decisionsFocusHref(requestId) : '/dashboard/decisions'
                )
              }
            >
              <ClipboardCheck className="h-4 w-4" />
              Review in Decisions
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>

        <p className="mt-3 text-sm leading-6 text-slate-600 in-[.lichen-d3]:text-meta">{summaryText}</p>

        {metaBadges.length > 0 || activeCandidate ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-200/70 pt-3 in-[.lichen-d3]:border-border">
            {metaBadges.map((entry) => (
              <Badge
                key={entry.label}
                className="max-w-full whitespace-normal break-words border-transparent bg-white text-slate-600 shadow-sm in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-meta in-[.lichen-d3]:shadow-none"
              >
                <span className="text-slate-400 in-[.lichen-d3]:text-meta">{entry.label}:</span>
                <span className="ml-1 font-medium text-slate-700 in-[.lichen-d3]:text-ink">{entry.value}</span>
              </Badge>
            ))}
            {activeCandidate ? (
              <Badge className="max-w-full whitespace-normal break-words border-transparent bg-indigo-100 text-indigo-700 in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink">
                Active: {activeCandidate.name}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Four across only when each tile keeps room for its label. */}
      <div className="grid grid-cols-1 gap-3 @min-[18rem]:grid-cols-2 @lg:grid-cols-4">
        <InfoTile label="Discovered" value={String(snapshot.diagnostics?.discoveredCount || 0)} />
        <InfoTile label="Service matched" value={String(snapshot.diagnostics?.serviceMatchedCount || 0)} />
        <InfoTile label="Eligible" value={String(snapshot.diagnostics?.eligibleCount || 0)} />
        <InfoTile label="Outcome" value={formatDecisionLabel(snapshot.diagnostics?.outcomeCode || 'pending')} />
      </div>
    </div>
  );
}
