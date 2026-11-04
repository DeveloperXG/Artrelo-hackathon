const assert = require("assert");
const { interval, overlaps, subtractBusy } = require("../../../services/vendor/calendarPolicy");
const at = time => `2026-11-02T${time}:00Z`;
const visit = interval(at("10:00"), at("11:00"));
assert.throws(() => interval("invalid", at("11:00")), /valid start/);
assert.throws(() => interval(at("11:00"), at("10:00")), /valid start/);
assert.ok(overlaps(visit, interval(at("11:15"), at("12:00"))), "travel buffer blocks an adjacent visit");
assert.ok(!overlaps(visit, interval(at("11:30"), at("12:00"))), "exactly thirty minutes between visits is permitted");
assert.ok(overlaps(visit, interval(at("09:00"), at("09:45"))), "buffer applies in both directions");
const free = subtractBusy([interval(at("08:00"), at("14:00"))], [visit], { durationMinutes: 60 });
assert.deepStrictEqual(free.map(row => [row.start.toISOString(), row.end.toISOString()]),
  [[at("08:00").replace("Z", ".000Z"), at("09:30").replace("Z", ".000Z")],
    [at("11:30").replace("Z", ".000Z"), at("14:00").replace("Z", ".000Z")]]);
assert.strictEqual(subtractBusy([visit], [visit]).length, 0, "booked time is never offered");
assert.strictEqual(subtractBusy([interval(at("08:00"), at("09:00"))], [], { durationMinutes: 120 }).length, 0,
  "free fragments must accommodate the whole visit");
console.log("calendar policy tests passed");
