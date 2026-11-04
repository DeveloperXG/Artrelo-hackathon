// The vendor's "Accept job" form: what's checked before it is sent.
//
// Mirrors validateSubmission in vendorPortal.controller.js so the vendor sees
// each problem beside its field instead of after a round trip. The server
// stays the authority.
//
// Every field is checked at once. Stopping at the first problem (as the old
// toasts did) made a vendor fix the form one complaint at a time.

import { parseCustomDuration } from './durationOnSite';
import type { OfferedWindow } from './vendorPortalTypes';

export type AcceptField = 'window' | 'quote' | 'arrival' | 'duration';
export type AcceptFieldErrors = Partial<Record<AcceptField, string>>;

/** Top-to-bottom order on the page, so the first error is the one to scroll to. */
export const ACCEPT_FIELD_ORDER: AcceptField[] = ['window', 'arrival', 'duration', 'quote'];

const pad = (n: number) => String(n).padStart(2, '0');
const MINUTE_MS = 60_000;

type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

/** The wall clock in `timeZone` at an instant. */
function wallClockIn(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

/**
 * `YYYY-MM-DD` for a date: in the windows' own zone when given, else the
 * phone's. Windows (and their labels) are built in the property's zone, so a
 * vendor whose phone is set elsewhere must still see the window's date.
 */
export function toDateInputValue(value: string | Date, timeZone?: string | null) {
  const d = new Date(value);
  if (timeZone) {
    const w = wallClockIn(d, timeZone);
    return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `HH:MM` for an instant, in the given zone (else the phone's). */
export function toTimeInputValue(value: string | Date, timeZone?: string | null) {
  const d = new Date(value);
  if (timeZone) {
    const w = wallClockIn(d, timeZone);
    return `${pad(w.hour)}:${pad(w.minute)}`;
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The instant at which the wall clock in `timeZone` reads `date` `time`.
 * Guess as if UTC, measure the zone's offset there, correct, and measure once
 * more so a DST change between the guess and the answer is accounted for.
 */
export function zonedWallClockToIso(dateValue: string, timeValue: string, timeZone: string): string {
  const [year, month, day] = dateValue.split('-').map(Number);
  const [hour, minute] = timeValue.split(':').map(Number);
  if ([year, month, day, hour, minute].some((n) => !Number.isFinite(n))) return '';
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const w = wallClockIn(new Date(instant), timeZone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - instant;
  };
  let instant = target - offsetAt(target);
  instant = target - offsetAt(instant);
  return Number.isNaN(instant) ? '' : new Date(instant).toISOString();
}

/** Combines the date (implied by the chosen window, or picked for a flexible
 *  slot) with the vendor's time into an absolute instant, in the window's
 *  zone. */
export function buildArrivalIso(
  slot: OfferedWindow | undefined,
  dateValue: string,
  timeValue: string
): string {
  if (!timeValue) return '';
  const timeZone = slot?.timeZone || null;
  const fixed = Boolean(slot?.start && slot.kind !== 'flexible');
  const datePart = fixed ? toDateInputValue(slot!.start!, timeZone) : dateValue;
  if (!datePart) return '';
  const build = (date: string) => {
    if (timeZone) return zonedWallClockToIso(date, timeValue, timeZone);
    const local = new Date(`${date}T${timeValue}`);
    return Number.isNaN(local.getTime()) ? '' : local.toISOString();
  };
  const iso = build(datePart);
  // A window that runs past midnight (an evening emergency slot): 12:30 means
  // the morning after the window's start date, not the morning before it.
  if (fixed && iso && slot!.end && new Date(iso) < new Date(slot!.start!)) {
    const nextDay = toDateInputValue(new Date(new Date(iso).getTime() + 24 * 60 * MINUTE_MS), timeZone);
    const later = build(nextDay);
    if (later && new Date(later) < new Date(slot!.end)) return later;
  }
  return iso;
}

export function isArrivalInsideWindow(slot: OfferedWindow | undefined, arrivalIso: string) {
  if (!slot || slot.kind === 'flexible' || !slot.start || !slot.end) return true;
  const arrival = new Date(arrivalIso).getTime();
  return arrival >= new Date(slot.start).getTime() && arrival < new Date(slot.end).getTime();
}

/* ------------------------------------------------------------------ *
 * Windows that age while the page is open. Mirrors
 * backend/services/vendor/offeredWindows.service.js, which applies the same
 * rules whenever the page is loaded or submitted -- this only keeps an open
 * page honest between loads.
 * ------------------------------------------------------------------ */

const STEP_MS = 15 * MINUTE_MS;
const MIN_REMAINING_MS = 30 * MINUTE_MS;
const ceilToStep = (time: number) => Math.ceil(time / STEP_MS) * STEP_MS;
const isFixed = (slot: OfferedWindow) => slot.kind !== 'flexible' && Boolean(slot.start && slot.end);

/** Whether there is still time to turn up in this window. */
export function isWindowBookable(slot: OfferedWindow, now: Date = new Date()) {
  if (!isFixed(slot)) return true;
  return new Date(slot.end!).getTime() - ceilToStep(now.getTime()) >= MIN_REMAINING_MS;
}

function formatWindowLabel(start: Date, end: Date, timeZone?: string | null) {
  const zone = timeZone ? { timeZone } : {};
  const day = new Intl.DateTimeFormat('en-CA', { ...zone, weekday: 'short', month: 'short', day: 'numeric' }).format(start);
  const time = new Intl.DateTimeFormat('en-CA', { ...zone, hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day}, ${time.format(start)} – ${time.format(end)}`;
}

/**
 * The windows as of `now`: past ones dropped, one under way starting now
 * (rounded up to the quarter hour) with its label to match. Slot ids are
 * untouched, so a selection survives the clamp.
 */
export function currentWindows(windows: OfferedWindow[], now: Date = new Date()): OfferedWindow[] {
  const earliest = ceilToStep(now.getTime());
  return windows.filter((slot) => isWindowBookable(slot, now)).map((slot) => {
    if (!isFixed(slot) || new Date(slot.start!).getTime() >= earliest) return slot;
    const start = new Date(earliest);
    const label = formatWindowLabel(start, new Date(slot.end!), slot.timeZone);
    return { ...slot, start: start.toISOString(), label: slot.kind === 'asap' ? `ASAP — ${label}` : label };
  });
}

/** min/max for the arrival `<input type="time">` in a fixed window, when it
 *  starts and ends on the same day (an overnight window can't be bounded). */
export function arrivalTimeBounds(slot: OfferedWindow | undefined) {
  if (!slot || !isFixed(slot)) return {};
  const start = new Date(slot.start!);
  const last = new Date(new Date(slot.end!).getTime() - MINUTE_MS);
  if (toDateInputValue(start, slot.timeZone) !== toDateInputValue(last, slot.timeZone)) return {};
  return { min: toTimeInputValue(start, slot.timeZone), max: toTimeInputValue(last, slot.timeZone) };
}

export const arrivalOutsideMessage = (slot: OfferedWindow) =>
  `That's outside ${slot.label}. Pick a time inside the window you chose.`;

export function validateAcceptForm({
  slot,
  quoteLow,
  quoteHigh,
  arrivalDate,
  arrivalTime,
  durationMinutes,
  customHours,
  customMinutes,
  itemized = false,
}: {
  slot: OfferedWindow | undefined;
  quoteLow: string;
  quoteHigh: string;
  arrivalDate: string;
  arrivalTime: string;
  /** A preset like '120', or 'custom'. */
  durationMinutes: string;
  customHours: string;
  customMinutes: string;
  /** Itemized outreach: the line editor checks the price, not low/high. */
  itemized?: boolean;
}): { errors: AcceptFieldErrors } | { errors: null; arrivalIso: string; onSiteMinutes: number } {
  const errors: AcceptFieldErrors = {};

  const low = Number(quoteLow);
  const high = Number(quoteHigh);
  if (itemized) {
    // Checked line by line by buildItemization.
  } else if (!quoteLow.trim() || !quoteHigh.trim() || !Number.isFinite(low) || !Number.isFinite(high)) {
    errors.quote = 'Enter both a low and a high estimate.';
  } else if (low < 0 || high < 0) {
    errors.quote = "Estimates can't be negative.";
  } else if (high < low) {
    errors.quote = 'The high estimate must be at least the low estimate.';
  }

  let arrivalIso = '';
  let onSiteMinutes = 0;
  if (!slot) {
    // Arrival and time on site only appear once a window is chosen.
    errors.window = 'Choose one of the offered time windows.';
  } else {
    arrivalIso = buildArrivalIso(slot, arrivalDate, arrivalTime);
    if (!arrivalIso) {
      errors.arrival =
        slot.kind === 'flexible' ? 'Pick the date and time you expect to arrive.' : 'Enter the time you expect to arrive.';
    } else if (!isArrivalInsideWindow(slot, arrivalIso)) {
      errors.arrival = arrivalOutsideMessage(slot);
    }

    if (durationMinutes === 'custom') {
      const parsed = parseCustomDuration(customHours, customMinutes);
      if ('error' in parsed) errors.duration = parsed.error;
      else onSiteMinutes = parsed.minutes;
    } else {
      onSiteMinutes = Number(durationMinutes);
    }
  }

  if (Object.keys(errors).length) return { errors };
  return { errors: null, arrivalIso, onSiteMinutes };
}
