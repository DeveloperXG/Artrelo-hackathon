import { useState } from 'react';
import { ClipboardList, HandCoins, Wrench } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { MarkDirectPaidDialog, type MarkablePayment } from '../landlord/DirectPayments';
import type { RequestDetailRecord, VendorRecommendationCandidate } from './requestDetailTypes';
import { getSourceLabel } from './requestDetailSelectors';
import { DetailCard } from './detailUi';

function infoRow(label: string, value: string, { capitalize = true }: { capitalize?: boolean } = {}) {
  return (
    // The value drops below its label only when the two cannot share a row.
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-slate-100 py-2.5 first:pt-0 last:border-b-0 last:pb-0 in-[.lichen-d3]:border-hairline">
      <span className="text-sm text-slate-500 in-[.lichen-d3]:text-meta">{label}</span>
      <span className={`ml-auto min-w-0 break-words text-right text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink ${capitalize ? 'capitalize' : ''}`}>{value}</span>
    </div>
  );
}

export default function RequestContextSidebar({
  request,
  lifecycleStatus,
  urgencyLabel,
  propertyLabel,
  unitLabel,
  activeCandidate,
  onRequestChanged,
}: {
  request: RequestDetailRecord;
  lifecycleStatus: string;
  urgencyLabel: string;
  propertyLabel: string;
  unitLabel: string;
  activeCandidate: VendorRecommendationCandidate | null;
  /** Re-read the request after something on this card changed it. */
  onRequestChanged?: () => void;
}) {
  const [marking, setMarking] = useState<MarkablePayment | null>(null);
  const directPayment = request.directPayment || null;
  // One line instead of the old Location card, which repeated the header's
  // property and unit under a heading of its own.
  const where = [propertyLabel, unitLabel].filter(Boolean).join(' · ');
  const assignedVendor =
    typeof request.vendorId === 'object' && request.vendorId ? request.vendorId : null;
  // `confirmed` was never a valid value on either model, so every non-scheduled
  // state silently rendered "Assigned". Full map instead.
  const APPOINTMENT_LABELS: Record<string, string> = {
    scheduled: 'Scheduled',
    awaiting_tenant: 'Awaiting tenant',
    awaiting_vendor: 'Awaiting vendor',
    proposed: 'Needs a time',
    work_verifying: 'Awaiting tenant sign-off',
    in_review: 'Evidence under review',
    disputed: 'Tenant reported unresolved',
    completed: 'Visit completed',
    cancelled: 'Cancelled',
    failed: 'Scheduling failed',
  };
  const assignedVendorLabel = APPOINTMENT_LABELS[request.appointmentStatus || ''] || 'Assigned';

  return (
    <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start in-[.lichen-d3]:[overflow-wrap:anywhere]">
      <DetailCard icon={ClipboardList} title="Request context" className="p-5">
        <div>
          {infoRow('Status', lifecycleStatus.replace(/_/g, ' '))}
          {infoRow('Priority', urgencyLabel)}
          {infoRow('Category', request.category)}
          {/* Final cost and Responsibility were here. Neither drives anything a
              manager does on this page yet; both are still on the request. */}
          {where ? infoRow('Property', where, { capitalize: false }) : null}
        </div>
      </DetailCard>

      {/* Direct pay: the landlord pays this vendor themselves. Shown once the
          job has closed and something is owed or was paid. */}
      {directPayment ? (
        <DetailCard icon={HandCoins} iconColor="#059669" title="Payment" className="p-5">
          <div data-testid="request-direct-payment">
            <p className="text-sm text-slate-600 in-[.lichen-d3]:text-meta">
              {directPayment.status === 'due'
                ? `You pay ${directPayment.vendorName || 'the vendor'} directly for this job.`
                : `You paid ${directPayment.vendorName || 'the vendor'} directly${
                    directPayment.paidAt
                      ? ` on ${new Date(directPayment.paidAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                      : ''
                  }${directPayment.reference ? ` (${directPayment.reference})` : ''}.`}
            </p>
            <div className="mt-3 flex items-center justify-between gap-3 in-[.lichen-d3]:flex-wrap">
              <span className="text-lg font-semibold tabular-nums text-slate-900 in-[.lichen-d3]:text-ink in-[.lichen-d3]:font-mono">
                {new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(directPayment.amount)}
              </span>
              {directPayment.status === 'due' ? (
                <Button
                  size="sm"
                  onClick={() =>
                    setMarking({
                      appointmentId: directPayment.appointmentId,
                      amount: directPayment.amount,
                      vendorName: directPayment.vendorName,
                      issueTitle: request.issueTitle || null,
                    })
                  }
                  className="bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground"
                  data-testid="request-direct-payment-mark"
                >
                  Mark paid
                </Button>
              ) : (
                <Badge className="border-transparent bg-emerald-100 text-emerald-700 in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text">Paid</Badge>
              )}
            </div>
          </div>
          <MarkDirectPaidDialog
            payment={marking}
            onClose={() => setMarking(null)}
            onMarked={() => onRequestChanged?.()}
          />
        </DetailCard>
      ) : null}

      {/* Only when there is a vendor to show. Its third state, "Next manager
          action", restated what the Vendor Routing tab already says in more
          detail; this card stays because it is the one place the assigned
          vendor's phone number appears. */}
      {assignedVendor || activeCandidate ? (
        <DetailCard
          icon={Wrench}
          iconColor={assignedVendor ? '#059669' : '#4f46e5'}
          title={assignedVendor ? 'Assigned vendor' : 'Active vendor candidate'}
          className="p-5"
        >
          {assignedVendor ? (
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-mist-line in-[.lichen-d3]:bg-mist-tint">
              <p className="font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{assignedVendor.name || 'Assigned vendor'}</p>
              {assignedVendor.company ? (
                <p className="mt-1 text-sm text-slate-600 in-[.lichen-d3]:text-meta">{assignedVendor.company}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge className="border-transparent bg-emerald-100 text-emerald-700 in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text">
                  {assignedVendorLabel}
                </Badge>
                {assignedVendor.phone ? (
                  <Badge className="border-transparent bg-white text-slate-700 shadow-sm in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink in-[.lichen-d3]:shadow-none">
                    {assignedVendor.phone}
                  </Badge>
                ) : null}
              </div>
            </div>
          ) : activeCandidate ? (
            <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-4 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-well">
              <p className="font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{activeCandidate.name}</p>
              <p className="mt-1 text-sm text-slate-600 in-[.lichen-d3]:text-meta">{activeCandidate.providerName}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Badge className="max-w-full whitespace-normal border-transparent bg-indigo-100 text-indigo-700 in-[.lichen-d3]:bg-well in-[.lichen-d3]:text-ink">
                  {activeCandidate.state === 'selected' ? 'Selected vendor' : 'Contact approved'}
                </Badge>
                <Badge className="max-w-full whitespace-normal border-transparent bg-white text-slate-700 shadow-sm in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink in-[.lichen-d3]:shadow-none">
                  {getSourceLabel(activeCandidate.candidateSource)}
                </Badge>
              </div>
              {activeCandidate.service ? (
                <p className="mt-3 text-sm text-slate-600 in-[.lichen-d3]:text-meta">{activeCandidate.service}</p>
              ) : null}
            </div>
          ) : null}
        </DetailCard>
      ) : null}
    </aside>
  );
}
