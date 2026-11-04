import { AlertTriangle, MoreVertical } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { RequestItem } from '../../types/landlord';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { cn } from '../ui/utils';
import { categoryColor, categoryIcon } from './overview/categoryVisuals';
import {
  STATUS_COLORS,
  canRejectRequest,
  getContactCandidate,
  getContactStatus,
  getPropertyLabel,
  getRequestDisplayTitle,
  getRequestLifecycleStatus,
  getUnitLabel,
} from './requestHelpers';
import { requestFinalCost, requestVendorLabel } from './requestsTableData';
import RequestIdentity, { NewRequestBadge } from './RequestIdentity';
import RequestWorkflowLines from './RequestWorkflowLines';
import { useNewRequestIds } from '../../hooks/landlord/useNewRequests';
import { D3_PORTAL, d3StatusClass, useD3Presentation } from '../request-detail/d3Presentation';

const PRIORITY: Record<string, { label: string; className: string; dot: string }> = {
  emergency: { label: 'Emergency', className: 'bg-rose-50 text-rose-700 in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-destructive', dot: 'bg-rose-500 in-[.lichen-d3]:bg-destructive' },
  high: { label: 'High', className: 'bg-rose-50 text-rose-700 in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-destructive', dot: 'bg-rose-500 in-[.lichen-d3]:bg-destructive' },
  medium: { label: 'Medium', className: 'bg-amber-50 text-amber-700 in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text', dot: 'bg-amber-500 in-[.lichen-d3]:bg-lichen-icon' },
  low: { label: 'Low', className: 'bg-sky-50 text-sky-700 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-chip-icon', dot: 'bg-sky-500 in-[.lichen-d3]:bg-chip-icon' },
};

