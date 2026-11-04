import {
  appointmentRequest,
  appointmentTitle,
  appointmentVendor,
  isUpcoming,
  needsTenantScheduleAnswer,
  needsTenantVerification,
  type AppointmentItem,
  type AppointmentStatus,
} from '../../../types/appointment';

/**
 * How the schedule calendar names and colours a visit, in either portal.
 *
 * Every AppointmentStatus is here, plus one derived state: `proposed` carries
 * two meanings (see needsTenantScheduleAnswer), and once the tenant has
 * answered it means the tenant declined and the time is being re-coordinated —
 * "Needs a new time", which the mockup shows as its own tag.
 */
export type ScheduleState = AppointmentStatus | 'needs_new_time';

export function scheduleState(a: AppointmentItem): ScheduleState {
  if (a.status === 'proposed' && a.tenantConfirmation?.respondedAt) return 'needs_new_time';
  // An unanswered proposal is the tenant being asked — the same thing as
  // awaiting_tenant from the landlord's side.
  if (a.status === 'proposed') return 'awaiting_tenant';
  return a.status;
}

type StateStyle = {
  label: string;
  /** Calendar block: tinted background + coloured left rule. */
  block: string;
  /** Status pill. */
  pill: string;
  /** Small dot before the time. */
  dot: string;
};

// NOTE: no tsconfig here, so a missing key is `undefined` at runtime, not a
// compile error — keep every ScheduleState in this map.
export const SCHEDULE_STYLES: Record<ScheduleState, StateStyle> = {
  scheduled: {
    label: 'Scheduled',
    block: 'border-l-[#137fec] bg-[#137fec]/[0.07]',
    pill: 'bg-[#137fec]/10 text-[#137fec]',
    dot: 'bg-[#137fec]',
  },
  awaiting_tenant: {
    label: 'Awaiting tenant',
    block: 'border-l-orange-400 bg-orange-50',
    pill: 'bg-orange-100 text-orange-700',
    dot: 'bg-orange-400',
  },
  proposed: {
    label: 'Awaiting tenant',
    block: 'border-l-orange-400 bg-orange-50',
    pill: 'bg-orange-100 text-orange-700',
    dot: 'bg-orange-400',
  },
  awaiting_vendor: {
    label: 'Awaiting vendor',
    block: 'border-l-sky-400 bg-sky-50',
    pill: 'bg-sky-100 text-sky-700',
    dot: 'bg-sky-400',
  },
  work_verifying: {
    label: 'Awaiting sign-off',
    block: 'border-l-amber-400 bg-amber-50',
    pill: 'bg-amber-100 text-amber-800',
    dot: 'bg-amber-400',
  },
  in_review: {
    label: 'Needs review',
    block: 'border-l-rose-400 bg-rose-50',
    pill: 'bg-rose-100 text-rose-700',
    dot: 'bg-rose-400',
  },
  disputed: {
    label: 'Disputed',
    block: 'border-l-slate-500 bg-slate-100',
    pill: 'bg-slate-200 text-slate-700',
    dot: 'bg-slate-500',
  },
  needs_new_time: {
    label: 'Needs a new time',
    block: 'border-l-violet-400 bg-violet-50',
    pill: 'bg-violet-100 text-violet-700',
    dot: 'bg-violet-400',
  },
  completed: {
    label: 'Completed',
    block: 'border-l-emerald-400 bg-emerald-50',
    pill: 'bg-emerald-100 text-emerald-700',
    dot: 'bg-emerald-400',
  },
  cancelled: {
    label: 'Cancelled',
    block: 'border-l-slate-300 bg-slate-50',
    pill: 'bg-slate-100 text-slate-600',
    dot: 'bg-slate-300',
  },
  failed: {
    label: 'Could not schedule',
    block: 'border-l-rose-300 bg-rose-50/70',
    pill: 'bg-rose-100 text-rose-700',
    dot: 'bg-rose-300',
  },
};

export type ScheduleAudience = 'landlord' | 'tenant';

/**
 * The same visit, said from the tenant's side. Colours stay the same so the
 * two portals read alike; only the words change — a tenant asked to confirm a
 * time isn't "awaiting tenant", they're the one being asked.
 */
