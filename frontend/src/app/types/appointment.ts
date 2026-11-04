/** Shared appointment shape for both portals.
 *
 *  `confirmedStart`/`confirmedEnd` are the precise commitment the vendor made;
 *  `proposedWindows` keeps the original window label purely as context. */

export type AppointmentStatus =
  | 'proposed'
  | 'awaiting_vendor'
  | 'awaiting_tenant'
  | 'scheduled'
  | 'work_verifying'
  | 'in_review'
  | 'disputed'
  | 'cancelled'
  | 'completed'
  | 'failed';

export interface AppointmentVendorRef {
  _id?: string;
  name?: string;
  company?: string;
  /**
   * No `phone`/`email`. The server stopped selecting them: a tenant reaches the
   * vendor through the masked relay (see `vendorContact`), never directly.
   */
}

/** Masked contact.
 *
 *  `phone`, once present, is the PROXY number — never the real one. It appears
 *  ONLY on the vendor-facing side (`channel: 'relay'`), which is the direction
 *  that actually sends SMS.
 *
 *  The tenant-facing side is `channel: 'in_app'` and always carries
 *  `phone: null`. That is not an oversight to be tidied up later: inbound relay
 *  routing keys on the sender being the VENDOR's phone, so a text from a
 *  tenant's phone to the proxy number matches nothing and is silently dropped.
 *  A tenant reaches their vendor by posting a comment, which the server fans
 *  out. Do not render a number here even if one ever appears. */
export interface RelayContact {
  channel: 'relay' | 'in_app' | 'direct';
  provider: string;
  phone?: string | null;
  available: boolean;
  label: string;
  fallback?: { kind: string; phone?: string | null } | null;
}

/** The tenant-facing completion projection. Carries NO cost — the server's
 *  buildTenantCompletionView strips actualCost, the ceiling, and any overage. */
export interface TenantCompletionView {
  status: string;
  needsVerification: boolean;
  workPerformed: string;
  partsUsed: string;
  followUpNeeded: boolean;
  followUpNotes: string;
  completedAt?: string | null;
  photos: { url: string; label?: string | null; stage: string }[];
  /** When silence becomes acceptance. Shown to the tenant, never hidden. */
  autoConfirmAt?: string | null;
  confirmation?: {
    outcome: string;
    rating?: number | null;
    respondedAt: string;
    autoConfirmed: boolean;
  } | null;
}

export interface AppointmentRequestRef {
  _id?: string;
  issueTitle?: string;
  category?: string;
  urgency?: string;
  ai?: { shortTitle?: string };
  /** Landlord schedule only: populated through the request. */
  propertyId?: { _id?: string; name?: string } | string | null;
  unitId?: { _id?: string; unitNumber?: string } | string | null;
}

export interface AppointmentItem {
  _id: string;
  bookingVersion?: number;
  coordinationRevision?: number;
  coordinationPhase?: string;
  requestId?: AppointmentRequestRef | string;
  vendorId?: AppointmentVendorRef | string | null;
  vendorContact?: RelayContact | null;
  tenantId?: { firstName?: string; lastName?: string; phone?: string } | string;
  status: AppointmentStatus;
  proposedWindows?: string[];
  confirmedStart?: string | null;
  confirmedEnd?: string | null;
  accessNotes?: string;
  vendorConfirmation?: { accepted?: boolean; respondedAt?: string | null; note?: string };
  tenantConfirmation?: { accepted?: boolean; respondedAt?: string | null; note?: string };
  completion?: TenantCompletionView | null;
  createdAt?: string;
  /** Tenant view: the server's own reportNoShow rules, pre-computed. */
  canReportNoShow?: boolean;
  noShowReportableAt?: string | null;
  noShowReport?: { status?: 'reported' | 'confirmed' | 'dismissed' | null; reportedAt?: string | null } | null;
}

// NOTE: there is no tsconfig in this project, so a missing key here is
// `undefined` at RUNTIME rather than a compile error. Every AppointmentStatus
// must appear in both maps.
export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  proposed: 'Needs a new time',
  awaiting_vendor: 'Awaiting vendor',
  awaiting_tenant: 'Awaiting tenant confirmation',
  scheduled: 'Scheduled',
  work_verifying: 'Awaiting your confirmation',
  in_review: 'Under review',
  disputed: 'Reported unresolved',
  cancelled: 'Cancelled',
  completed: 'Completed',
  failed: 'Could not schedule',
};

