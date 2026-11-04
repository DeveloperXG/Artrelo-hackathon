const assert = require("assert");
const {
  resolveOutreachTier,
  resolveResponseSla,
  buildOfferedWindows,
  parseBusinessHours,
  addBusinessHours,
  getTierLabel,
} = require("../../../services/vendor/vendorOutreachPolicy.service");

const TZ = "America/Regina"; // no DST — stable arithmetic baseline
const MON_HOURS = { businessHours: "Mon-Fri 08:00-18:00" };

/* ---------------- 1) Tier resolution, first match wins ---------------- */

assert.strictEqual(resolveOutreachTier({ urgency: "emergency" }), "emergency");
assert.strictEqual(resolveOutreachTier({ incidentRecord: { emergency: true } }), "emergency");
assert.strictEqual(
  resolveOutreachTier({ incidentRecord: { safety: { lifeSafetyConcern: true } } }),
  "emergency"
);
// Severity 5 escalates even when the tenant called it low priority.
assert.strictEqual(resolveOutreachTier({ urgency: "low", ai: { severity: 5 } }), "emergency");

assert.strictEqual(resolveOutreachTier({ urgency: "high" }), "urgent");
assert.strictEqual(resolveOutreachTier({ urgency: "low", ai: { severity: 4 } }), "urgent");

assert.strictEqual(resolveOutreachTier({ urgency: "medium" }), "normal");
assert.strictEqual(resolveOutreachTier({}), "normal", "missing urgency defaults to severity 3");

assert.strictEqual(resolveOutreachTier({ urgency: "low" }), "low");
// severityOverride beats the AI's severity.
assert.strictEqual(
  resolveOutreachTier({ urgency: "low", ai: { severity: 5 }, severityOverride: 2 }),
  "low"
);

assert.strictEqual(getTierLabel("emergency"), "Emergency");
assert.strictEqual(getTierLabel("nonsense"), "Standard");

/* ---------------- 2) Business-hours parsing ---------------- */

assert.deepStrictEqual(parseBusinessHours("Mon-Sat 08:00-18:00"), {
  days: [1, 2, 3, 4, 5, 6],
  startMinutes: 480,
  endMinutes: 1080,
});
assert.deepStrictEqual(parseBusinessHours("Mon-Fri 9:00-17:00"), {
  days: [1, 2, 3, 4, 5],
  startMinutes: 540,
  endMinutes: 1020,
});
assert.strictEqual(parseBusinessHours("whenever"), null);
assert.strictEqual(parseBusinessHours(""), null);
assert.strictEqual(parseBusinessHours(null), null);
// End before start is nonsense -> fall back rather than generate inverted windows.
assert.strictEqual(parseBusinessHours("Mon-Fri 18:00-08:00"), null);

/* ---------------- 3) Response SLA ---------------- */
// Tue 2026-07-28 09:00 Regina == 15:00Z (Regina is UTC-6 year-round).
const TUE_9AM = new Date("2026-07-28T15:00:00.000Z");

const emergency = resolveResponseSla({ tier: "emergency", sentAt: TUE_9AM, timeZone: TZ });
assert.strictEqual(emergency.responseDeadlineAt.toISOString(), "2026-07-28T15:15:00.000Z");
assert.strictEqual(emergency.escalateImmediately, true, "emergency escalates at send time");

const urgent = resolveResponseSla({ tier: "urgent", sentAt: TUE_9AM, timeZone: TZ });
assert.strictEqual(urgent.responseDeadlineAt.toISOString(), "2026-07-28T15:20:00.000Z");
assert.strictEqual(urgent.escalateImmediately, false);

// 4 business hours from 09:00 -> 13:00 same day.
const normal = resolveResponseSla({ tier: "normal", sentAt: TUE_9AM, timeZone: TZ, vendor: MON_HOURS });
assert.strictEqual(normal.responseDeadlineAt.toISOString(), "2026-07-28T19:00:00.000Z");

// Low -> next business day 17:00 local == 23:00Z.
const low = resolveResponseSla({ tier: "low", sentAt: TUE_9AM, timeZone: TZ, vendor: MON_HOURS });
assert.strictEqual(low.responseDeadlineAt.toISOString(), "2026-07-29T23:00:00.000Z");

/* ---------------- 4) Business-hour arithmetic rolls over correctly ------- */

// Tue 16:00 local + 4 business hours -> spills into Wed 10:00 (closes at 18:00).
const TUE_4PM = new Date("2026-07-28T22:00:00.000Z");
const rolled = addBusinessHours(TUE_4PM, 4, TZ, parseBusinessHours("Mon-Fri 08:00-18:00"));
assert.strictEqual(rolled.toISOString(), "2026-07-29T16:00:00.000Z", "Wed 10:00 Regina");

