import { ApiError } from '../../api/client';
import type {
  BookingCapabilities, BookingCapabilityState, BookingPayload, BookingPhase, PartyResponse, RescheduleActor,
  RescheduleReceipt, RescheduleStatus, RescheduleView, TimeWindow, VendorBookingPayload,
} from '../../types/booking';

// Pure presentation and validation for confirmed-visit changes. The server owns
// every transition; nothing here decides consent, availability or state.

export type Audience = 'landlord' | 'tenant' | 'vendor';

export const STATUS_LABEL: Record<RescheduleStatus, string> = {
  awaiting_vendor: 'Waiting for the vendor to confirm a new time',
  awaiting_tenant: 'Waiting for the tenant to confirm the new time',
  ready_to_commit: 'Both confirmed; the new time is being saved',
  committed: 'New time confirmed by the vendor and tenant',
  declined: 'Declined; the original visit is kept',
  expired: 'Expired; the original visit is kept',
  conflict: 'The new time was unavailable; the original visit is kept',
  invalidated: 'No longer valid; the original visit is kept',
};
export const RESPONSE_LABEL: Record<PartyResponse, string> = {
  pending: 'Not answered yet', accepted: 'Confirmed', declined: 'Declined',
};
export const ACTOR_LABEL: Record<RescheduleActor, string> = {
  landlord: 'Property manager', tenant: 'Tenant', vendor: 'Vendor', system: 'Artrelo (automatic check)',
};
const EVENT_LABEL: Record<string, string> = {
  requested: 'Change requested',
  vendor_confirmed_slot: 'Vendor confirmed a new time',
  tenant_confirmed_slot: 'Tenant confirmed the new time',
  tenant_declined_slot: 'Tenant declined the new time',
  vendor_declined_change: 'Vendor declined the change',
  tenant_declined_change: 'Tenant declined the change',
  landlord_declined_change: 'Property manager withdrew the request',
  committed: 'Visit time changed',
  expired: 'Request expired',
  candidate_unavailable: 'New time was unavailable',
  original_basis_changed: 'Request no longer valid',
  response_deadline_shortened: 'Answer deadline moved earlier',
};
export const eventLabel = (type: string) => EVENT_LABEL[type] || 'Change updated';

const DELIVERY_LABEL: Record<string, string> = {
  pending: 'Queued', processing: 'Sending', sent: 'Sent (reported by the delivery service)',
  disabled: 'Not sent: delivery is off', failed: 'Delivery failed', uncertain: 'Delivery not confirmed',
  stale: 'Not sent: replaced by a newer update',
};
export function deliveryLabel(status: string, inAppRecorded: boolean, audience: Audience) {
  const transport = DELIVERY_LABEL[status] || 'Delivery status unknown';
  // Vendors have no in-app inbox; saying "no in-app notice" for them would read as a failure.
  if (audience === 'vendor') return transport;
  return `${transport} · ${inAppRecorded ? 'In-app notice recorded' : 'No in-app notice yet'}`;
}

/** Plain headline from authoritative state. Retained preparation phase only
 * fills in detail while the server still reports the initial booking flow. */
const STATE_LABEL: Record<BookingCapabilityState, string> = {
  unavailable: 'Visit details are unavailable right now',
  closed: 'This visit is closed',
  unbooked: '',
  confirmed: 'Visit confirmed',
  confirmation_unknown: 'Visit booked; the tenant confirmation is not on record',
  awaiting_confirmation: '',
  completion_submitted: 'Work submitted; the visit time can no longer change',
  work_started: 'Work has started; the visit time can no longer change',
};
const PHASE_LABEL: Record<BookingPhase, string> = {
  preparing: 'Preparing the visit', awaiting_approval: 'The quote is being reviewed',
  awaiting_funds: 'Funding needed before the visit can be confirmed', awaiting_vendor: 'Arranging an alternative time with the vendor',
  awaiting_tenant: 'Please confirm the proposed time', scheduled: 'Visit confirmed',
  paused: 'This visit needs attention', expired: 'This proposal expired', closed: 'This proposal is closed',
};
export function headline(phase: BookingPhase, capabilities?: BookingCapabilities) {
  if (!capabilities) return PHASE_LABEL[phase];
  if (capabilities.reasonCode === 'confirmed_time_unavailable') return 'Visit booked; the confirmed time is not on record';
  return STATE_LABEL[capabilities.state] || PHASE_LABEL[phase];
}

/** A visit stays "booked" once confirmed, including after work starts. */
export function bookedLabel(state: BookingCapabilityState | undefined) {
  return state && ['confirmed', 'confirmation_unknown', 'completion_submitted', 'work_started'].includes(state) ? 'Booked visit' : 'Proposed arrival';
}

export type PanelControls = {
  canConfirmInitial: boolean; canSuggestInitialAlternatives: boolean; canRequestReschedule: boolean;
  /** True when the server sent no capability set: show state, offer no writes. */
  legacyReadOnly: boolean; active: RescheduleView | null; past: RescheduleView[];
};
/** Controls come only from server capabilities. A missing capability set never
 * falls back to the retained phase, which can say `scheduled` after work ends. */
