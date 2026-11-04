import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import TenantArchivedRequests from '../../components/tenant/TenantArchivedRequests';
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  Bug,
  ChevronRight,
  Droplet,
  Lock,
  ListChecks,
  ShieldAlert,
  Trash2,
  Wind,
  Wrench,
  Zap,
} from 'lucide-react';
import { CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { TenantAPI } from '../../api/client';
import { useAppointments } from '../../hooks/useAppointments';
import { formatAppointmentWhen } from '../../types/appointment';
import { TenantPage, TenantPageHeader, TenantState, TENANT_FIELD, useTenantPresentation } from '../../components/tenant/tenantPresentation';
import { tenantStatusClass } from '../../components/tenant/tenantRoles';
import { TenantConfirmDialog, useTenantConfirmationFocus } from '../../components/tenant/TenantDialogs';
import {
  FieldLabel,
  LandlordError,
  LandlordLoading,
  fieldClass,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import { Card } from '../../components/ui/card';
import {
  STATUS_LABEL,
  getEffectiveStatus,
  type Request,
} from '../../components/tenant/tenantRequests';
import {
  AppealRequestDialog,
  type AppealRequestTarget,
} from '../../components/tenant/AppealRequestDialog';
import { useTenantRequests } from '../../hooks/tenant/useTenantRequests';
import { useTenantMoveOut } from '../../hooks/tenant/useTenantMoveOut';
import { useRequestQuota } from '../../hooks/tenant/useRequestQuota';
import RequestQuotaMeter from '../../components/tenant/RequestQuotaMeter';
import { CreationGateNotice, NewRequestButton, SafetyConcernLink } from '../../components/tenant/NewRequestGate';
import { outstandingQuestions, safetyPendingReview, tenantSafetyLabel } from '../../lib/requestWorkflow';

type ProcessFilter = 'all' | 'queued' | 'active' | 'completed' | 'rejected';

const matchesProcess = (processFilter: ProcessFilter, status: string) => {
  if (processFilter === 'all') return true;
  if (processFilter === 'queued') return status === 'queued';
  if (processFilter === 'active') return ['approved', 'assigned', 'in_progress'].includes(status);
  if (processFilter === 'completed') return status === 'completed';
  if (processFilter === 'rejected') return ['rejected', 'appeal_pending', 'cancelled'].includes(status);
  return true;
};

// Soft, low-saturation status pills read calmer than solid badges.
const STATUS_PILL: Record<string, string> = {
  queued: 'bg-amber-50 text-amber-700 ring-amber-200',
  approved: 'bg-sky-50 text-sky-700 ring-sky-200',
  assigned: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  in_progress: 'bg-blue-50 text-blue-700 ring-blue-200',
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  rejected: 'bg-rose-50 text-rose-700 ring-rose-200',
  appeal_pending: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200',
  cancelled: 'bg-slate-100 text-slate-600 ring-slate-200',
};

function categoryIcon(category?: string) {
  const c = (category || '').toLowerCase();
  if (c.includes('plumb') || c.includes('water') || c.includes('leak')) return Droplet;
  if (c.includes('electric') || c.includes('power') || c.includes('light')) return Zap;
  if (c.includes('hvac') || c.includes('heat') || c.includes('cool') || c.includes('air')) return Wind;
  if (c.includes('struct')) return Building2;
  if (c.includes('pest')) return Bug;
  if (c.includes('lock') || c.includes('hardware')) return Lock;
  return Wrench;
}

function timeAgo(iso: string) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function RequestsPage() {
  const tenantPresentation = useTenantPresentation();
  useLandlordEntrance();
  const navigate = useNavigate();
  const { linked } = useTenantMoveOut();
  // Finished requests move to the archive a week after they end; the switch is
  // in the URL so the Schedule page can link straight to it.
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') === 'archived' ? 'archived' : 'active';
  const { requests, setRequests, loading, error, reload } = useTenantRequests();
  const deleteDialogFocus = useTenantConfirmationFocus(loading);
  const { quota, gate, reload: reloadQuota } = useRequestQuota(linked);
  const { appointments } = useAppointments('tenant');
  const awaitingConfirmation = appointments.filter((a) => a.status === 'awaiting_tenant');

  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [processFilter, setProcessFilter] = useState<ProcessFilter>('all');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [appealTarget, setAppealTarget] = useState<AppealRequestTarget | null>(null);
  const [appealBusy, setAppealBusy] = useState(false);

  const requestCategories = useMemo(
    () => Array.from(new Set(requests.map((r) => r.category).filter(Boolean))).sort(),
    [requests]
  );
  const requestStatuses = useMemo(
    () => Array.from(new Set(requests.map((r) => getEffectiveStatus(r)).filter(Boolean))).sort(),
    [requests]
  );

  const filteredRequests = useMemo(
    () =>
      requests.filter((r) => {
        const effectiveStatus = getEffectiveStatus(r);
        const byCategory = categoryFilter === 'all' || r.category === categoryFilter;
        const byStatus = statusFilter === 'all' || effectiveStatus === statusFilter;
        const byProcess = matchesProcess(processFilter, effectiveStatus);
        return byCategory && byStatus && byProcess;
      }),
    [requests, categoryFilter, statusFilter, processFilter]
  );

  const confirmAppeal = async (note: string) => {
    if (!appealTarget) return;
    setAppealBusy(true);
    try {
      await TenantAPI.appealRequest(appealTarget.requestId, note);
      setAppealTarget(null);
      void reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit appeal');
      void reload({ silent: true });
    } finally {
      setAppealBusy(false);
    }
  };

  // Re-verify the request is still queued before offering deletion — the
  // landlord may have advanced it since the list was loaded.
  const requestDelete = async (id: string) => {
    try {
      const response = await TenantAPI.getRequest(id);
      const currentRequest = response.data as Request;
      setRequests((current) =>
        current.map((request) => (request._id === currentRequest._id ? currentRequest : request))
      );
      if (getEffectiveStatus(currentRequest) !== 'queued') {
        toast.info('This request is no longer queued and cannot be deleted.');
        return;
      }
      setPendingDeleteId(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to verify request status');
    }
  };

  const confirmDelete = async () => {
    if (!pendingDeleteId) return;
    try {
      await TenantAPI.deletePendingRequest(pendingDeleteId);
      toast.success('Pending request deleted');
      setPendingDeleteId(null);
      void reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete request');
      setPendingDeleteId(null);
      void reload({ silent: true });
    }
  };

  if (loading) {
    return <TenantState><LandlordLoading label="Loading requests..." /></TenantState>;
  }

  if (error) {
    return <TenantState><LandlordError title="Requests unavailable" message={error} onRetry={() => void reload()} /></TenantState>;
  }

  return (
    <TenantPage>
      <div className="[&>div>div:first-child]:flex-wrap [&>div>div:first-child>div:last-child]:min-w-0 [&>div>div:first-child>div:last-child]:flex-1 [&>div>div:first-child>div:last-child]:basis-48 [&_h2]:[overflow-wrap:anywhere]">
      <TenantPageHeader
        icon={Wrench}
        title="Maintenance Requests"
        description="Submit and track issues in your unit."
        titleTestId="tenant-page-title"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {/* Separate from the normal limits; a tenant with no unit can't file
                either kind, and the layout banner says why. */}
            {linked ? <SafetyConcernLink /> : null}
            <NewRequestButton gate={gate} linked={linked} onClick={() => navigate('/portal/new')} />
          </div>
        }
      />
      </div>
      {linked && view === 'active' ? (
        <CreationGateNotice gate={gate} onRetry={() => void reloadQuota()} className="ll-fade-up mb-4" showSafetyLink={false} />
      ) : null}

      {view === 'active' ? <RequestQuotaMeter quota={quota} className="ll-fade-up mb-6" /> : null}

      {/* A pending confirmation is time-critical and the tenant's only other
          signal is a notification, so it gets surfaced on the landing page. */}
      {awaitingConfirmation.length > 0 ? (
        <button
          type="button"
          onClick={() => navigate('/portal/schedule')}
          data-testid="tenant-confirm-banner"
          className="ll-fade-up mb-6 flex w-full items-center justify-between gap-4 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-left transition hover:border-amber-300 hover:bg-amber-100/70 in-[.lichen-d5]:flex-wrap in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-lichen-line in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:hover:border-control-border in-[.lichen-d5]:hover:bg-lichen-tint"
        >
          <span className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700 in-[.lichen-d5]:rounded-md in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-lichen-text">
              <CalendarClock className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-amber-900 in-[.lichen-d5]:text-lichen-text">
                {awaitingConfirmation.length === 1
                  ? 'A vendor is waiting on you to confirm a time'
                  : `${awaitingConfirmation.length} appointments need your confirmation`}
              </span>
              <span className="mt-0.5 block text-sm text-amber-800 in-[.lichen-d5]:text-lichen-text">
                {awaitingConfirmation.length === 1
                  ? formatAppointmentWhen(awaitingConfirmation[0])
                  : 'Confirm the times so the visits can be booked.'}
              </span>
            </span>
          </span>
          <span className="shrink-0 text-sm font-semibold text-amber-900 in-[.lichen-d5]:text-lichen-text">Review →</span>
        </button>
      ) : null}

      <div className="mb-4 inline-flex max-w-full flex-wrap rounded-lg border border-slate-200 bg-white p-0.5 in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card" role="tablist" data-testid="tenant-request-view">
        {(['active', 'archived'] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={view === option}
            data-testid={`tenant-view-${option}`}
            onClick={() => setSearchParams(option === 'archived' ? { view: 'archived' } : {}, { replace: true })}
            className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition ${
              view === option ? 'bg-slate-900 text-white shadow-sm in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:shadow-none' : "text-slate-600 hover:text-slate-900 in-[.lichen-d5]:text-meta in-[.lichen-d5]:hover:text-ink"
            }`}
          >
            {option === 'active' ? 'Active' : 'Archived'}
          </button>
        ))}
      </div>

      {view === 'archived' ? (
        <TenantArchivedRequests />
      ) : (
        <>
      <Card className="ll-fade-up mb-6 gap-4 border border-slate-100 p-5 shadow-sm in-[.lichen-d5]:border-border in-[.lichen-d5]:shadow-none">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <FieldLabel className="in-[.lichen-d5]:text-meta">Category</FieldLabel>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label={tenantPresentation ? 'Category' : undefined}
              className={`${fieldClass} ${TENANT_FIELD}`}
            >
              <option value="all">All categories</option>
              {requestCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <FieldLabel className="in-[.lichen-d5]:text-meta">Status</FieldLabel>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label={tenantPresentation ? 'Status' : undefined}
              className={`${fieldClass} ${TENANT_FIELD}`}
            >
              <option value="all">All statuses</option>
              {requestStatuses.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s] || s}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <FieldLabel className="in-[.lichen-d5]:text-meta">Process</FieldLabel>
            <select
              value={processFilter}
              onChange={(e) => setProcessFilter(e.target.value as ProcessFilter)}
              aria-label={tenantPresentation ? 'Process' : undefined}
              className={`${fieldClass} ${TENANT_FIELD}`}
            >
              <option value="all">All process stages</option>
              <option value="queued">Queued</option>
              <option value="active">Active Work</option>
              <option value="completed">Completed</option>
              <option value="rejected">Rejected / Cancelled</option>
            </select>
          </div>
        </div>
      </Card>

      <Card className="ll-fade-up border border-slate-100 p-5 shadow-sm in-[.lichen-d5]:border-border in-[.lichen-d5]:shadow-none" style={{ animationDelay: '70ms' }}>
        {filteredRequests.length === 0 ? (
          <div className="py-12 text-center">
            <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 in-[.lichen-d5]:bg-chip">
              <AlertCircle className="h-7 w-7 text-slate-400 in-[.lichen-d5]:text-meta" />
            </div>
            <p className="text-sm text-slate-500 in-[.lichen-d5]:text-meta" data-testid="tenant-empty">
              No requests match your filters.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filteredRequests.map((r) => {
              const effectiveStatus = getEffectiveStatus(r);
              const Icon = categoryIcon(r.category);
              const urgent = r.urgency === 'high' || r.urgency === 'emergency';
              // Decided by the server: the browser's clock can be wrong.
              const canAppeal = Boolean(r.appeal?.canAppeal);
              const canDelete = effectiveStatus === 'queued';
              const owesDetails = outstandingQuestions(r.intakeFollowUp).length > 0;
              const safetyLabel = tenantSafetyLabel(r.safetyAssessment);
              const safetyReview = Boolean(safetyLabel);
              return (
                <div
                  key={r._id}
                  data-testid={`tenant-request-${r._id}`}
                  role="link"
                  tabIndex={0}
                  aria-label={`Open request: ${r.ai?.shortTitle || r.ai?.summary || r.issueTitle}`}
                  className="group cursor-pointer rounded-xl border border-slate-100 p-3.5 transition-all hover:border-[#137fec]/30 hover:bg-slate-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#137fec]/40 in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-hairline in-[.lichen-d5]:hover:border-control-border in-[.lichen-d5]:hover:bg-well"
                  onClick={() => navigate(`/portal/requests/${r._id}`)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/portal/requests/${r._id}`);
                    }
                  }}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#137fec]/10 text-[#137fec] in-[.lichen-d5]:rounded-md in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-chip-icon">
                      <Icon className="h-[18px] w-[18px]" />
                    </div>
                    <div className="min-w-0 flex-1 basis-32">
                      <div className="flex items-start gap-1.5">
                        {urgent && (
                          <AlertTriangle
                            aria-label={r.urgency === 'emergency' ? 'Emergency' : 'Urgent'}
                            className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                              r.urgency === 'emergency' ? 'text-rose-500 in-[.lichen-d5]:text-alert-text' : 'text-amber-500 in-[.lichen-d5]:text-alert-text'
                            }`}
                          />
                        )}
                        <span className="line-clamp-2 min-w-0 text-sm font-semibold leading-snug text-slate-900 in-[.lichen-d5]:text-ink">
                          {r.ai?.shortTitle || r.ai?.summary || r.issueTitle}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-slate-500 in-[.lichen-d5]:text-meta">
                        {r.category} · {timeAgo(r.createdAt)}
                      </div>
                      {safetyReview || owesDetails ? (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {safetyReview ? (
                            <span
                              data-testid={`tenant-safety-review-${r._id}`}
                              data-pending={safetyPendingReview(r.safetyAssessment) ? 'true' : 'false'}
                              className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700 ring-1 ring-inset ring-rose-200 in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text in-[.lichen-d5]:ring-0"
                            >
                              <ShieldAlert className="h-3 w-3" aria-hidden="true" /> {safetyLabel}
                            </span>
                          ) : null}
                          {owesDetails ? (
                            <span
                              data-testid={`tenant-owes-details-${r._id}`}
                              className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700 ring-1 ring-inset ring-sky-200 in-[.lichen-d5]:bg-lichen-tint in-[.lichen-d5]:text-lichen-text in-[.lichen-d5]:ring-0"
                            >
                              <ListChecks className="h-3 w-3" aria-hidden="true" /> Add missing details
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <span
                      className={`inline-flex max-w-full shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset [overflow-wrap:anywhere] ${
                        STATUS_PILL[effectiveStatus] || "bg-slate-100 text-slate-600 ring-slate-200 in-[.lichen-d5]:bg-chip in-[.lichen-d5]:text-meta"
                      } ${tenantStatusClass(effectiveStatus)}`}
                    >
                      {STATUS_LABEL[effectiveStatus] || effectiveStatus}
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-400 in-[.lichen-d5]:text-meta in-[.lichen-d5]:group-hover:text-meta" />
                  </div>
                  {(canAppeal || canDelete) && (
                    <div className="mt-2.5 flex items-center gap-4 border-t border-slate-100 pl-12 pt-2.5 in-[.lichen-d5]:flex-wrap in-[.lichen-d5]:border-hairline in-[.lichen-d5]:pl-0">
                      {canAppeal && (
                        <button
                          data-testid={`appeal-${r._id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setAppealTarget({
                              requestId: r._id,
                              issueTitle: r.issueTitle,
                              summary: r.ai?.summary,
                              rejectionReason: r.rejectionReason,
                            });
                          }}
                          className="text-xs font-medium text-[#137fec] hover:underline in-[.lichen-d5]:text-lichen-text"
                        >
                          Appeal rejection
                        </button>
                      )}
                      {canDelete && (
                        <button
                          data-testid={`delete-pending-${r._id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void requestDelete(r._id);
                          }}
                          className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 transition-colors hover:text-rose-600 in-[.lichen-d5]:text-meta in-[.lichen-d5]:hover:text-alert-text"
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
        </>
      )}

      <TenantConfirmDialog
        {...deleteDialogFocus}
        open={Boolean(pendingDeleteId)}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
        title="Delete pending request?"
        description="Deleting will permanently remove this queued request and its related draft workflow artifacts. This action cannot be undone."
        confirmLabel="Delete request"
        onConfirm={confirmDelete}
      />

      <AppealRequestDialog
        target={appealTarget}
        busy={appealBusy}
        onClose={() => setAppealTarget(null)}
        onConfirm={confirmAppeal}
      />
    </TenantPage>
  );
}