// Friday afternoon must skip the weekend entirely.
const FRI_4PM = new Date("2026-07-31T22:00:00.000Z");
const overWeekend = addBusinessHours(FRI_4PM, 4, TZ, parseBusinessHours("Mon-Fri 08:00-18:00"));
const overWeekendLocalDay = new Date(overWeekend.getTime() - 6 * 3600 * 1000).getUTCDay();
assert.strictEqual(overWeekendLocalDay, 1, "should land on Monday, not the weekend");

// Before opening: clock starts at open, not at the current time.
const TUE_6AM = new Date("2026-07-28T12:00:00.000Z");
const fromEarly = addBusinessHours(TUE_6AM, 2, TZ, parseBusinessHours("Mon-Fri 08:00-18:00"));
assert.strictEqual(fromEarly.toISOString(), "2026-07-28T16:00:00.000Z", "08:00 + 2h = 10:00 local");

/* ---------------- 5) Offered windows per tier ---------------- */

const emergencyWindows = buildOfferedWindows({ tier: "emergency", now: TUE_9AM, timeZone: TZ });
assert.strictEqual(emergencyWindows[0].kind, "asap", "emergency leads with an ASAP pseudo-slot");
assert.ok(emergencyWindows.length >= 2 && emergencyWindows.length <= 3);
assert.ok(emergencyWindows.every((slot) => slot.slotId), "every window needs a stable slotId");

const urgentWindows = buildOfferedWindows({
  tier: "urgent",
  now: TUE_9AM,
  timeZone: TZ,
  vendor: MON_HOURS,
});
assert.ok(urgentWindows.length <= 4, "urgent offers at most 4 windows");
assert.ok(!urgentWindows.some((slot) => slot.kind === "asap"), "only emergency gets ASAP");

// Urgent must never propose a pre-dawn slot: a request raised before opening
// should start its same-day offer at opening time, not at now+30min.
const PRE_DAWN = new Date("2026-07-28T10:00:00.000Z"); // 04:00 Regina
const preDawn = buildOfferedWindows({
  tier: "urgent",
  now: PRE_DAWN,
  timeZone: TZ,
  vendor: MON_HOURS,
});
preDawn.forEach((slot) => {
  const localMinutes = new Date(new Date(slot.start).getTime() - 6 * 3600 * 1000).getUTCHours() * 60;
  assert.ok(
    localMinutes >= 8 * 60,
    `urgent window starts before opening: ${slot.label}`
  );
});
// Emergency deliberately ignores business hours — life safety does not wait.
const preDawnEmergency = buildOfferedWindows({
  tier: "emergency",
  now: PRE_DAWN,
  timeZone: TZ,
  vendor: MON_HOURS,
});
assert.strictEqual(preDawnEmergency[0].kind, "asap", "emergency still leads with ASAP pre-dawn");
assert.ok(preDawnEmergency.length >= 2, "emergency still offers same-day slots pre-dawn");

const normalWindows = buildOfferedWindows({
  tier: "normal",
  now: TUE_9AM,
  timeZone: TZ,
  vendor: MON_HOURS,
});
assert.strictEqual(normalWindows.length, 6, "normal offers 3 business days x 2 windows");
// Nothing on the same day — the earliest is the next business day.
assert.ok(
  normalWindows.every((slot) => new Date(slot.start).getTime() > TUE_9AM.getTime()),
  "normal windows start after the request"
);

const lowWindows = buildOfferedWindows({
  tier: "low",
  now: TUE_9AM,
  timeZone: TZ,
  vendor: MON_HOURS,
});
assert.ok(lowWindows.length <= 6);
assert.strictEqual(lowWindows[lowWindows.length - 1].kind, "flexible", "low ends with a flexible option");
assert.strictEqual(lowWindows[lowWindows.length - 1].start, null, "flexible slot has no fixed start");

/* ---------------- 6) Weekends are skipped for fixed-day tiers ----------- */

// Start on a Friday; normal windows must not land on Sat/Sun for a Mon-Fri vendor.
const FRI_9AM = new Date("2026-07-31T15:00:00.000Z");
const acrossWeekend = buildOfferedWindows({
  tier: "normal",
  now: FRI_9AM,
  timeZone: TZ,
  vendor: MON_HOURS,
});
acrossWeekend.forEach((slot) => {
  const localDay = new Date(new Date(slot.start).getTime() - 6 * 3600 * 1000).getUTCDay();
  assert.ok(localDay !== 0 && localDay !== 6, `window landed on a weekend: ${slot.label}`);
});

