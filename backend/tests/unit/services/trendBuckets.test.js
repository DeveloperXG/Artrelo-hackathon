// The dashboard chart and the reports endpoint both bucket through this, so
// its rules are the definition of "a month's requests" and "a month's spend".

const assert = require("assert");
const { monthlyTrend, dailyTrend } = require("../../../services/reports/trendBuckets");

const now = new Date(2026, 9, 5, 15, 0); // 5 Oct 2026, 3 p.m.
const day = (d, m = 9) => new Date(2026, m, d, 10, 0);

/* ===== 1) Shape: oldest first, ending with the current period ===== */
const empty = monthlyTrend([], { now, months: 12 });
assert.strictEqual(empty.length, 12);
assert.strictEqual(empty[11].label, "Oct");
assert.strictEqual(empty[0].label, "Nov", "twelve months back from October starts at last November");

const days = dailyTrend([], { now, days: 30 });
assert.strictEqual(days.length, 30);
assert.strictEqual(days[29].label, "Oct 5");
assert.strictEqual(days[0].label, "Sep 6", "thirty days crosses the month boundary cleanly");

/* ===== 2) Incoming by creation, resolved and spend by completion ===== */
const rows = [
  // raised in September, finished on Oct 3: incoming Sept, spend Oct 3
  { status: "completed", finalCost: 300, createdAt: day(28, 8), completedAt: day(3) },
  // raised and finished today
  { status: "completed", finalCost: 120, createdAt: day(5), completedAt: day(5) },
  // a zero-cost completion still counts as resolved
  { status: "completed", finalCost: 0, createdAt: day(5), completedAt: day(5) },
  // open: incoming only
  { status: "assigned", finalCost: 0, estimatedCost: 900, createdAt: day(4) },
  // completed without completedAt falls back to createdAt
  { status: "completed", finalCost: 50, createdAt: day(2) },
];

const daily = dailyTrend(rows, { now, days: 30 });
const at = (label) => daily.find((b) => b.label === label);
assert.deepStrictEqual(
  { r: at("Oct 5").requests, done: at("Oct 5").resolved, cost: at("Oct 5").cost },
  { r: 2, done: 2, cost: 120 }
);
assert.strictEqual(at("Oct 3").cost, 300, "spend lands on the completion day");
assert.strictEqual(at("Oct 3").requests, 0);
assert.strictEqual(at("Sep 28").requests, 1, "but the request counts where it was raised");
assert.strictEqual(at("Oct 4").cost, 0, "a quote on open work is never spend");
assert.strictEqual(at("Oct 2").cost, 50);

const monthly = monthlyTrend(rows, { now, months: 12 });
const oct = monthly[11];
const sep = monthly[10];
assert.deepStrictEqual({ r: oct.requests, done: oct.resolved, cost: oct.cost }, { r: 4, done: 4, cost: 470 });
assert.deepStrictEqual({ r: sep.requests, done: sep.resolved, cost: sep.cost }, { r: 1, done: 0, cost: 0 });

/* ===== 3) Rows outside the window are ignored, not clamped in ===== */
const old = dailyTrend([{ status: "completed", finalCost: 999, createdAt: day(1, 0), completedAt: day(2, 0) }], {
  now,
  days: 30,
});
assert.strictEqual(old.reduce((acc, b) => acc + b.cost + b.requests, 0), 0);

console.log("trendBuckets tests passed");
