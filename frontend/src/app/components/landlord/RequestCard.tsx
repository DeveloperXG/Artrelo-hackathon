import { AlertTriangle, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import type { RequestItem } from '../../types/landlord';
import RequestIdentity, { NewRequestBadge } from './RequestIdentity';
import RequestWorkflowLines from './RequestWorkflowLines';
import { D3_LINK, D3_PRIMARY, d3PriorityClass, d3StatusClass } from '../request-detail/d3Presentation';
import {
  canRejectRequest,
  DECISION_LABELS,
  getContactCandidate,
  getContactStatus,
  getPropertyLabel,
  getRequestDisplayTitle,
  getRequestLifecycleStatus,
  getTenantName,
  getUnitLabel,
  STATUS_COLORS,
  URGENCY_COLORS,
} from './requestHelpers';

export default function RequestCard({
  request,
  onApproveContact,
  onReject,
  onAssign,
  onComplete,
  onView,
  variant = 'default',
  isNew = false,
}: {
  request: RequestItem;
  onApproveContact: (request: RequestItem) => void;
  onReject: (request: RequestItem) => void;
  onAssign: (id: string) => void;
  onComplete: (id: string) => void;
  onView: (id: string) => void;
  variant?: 'default' | 'compact';
  isNew?: boolean;
}) {
  const contactState = getContactStatus(request);
  const contactCandidate = getContactCandidate(request);
  const isCompact = variant === 'compact';
  const lifecycleStatus = getRequestLifecycleStatus(request);
  const lifecycleLabel = lifecycleStatus
    .replace('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  const isEmergency = request.urgency === 'emergency';
  const isHigh = request.urgency === 'high';

  if (isCompact) {
    return (
      <div
        data-testid={`request-row-${request._id}`}
        role="link"
        tabIndex={0}
        onClick={() => onView(request._id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onView(request._id);
          }
        }}
        className={`cursor-pointer rounded-xl border p-4 transition hover:border-[#137fec]/30 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]/50 in-[.lichen-d3]:bg-card in-[.lichen-d3]:hover:border-control-border in-[.lichen-d3]:focus-visible:ring-0 in-[.lichen-d3]:focus-visible:outline-solid in-[.lichen-d3]:focus-visible:outline-2 in-[.lichen-d3]:focus-visible:outline-offset-2 in-[.lichen-d3]:focus-visible:outline-ring in-[.lichen-d3]:motion-reduce:transition-none in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:hover:bg-well ${isNew ? 'border-blue-300 bg-blue-50/40 ring-1 ring-inset ring-blue-200 in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-new-row in-[.lichen-d3]:ring-0' : "border-slate-100 in-[.lichen-d3]:border-hairline"} ${
          isEmergency ? 'border-l-4 border-l-rose-500 in-[.lichen-d3]:border-l in-[.lichen-d3]:border-l-border' : isHigh ? 'border-l-4 border-l-orange-400 in-[.lichen-d3]:border-l in-[.lichen-d3]:border-l-border' : ''
        }`}
      >
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
          <div className="min-w-0 w-full sm:w-auto sm:flex-1">
            <div className="flex items-center gap-1.5">
              {isEmergency || isHigh ? (
                <AlertTriangle
                  className={`h-3.5 w-3.5 shrink-0 in-[.lichen-d3]:text-destructive ${isEmergency ? 'text-rose-500' : 'text-orange-500'}`}
                />
              ) : null}
              <div className="truncate text-sm font-semibold text-slate-900 in-[.lichen-d3]:text-ink">
                {getRequestDisplayTitle(request)}
              </div>
            </div>
            <div className="mt-1 truncate text-xs text-slate-500 in-[.lichen-d3]:text-meta">
              {[getUnitLabel(request.unitId), getPropertyLabel(request.propertyId)]
                .filter((label) => label && label !== '-')
                .join(' · ') || 'Location unavailable'}
            </div>
            <div className="mt-1"><RequestIdentity id={request._id} createdAt={request.createdAt} /></div>
            <RequestWorkflowLines request={request} />
            {request.status === 'completed' && <Link to={`/dashboard/requests/${request._id}?tab=work`} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} className={`mt-2 inline-block text-xs font-semibold text-blue-700 underline ${D3_LINK}`}>Work record</Link>}
          </div>
          <div className="flex max-w-full flex-wrap justify-start gap-1.5 sm:max-w-[45%] sm:justify-end">
            {isNew ? <NewRequestBadge /> : null}
            <Badge className={`max-w-full whitespace-normal ${STATUS_COLORS[lifecycleStatus] || "bg-slate-100 text-slate-700 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-ink"} ${d3StatusClass(lifecycleStatus)}`}>
              {lifecycleLabel}
            </Badge>
            {isEmergency && (
              <Badge className="gap-1 bg-rose-100 text-rose-700 in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-destructive">
                <AlertTriangle className="h-3 w-3" />
                Emergency
              </Badge>
            )}
            {isHigh && (
              <Badge className="gap-1 bg-orange-100 text-orange-700 in-[.lichen-d3]:bg-alert-tint in-[.lichen-d3]:text-destructive">
                <AlertTriangle className="h-3 w-3" />
                Urgent
              </Badge>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid={`request-row-${request._id}`}
      role="link"
      tabIndex={0}
      onClick={() => onView(request._id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onView(request._id);
        }
      }}
      className={`cursor-pointer rounded-lg border p-3 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]/50 in-[.lichen-d3]:bg-card in-[.lichen-d3]:hover:border-control-border in-[.lichen-d3]:focus-visible:ring-0 in-[.lichen-d3]:focus-visible:outline-solid in-[.lichen-d3]:focus-visible:outline-2 in-[.lichen-d3]:focus-visible:outline-offset-2 in-[.lichen-d3]:focus-visible:outline-ring in-[.lichen-d3]:motion-reduce:transition-none in-[.lichen-d3]:hover:bg-well ${isNew ? 'border-blue-300 bg-blue-50/40 ring-1 ring-inset ring-blue-200 in-[.lichen-d3]:border-lichen-line in-[.lichen-d3]:bg-new-row in-[.lichen-d3]:ring-0' : "border-slate-100 in-[.lichen-d3]:border-hairline"}`}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            {isNew ? <NewRequestBadge /> : null}
            <Badge className={`${STATUS_COLORS[request.status] || ''} ${d3StatusClass(request.status)}`}>{request.status.replace('_', ' ')}</Badge>
            {contactState.kind === 'approved' && (
              <Badge className="bg-emerald-100 text-emerald-700 in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text">Contact approved</Badge>
            )}
            {contactState.kind === 'selected' && (
              <Badge className="bg-violet-100 text-violet-700 in-[.lichen-d3]:bg-pill-neutral in-[.lichen-d3]:text-chip-icon">Vendor selected</Badge>
            )}
            <Badge className={`${URGENCY_COLORS[request.urgency] || ''} ${d3PriorityClass(request.urgency)}`}>{request.urgency}</Badge>
            <span className="text-xs text-slate-500 in-[.lichen-d3]:text-meta">{request.category}</span>
            {(request.vendorRecommendation?.routingDecision?.decision || request.routingDecision) &&
              !request.vendorRecommendation?.managerAction?.type &&
              !['approved', 'selected'].includes(contactState.kind) && (
                <Badge className="bg-violet-100 text-violet-700 in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-pill">
                  {DECISION_LABELS[
                    request.vendorRecommendation?.routingDecision?.decision ||
                      request.routingDecision ||
                      ''
                  ] || 'Decision needed'}
                </Badge>
              )}
            {request.urgency === 'emergency' && <AlertTriangle className="h-3.5 w-3.5 text-rose-500 in-[.lichen-d3]:text-alert-text" />}
          </div>
          <div className="line-clamp-2 break-words text-sm font-medium leading-snug text-slate-900 in-[.lichen-d3]:text-ink">
            {getRequestDisplayTitle(request)}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 in-[.lichen-d3]:text-meta">
            {getTenantName(request.tenantId)} · {getUnitLabel(request.unitId)}{' '}
            {getPropertyLabel(request.propertyId) && `· ${getPropertyLabel(request.propertyId)}`}
          </div>
          <div className="mt-1"><RequestIdentity id={request._id} createdAt={request.createdAt} /></div>
            <RequestWorkflowLines request={request} />
        </div>
        <div
          className="flex flex-wrap items-center justify-end gap-1.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {contactCandidate && (
            <Button
              size="sm"
              data-testid={`approve-${request._id}`}
              className={`h-8 bg-emerald-600 text-xs hover:bg-emerald-700 ${D3_PRIMARY}`}
              onClick={() => onApproveContact(request)}
            >
              Approve Contact
            </Button>
          )}
          {['approved', 'selected'].includes(contactState.kind) && (
            <Badge
              className={
                contactState.kind === 'selected'
                  ? 'bg-violet-100 text-violet-700 in-[.lichen-d3]:bg-pill-neutral in-[.lichen-d3]:text-chip-icon'
                  : 'bg-indigo-100 text-indigo-700 in-[.lichen-d3]:bg-mist-tint in-[.lichen-d3]:text-mist-text'
              }
            >
              {contactState.kind === 'selected' ? 'Assigned candidate' : 'Awaiting vendor response'}:{' '}
              {contactState.candidate?.name}
            </Badge>
          )}
          {canRejectRequest(request) && (
            <Button
              size="sm"
              data-testid={`reject-${request._id}`}
              variant="outline"
              className="h-8 border-rose-200 text-xs text-rose-600 hover:bg-rose-50 in-[.lichen-d3]:border-alert-line in-[.lichen-d3]:text-alert-text in-[.lichen-d3]:hover:bg-alert-tint"
              onClick={() => onReject(request)}
            >
              Reject
            </Button>
          )}
          {request.status === 'approved' && contactState.kind === 'none' && (
            <Button
              size="sm"
              data-testid={`assign-${request._id}`}
              className={`h-8 bg-indigo-600 text-xs hover:bg-indigo-700 ${D3_PRIMARY}`}
              onClick={() => onAssign(request._id)}
            >
              Assign
            </Button>
          )}
          {['assigned', 'in_progress'].includes(request.status) && (
            <Button
              size="sm"
              data-testid={`complete-${request._id}`}
              className="h-8 bg-slate-900 text-xs hover:bg-slate-800 in-[.lichen-d3]:bg-chip in-[.lichen-d3]:text-ink in-[.lichen-d3]:hover:bg-well"
              onClick={() => onComplete(request._id)}
            >
              Complete
            </Button>
          )}
          {request.status === 'completed' && <Button size="sm" variant="outline" className="h-8 text-xs" asChild><Link to={`/dashboard/requests/${request._id}?tab=work`}>Work record</Link></Button>}
          <Button
            size="sm"
            data-testid={`view-${request._id}`}
            variant="ghost"
            className="h-8 text-xs"
            onClick={() => onView(request._id)}
          >
            View <ChevronRight className="ml-1 h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