// A Mon-Sat vendor SHOULD get Saturday windows.
const satCapable = buildOfferedWindows({
  tier: "normal",
  now: FRI_9AM,
  timeZone: TZ,
  vendor: { businessHours: "Mon-Sat 08:00-18:00" },
});
const hasSaturday = satCapable.some((slot) => {
  const localDay = new Date(new Date(slot.start).getTime() - 6 * 3600 * 1000).getUTCDay();
  return localDay === 6;
});
assert.ok(hasSaturday, "a Mon-Sat vendor should be offered Saturday windows");

/* ---------------- 6b) Structured hours, read per day ---------------- */

const { normalizeHours } = require("../../../services/vendor/vendorHours");
const local = (date) => new Date(new Date(date).getTime() - 6 * 3600 * 1000); // Regina wall clock
const localMinutes = (date) => local(date).getUTCHours() * 60 + local(date).getUTCMinutes();
const localDay = (date) => local(date).getUTCDay();
const withHours = (input) => ({ operatingHours: normalizeHours(input) });

// Custom: Mon-Wed 08-16, Sat 10-14. Saturday is offered INSIDE 10-14 rather
// than dropped (toPolicyWindow would drop it) or offered 08-12.
const CUSTOM = withHours({
  preset: "custom",
  weekly: [
    { day: 1, open: "08:00", close: "16:00" },
    { day: 2, open: "08:00", close: "16:00" },
    { day: 3, open: "08:00", close: "16:00" },
    { day: 6, open: "10:00", close: "14:00" },
  ],
});
const THU_9AM = new Date("2026-07-30T15:00:00.000Z");
const customNormal = buildOfferedWindows({ tier: "normal", now: THU_9AM, timeZone: TZ, vendor: CUSTOM });
const saturday = customNormal.filter((slot) => localDay(slot.start) === 6);
assert.ok(saturday.length >= 1, "Saturday is offered");
saturday.forEach((slot) => {
  assert.ok(localMinutes(slot.start) >= 10 * 60, `Saturday window starts before 10: ${slot.label}`);
  assert.ok(localMinutes(slot.end) <= 14 * 60, `Saturday window ends after 14: ${slot.label}`);
});
customNormal.forEach((slot) => {
  assert.ok([1, 2, 3, 6].includes(localDay(slot.start)), `offered a closed day: ${slot.label}`);
  if (localDay(slot.start) !== 6) assert.ok(localMinutes(slot.end) <= 16 * 60, `past 16:00: ${slot.label}`);
});

// A 10-14 vendor is never offered a window that starts before 10.
const TEN_TO_TWO = withHours({
  preset: "custom",
  weekly: [1, 2, 3, 4, 5].map((day) => ({ day, open: "10:00", close: "14:00" })),
});
buildOfferedWindows({ tier: "normal", now: TUE_9AM, timeZone: TZ, vendor: TEN_TO_TWO }).forEach((slot) => {
  assert.ok(localMinutes(slot.start) >= 10 * 60, `10-14 vendor offered ${slot.label}`);
  assert.ok(localMinutes(slot.end) <= 14 * 60, `10-14 vendor offered ${slot.label}`);
});

// 24/7: every day is open, but standard offers stay in daytime.
const ALWAYS = withHours({ preset: "always" });
const alwaysNormal = buildOfferedWindows({ tier: "normal", now: FRI_9AM, timeZone: TZ, vendor: ALWAYS });
assert.ok(alwaysNormal.some((slot) => localDay(slot.start) === 6), "a 24/7 vendor is offered Saturday");
alwaysNormal.forEach((slot) => {
  assert.ok(localMinutes(slot.start) >= 7 * 60, `24/7 offered a night slot: ${slot.label}`);
});
const alwaysPreDawn = buildOfferedWindows({ tier: "urgent", now: PRE_DAWN, timeZone: TZ, vendor: ALWAYS });
alwaysPreDawn.forEach((slot) => {
  assert.ok(localMinutes(slot.start) >= 7 * 60, `urgent 24/7 offered a pre-dawn slot: ${slot.label}`);
});

// Urgent on a Friday afternoon for a weekday vendor: the next-day pair lands
// on Monday, not Saturday.
const WEEKDAYS = withHours({ preset: "weekdays" });
const friUrgent = buildOfferedWindows({ tier: "urgent", now: FRI_4PM, timeZone: TZ, vendor: WEEKDAYS });
assert.ok(friUrgent.length > 0);
friUrgent.forEach((slot) => {
  assert.ok(![0, 6].includes(localDay(slot.start)), `urgent landed on a weekend: ${slot.label}`);
  if (localDay(slot.start) === 5) {
    assert.ok(localMinutes(slot.end) <= 17 * 60, `same-day window runs past closing: ${slot.label}`);
  }
});
assert.ok(friUrgent.some((slot) => localDay(slot.start) === 1), "next-day windows are on Monday");

