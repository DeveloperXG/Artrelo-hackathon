import type { LucideIcon } from 'lucide-react';
import { useIsSimulatedVendor } from '../judge/JudgeSandboxProvider';
import { SimulatedVendorBadge } from '../judge/JudgeBadges';
import { CalendarClock, DollarSign, Gauge, Loader2, PencilLine } from 'lucide-react';
import { canApproveVendorContact } from '../vendorContactAction';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Textarea } from '../ui/textarea';
import VendorOutreachStatus from './VendorOutreachStatus';
import type {
  VendorRecommendationCandidate,
  VendorRecommendationSnapshot,
} from './requestDetailTypes';
import {
  formatPriceEstimate,
  getAvailabilityDisplay,
  getCandidateActionBlockReason,
  getCandidateStateBadge,
  getCandidateStateLabel,
  getEstimateHint,
  getSourceLabel,
} from './requestDetailSelectors';
import MessageParagraphs from '../MessageParagraphs';
import { D3DialogContent, D3_FIELD, d3CandidateClass } from './d3Presentation';

// Whitespace at the ends and CRLF vs LF are not edits.
function normalizeDraft(text: string | null | undefined) {
  return String(text ?? '').replace(/\r\n/g, '\n').trim();
}

function metricPill(label: string, value: string, Icon: LucideIcon, hint?: string | null) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 in-[.lichen-d3]:text-meta">
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{value}</div>
      {hint ? <div className="mt-0.5 truncate text-xs text-slate-500 in-[.lichen-d3]:text-meta">{hint}</div> : null}
    </div>
  );
}

