// Severity -> offered availability windows and response SLA.
//
// Pure functions, no I/O, so this is unit-testable under tests/run_unit.js.
//
// SLA figures come from mvp_implementation.md "Vendor Response Timeouts":
//   Emergency: escalate immediately
//   Urgent:    no response in 20 minutes  -> try next vendor
//   Normal:    no response in 4 business hours
//   Low:       retry within next business day
//
// Timezone handling deliberately uses Intl rather than adding a tz dependency.
// Slot start/end are stored as absolute instants; the timezone only affects the
// human-readable label and the business-hours arithmetic.

// vendorHours is pure too, so this module stays I/O-free.
const { toPolicyWindow } = require("./vendorHours");

const DEFAULT_TIME_ZONE = "America/Regina";
const DEFAULT_BUSINESS_START_MINUTES = 8 * 60; // 08:00
const DEFAULT_BUSINESS_END_MINUTES = 18 * 60; // 18:00

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const DAY_TOKENS = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/* ------------------------------------------------------------------ *
 * Timezone helpers
 * ------------------------------------------------------------------ */

// Offset (ms) of `timeZone` relative to UTC at the given instant.
function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );

  return asUtc - date.getTime();
}

// Wall-clock reading of `date` in `timeZone`.
function getZonedParts(date, timeZone) {
  const offset = getTimeZoneOffsetMs(date, timeZone);
  const shifted = new Date(date.getTime() + offset);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

// Inverse of getZonedParts: the instant at which `timeZone` reads this wall clock.
// Two-pass so DST transitions resolve to the correct offset.
function zonedWallClockToDate({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstOffset = getTimeZoneOffsetMs(new Date(naive), timeZone);
  let result = naive - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(result), timeZone);
  if (secondOffset !== firstOffset) result = naive - secondOffset;
  return new Date(result);
}

function addZonedDays(parts, days) {
  const base = Date.UTC(parts.year, parts.month - 1, parts.day);
  const moved = new Date(base + days * 24 * HOUR_MS);
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
    weekday: moved.getUTCDay(),
  };
}

function isWeekend(weekday) {
  return weekday === 0 || weekday === 6;
}

/* ------------------------------------------------------------------ *
 * Business hours
 * ------------------------------------------------------------------ */

// Parses the free-text Vendor.businessHours field, e.g. "Mon-Sat 08:00-18:00"
// or "Mon-Fri 9:00-17:00". Returns null when it can't be understood, in which
// case callers fall back to weekday 08:00-18:00.
function parseBusinessHours(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const timeMatch = text.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!timeMatch) return null;

  const startMinutes = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
  const endMinutes = Number(timeMatch[3]) * 60 + Number(timeMatch[4]);
  if (!(endMinutes > startMinutes)) return null;

  const dayMatch = text.match(/([A-Za-z]{3})\s*-\s*([A-Za-z]{3})/);
  let days = [1, 2, 3, 4, 5];
  if (dayMatch) {
    const from = DAY_TOKENS[dayMatch[1].toLowerCase()];
    const to = DAY_TOKENS[dayMatch[2].toLowerCase()];
    if (from !== undefined && to !== undefined) {
      days = [];
      // Walk forward so ranges that wrap the week (e.g. Sat-Wed) still work.
      for (let index = 0, cursor = from; index < 7; index += 1) {
        days.push(cursor);
        if (cursor === to) break;
        cursor = (cursor + 1) % 7;
      }
    }
  }

  return { days, startMinutes, endMinutes };
}

// Structured operatingHours win when present. Vendor.businessHours for those
// vendors is a DISPLAY string ("Mon–Fri 9:00–17:00", "24/7", with en dashes)
// that this parser was never meant to read -- it would fail and fall back to
// the default window, offering a 24/7 vendor weekday slots only. The string is
// still parsed for vendors that predate structured hours.
function resolveBusinessHours(vendor) {
  return (
    toPolicyWindow(vendor?.operatingHours) ||
    parseBusinessHours(vendor?.businessHours) || {
      days: [1, 2, 3, 4, 5],
      startMinutes: DEFAULT_BUSINESS_START_MINUTES,
      endMinutes: DEFAULT_BUSINESS_END_MINUTES,
    }
  );
}

/* ------------------------------------------------------------------ *
 * Tier resolution
 * ------------------------------------------------------------------ */