function tenantLabel(a: AppointmentItem, state: ScheduleState): string | null {
  switch (state) {
    case 'awaiting_tenant':
    case 'proposed':
      return 'Confirm the time';
    case 'needs_new_time':
      return 'New time coming';
    case 'work_verifying':
      // Only the tenant can answer when the completion asks for verification;
      // otherwise the manager is checking the vendor's evidence.
      return needsTenantVerification(a) ? 'Review the work' : 'Being checked';
    case 'in_review':
      return 'Under review';
    case 'disputed':
      return 'Reported unresolved';
    default:
      return null;
  }
}

export function scheduleStyle(a: AppointmentItem, audience: ScheduleAudience = 'landlord'): StateStyle {
  const state = scheduleState(a);
  const style = SCHEDULE_STYLES[state] || SCHEDULE_STYLES.scheduled;
  if (audience !== 'tenant') return style;
  const label = tenantLabel(a, state);
  return label ? { ...style, label } : style;
}

/**
 * The stat tiles at the top of the page, each one a filter. The first four
 * are the landlord's; `your_review` and `waiting_on_manager` are the tenant's.
 */
export type ScheduleFilter =
  | 'upcoming'
  | 'awaiting_tenant'
  | 'sign_off'
  | 'review'
  | 'your_review'
  | 'waiting_on_manager';

export function matchesFilter(a: AppointmentItem, filter: ScheduleFilter | null): boolean {
  if (!filter) return true;
  const state = scheduleState(a);
  switch (filter) {
    // A booked time still ahead — what the calendar is mostly for.
    case 'upcoming':
      return Boolean(a.confirmedStart) && isUpcoming(a) && state !== 'needs_new_time';
    case 'awaiting_tenant':
      return needsTenantScheduleAnswer(a);
    case 'sign_off':
      return state === 'work_verifying';
    case 'review':
      return state === 'in_review' || state === 'disputed' || state === 'needs_new_time';
    // The tenant is the one asked whether the work is done.
    case 'your_review':
      return needsTenantVerification(a);
    // Nothing the tenant can do: the manager or the vendor owes the next move.
    case 'waiting_on_manager':
      return (
        ['in_review', 'disputed', 'needs_new_time', 'awaiting_vendor'].includes(state) ||
        (state === 'work_verifying' && !needsTenantVerification(a))
      );
    default:
      return true;
  }
}

/**
 * Belongs in the "Needs attention" list under the calendar: someone owes an
 * answer, or the visit has no time the calendar could place it at. A plain
 * scheduled visit is NOT here — the calendar already shows it.
 */
export function needsAttention(a: AppointmentItem): boolean {
  const state = scheduleState(a);
  if (!a.confirmedStart) return true;
  return ['awaiting_tenant', 'awaiting_vendor', 'needs_new_time', 'work_verifying', 'in_review', 'disputed'].includes(
    state
  );
}

/** Something only the tenant can answer: a time, whether the work is done, or a vendor who never came. */
export function tenantCanAct(a: AppointmentItem): boolean {
  return needsTenantScheduleAnswer(a) || needsTenantVerification(a) || Boolean(a.canReportNoShow);
}

/**
 * The tenant's "Needs your attention" list: everything they can act on, plus
 * visits with no time the calendar could place. (The landlord's list is
 * needsAttention; the tenant sees cards with their buttons, not table rows.)
 */
export function needsTenantAttention(a: AppointmentItem): boolean {
  return tenantCanAct(a) || !a.confirmedStart;
}

/** "Maple Court · Unit 4B", from the request the visit belongs to. */
export function appointmentPlace(a: AppointmentItem): { property: string; unit: string } {
  const request = appointmentRequest(a);
  const property = request?.propertyId && typeof request.propertyId === 'object' ? request.propertyId.name || '' : '';
  const unitNumber = request?.unitId && typeof request.unitId === 'object' ? request.unitId.unitNumber || '' : '';
  return { property, unit: unitNumber ? `Unit ${unitNumber}` : '' };
}

export function appointmentVendorName(a: AppointmentItem): string {
  const vendor = appointmentVendor(a);
  return vendor?.company || vendor?.name || 'Vendor';
}

export { appointmentTitle };