export default function VendorCandidateCard({
  candidate,
  snapshot,
  draftValue,
  draftOpen,
  vendorActionBusy,
  allowApprove = false,
  allowManualAssign = false,
  onToggleDraft,
  onChangeDraft,
  onSaveDraft,
  onApproveContact,
  onManualAssign,
  onResendOutreach,
  onDismissResponse,
  onCancelScheduled,
}: {
  candidate: VendorRecommendationCandidate;
  snapshot: VendorRecommendationSnapshot | null;
  draftValue: string;
  draftOpen: boolean;
  vendorActionBusy: string;
  allowApprove?: boolean;
  allowManualAssign?: boolean;
  onToggleDraft: () => void;
  onChangeDraft: (value: string) => void;
  onSaveDraft: () => void;
  onApproveContact: () => void;
  onManualAssign: () => void;
  onResendOutreach?: () => void;
  onDismissResponse?: () => void;
  onCancelScheduled?: () => void;
}) {
  const simulatedVendor = useIsSimulatedVendor(candidate.vendorId);
  const approved = candidate.state === 'approved_for_contact';
  const selected = candidate.state === 'selected';
  const rejected = candidate.state === 'manager_rejected';
  const held = candidate.state === 'held';
  const excluded = candidate.state === 'excluded';
  const actionBlockReason = getCandidateActionBlockReason(candidate, snapshot);
  const canApprove =
    Boolean(allowApprove) &&
    canApproveVendorContact(snapshot, candidate.candidateKey) &&
    !approved &&
    !selected &&
    !rejected &&
    !held &&
    !excluded &&
    !actionBlockReason;
  const canManuallyAssign =
    Boolean(allowManualAssign) && !approved && !selected && !held && !actionBlockReason;
  const showScore =
    typeof candidate.score === 'number' && Boolean(candidate.humanReadableReasons?.length);
  const draftBusy = vendorActionBusy === `draft:${candidate.candidateKey}`;
  // Save only means something when the text differs from what is stored --
  // the landlord's last save, or the generated draft if they never saved one.
  const draftChanged = normalizeDraft(draftValue) !== normalizeDraft(candidate.draftMessage);
  const outreachStarted = Boolean(candidate.outreach?.status && candidate.outreach.status !== 'not_sent');
  const availability = getAvailabilityDisplay(candidate);
  // A vendor picked by manual assignment never had outreach sent, so fall back
  // to the plain "selected" label rather than an empty outreach panel.
  const hasOutreach = Boolean(
    candidate.outreach?.status && candidate.outreach.status !== 'not_sent'
  );

  return (
    <article
      className="@container min-w-0 break-words rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-[#137fec]/25 sm:p-5 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:shadow-none in-[.lichen-d3]:hover:border-control-border"
      data-testid={`detail-recommendation-${candidate.candidateKey}`}
    >
      {/* Laid out by the card's own width: the record column can be narrow on
          a wide screen (side column beside it, Iris docked). */}
      <div className="flex flex-col gap-4 @2xl:flex-row @2xl:items-start @2xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{candidate.name}</h3>
            <SimulatedVendorBadge vendorId={candidate.vendorId} />
            <Badge className={`max-w-full whitespace-normal break-words border-transparent ${getCandidateStateBadge(candidate)} ${d3CandidateClass(candidate.state)}`}>
              {getCandidateStateLabel(candidate)}
            </Badge>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {/* A simulated vendor's source name ("External vendor") would read as real. */}
            {simulatedVendor ? null : (
              <Badge className="max-w-full whitespace-normal break-words border-transparent bg-slate-100 text-slate-700 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-ink">
                {getSourceLabel(candidate.candidateSource)}
              </Badge>
            )}
            {candidate.service ? (
              <Badge className="max-w-full whitespace-normal break-words border-transparent bg-cyan-100 text-cyan-700 in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink">{candidate.service}</Badge>
            ) : null}
          </div>

          <p className="mt-2 text-sm text-slate-500 in-[.lichen-d3]:text-meta">
            {candidate.city || 'Service area pending'} • {candidate.providerName}
            {candidate.avgResponseMinutes
              ? ` • Response in about ${candidate.avgResponseMinutes} min`
              : ''}
          </p>

          <p className="mt-3 text-sm leading-6 text-slate-700 in-[.lichen-d3]:text-ink">
            {candidate.whyRecommended ||
              candidate.holdReason ||
              'Candidate recorded in the routing ledger.'}
          </p>
        </div>

        <div
          className={`grid gap-2.5 ${
            showScore
              ? 'grid-cols-1 @md:grid-cols-3 @2xl:w-72 @2xl:shrink-0 @2xl:grid-cols-1'
              : 'grid-cols-1 @md:grid-cols-2 @2xl:w-56 @2xl:shrink-0 @2xl:grid-cols-1'
          }`}
        >
          {metricPill(
            'Estimate',
            formatPriceEstimate(candidate.priceEstimate),
            DollarSign,
            getEstimateHint(candidate.priceEstimate)
          )}
          {showScore ? metricPill('Score', candidate.score!.toFixed(1), Gauge) : null}
          {metricPill('Availability', availability.value, CalendarClock, availability.hint)}
        </div>
      </div>

      {candidate.humanReadableReasons?.length ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {candidate.humanReadableReasons.map((reason) => (
            <span
              key={`${candidate.candidateKey}-${reason}`}
              className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-meta"
            >
              {reason}
            </span>
          ))}
        </div>
      ) : null}

      {candidate.holdReason ? (
        <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text">
          {candidate.holdReason}
        </div>
      ) : null}

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 in-[.lichen-d3]:text-meta">
            Draft outreach
          </div>
          {/* Once a send is scheduled or out, the message is fixed on the
              outreach; an edit here would never reach the vendor. */}
          {outreachStarted ? null : (
            <Button
              variant="ghost"
              className="h-auto gap-1.5 px-2 text-[#137fec] hover:bg-[#137fec]/10 hover:text-[#137fec] in-[.lichen-d3]:text-lichen-text in-[.lichen-d3]:hover:bg-lichen-tint in-[.lichen-d3]:hover:text-lichen-text"
              onClick={onToggleDraft}
            >
              <PencilLine className="h-3.5 w-3.5" />
              Edit draft
            </Button>
          )}
        </div>
        {candidate.draftMessage ? (
          // Rendered the way the vendor will see it (email and response page).
          <MessageParagraphs
            text={candidate.draftMessage}
            className="mt-2 line-clamp-4 text-sm leading-6 text-slate-600 in-[.lichen-d3]:text-meta"
          />
        ) : (
          <p className="mt-2 text-sm leading-6 text-slate-600 in-[.lichen-d3]:text-meta">No draft message generated yet.</p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 in-[.lichen-d3]:border-hairline">
        {canApprove ? (
          <Button
            onClick={onApproveContact}
            disabled={vendorActionBusy === `approve:${candidate.candidateKey}`}
            className="gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
          >
            {vendorActionBusy === `approve:${candidate.candidateKey}` ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Approve Contact
          </Button>
        ) : hasOutreach || approved || selected ? (
          // `approved` with no outreach is the recoverable "approved but never
          // sent" state, which the status panel renders with a Send action.
          // `selected` with no outreach is the same thing from before manual
          // assignment contacted the vendor; Send recovers it too.
          <VendorOutreachStatus
            outreach={candidate.outreach}
            vendorName={candidate.name}
            busy={vendorActionBusy === `outreach:${candidate.candidateKey}`}
            onResend={onResendOutreach}
            onDismissResponse={onDismissResponse}
            onCancelScheduled={onCancelScheduled}
          />
        ) : null}

        {/* Not offered on the vendor already being contacted. */}
        {approved || selected ? null : (
          <Button
            variant="outline"
            className="border-slate-200 in-[.lichen-d3]:border-border"
            onClick={onManualAssign}
            disabled={!canManuallyAssign || vendorActionBusy === 'manual-assignment'}
          >
            Assign manually
          </Button>
        )}

      </div>

      {actionBlockReason ? (
        <div className="mt-3 text-xs text-slate-500 in-[.lichen-d3]:text-meta">{actionBlockReason}</div>
      ) : null}

      <Dialog
        open={draftOpen}
        onOpenChange={(open) => {
          if (!open && !draftBusy) onToggleDraft();
        }}
      >
        <D3DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-slate-900 in-[.lichen-d3]:text-ink">Edit outreach draft</DialogTitle>
            <DialogDescription className="text-slate-500 in-[.lichen-d3]:text-meta">
              This message is sent to {candidate.name} on your behalf. Review it before approving contact.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={draftValue}
            onChange={(event) => onChangeDraft(event.target.value)}
            aria-label="Outreach draft message"
            className={`h-72 resize-none overflow-y-auto [field-sizing:fixed] bg-white px-3.5 py-3 text-sm leading-6 text-slate-700 in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink ${D3_FIELD}`}
          />
          <DialogFooter>
            <Button
              variant="outline"
              className="border-slate-200 in-[.lichen-d3]:border-border"
              onClick={onToggleDraft}
              disabled={draftBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={onSaveDraft}
              disabled={draftBusy || !draftValue.trim() || !draftChanged}
              className="gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
            >
              {draftBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save draft
            </Button>
          </DialogFooter>
        </D3DialogContent>
      </Dialog>
    </article>
  );
}