export function panelControls(data: BookingPayload | null, audience: 'landlord' | 'tenant'): PanelControls {
  const capabilities = data?.coordination?.capabilities;
  const reschedules = data?.reschedules || [];
  const active = reschedules.find(change => change.active) || null;
  return {
    canConfirmInitial: capabilities?.canConfirmInitial === true,
    canSuggestInitialAlternatives: capabilities?.canSuggestInitialAlternatives === true,
    canRequestReschedule: audience === 'landlord' && capabilities?.canRequestReschedule === true && !active,
    legacyReadOnly: !!data?.coordination && !capabilities,
    active, past: reschedules.filter(change => change !== active),
  };
}

/** Why a manager cannot start a change right now, when the server says so. */
export function requestBlockedReason(capabilities: BookingCapabilities | undefined, audience: 'landlord' | 'tenant') {
  if (audience !== 'landlord' || !capabilities || capabilities.state !== 'confirmed') return '';
  if (capabilities.reasonCode === 'reschedule_response_window_closed') return 'It is too close to the visit to request a different time here. Changes close two hours before the visit, so both people have time to answer.';
  return '';
}
export const CUTOFF_COPY = 'Answers close two hours before the booked visit or the proposed time, whichever is earlier.';

export const deviceZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};
/** Labels Date's local wall clock, not the preview service's explicit zone.
 * Missing Intl metadata does not mean the native Date clock is UTC. */
