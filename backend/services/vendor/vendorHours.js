// A vendor's hours of operation: pure functions, no I/O.
//
// Shape (Vendor.operatingHours):
//   { preset: "weekdays" | "always" | "custom",
//     weekly: [{ day: 0-6 (Sun-Sat), open: "HH:mm", close: "HH:mm" }] }
//
// `weekly` is always the source of truth, even for a preset: normalizeHours
// expands "weekdays" and "always" into rows, so anything reading hours later
// (an "open now" badge, a future after-hours routing rule) reads one shape and
// never has to know presets exist. `preset` is kept only so the form can show
// the landlord the choice they made.
//
// "24:00" is allowed as a closing time so a full day is representable without
// wrapping past midnight. Overnight shifts (close < open) are rejected rather
// than guessed at; nobody has asked for them yet.

const PRESETS = ["weekdays", "always", "custom"];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((day) => ({ day, open: "09:00", close: "17:00" }));
const ALL_DAY_EVERY_DAY = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "00:00", close: "24:00" }));

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

/**
 * Validate raw input. Returns an error message for the whole field, or null.
 * One message, because the form shows one error under the hours control.
 */
function validateHours(input) {
  if (!input || typeof input !== "object") return "Set the vendor's hours of operation.";
  if (!PRESETS.includes(input.preset)) return "Choose when this vendor works.";
  if (input.preset !== "custom") return null;

  const rows = Array.isArray(input.weekly) ? input.weekly : [];
  if (!rows.length) return "Pick at least one day the vendor works.";

  const seen = new Set();
  for (const row of rows) {
    const day = Number(row?.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) return "One of the days is not valid.";
    if (seen.has(day)) return `${DAY_LABELS[day]} is listed twice.`;
    seen.add(day);
    if (!TIME_RE.test(String(row.open)) || !TIME_RE.test(String(row.close))) {
      return `Enter opening and closing times for ${DAY_LABELS[day]}.`;
    }
    if (row.open === "24:00") return `${DAY_LABELS[day]} cannot open at 24:00.`;
    if (toMinutes(row.open) >= toMinutes(row.close)) {
      return `${DAY_LABELS[day]} must close after it opens.`;
    }
  }
  return null;
}

/** Canonical stored form. Call only on input validateHours accepted. */
function normalizeHours(input) {
  if (input.preset === "weekdays") return { preset: "weekdays", weekly: WEEKDAYS_9_TO_5.map((r) => ({ ...r })) };
  if (input.preset === "always") return { preset: "always", weekly: ALL_DAY_EVERY_DAY.map((r) => ({ ...r })) };
  const weekly = input.weekly
    .map((row) => ({ day: Number(row.day), open: String(row.open), close: String(row.close) }))
    .sort((a, b) => a.day - b.day);
  return { preset: "custom", weekly };
}

const fmt = (hhmm) => (hhmm === "24:00" ? "24:00" : hhmm.replace(/^0(\d)/, "$1"));

/**
 * One-line summary, e.g. "Mon–Fri 9:00–17:00", "24/7",
 * "Mon–Wed 8:00–16:00 · Sat 10:00–14:00". Consecutive days with identical
 * hours are folded into a range. Stored as Vendor.businessHours so the readers
 * that predate structured hours keep working.
 */
function formatHours(hours) {
  if (!hours || !Array.isArray(hours.weekly) || !hours.weekly.length) return "";
  if (hours.preset === "always") return "24/7";

  // Week order Mon..Sun reads more naturally than Sun..Sat.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const byDay = new Map(hours.weekly.map((row) => [row.day, row]));
  const groups = [];
  for (const day of order) {
    const row = byDay.get(day);
    const last = groups[groups.length - 1];
    const contiguous = last && order.indexOf(last.end) === order.indexOf(day) - 1;
    if (row && last && contiguous && last.open === row.open && last.close === row.close) {
      last.end = day;
    } else if (row) {
      groups.push({ start: day, end: day, open: row.open, close: row.close });
    }
  }
  return groups
    .map((g) => {
      const days = g.start === g.end ? DAY_LABELS[g.start] : `${DAY_LABELS[g.start]}–${DAY_LABELS[g.end]}`;
      return `${days} ${fmt(g.open)}–${fmt(g.close)}`;
    })
    .join(" · ");
}

/**
 * The single daily window the outreach policy schedules within
 * ({ days, startMinutes, endMinutes }, days 0=Sun as getUTCDay), derived from
 * structured hours. Outreach offers time slots and response deadlines inside
 * this window, so it must never claim the vendor works when they do not.
 *
 * The policy model has one window for every working day, while custom hours
 * can differ per day. So take the window most days share (ties: the one that
 * covers more days, then the earliest), and include only the days whose own
 * hours contain it -- a short Saturday is left out rather than offered slots
 * the vendor is closed for. Returns null when there is nothing to schedule in.
 */
function toPolicyWindow(hours) {
  const rows = Array.isArray(hours?.weekly) ? hours.weekly : [];
  if (!rows.length) return null;

  const tally = new Map();
  for (const row of rows) {
    const key = `${row.open}-${row.close}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  const [bestKey] = [...tally.entries()].sort(
    (a, b) => b[1] - a[1] || toMinutes(a[0].split("-")[0]) - toMinutes(b[0].split("-")[0])
  )[0];
  const [open, close] = bestKey.split("-");
  const startMinutes = toMinutes(open);
  const endMinutes = toMinutes(close);

  const days = rows
    .filter((row) => toMinutes(row.open) <= startMinutes && toMinutes(row.close) >= endMinutes)
    .map((row) => Number(row.day))
    .sort((a, b) => a - b);
  return days.length ? { days, startMinutes, endMinutes } : null;
}

module.exports = { PRESETS, DAY_LABELS, validateHours, normalizeHours, formatHours, toPolicyWindow };
