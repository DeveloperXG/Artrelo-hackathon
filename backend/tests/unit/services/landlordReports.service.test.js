// Reports must never disagree with the dashboard: spend is the final cost of
// work COMPLETED in the range, incoming is counted by creation, and the
// comparison is the equally long period just before.

const assert = require("assert");
const {
  parseRange,
  previousPeriod,
  summarizeReport,
} = require("../../../services/reports/landlordReports.service");

const d = (month, day, hour = 12) => new Date(2026, month - 1, day, hour);

/* ===== 1) Range parsing ===== */
{
  const now = new Date(2026, 9, 5, 15);
  const fallback = parseRange({}, now);
  assert.deepStrictEqual(fallback.from, new Date(2026, 9, 1), "defaults to the start of this month");
  assert.deepStrictEqual(fallback.to, now, "…through now");

  const explicit = parseRange({ from: "2026-09-01", to: "2026-09-30" }, now);
  assert.deepStrictEqual(explicit.from, new Date(2026, 8, 1));
  assert.strictEqual(explicit.to.getDate(), 30);
  assert.strictEqual(explicit.to.getHours(), 23, "the end date is inclusive — the whole day");

  assert.throws(() => parseRange({ from: "2026-10-05", to: "2026-10-01" }, now), (e) => e.field === "from");
  assert.throws(() => parseRange({ from: "not-a-date" }, now), (e) => e.field === "from" && e.status === 400);
  assert.throws(() => parseRange({ from: "2020-01-01", to: "2026-01-01" }, now), /three years/);
}

/* ===== 2) The comparison period is the same length, immediately before ===== */
{
  const range = { from: d(10, 1, 0), to: new Date(2026, 9, 31, 23, 59, 59, 999) };
  const prev = previousPeriod(range);
  assert.strictEqual(prev.to.getTime(), range.from.getTime() - 1);
  assert.strictEqual(prev.to - prev.from, range.to - range.from);
}

/* ===== 3) Totals, by the dashboard's definitions ===== */
const range = { from: new Date(2026, 9, 1), to: new Date(2026, 9, 31, 23, 59, 59, 999) };
const rows = [
  // completed in range: counts as spend and completed; raised in September
  { _id: "r1", status: "completed", category: "Plumbing", finalCost: 300, createdAt: d(9, 28), completedAt: d(10, 2), propertyId: "p1", selectedVendorId: "v1" },
  // completed in range, zero cost is real
  { _id: "r2", status: "completed", category: "Plumbing", finalCost: 0, createdAt: d(10, 3), completedAt: d(10, 4), propertyId: "p1", selectedVendorId: "v1" },
  // completed in range, other property and vendor
  { _id: "r3", status: "completed", category: "HVAC", finalCost: 500, createdAt: d(10, 5), completedAt: d(10, 9), propertyId: "p2", vendorId: "v2" },
  // open with a quote: incoming only, never spend
  { _id: "r4", status: "assigned", category: "Electrical", finalCost: 0, estimatedCost: 900, createdAt: d(10, 10), propertyId: "p2" },
  // completed LAST period: comparison only
  { _id: "r5", status: "completed", category: "Plumbing", finalCost: 200, createdAt: d(9, 10), completedAt: d(9, 12), propertyId: "p1", selectedVendorId: "v1" },
];
const report = summarizeReport(rows, range, { ratingsByRequest: new Map([["r1", 5], ["r2", 3]]) });

assert.deepStrictEqual(report.totals, {
  spend: 800,
  completed: 3,
  incoming: 3, // r2, r3, r4 — r1 was raised in September
  avgResolutionDays: 3, // (4 + 1 + 4) / 3
  avgCostPerJob: 266.67,
});
assert.strictEqual(report.previousTotals.spend, 200, "September's job is the comparison, not this period");
assert.strictEqual(report.previousTotals.completed, 1);

/* ===== 4) Breakdowns ===== */
assert.deepStrictEqual(report.byCategory, { Plumbing: 1, HVAC: 1, Electrical: 1 }, "categories of requests raised in range");
assert.deepStrictEqual(report.spendByProperty, [
  { propertyId: "p2", spend: 500 },
  { propertyId: "p1", spend: 300 },
]);

const v1 = report.vendorPerformance.find((row) => row.vendorId === "v1");
assert.deepStrictEqual(
  { jobs: v1.jobs, spend: v1.spend, avgRating: v1.avgRating, ratingCount: v1.ratingCount, avgResolutionDays: v1.avgResolutionDays },
  { jobs: 2, spend: 300, avgRating: 4, ratingCount: 2, avgResolutionDays: 2.5 },
  "selectedVendorId counts, last period's job does not"
);
const v2 = report.vendorPerformance.find((row) => row.vendorId === "v2");
assert.strictEqual(v2.jobs, 1, "falls back to vendorId when nothing was selected");
assert.strictEqual(v2.avgRating, null, "no rating given, no rating invented");
assert.strictEqual(report.vendorPerformance[0].vendorId, "v1", "busiest vendor first");

/* ===== 5) The trend agrees with the totals ===== */
assert.strictEqual(report.range.unit, "day", "a month is charted by day");
const trendSpend = report.trend.reduce((acc, b) => acc + b.cost, 0);
const trendIncoming = report.trend.reduce((acc, b) => acc + b.requests, 0);
assert.strictEqual(trendSpend, report.totals.spend);
assert.strictEqual(trendIncoming, report.totals.incoming);

/* ===== 6) Monthly charting clips the first and last month to the range ===== */
{
  const long = { from: new Date(2026, 3, 15), to: new Date(2026, 9, 10, 23, 59) }; // Apr 15 – Oct 10
  const sample = [
    { _id: "a", status: "completed", finalCost: 100, createdAt: d(4, 2), completedAt: d(4, 3) }, // before the range
    { _id: "b", status: "completed", finalCost: 50, createdAt: d(4, 20), completedAt: d(4, 21) }, // inside April
  ];
  const monthly = summarizeReport(sample, long);
  assert.strictEqual(monthly.range.unit, "month");
  assert.strictEqual(monthly.trend[0].label, "Apr");
  assert.strictEqual(monthly.trend[0].cost, 50, "the 2nd of April is outside a range starting the 15th");
  assert.strictEqual(monthly.trend[0].requests, 1);
  assert.strictEqual(monthly.trend.at(-1).label, "Oct");
}

/* ===== 7) Empty is zeros and nulls, never NaN ===== */
{
  const empty = summarizeReport([], range);
  assert.deepStrictEqual(empty.totals, { spend: 0, completed: 0, incoming: 0, avgResolutionDays: null, avgCostPerJob: null });
  assert.deepStrictEqual(empty.vendorPerformance, []);
}

console.log("landlordReports service tests passed");
