import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarDays, ClipboardCheck, Clock, Hourglass, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { TenantAPI } from '../../api/client';
import PageHeader from '../../components/landlord/PageHeader';
import StatCard, { StatGrid } from '../../components/landlord/StatCard';
import ScheduleCalendar from '../../components/landlord/schedule/ScheduleCalendar';
import {
  matchesFilter,
  needsTenantAttention,
  tenantCanAct,
  type ScheduleFilter,
} from '../../components/landlord/schedule/scheduleStatus';
import AppointmentCard from '../../components/AppointmentCard';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Dialog, DialogDescription, DialogTitle } from '../../components/ui/dialog';
import { TenantPage, TenantState, TenantPageHeader, TENANT_FIELD, useTenantPresentation } from '../../components/tenant/tenantPresentation';
import { TenantDialogContent, TenantFormDialog } from '../../components/tenant/TenantDialogs';
import { Textarea } from '../../components/ui/textarea';
import {
  EmptyState,
  FieldLabel,
  LandlordError,
  LandlordLoading,
  PageContainer,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import { useAppointments } from '../../hooks/useAppointments';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { adjustTenantBadge, refreshTenantBadges } from '../../hooks/tenant/useTenantBadges';
import { appointmentRequestId, appointmentTitle, type AppointmentItem } from '../../types/appointment';
import { useJudgeSandbox } from '../../components/judge/JudgeSandboxProvider';

type TenantFilter = Extract<ScheduleFilter, 'upcoming' | 'awaiting_tenant' | 'your_review' | 'waiting_on_manager'>;

const FILTER_LABELS: Record<TenantFilter, string> = {
  upcoming: 'Upcoming visits',
  awaiting_tenant: 'Confirm a time',
  your_review: 'Review the work',
  waiting_on_manager: 'Waiting on your manager',
};

export default function TenantSchedulePage() {
  const { view: judge } = useJudgeSandbox();
  const judgeVerification = judge.loaded && !judge.refreshFailed && !judge.notice && !judge.pollExpired &&
    judge.status.enabled && judge.status.role === 'tenant';
  const tenantPresentation = useTenantPresentation();
  const ScheduleHeader = tenantPresentation ? TenantPageHeader : PageHeader;
  useLandlordEntrance();
  const navigate = useNavigate();
  const { appointments, loading, error, reload } = useAppointments('tenant');
  const [busyId, setBusyId] = useState('');
  const [declineTarget, setDeclineTarget] = useState<AppointmentItem | null>(null);
  const [declineNote, setDeclineNote] = useState('');
  const [disputeTarget, setDisputeTarget] = useState<AppointmentItem | null>(null);
  const [disputeNote, setDisputeNote] = useState('');
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [noShowTarget, setNoShowTarget] = useState<AppointmentItem | null>(null);
  const [noShowNote, setNoShowNote] = useState('');
  const [filter, setFilter] = useState<TenantFilter | null>(null);
  // The visit opened from the calendar, shown with its own buttons.
  const [selected, setSelected] = useState<AppointmentItem | null>(null);
  // A week of seven columns doesn't fit a phone; it opens on the day instead.
  const wide = useMediaQuery('(min-width: 768px)');

  const counts = useMemo(
    () => ({
      upcoming: appointments.filter((a) => matchesFilter(a, 'upcoming')).length,
      awaiting_tenant: appointments.filter((a) => matchesFilter(a, 'awaiting_tenant')).length,
      your_review: appointments.filter((a) => matchesFilter(a, 'your_review')).length,
      waiting_on_manager: appointments.filter((a) => matchesFilter(a, 'waiting_on_manager')).length,
    }),
    [appointments]
  );

  const visible = useMemo(() => appointments.filter((a) => matchesFilter(a, filter)), [appointments, filter]);

  // What the tenant can act on comes first, then anything the calendar can't
  // place; within each, soonest first. A visit that happened but still owes an
  // answer is here, not buried in history — that's how a job used to
  // auto-close without the tenant ever seeing the question.
  const attention = useMemo(
    () =>
      visible.filter(needsTenantAttention).sort((a, b) => {
        const act = Number(tenantCanAct(b)) - Number(tenantCanAct(a));
        if (act) return act;
        const at = a.confirmedStart ? new Date(a.confirmedStart).getTime() : Infinity;
        const bt = b.confirmedStart ? new Date(b.confirmedStart).getTime() : Infinity;
        return at - bt;
      }),
    [visible]
  );

  const confirm = async (appointment: AppointmentItem) => {
    setBusyId(appointment._id);
    // Optimistic, and BEFORE the request. Each of these four answers resolves
    // exactly one thing that was waiting on the tenant; waiting for the round
    // trip to finish is what left the badge sitting on the old number. It is
    // put back in the catch if the answer does not land.
    adjustTenantBadge('schedule', -1);
    try {
      await TenantAPI.confirmAppointment(appointment._id, true, undefined, appointment.coordinationRevision);
      toast.success('Appointment confirmed — the vendor and your manager have been told.');
      await reload({ silent: true });
      void refreshTenantBadges();
    } catch (err) {
      adjustTenantBadge('schedule', 1);
      toast.error(err instanceof Error ? err.message : 'Could not confirm the appointment');
    } finally {
      setBusyId('');
    }
  };

  const verify = async (appointment: AppointmentItem) => {
    setBusyId(appointment._id);
    adjustTenantBadge('schedule', -1);
    try {
      await TenantAPI.verifyAppointment(appointment._id, true, {
        rating: ratings[appointment._id] ?? null,
      });
      toast.success('Thanks — we’ve marked this one done.');
      await reload({ silent: true });
      void refreshTenantBadges();
    } catch (err) {
      adjustTenantBadge('schedule', 1);
      toast.error(err instanceof Error ? err.message : 'Could not send your confirmation');
    } finally {
      setBusyId('');
    }
  };

  const dispute = async () => {
    if (!disputeTarget) return;
    setBusyId(disputeTarget._id);
    adjustTenantBadge('schedule', -1);
    try {
      await TenantAPI.verifyAppointment(disputeTarget._id, false, {
        rating: ratings[disputeTarget._id] ?? null,
        comment: disputeNote.trim(),
      });
      toast.success('Thanks — your manager has been told and will follow up.');
      setDisputeTarget(null);
      setDisputeNote('');
      await reload({ silent: true });
      void refreshTenantBadges();
    } catch (err) {
      adjustTenantBadge('schedule', 1);
      toast.error(err instanceof Error ? err.message : 'Could not send your response');
    } finally {
      setBusyId('');
    }
  };

  const decline = async () => {
    if (!declineTarget) return;
    setBusyId(declineTarget._id);
    // Declining still counts — the ball moves to the manager either way.
    adjustTenantBadge('schedule', -1);
    try {
      await TenantAPI.confirmAppointment(declineTarget._id, false, declineNote.trim(), declineTarget.coordinationRevision);
      toast.success(declineTarget.bookingVersion === 2 ? 'We have asked the vendor to arrange another time. You can suggest alternatives in your request.' : 'Thanks — your manager will arrange another time.');
      setDeclineTarget(null);
      setDeclineNote('');
      await reload({ silent: true });
      void refreshTenantBadges();
    } catch (err) {
      adjustTenantBadge('schedule', 1);
      toast.error(err instanceof Error ? err.message : 'Could not send your response');
    } finally {
      setBusyId('');
    }
  };

  const reportNoShow = async () => {
    if (!noShowTarget) return;
    setBusyId(noShowTarget._id);
    try {
      await TenantAPI.reportNoShow(noShowTarget._id, noShowNote.trim());
      toast.success('Thanks — your property manager has been told and will follow up.');
      setNoShowTarget(null);
      setNoShowNote('');
      await reload({ silent: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send your report');
    } finally {
      setBusyId('');
    }
  };

  /**
   * One card, every action wired. AppointmentCard shows a button only when the
   * visit's own state allows it (a time to confirm, work to verify, a no-show
   * that can be reported), so the same wiring is right for every visit — in
   * the list and in the calendar's dialog alike. Any action from the dialog
   * closes it first: its visit is about to change, and the follow-up forms
   * are dialogs of their own.
   */
  const renderCard = (appointment: AppointmentItem, fromDialog = false) => {
    const leaveDialog = () => {
      if (fromDialog) setSelected(null);
    };
    return (
      <AppointmentCard
        key={appointment._id}
        appointment={appointment}
        audience="tenant"
        hideCompletionDispute={judgeVerification}
        busy={busyId === appointment._id}
        rating={ratings[appointment._id] ?? null}
        onRatingChange={(value) => setRatings((prev) => ({ ...prev, [appointment._id]: value }))}
        onConfirm={() => {
          leaveDialog();
          void confirm(appointment);
        }}
        onDecline={() => {
          leaveDialog();
          setDeclineTarget(appointment);
          setDeclineNote('');
        }}
        onVerify={() => {
          leaveDialog();
          void verify(appointment);
        }}
        onDispute={() => {
          leaveDialog();
          setDisputeTarget(appointment);
          setDisputeNote('');
        }}
        onReportNoShow={() => {
          leaveDialog();
          setNoShowTarget(appointment);
          setNoShowNote('');
        }}
        onOpenRequest={() => {
          const id = appointmentRequestId(appointment);
          if (id) navigate(`/portal/requests/${id}`);
        }}
      />
    );
  };

  const toggle = (next: TenantFilter) => setFilter((current) => (current === next ? null : next));

  if (loading) return <TenantState><LandlordLoading label="Loading your appointments..." /></TenantState>;
  if (error) {
    return (
      <TenantState><LandlordError
        title="Schedule unavailable"
        message={error}
        onRetry={() => void reload()}
      /></TenantState>
    );
  }

  const awaitingCount = counts.awaiting_tenant;

  return (
    <TenantPage><PageContainer>
      <ScheduleHeader
        title="Schedule"
        description={
          awaitingCount
            ? `${awaitingCount} appointment${awaitingCount === 1 ? '' : 's'} need${
                awaitingCount === 1 ? 's' : ''
              } your confirmation.`
            : 'Visits booked for your unit.'
        }
        titleTestId="tenant-schedule-title"
      />

      <StatGrid className="mb-6">
        <StatCard
          wrap={tenantPresentation}
          icon={CalendarDays}
          label={FILTER_LABELS.upcoming}
          value={counts.upcoming}
          sub="Booked times ahead"
          onClick={() => toggle('upcoming')}
          active={filter === 'upcoming'}
          testId="tenant-schedule-filter-upcoming"
        />
        <StatCard
          wrap={tenantPresentation}
          icon={Clock}
          tone={counts.awaiting_tenant ? 'amber' : 'slate'}
          label={FILTER_LABELS.awaiting_tenant}
          value={counts.awaiting_tenant}
          sub="A vendor is waiting on you"
          onClick={() => toggle('awaiting_tenant')}
          active={filter === 'awaiting_tenant'}
          delay={60}
          testId="tenant-schedule-filter-awaiting_tenant"
        />
        <StatCard
          wrap={tenantPresentation}
          icon={ClipboardCheck}
          tone={counts.your_review ? 'amber' : 'slate'}
          label={FILTER_LABELS.your_review}
          value={counts.your_review}
          sub="Tell us if it's fixed"
          onClick={() => toggle('your_review')}
          active={filter === 'your_review'}
          delay={120}
          testId="tenant-schedule-filter-your_review"
        />
        <StatCard
          wrap={tenantPresentation}
          icon={Hourglass}
          label={FILTER_LABELS.waiting_on_manager}
          value={counts.waiting_on_manager}
          sub="Nothing needed from you"
          onClick={() => toggle('waiting_on_manager')}
          active={filter === 'waiting_on_manager'}
          delay={180}
          testId="tenant-schedule-filter-waiting_on_manager"
        />
      </StatGrid>

      {filter ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-slate-600 in-[.lichen-d5]:text-meta" data-testid="tenant-schedule-active-filter">
          Showing <span className="font-semibold text-slate-900 in-[.lichen-d5]:text-ink">{FILTER_LABELS[filter]}</span> only.
          <button
            type="button"
            onClick={() => setFilter(null)}
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-medium text-slate-600 hover:text-slate-900 in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card in-[.lichen-d5]:text-meta in-[.lichen-d5]:hover:text-ink"
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        </div>
      ) : null}

      <ScheduleCalendar
        appointments={visible}
        initialView={wide ? 'week' : 'day'}
        audience="tenant"
        onOpen={setSelected}
      />

      <section className="mt-6">
        <div className="mb-3">
          <h3 className="text-lg font-semibold text-slate-900 in-[.lichen-d5]:text-ink">Needs your attention</h3>
          <p className="text-sm text-slate-500 in-[.lichen-d5]:text-meta">
            Visits waiting on your answer, and any without a time the calendar can show.
          </p>
        </div>
        {attention.length === 0 ? (
          <Card className="ll-fade-up border border-slate-200/70 p-5 shadow-sm in-[.lichen-d5]:border-border in-[.lichen-d5]:shadow-none">
            <EmptyState
              icon={CalendarDays}
              title={appointments.length ? "You're all caught up" : 'No visits booked'}
              description={
                appointments.length
                  ? 'Nothing needs an answer from you. Click a visit on the calendar to see its details.'
                  : 'When a vendor accepts one of your requests, their arrival time will appear here for you to confirm.'
              }
              testId="tenant-schedule-empty"
            />
          </Card>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2" data-testid="tenant-schedule-attention">
            {attention.map((appointment) => renderCard(appointment))}
          </div>
        )}
      </section>

      <p className="mt-6 text-center text-xs text-slate-400 in-[.lichen-d5]:text-meta" data-testid="schedule-history-note">
        Finished visits leave the schedule. They stay with each request, and older ones are in your{' '}
        <Link to="/portal?view=archived" className="font-medium text-slate-500 underline-offset-2 hover:underline in-[.lichen-d5]:text-meta">
          archived requests
        </Link>
        .
      </p>

      {/* A visit opened from the calendar: the same card, with the same buttons. */}
      <Dialog open={Boolean(selected)} onOpenChange={(open) => (open ? null : setSelected(null))}>
          <TenantDialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="tenant-schedule-visit">
          <DialogTitle className="sr-only">{selected ? appointmentTitle(selected) : 'Visit'}</DialogTitle>
          <DialogDescription className="sr-only">Details and actions for this visit.</DialogDescription>
          {/* Read the live copy, so a reload while it's open shows fresh state. */}
          {selected ? renderCard(appointments.find((a) => a._id === selected._id) || selected, true) : null}
        </TenantDialogContent>
      </Dialog>

      <TenantFormDialog
        open={Boolean(declineTarget)}
        returnFocusFallback={tenantPresentation ? () => document.querySelector<HTMLElement>(`[data-testid="schedule-event-${CSS.escape(declineTarget?._id || '')}"]`) : undefined}
        onOpenChange={(open) => {
          if (!open) setDeclineTarget(null);
        }}
        icon={CalendarDays}
        title="Request another time"
        description="Your property manager will arrange a new time with the vendor."
      >
        <div>
          <FieldLabel className="in-[.lichen-d5]:text-meta">When would suit you better? (optional)</FieldLabel>
          <Textarea
            aria-label={tenantPresentation ? 'When would suit you better? (optional)' : undefined}
            value={declineNote}
            onChange={(event) => setDeclineNote(event.target.value)}
            maxLength={500}
            rows={3}
            placeholder="Any weekday after 4pm, or Saturday morning…"
            className={`mt-1.5 border-slate-200 bg-white ${TENANT_FIELD}`}
            data-testid="tenant-decline-note"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            className="border-slate-200 in-[.lichen-d5]:border-border"
            onClick={() => setDeclineTarget(null)}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void decline()}
            disabled={Boolean(busyId)}
            className="gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90"
            data-testid="tenant-decline-confirm"
          >
            {busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Send request
          </Button>
        </div>
      </TenantFormDialog>

      <TenantFormDialog
        open={Boolean(noShowTarget)}
        returnFocusFallback={tenantPresentation ? () => document.querySelector<HTMLElement>(`[data-testid="schedule-event-${CSS.escape(noShowTarget?._id || '')}"]`) : undefined}
        onOpenChange={(open) => {
          if (!open) setNoShowTarget(null);
        }}
        icon={CalendarDays}
        title="The vendor didn't arrive?"
        description="We'll tell your property manager. They'll check with the vendor and find someone else if needed."
      >
        <div>
          <FieldLabel className="in-[.lichen-d5]:text-meta">Anything they should know? (optional)</FieldLabel>
          <Textarea
            aria-label={tenantPresentation ? 'Anything they should know? (optional)' : undefined}
            value={noShowNote}
            onChange={(event) => setNoShowNote(event.target.value)}
            maxLength={500}
            rows={3}
            placeholder="I was home all morning and nobody came or called…"
            className={`mt-1.5 border-slate-200 bg-white ${TENANT_FIELD}`}
            data-testid="tenant-no-show-note"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            className="border-slate-200 in-[.lichen-d5]:border-border"
            onClick={() => setNoShowTarget(null)}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void reportNoShow()}
            disabled={Boolean(busyId)}
            className="gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90"
            data-testid="tenant-no-show-confirm"
          >
            {busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Report it
          </Button>
        </div>
      </TenantFormDialog>

      <TenantFormDialog
        open={Boolean(disputeTarget)}
        returnFocusFallback={tenantPresentation ? () => document.querySelector<HTMLElement>(`[data-testid="schedule-event-${CSS.escape(disputeTarget?._id || '')}"]`) : undefined}
        onOpenChange={(open) => {
          if (!open) setDisputeTarget(null);
        }}
        icon={CalendarDays}
        title="What's still wrong?"
        description="Your manager will be notified and the vendor won't be paid until this is sorted."
      >
        <div>
          <FieldLabel className="in-[.lichen-d5]:text-meta">Tell us what&rsquo;s still not right</FieldLabel>
          <Textarea
            aria-label={tenantPresentation ? 'Tell us what’s still not right' : undefined}
            value={disputeNote}
            onChange={(event) => setDisputeNote(event.target.value)}
            maxLength={500}
            rows={3}
            placeholder="The leak stopped but the cabinet floor is still soaked…"
            className={`mt-1.5 border-slate-200 bg-white ${TENANT_FIELD}`}
            data-testid="tenant-dispute-note"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            className="border-slate-200 in-[.lichen-d5]:border-border"
            onClick={() => setDisputeTarget(null)}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void dispute()}
            disabled={Boolean(busyId)}
            className="gap-2 bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d5]:bg-primary in-[.lichen-d5]:text-primary-foreground in-[.lichen-d5]:hover:bg-primary/90"
            data-testid="tenant-dispute-confirm"
          >
            {busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Report it
          </Button>
        </div>
      </TenantFormDialog>
    </PageContainer></TenantPage>
  );
}