const money = (value: number) => `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function lifecycleLabel(status: string) {
  const clean = status.replace(/_/g, ' ');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * The maintenance request list as a table (md and up). Each row opens the
 * request; the row menu carries the same actions the old cards did — approve
 * contact, reject, assign, complete — under the same rules and test ids.
 */
export default function RequestsTable({
  requests,
  onApproveContact,
  onReject,
  onAssign,
  onComplete,
  onView,
}: {
  requests: RequestItem[];
  onApproveContact: (request: RequestItem) => void;
  onReject: (request: RequestItem) => void;
  onAssign: (id: string) => void;
  onComplete: (id: string) => void;
  onView: (id: string) => void;
}) {
  const d3 = useD3Presentation();
  const newIds = useNewRequestIds(requests);
  if (!requests.length) {
    return (
      <div className="py-12 text-center text-slate-400 in-[.lichen-d3]:text-meta" data-testid="no-requests">
        No requests.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto in-[.lichen-d3]:relative">
      <table className="w-full min-w-[60rem] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-xs font-semibold text-slate-500 in-[.lichen-d3]:border-hairline in-[.lichen-d3]:text-meta">
            <th className="px-5 py-3 font-semibold">Request</th>
            <th className="px-2.5 py-3 font-semibold">Property / Unit</th>
            <th className="px-2.5 py-3 font-semibold">Category</th>
            <th className="px-2.5 py-3 font-semibold">Priority</th>
            <th className="px-2.5 py-3 font-semibold">Submitted</th>
            <th className="px-2.5 py-3 font-semibold">Vendor / Assignment</th>
            <th className="whitespace-nowrap px-2.5 py-3 font-semibold">Final cost</th>
            <th className="px-2.5 py-3 font-semibold">Status</th>
            <th className="px-4 py-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 in-[.lichen-d3]:divide-hairline">
          {requests.map((request) => {
            const lifecycle = getRequestLifecycleStatus(request);
            const contactState = getContactStatus(request);
            const candidate = getContactCandidate(request);
            const priority = PRIORITY[request.urgency] || PRIORITY.medium;
            const vendor = requestVendorLabel(request);
            const finalCost = requestFinalCost(request);
            const Icon = categoryIcon(request.category);
            const color = categoryColor(request.category);
            const unit = getUnitLabel(request.unitId);
            const created = new Date(request.createdAt);
            const canAssign = request.status === 'approved' && contactState.kind === 'none';
            const canComplete = ['assigned', 'in_progress'].includes(request.status);
            const canReject = canRejectRequest(request);
            const hasMenu = Boolean(candidate) || canReject || canAssign || canComplete;
            return (
              <tr
                key={request._id}
                data-testid={`request-row-${request._id}`}
                onClick={() => onView(request._id)}
                className={cn("cursor-pointer align-middle transition hover:bg-slate-50/70 in-[.lichen-d3]:hover:bg-well in-[.lichen-d3]:motion-reduce:transition-none", newIds.has(request._id) && 'bg-blue-50/40 ring-1 ring-inset ring-blue-200 in-[.lichen-d3]:bg-new-row in-[.lichen-d3]:ring-0')}
              >
                <td className="max-w-[13rem] px-5 py-3.5">
                  <div className="flex items-center gap-1.5">
                    {request.urgency === 'emergency' ? (
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" aria-label="Emergency" />
                    ) : null}
                    <span className="truncate font-semibold text-slate-900 in-[.lichen-d3]:text-ink">{getRequestDisplayTitle(request)}</span>
                    {newIds.has(request._id) ? <NewRequestBadge /> : null}
                  </div>
                  <RequestIdentity id={request._id} />
                  <div className="truncate text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                    {request.ai?.summary || request.issueDescription}
                  </div>
                  <RequestWorkflowLines request={request} />
                </td>
                <td className="max-w-[10rem] px-2.5 py-3.5">
                  <div className="truncate text-slate-700 in-[.lichen-d3]:text-ink">{getPropertyLabel(request.propertyId) || '—'}</div>
                  {unit !== '-' ? <div className="truncate text-xs text-slate-500 in-[.lichen-d3]:text-meta">{unit}</div> : null}
                </td>
                <td className="px-2.5 py-3.5">
                  <span className="flex items-center gap-2 whitespace-nowrap text-slate-700 in-[.lichen-d3]:text-ink">
                    <span
                      className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg 2xl:flex in-[.lichen-d3]:rounded-md in-[.lichen-d3]:bg-chip! in-[.lichen-d3]:text-chip-icon!"
                      style={{ backgroundColor: `${color}14`, color }}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    {request.category || 'Other'}
                  </span>
                </td>
                <td className="px-2.5 py-3.5">
                  <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold in-[.lichen-d3]:rounded-full', priority.className)}>
                    <span className={cn('h-1.5 w-1.5 rounded-full', priority.dot)} />
                    {priority.label}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2.5 py-3.5">
                  <div className="text-slate-700 in-[.lichen-d3]:text-ink">
                    {created.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                  <div className="text-xs text-slate-500 in-[.lichen-d3]:text-meta">
                    {created.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </div>
                </td>
                <td className="max-w-[8.5rem] px-2.5 py-3.5">
                  <div className={cn('truncate', vendor.pending ? "text-slate-400 in-[.lichen-d3]:text-meta" : "text-slate-700 in-[.lichen-d3]:text-ink")}>{vendor.name}</div>
                  {vendor.note ? <div className="text-xs text-slate-500 in-[.lichen-d3]:text-meta">{vendor.note}</div> : null}
                </td>
                <td className="whitespace-nowrap px-2.5 py-3.5 font-semibold text-slate-900 tabular-nums in-[.lichen-d3]:text-ink" data-testid={`request-final-cost-${request._id}`}>
                  {finalCost === null ? <span className="font-normal text-slate-400 in-[.lichen-d3]:text-meta">—</span> : money(finalCost)}
                </td>
                <td className="px-2.5 py-3.5">
                  <span
                    className={cn(
                      "inline-block max-w-[7.5rem] rounded-2xl px-2.5 py-1 text-center text-xs font-semibold leading-tight in-[.lichen-d3]:rounded-lg",
                      STATUS_COLORS[lifecycle] || "bg-slate-100 text-slate-700 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-ink",
                      'in-[.lichen-d3]:rounded-full', d3StatusClass(lifecycle)
                    )}
                  >
                    {lifecycleLabel(lifecycle)}
                  </span>
                </td>
                <td className="px-4 py-3.5" onClick={(event) => event.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    {request.status === 'completed' && <Link className="whitespace-nowrap rounded-lg border border-blue-200 px-2.5 py-1.5 text-xs font-semibold text-blue-700 in-[.lichen-d3]:rounded-md in-[.lichen-d3]:border-border in-[.lichen-d3]:text-lichen-text" to={`/dashboard/requests/${request._id}?tab=work`}>Work record</Link>}
                    <button
                      type="button"
                      data-testid={`view-${request._id}`}
                      onClick={() => onView(request._id)}
                      className="whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-[#137fec]/30 hover:text-[#137fec] in-[.lichen-d3]:rounded-md in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-ink in-[.lichen-d3]:hover:border-control-border in-[.lichen-d3]:hover:bg-well in-[.lichen-d3]:hover:text-lichen-text"
                    >
                      View details
                    </button>
                    {hasMenu ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label="More actions"
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 in-[.lichen-d3]:rounded-md in-[.lichen-d3]:text-meta in-[.lichen-d3]:hover:bg-chip in-[.lichen-d3]:hover:text-ink"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className={d3 ? D3_PORTAL : undefined}>
                          {candidate ? (
                            <DropdownMenuItem data-testid={`approve-${request._id}`} onSelect={() => onApproveContact(request)}>
                              Approve contact
                            </DropdownMenuItem>
                          ) : null}
                          {canAssign ? (
                            <DropdownMenuItem data-testid={`assign-${request._id}`} onSelect={() => onAssign(request._id)}>
                              Assign
                            </DropdownMenuItem>
                          ) : null}
                          {canComplete ? (
                            <DropdownMenuItem data-testid={`complete-${request._id}`} onSelect={() => onComplete(request._id)}>
                              Mark complete
                            </DropdownMenuItem>
                          ) : null}
                          {canReject ? (
                            <DropdownMenuItem
                              data-testid={`reject-${request._id}`}
                              onSelect={() => onReject(request)}
                              className="text-rose-600 focus:text-rose-700 in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:focus:text-alert-text"
                            >
                              Reject
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      // Same width as the menu button, so "View details" lines up down the column.
                      <span className="inline-block h-8 w-8" aria-hidden />
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