export function deviceWallClockLabel() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && isValidZone(zone)) return zone;
  } catch { /* The exact fields still use the device's native Date clock. */ }
  return 'local device time; zone name unavailable';
}
export function isValidZone(zone: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return !!zone.trim(); } catch { return false; }
}
const valid = (value: string | undefined | null) => !!value && Number.isFinite(new Date(value).getTime());
export function formatInstant(value: string, zone = deviceZone()) {
  if (!valid(value)) return 'Time unavailable';
  return new Date(value).toLocaleString(undefined, { timeZone: zone, weekday: 'short', year: 'numeric', month: 'short',
    day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
/** Exact slot with the zone spelled out, so nobody has to guess whose clock it is. */
export function formatSlot(slot: TimeWindow | null | undefined, zone = deviceZone()) {
  if (!slot || !valid(slot.start) || !valid(slot.end)) return 'Time unavailable';
  const day = (value: string) => new Date(value).toLocaleDateString('en-CA', { timeZone: zone });
  const end = day(slot.start) === day(slot.end)
    ? new Date(slot.end).toLocaleTimeString(undefined, { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    : formatInstant(slot.end, zone);
  return `${formatInstant(slot.start, zone)} to ${end} (${zone})`;
}
export const slotMinutes = (slot: TimeWindow) => Math.round((new Date(slot.end).getTime() - new Date(slot.start).getTime()) / 60000);
export function formatDuration(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '', rest ? `${rest} minutes` : ''].filter(Boolean).join(' ');
}

/** `datetime-local` values are wall-clock times on this device. */
export function toLocalInput(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function fromLocalInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const DAY = 24 * 3600000;
export type WindowRow = { start: string; end: string };
/** Mirrors the server's window rules so most mistakes surface before a write. */
export function checkWindows(rows: WindowRow[], now = new Date()) {
  const errors = rows.map(() => '');
  const windows: TimeWindow[] = [];
  if (rows.length < 1 || rows.length > 3) return { windows, errors, summary: 'Add one to three windows.' };
  rows.forEach((row, index) => {
    const start = fromLocalInput(row.start), end = fromLocalInput(row.end);
    if (!start || !end) { errors[index] = 'Enter both the start and the end.'; return; }
    const from = new Date(start).getTime(), to = new Date(end).getTime();
    if (from <= now.getTime()) errors[index] = 'Start this window in the future.';
    else if (to - from < 15 * 60000) errors[index] = 'Make this window at least 15 minutes long.';
    else if (to > now.getTime() + 60 * DAY) errors[index] = 'End this window within the next 60 days.';
    else windows.push({ start, end });
  });
  return { windows, errors, summary: errors.some(Boolean) ? 'Fix the highlighted windows.' : '' };
}
export function checkReason(reason: string) {
  if (!reason.trim()) return 'Explain why the visit needs to move. The vendor and tenant will see this.';
  if (reason.length > 800) return 'Keep the reason to 800 characters or fewer.';
  return '';
}
export function checkDuration(minutes: number) {
  return Number.isInteger(minutes) && minutes >= 15 && minutes <= 720 && minutes % 15 === 0
    ? '' : 'Use 15 to 720 minutes, in steps of 15.';
}
export const insideWindows = (slot: TimeWindow, windows: TimeWindow[]) => windows.some(window =>
  new Date(slot.start).getTime() >= new Date(window.start).getTime() && new Date(slot.end).getTime() <= new Date(window.end).getTime());

/** Idempotency for "request a change". The same body reuses its key, so a retry
 * after an unknown outcome cannot open a second request; a changed body gets a
 * new key, because the server refuses a reused key with a different body. */
export type ActionKey = { key: string; fingerprint: string } | null;
export function newActionId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `visit-change-${random}`.slice(0, 80);
}
export function actionKeyFor(current: ActionKey, fingerprint: string, make = newActionId): { key: string; fingerprint: string } {
  return current && current.fingerprint === fingerprint ? current : { key: make(), fingerprint };
}

export type Failure = { kind: 'stale' | 'conflict' | 'refused' | 'unknown'; message: string };
const CONFLICT_COPY: Record<string, string> = {
  time_unavailable: 'That time overlaps another visit or a busy period on your calendar. Your original visit is unchanged. Choose a different time.',
  calendar_needs_review: 'Your calendar needs a check before this time can be offered. Your original visit is unchanged.',
  reschedule_round_limit: 'New times have already been proposed twice for this request. The original visit is unchanged.',
  reschedule_already_pending: 'Another change request is already pending. Refreshed to show it.',
  idempotency_key_reused: 'This change request was already sent with different details. Refreshed to show what was saved.',
  work_already_started: 'Work has already started, so the visit time can no longer change.',
  reschedule_slot_not_offered: 'That is the current visit time. Choose a different time.',
  booking_confirmation_paused: 'Confirmations are paused right now. The original visit is unchanged.',
  reschedule_response_window_closed: 'There is not enough time for both people to answer before the two-hour cutoff. The original visit stays booked.',
  reschedule_deadline_changed: 'The answer deadline moved earlier to protect the booked visit. Refreshed; check the new deadline before answering again.',
  reschedule_expired: 'This change request has expired. The original visit is kept.',
  funding_obligations_outstanding: 'The payment account needs attention before this change can be saved. The original visit is unchanged.',
};
const STALE = 'This visit change was updated elsewhere. Refreshed to show the current state; the original visit has not been replaced.';
export function classifyFailure(error: unknown): Failure {
  if (!(error instanceof ApiError) || error.status >= 500) {
    return { kind: 'unknown', message: 'We could not confirm whether this was saved. Refreshed to show the current state; check it before trying again.' };
  }
  const code = (error.payload as { code?: string } | null)?.code || '';
  if (error.status === 409) return CONFLICT_COPY[code] ? { kind: 'conflict', message: CONFLICT_COPY[code] } : { kind: 'stale', message: STALE };
  return { kind: 'refused', message: error.message || 'This change was not accepted.' };
}

/** What a receipt proves. HTTP 200 alone never means the visit moved. */
export function receiptMessage(receipt: RescheduleReceipt, proposed?: TimeWindow | null) {
  const prefix = receipt.duplicate ? 'Already recorded. ' : '';
  const copy: Record<RescheduleStatus, string> = {
    awaiting_vendor: 'Change request sent. The original visit stays booked until the vendor and tenant both confirm a new time.',
    awaiting_tenant: 'New time sent to the tenant. The original visit stays booked until they confirm it.',
    ready_to_commit: 'Both confirmations are in; the new time is still being saved. Refresh to see the result.',
    committed: `The visit time changed${proposed ? ` to ${formatSlot(proposed)}` : ''}.`,
    declined: 'Declined. The original visit is kept.',
    expired: 'This request had expired. The original visit is kept.',
    conflict: 'The new time could not be booked. The original visit is kept.',
    invalidated: 'This request no longer applied. No change was made to the visit.',
  };
  return prefix + copy[receipt.status];
}

/** The body for one party action on an existing change. `accept` and
 * `keep_original` answer the exact candidate (slotKey) the tenant was shown. */
export function partyActionBody(change: RescheduleView, action: 'accept' | 'keep_original' | 'decline' | 'withdraw') {
  if (action === 'accept' || action === 'keep_original') {
    if (!change.slotKey) return null;
    return { action: 'respond_reschedule' as const, proposalRef: change.ref, expectedRevision: change.revision,
      slotKey: change.slotKey, accepted: action === 'accept' };
  }
  return { action: 'decline_reschedule' as const, proposalRef: change.ref, expectedRevision: change.revision };
}

/** A spoken update only when the change itself moved on (new request, new
 * status or revision), never on an unchanged refetch. */
export const changeSignature = (changes: RescheduleView[] | undefined) => {
  const latest = changes?.[0];
  return latest ? `${latest.ref}:${latest.revision}:${latest.status}` : '';
};
export function changeAnnouncement(previous: string | null, changes: RescheduleView[] | undefined) {
  const next = changeSignature(changes);
  // `null` is the first load: what is already on screen is not news.
  if (previous === null || !next || previous === next) return '';
  return `Visit change update: ${STATUS_LABEL[changes![0].status]}.`;
}

/** A vendor change response carries coordination, reschedules and the receipt
 * but not the job brief; keep the brief already shown rather than dropping it. */
export function mergeVendorResponse(next: Partial<VendorBookingPayload> | undefined, previous: VendorBookingPayload | null): VendorBookingPayload | null {
  if (!next) return null;
  const brief = next.brief || previous?.brief;
  if (!brief) return null;
  return { coordination: next.coordination ?? null, reschedules: next.reschedules, receipt: next.receipt, brief };
}