// Returns null when no severity signal exists, so callers can tell "unknown"
// apart from "middling" — an absent severity must not escalate a low-urgency
// request, but a present severity of 3 should.
function resolveSeverity(request = {}) {
  const candidates = [
    request.severityOverride,
    request.incidentRecord?.severity,
    request.ai?.severity,
  ];
  const found = candidates.find((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  return found === undefined ? null : Number(found);
}

const TIER_RANK = { low: 0, normal: 1, urgent: 2, emergency: 3 };
const RANK_TIER = ["low", "normal", "urgent", "emergency"];

function tierFromUrgency(urgency) {
  if (urgency === "emergency") return "emergency";
  if (urgency === "high") return "urgent";
  if (urgency === "medium") return "normal";
  if (urgency === "low") return "low";
  return "normal"; // unknown/absent urgency is treated as standard
}

function tierFromSeverity(severity) {
  if (severity === null) return null;
  if (severity >= 5) return "emergency";
  if (severity === 4) return "urgent";
  if (severity === 3) return "normal";
  return "low";
}

// Urgency (declared) and severity (AI-scored) are independent signals; take the
// MORE severe of the two so either one can escalate but neither can quietly
// downgrade the other. Hard safety flags override both.
function resolveOutreachTier(request = {}) {
  const urgency = String(request.urgency || "").toLowerCase();

  if (
    urgency === "emergency" ||
    request.incidentRecord?.emergency === true ||
    request.incidentRecord?.safety?.lifeSafetyConcern === true
  ) {
    return "emergency";
  }

  const fromUrgency = tierFromUrgency(urgency);
  const fromSeverity = tierFromSeverity(resolveSeverity(request));
  if (!fromSeverity) return fromUrgency;

  return RANK_TIER[Math.max(TIER_RANK[fromUrgency], TIER_RANK[fromSeverity])];
}

const TIER_LABELS = {
  emergency: "Emergency",
  urgent: "Urgent",
  normal: "Standard",
  low: "Low priority",
};

function getTierLabel(tier) {
  return TIER_LABELS[tier] || "Standard";
}

/* ------------------------------------------------------------------ *
 * Response SLA
 * ------------------------------------------------------------------ */

// Walks forward through business hours adding `hours` of open time.
function addBusinessHours(from, hours, timeZone, businessHours) {
  let remainingMs = hours * HOUR_MS;
  let cursor = new Date(from.getTime());

  // Bounded so a pathological businessHours config can't spin forever.
  for (let guard = 0; guard < 400 && remainingMs > 0; guard += 1) {
    const parts = getZonedParts(cursor, timeZone);
    const isOpenDay = businessHours.days.includes(parts.weekday);

    if (!isOpenDay || parts.minutesOfDay >= businessHours.endMinutes) {
      const next = addZonedDays(parts, 1);
      cursor = zonedWallClockToDate(
        {
          year: next.year,
          month: next.month,
          day: next.day,
          hour: Math.floor(businessHours.startMinutes / 60),
          minute: businessHours.startMinutes % 60,
        },
        timeZone
      );
      continue;
    }

    if (parts.minutesOfDay < businessHours.startMinutes) {
      cursor = zonedWallClockToDate(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: Math.floor(businessHours.startMinutes / 60),
          minute: businessHours.startMinutes % 60,
        },
        timeZone
      );
      continue;
    }

    const minutesLeftToday = businessHours.endMinutes - parts.minutesOfDay;
    const usableMs = Math.min(remainingMs, minutesLeftToday * MINUTE_MS);
    cursor = new Date(cursor.getTime() + usableMs);
    remainingMs -= usableMs;
  }

  return cursor;
}

function nextBusinessDayAt(from, minutesOfDay, timeZone, businessHours) {
  let parts = getZonedParts(from, timeZone);
  for (let guard = 0; guard < 14; guard += 1) {
    const next = addZonedDays(parts, 1);
    if (businessHours.days.includes(next.weekday)) {
      return zonedWallClockToDate(
        {
          year: next.year,
          month: next.month,
          day: next.day,
          hour: Math.floor(minutesOfDay / 60),
          minute: minutesOfDay % 60,
        },
        timeZone
      );
    }
    parts = { ...parts, ...next };
  }
  return new Date(from.getTime() + 24 * HOUR_MS);
}

function resolveResponseSla({ tier, sentAt = new Date(), timeZone = DEFAULT_TIME_ZONE, vendor }) {
  const businessHours = resolveBusinessHours(vendor);
  const from = new Date(sentAt);

  if (tier === "emergency") {
    return {
      responseDeadlineAt: new Date(from.getTime() + 15 * MINUTE_MS),
      // Emergency does not wait for the clock — it escalates to a human at send.
      escalateImmediately: true,
      slaLabel: "15 minutes",
    };
  }
  if (tier === "urgent") {
    return {
      responseDeadlineAt: new Date(from.getTime() + 20 * MINUTE_MS),
      escalateImmediately: false,
      slaLabel: "20 minutes",
    };
  }
  if (tier === "normal") {
    return {
      responseDeadlineAt: addBusinessHours(from, 4, timeZone, businessHours),
      escalateImmediately: false,
      slaLabel: "4 business hours",
    };
  }
  return {
    responseDeadlineAt: nextBusinessDayAt(from, 17 * 60, timeZone, businessHours),
    escalateImmediately: false,
    slaLabel: "next business day",
  };
}

/* ------------------------------------------------------------------ *
 * Offered windows
 * ------------------------------------------------------------------ */

function formatWindowLabel(start, end, timeZone) {
  const dayLabel = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(start);
  const timeFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${dayLabel}, ${timeFormatter.format(start)} – ${timeFormatter.format(end)}`;
}

function buildWindow({ start, end, timeZone, kind = "window" }) {
  return {
    slotId: `w-${kind}-${start.toISOString().replace(/[:.]/g, "")}`,
    start,
    end,
    label: formatWindowLabel(start, end, timeZone),
    timeZone,
    kind,
  };
}

function ceilToHalfHour(date) {
  const ms = 30 * MINUTE_MS;
  return new Date(Math.ceil(date.getTime() / ms) * ms);
}

/* ------------------------------------------------------------------ *
 * Per-day hours
 * ------------------------------------------------------------------ */

const hhmmToMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

// Non-emergency offers stay inside sociable hours even for a vendor who works
// around the clock: a 24/7 plumber is not offered a 2am slot for a dripping tap,
// and a tenant is not asked to open the door then.
const SOCIABLE_START_MINUTES = 7 * 60;
const SOCIABLE_END_MINUTES = 21 * 60;
const MIN_WINDOW_MINUTES = 60;

/**
 * weekday (0=Sun) -> { open, close } in minutes, or null when closed.
 *
 * Reads Vendor.operatingHours.weekly ROW BY ROW, so custom hours keep their
 * per-day shape: a Saturday 10-14 is offered as 10-14, not dropped because the
 * weekdays run 8-16 (toPolicyWindow, which the SLA still uses, has to collapse
 * them into one shared window). Vendors without structured hours fall back to
 * the legacy single window, so they behave exactly as before.
 */
function resolveDayHours(vendor) {
  const rows = Array.isArray(vendor?.operatingHours?.weekly) ? vendor.operatingHours.weekly : [];
  if (rows.length) {
    const byDay = new Map(
      rows.map((row) => [Number(row.day), { open: hhmmToMinutes(row.open), close: hhmmToMinutes(row.close) }])
    );
    return (weekday) => byDay.get(weekday) || null;
  }
  const window = resolveBusinessHours(vendor);
  return (weekday) =>
    window.days.includes(weekday) ? { open: window.startMinutes, close: window.endMinutes } : null;
}

/**
 * Is the vendor open at this instant, by their OWN hours? Raw hours, not the
 * sociable band below: "available" means what the vendor configured.
 */
function isOpenAt(vendor, at = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = getZonedParts(new Date(at), timeZone);
  const day = resolveDayHours(vendor)(parts.weekday);
  return Boolean(day) && parts.minutesOfDay >= day.open && parts.minutesOfDay < day.close;
}

/**
 * The next instant the vendor opens: `from` itself when they're open now,
 * later today if they haven't opened yet, otherwise the next day they work.
 * Searches two weeks ahead; null means no hours at all in that span.
 *
 * Friday 6 PM for a Mon–Fri 08:00 vendor -> Monday 08:00.
 */
function nextOpeningAt(vendor, from = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const start = new Date(from);
  if (isOpenAt(vendor, start, timeZone)) return start;

  const dayHours = resolveDayHours(vendor);
  const nowParts = getZonedParts(start, timeZone);
  const today = dayHours(nowParts.weekday);
  if (today && nowParts.minutesOfDay < today.open) {
    return zonedWallClockToDate(
      { year: nowParts.year, month: nowParts.month, day: nowParts.day, hour: Math.floor(today.open / 60), minute: today.open % 60 },
      timeZone
    );
  }

  let cursor = nowParts;
  for (let offset = 1; offset <= 14; offset += 1) {
    const next = addZonedDays(cursor, 1);
    cursor = { ...cursor, ...next };
    const hours = dayHours(next.weekday);
    if (!hours) continue;
    return zonedWallClockToDate(
      { year: next.year, month: next.month, day: next.day, hour: Math.floor(hours.open / 60), minute: hours.open % 60 },
      timeZone
    );
  }
  return null;
}

// Tiers that wait for the vendor's hours. Emergency and urgent go out now:
// an urgent job at 9 PM must not sit silently until Monday -- the vendor can
// still decline.
const SCHEDULABLE_TIERS = new Set(["normal", "low"]);

/**
 * When outreach should go out: now, or at the vendor's next opening.
 * Returns { sendNow: true } or { sendNow: false, scheduledFor }.
 */
function resolveSendTiming({ tier, vendor, now = new Date(), timeZone = DEFAULT_TIME_ZONE }) {
  if (!SCHEDULABLE_TIERS.has(tier) || isOpenAt(vendor, now, timeZone)) return { sendNow: true };
  const scheduledFor = nextOpeningAt(vendor, now, timeZone);
  return scheduledFor ? { sendNow: false, scheduledFor } : { sendNow: true };
}

// The part of a day's hours a non-emergency offer may use. A vendor who only
// works nights keeps their own hours rather than being offered nothing.
function sociableHours(day) {
  if (!day) return null;
  const open = Math.max(day.open, SOCIABLE_START_MINUTES);
  const close = Math.min(day.close, SOCIABLE_END_MINUTES);
  return close - open >= MIN_WINDOW_MINUTES ? { open, close } : day;
}

// Preferred ranges clipped to the day's hours. A range left shorter than an
// hour is dropped; if none survive, one window from opening (up to 4h).
function clipRanges(ranges, day) {
  const clipped = ranges
    .map(([start, end]) => [Math.max(start, day.open), Math.min(end, day.close)])
    .filter(([start, end]) => end - start >= MIN_WINDOW_MINUTES);
  if (clipped.length) return clipped;
  return [[day.open, Math.min(day.open + 4 * 60, day.close)]];
}

function buildSameDayWindows({
  now,
  timeZone,
  count,
  lengthHours = 2,
  respectEndMinutes,
  respectStartMinutes,
}) {
  const windows = [];
  let cursor = ceilToHalfHour(new Date(now.getTime() + 30 * MINUTE_MS));

  // Before opening, start the offer at opening rather than proposing a slot in
  // the middle of the night. Only tiers that respect business hours pass these
  // bounds — emergency deliberately omits them.
  if (respectStartMinutes !== undefined) {
    const parts = getZonedParts(cursor, timeZone);
    if (parts.minutesOfDay < respectStartMinutes) {
      cursor = zonedWallClockToDate(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: Math.floor(respectStartMinutes / 60),
          minute: respectStartMinutes % 60,
        },
        timeZone
      );
    }
  }

  for (let index = 0; index < count; index += 1) {
    const start = new Date(cursor.getTime());
    let end = new Date(start.getTime() + lengthHours * HOUR_MS);
    if (respectEndMinutes !== undefined) {
      const startParts = getZonedParts(start, timeZone);
      // A window must end by closing time, not run past it.
      const minutesLeft = respectEndMinutes - startParts.minutesOfDay;
      if (minutesLeft < MIN_WINDOW_MINUTES) break;
      if (minutesLeft < lengthHours * 60) end = new Date(start.getTime() + minutesLeft * MINUTE_MS);
    }
    windows.push(buildWindow({ start, end, timeZone }));
    cursor = end;
  }

  return windows;
}

function buildDayWindows({ dayParts, ranges, timeZone }) {
  return ranges.map(([startMinutes, endMinutes]) =>
    buildWindow({
      start: zonedWallClockToDate(
        {
          year: dayParts.year,
          month: dayParts.month,
          day: dayParts.day,
          hour: Math.floor(startMinutes / 60),
          minute: startMinutes % 60,
        },
        timeZone
      ),
      end: zonedWallClockToDate(
        {
          year: dayParts.year,
          month: dayParts.month,
          day: dayParts.day,
          hour: Math.floor(endMinutes / 60),
          minute: endMinutes % 60,
        },
        timeZone
      ),
      timeZone,
    })
  );
}

function buildOfferedWindows({
  tier,
  now = new Date(),
  vendor,
  timeZone = DEFAULT_TIME_ZONE,
} = {}) {
  const dayHours = resolveDayHours(vendor);
  const offerHours = (weekday) => sociableHours(dayHours(weekday));
  const nowParts = getZonedParts(now, timeZone);

  // The next `count` days the vendor is open, starting tomorrow.
  const nextOpenDays = (count, maxDays = 21) => {
    const days = [];
    let cursor = nowParts;
    for (let guard = 0; guard < maxDays && days.length < count; guard += 1) {
      const next = addZonedDays(cursor, 1);
      cursor = { ...cursor, ...next };
      const hours = offerHours(next.weekday);
      if (hours) days.push({ dayParts: next, hours });
    }
    return days;
  };

  if (tier === "emergency") {
    // Life-safety work ignores weekends and posted hours entirely.
    const asapStart = new Date(now.getTime());
    const asap = {
      ...buildWindow({
        start: asapStart,
        end: new Date(asapStart.getTime() + 2 * HOUR_MS),
        timeZone,
        kind: "asap",
      }),
      label: "ASAP — within 2 hours",
    };
    return [asap, ...buildSameDayWindows({ now, timeZone, count: 2 })];
  }

  if (tier === "urgent") {
    // Same day only if the vendor is open today, bounded by TODAY's hours.
    const today = offerHours(nowParts.weekday);
    const sameDay = today
      ? buildSameDayWindows({
          now,
          timeZone,
          count: 2,
          respectStartMinutes: today.open,
          respectEndMinutes: today.close,
        })
      : [];
    // "Tomorrow" means the next day they are open -- a Friday request to a
    // weekday vendor lands on Monday, not on a Saturday they don't work.
    const [nextDay] = nextOpenDays(1);
    const nextDayWindows = nextDay
      ? buildDayWindows({
          dayParts: nextDay.dayParts,
          ranges: [
            [nextDay.hours.open, nextDay.hours.open + 2 * 60],
            [nextDay.hours.open + 2 * 60, nextDay.hours.open + 4 * 60],
          ]
            .map(([start, end]) => [start, Math.min(end, nextDay.hours.close)])
            .filter(([start, end]) => end - start >= MIN_WINDOW_MINUTES),
          timeZone,
        })
      : [];
    return [...sameDay, ...nextDayWindows].slice(0, 4);
  }

  if (tier === "normal") {
    // Morning and afternoon on each of the next open days, clipped to that
    // day's own hours.
    const windows = [];
    for (const { dayParts, hours } of nextOpenDays(6)) {
      windows.push(
        ...buildDayWindows({
          dayParts,
          ranges: clipRanges(
            [
              [8 * 60, 12 * 60],
              [13 * 60, 17 * 60],
            ],
            hours
          ),
          timeZone,
        })
      );
      if (windows.length >= 6) break;
    }
    return windows.slice(0, 6);
  }

  // low: skips the next open day, then one morning per open day.
  const windows = [];
  for (const { dayParts, hours } of nextOpenDays(6).slice(1)) {
    windows.push(...buildDayWindows({ dayParts, ranges: clipRanges([[9 * 60, 13 * 60]], hours).slice(0, 1), timeZone }));
    if (windows.length >= 5) break;
  }

  windows.push({
    slotId: "w-flexible-any-open-day",
    start: null,
    end: null,
    label: "Flexible — any day you're open",
    timeZone,
    kind: "flexible",
  });

  return windows.slice(0, 6);
}

module.exports = {
  DEFAULT_TIME_ZONE,
  resolveOutreachTier,
  resolveSeverity,
  getTierLabel,
  resolveResponseSla,
  buildOfferedWindows,
  formatWindowLabel,
  parseBusinessHours,
  resolveBusinessHours,
  resolveDayHours,
  isOpenAt,
  nextOpeningAt,
  resolveSendTiming,
  SCHEDULABLE_TIERS,
  addBusinessHours,
  formatWindowLabel,
  // exported for tests
  getZonedParts,
  zonedWallClockToDate,
};