// Evening-only vendor (18-22): one window inside their hours per day, not 8-12.
const EVENINGS = withHours({
  preset: "custom",
  weekly: [1, 2, 3, 4, 5].map((day) => ({ day, open: "18:00", close: "22:00" })),
});
const eveningNormal = buildOfferedWindows({ tier: "normal", now: TUE_9AM, timeZone: TZ, vendor: EVENINGS });
assert.ok(eveningNormal.length > 0);
eveningNormal.forEach((slot) => {
  assert.ok(localMinutes(slot.start) >= 18 * 60, `evening vendor offered ${slot.label}`);
});

// Low tier's flexible option no longer says "weekday" to a weekend worker.
const alwaysLow = buildOfferedWindows({ tier: "low", now: TUE_9AM, timeZone: TZ, vendor: ALWAYS });
assert.strictEqual(alwaysLow.at(-1).label, "Flexible — any day you're open");

/* ---------------- 6c) Open now / next opening / send timing ------------ */

const { isOpenAt, nextOpeningAt, resolveSendTiming } = require("../../../services/vendor/vendorOutreachPolicy.service");
// The user's example: a vendor open 8 AM - 3 PM on weekdays.
const EIGHT_TO_THREE = withHours({
  preset: "custom",
  weekly: [1, 2, 3, 4, 5].map((day) => ({ day, open: "08:00", close: "15:00" })),
});
const FRI_6PM = new Date("2026-08-01T00:00:00.000Z"); // Fri Jul 31, 18:00 Regina
const MON_8AM = "2026-08-03T14:00:00.000Z"; // Mon Aug 3, 08:00 Regina
const TUE_7AM = new Date("2026-07-28T13:00:00.000Z"); // Tue, 07:00 Regina

assert.strictEqual(isOpenAt(EIGHT_TO_THREE, TUE_9AM, TZ), true, "open mid-morning on a weekday");
assert.strictEqual(isOpenAt(EIGHT_TO_THREE, FRI_6PM, TZ), false, "closed Friday evening");
assert.strictEqual(
  nextOpeningAt(EIGHT_TO_THREE, FRI_6PM, TZ).toISOString(),
  MON_8AM,
  "Friday 6 PM -> Monday 8 AM, skipping the weekend"
);
assert.strictEqual(
  nextOpeningAt(EIGHT_TO_THREE, TUE_7AM, TZ).toISOString(),
  "2026-07-28T14:00:00.000Z",
  "before opening -> later the same day"
);
assert.strictEqual(nextOpeningAt(EIGHT_TO_THREE, TUE_9AM, TZ).getTime(), TUE_9AM.getTime(), "open now -> now");
assert.strictEqual(isOpenAt(ALWAYS, FRI_6PM, TZ), true, "24/7 is always open");
// Closing time is exclusive: 15:00 sharp is closed.
assert.strictEqual(isOpenAt(EIGHT_TO_THREE, new Date("2026-07-28T21:00:00.000Z"), TZ), false);

// Standard and low wait; urgent and emergency go now.
assert.deepStrictEqual(
  resolveSendTiming({ tier: "normal", vendor: EIGHT_TO_THREE, now: FRI_6PM, timeZone: TZ }).scheduledFor.toISOString(),
  MON_8AM
);
assert.strictEqual(resolveSendTiming({ tier: "low", vendor: EIGHT_TO_THREE, now: FRI_6PM, timeZone: TZ }).sendNow, false);
assert.strictEqual(resolveSendTiming({ tier: "urgent", vendor: EIGHT_TO_THREE, now: FRI_6PM, timeZone: TZ }).sendNow, true);
assert.strictEqual(resolveSendTiming({ tier: "emergency", vendor: EIGHT_TO_THREE, now: FRI_6PM, timeZone: TZ }).sendNow, true);
assert.strictEqual(resolveSendTiming({ tier: "normal", vendor: EIGHT_TO_THREE, now: TUE_9AM, timeZone: TZ }).sendNow, true);

/* ---------------- 7) Slot ids are unique ---------------- */

[emergencyWindows, urgentWindows, normalWindows, lowWindows].forEach((windows) => {
  const ids = windows.map((slot) => slot.slotId);
  assert.strictEqual(new Set(ids).size, ids.length, "slot ids must be unique within an offer");
});

console.log("vendorOutreachPolicy.service tests passed");