export const APPOINTMENT_STATUS_COLORS: Record<AppointmentStatus, string> = {
  proposed: 'bg-amber-100 text-amber-800',
  awaiting_vendor: 'bg-sky-100 text-sky-800',
  awaiting_tenant: 'bg-amber-100 text-amber-800',
  scheduled: 'bg-emerald-100 text-emerald-800',
  work_verifying: 'bg-amber-100 text-amber-800',
  in_review: 'bg-sky-100 text-sky-800',
  disputed: 'bg-rose-100 text-rose-800',
  cancelled: 'bg-slate-100 text-slate-700',
  completed: 'bg-indigo-100 text-indigo-800',
  failed: 'bg-rose-100 text-rose-800',
};

export function appointmentVendor(a: AppointmentItem): AppointmentVendorRef | null {
  return a.vendorId && typeof a.vendorId === 'object' ? a.vendorId : null;
}

export function appointmentRequest(a: AppointmentItem): AppointmentRequestRef | null {
  return a.requestId && typeof a.requestId === 'object' ? a.requestId : null;
}

export function appointmentRequestId(a: AppointmentItem): string {
  if (typeof a.requestId === 'string') return a.requestId;
  return a.requestId?._id || '';
}

export function appointmentTitle(a: AppointmentItem): string {
  const req = appointmentRequest(a);
  return req?.ai?.shortTitle || req?.issueTitle || 'Maintenance visit';
}

/** "Thu, 30 Jul, 9:30 a.m. – 11:30 a.m." — the precise commitment, falling back
 *  to the original window label only when no exact time was captured. */
export function formatAppointmentWhen(a: AppointmentItem): string {
  if (!a.confirmedStart) return a.proposedWindows?.[0] || 'Time to be confirmed';
  const start = new Date(a.confirmedStart);
  const day = start.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const time = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!a.confirmedEnd) return `${day}, ${time(start)}`;
  return `${day}, ${time(start)} – ${time(new Date(a.confirmedEnd))}`;
}

/** The visit itself is still ahead. */
export function isUpcoming(a: AppointmentItem): boolean {
  // The post-visit states are excluded alongside the terminal ones. Without
  // them a verifying or disputed appointment — whose confirmedStart is in the
  // past — would pin itself to the top of both schedule pages indefinitely.
  if (
    ['cancelled', 'completed', 'failed', 'work_verifying', 'in_review', 'disputed'].includes(
      a.status
    )
  ) {
    return false;
  }
  if (!a.confirmedStart) return true;
  return new Date(a.confirmedStart).getTime() >= Date.now() - 2 * 60 * 60 * 1000;
}

/** The visit happened and someone still owes an answer about it. */
export function isAwaitingOutcome(a: AppointmentItem): boolean {
  return ['work_verifying', 'in_review', 'disputed'].includes(a.status);
}

/** The tenant is the one being asked. */
export function needsTenantVerification(a: AppointmentItem): boolean {
  return a.status === 'work_verifying' && Boolean(a.completion?.needsVerification);
}

/**
 * The tenant owes an answer about the TIME.
 *
 * Mirrors the server's own precondition in confirmTenantAppointment, which
 * accepts both statuses — and the tenant badge query, which counts exactly
 * this set. Keeping the three in step is the point of putting it here:
 * AppointmentCard used to test `awaiting_tenant` alone, so a `proposed`
 * appointment rendered with no buttons and its badge could never clear.
 *
 * `proposed` carries two meanings and respondedAt is the only thing that
 * separates them: unanswered means the tenant is being asked, while a recorded
 * response means they declined and the manager is re-coordinating. `accepted`
 * defaults to false, so it cannot tell those apart.
 */
/**
 * The booked arrival is already over (past a 15-minute grace). Mirrors
 * isArrivalPassed in backend completion/appointmentFailure.service, which
 * refuses to confirm such a time: it would book a visit in the past.
 */
export function isArrivalPassed(a: AppointmentItem, now: Date = new Date()): boolean {
  if (!a.confirmedStart) return false;
  return new Date(a.confirmedStart).getTime() < now.getTime() - 15 * 60 * 1000;
}

export function needsTenantScheduleAnswer(a: AppointmentItem): boolean {
  if (a.status === 'awaiting_tenant') return true;
  return a.status === 'proposed' && !a.tenantConfirmation?.respondedAt;
}
