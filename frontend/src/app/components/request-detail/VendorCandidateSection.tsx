import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type {
  VendorRecommendationCandidate,
  VendorRecommendationSnapshot,
} from './requestDetailTypes';
import VendorCandidateCard from './VendorCandidateCard';

const TONES = {
  primary: { dot: 'bg-[#137fec] in-[.lichen-d3]:bg-lichen-icon', count: 'bg-[#137fec]/10 text-[#137fec] in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-pill' },
  muted: { dot: 'bg-slate-300 in-[.lichen-d3]:bg-chip-icon', count: 'bg-slate-100 text-slate-500 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-meta' },
} as const;

export default function VendorCandidateSection({
  title,
  candidates,
  emptyMessage,
  snapshot,
  vendorActionBusy,
  draftValues,
  draftEditorOpen,
  allowApprove = false,
  allowManualAssign = false,
  defaultExpanded = true,
  tone = 'muted',
  onToggleDraft,
  onChangeDraft,
  onSaveDraft,
  onApproveContact,
  onManualAssign,
  onResendOutreach,
  onDismissResponse,
  onCancelScheduled,
}: {
  title: string;
  candidates: VendorRecommendationCandidate[];
  emptyMessage: string;
  snapshot: VendorRecommendationSnapshot | null;
  vendorActionBusy: string;
  draftValues: Record<string, string>;
  draftEditorOpen: Record<string, boolean>;
  allowApprove?: boolean;
  allowManualAssign?: boolean;
  defaultExpanded?: boolean;
  tone?: keyof typeof TONES;
  onToggleDraft: (candidate: VendorRecommendationCandidate) => void;
  onChangeDraft: (candidate: VendorRecommendationCandidate, value: string) => void;
  onSaveDraft: (candidate: VendorRecommendationCandidate) => void;
  onApproveContact: (candidate: VendorRecommendationCandidate) => void;
  onManualAssign: (candidateKey?: string) => void;
  onResendOutreach?: (candidate: VendorRecommendationCandidate) => void;
  onDismissResponse?: (candidate: VendorRecommendationCandidate) => void;
  onCancelScheduled?: (candidate: VendorRecommendationCandidate) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const contentId = useId();
  const toneClasses = TONES[tone];

  return (
    <div className="rounded-xl border border-slate-200 bg-white in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card">
      <button
        type="button"
        className={`flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]/30 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:hover:bg-well`}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        onClick={() => setIsExpanded((expanded) => !expanded)}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${toneClasses.dot}`} />
          <h3 className="min-w-0 text-xs font-semibold uppercase tracking-[0.14em] text-slate-600 [overflow-wrap:anywhere] in-[.lichen-d3]:text-meta">{title}</h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${toneClasses.count}`}
          >
            {candidates.length}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 in-[.lichen-d3]:text-meta ${
            isExpanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {isExpanded ? (
        <div id={contentId} className="px-3 pb-3">
          {candidates.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-5 py-6 text-center text-sm text-slate-500 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-meta">
              {emptyMessage}
            </div>
          ) : (
            <div className="max-h-[32rem] space-y-3 overflow-y-auto pr-1">
              {candidates.map((candidate) => (
                <VendorCandidateCard
                  key={candidate.candidateKey}
                  candidate={candidate}
                  snapshot={snapshot}
                  draftValue={draftValues[candidate.candidateKey] ?? candidate.draftMessage ?? ''}
                  draftOpen={Boolean(draftEditorOpen[candidate.candidateKey])}
                  vendorActionBusy={vendorActionBusy}
                  allowApprove={allowApprove}
                  allowManualAssign={allowManualAssign}
                  onToggleDraft={() => onToggleDraft(candidate)}
                  onChangeDraft={(value) => onChangeDraft(candidate, value)}
                  onSaveDraft={() => onSaveDraft(candidate)}
                  onApproveContact={() => onApproveContact(candidate)}
                  onManualAssign={() => onManualAssign(candidate.candidateKey)}
                  onResendOutreach={
                    onResendOutreach ? () => onResendOutreach(candidate) : undefined
                  }
                  onDismissResponse={
                    onDismissResponse ? () => onDismissResponse(candidate) : undefined
                  }
                  onCancelScheduled={
                    onCancelScheduled ? () => onCancelScheduled(candidate) : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
