// Vendor hours of operation, client side. Mirrors backend/services/vendor/vendorHours.js
// (same shape, same rules, same summary format) so the form can validate before
// the round trip and the card can say "Open now" without asking the server.

export type HoursPreset = 'weekdays' | 'always' | 'custom';

export interface DayHours {
  day: number; // 0-6, Sunday first (Date#getDay)
  open: string; // "HH:mm"
  close: string; // "HH:mm", "24:00" allowed
}

export interface OperatingHours {
  preset: HoursPreset;
  weekly: DayHours[];
}

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Display order: the working week first. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const WEEKDAYS_9_TO_5: DayHours[] = [1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '17:00' }));
const ALL_DAY: DayHours[] = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '00:00', close: '24:00' }));

/** One message for the whole hours control, or null when valid. */
export function validateHours(input: { preset?: string; weekly?: DayHours[] } | null | undefined): string | null {
  if (!input || !input.preset) return "Set the vendor's hours of operation.";
  if (!['weekdays', 'always', 'custom'].includes(input.preset)) return 'Choose when this vendor works.';
  if (input.preset !== 'custom') return null;

  const rows = input.weekly || [];
  if (!rows.length) return 'Pick at least one day the vendor works.';
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.day)) return `${DAY_LABELS[row.day]} is listed twice.`;
    seen.add(row.day);
    if (!TIME_RE.test(row.open) || !TIME_RE.test(row.close)) {
      return `Enter opening and closing times for ${DAY_LABELS[row.day]}.`;
    }
    if (row.open === '24:00') return `${DAY_LABELS[row.day]} cannot open at 24:00.`;
    if (toMinutes(row.open) >= toMinutes(row.close)) return `${DAY_LABELS[row.day]} must close after it opens.`;
  }
  return null;
}

/** Presets expanded into rows, as the server stores them. */
export function expandHours(hours: { preset: HoursPreset; weekly?: DayHours[] }): OperatingHours {
  if (hours.preset === 'weekdays') return { preset: 'weekdays', weekly: WEEKDAYS_9_TO_5 };
  if (hours.preset === 'always') return { preset: 'always', weekly: ALL_DAY };
  return { preset: 'custom', weekly: [...(hours.weekly || [])].sort((a, b) => a.day - b.day) };
}

const fmt = (hhmm: string) => hhmm.replace(/^0(\d)/, '$1');

/** "Mon–Fri 9:00–17:00", "24/7", "Mon–Wed 8:00–16:00 · Sat 10:00–14:00". */
export function formatHours(hours: OperatingHours | null | undefined): string {
  if (!hours || !hours.weekly?.length) return '';
  if (hours.preset === 'always') return '24/7';

  const byDay = new Map(hours.weekly.map((row) => [row.day, row]));
  const groups: { start: number; end: number; open: string; close: string }[] = [];
  for (const day of WEEK_ORDER) {
    const row = byDay.get(day);
    if (!row) continue;
    const last = groups[groups.length - 1];
    const contiguous = last && WEEK_ORDER.indexOf(last.end) === WEEK_ORDER.indexOf(day) - 1;
    if (last && contiguous && last.open === row.open && last.close === row.close) last.end = day;
    else groups.push({ start: day, end: day, open: row.open, close: row.close });
  }
  return groups
    .map((g) => {
      const days = g.start === g.end ? DAY_LABELS[g.start] : `${DAY_LABELS[g.start]}–${DAY_LABELS[g.end]}`;
      return `${days} ${fmt(g.open)}–${fmt(g.close)}`;
    })
    .join(' · ');
}

/**
 * Whether the vendor is working at `now`, in the VIEWER's local time. There is
 * no vendor time zone on record, so the card labels this as local time rather
 * than presenting it as fact.
 */
export function isOpenNow(hours: OperatingHours | null | undefined, now: Date = new Date()): boolean {
  if (!hours || !hours.weekly?.length) return false;
  const row = hours.weekly.find((entry) => entry.day === now.getDay());
  if (!row) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= toMinutes(row.open) && minutes < toMinutes(row.close);
}
