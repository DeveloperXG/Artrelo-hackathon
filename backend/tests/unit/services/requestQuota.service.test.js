// Daily / weekly request limits. Pins:
//   1. rolling windows: a request older than 24h stops counting today but still
//      counts this week; older than 7 days counts nowhere
//   2. at a limit, nextAvailableAt is when enough requests age out to free one
//      slot -- the later of the two windows when both are full
//   3. reserveSlot spends a slot under the limit and refuses (and leaves no
//      row behind) at it
//   4. two submits racing for the last slot cannot both win

const assert = require("assert");

delete process.env.REQUEST_DAILY_LIMIT;
delete process.env.REQUEST_WEEKLY_LIMIT;

// An in-memory ledger with monotonically increasing ids, like ObjectIds.
const RequestSubmission = require("../../../models/RequestSubmission");
let ledger = [];
let nextId = 1;
const pad = (n) => String(n).padStart(6, "0");
RequestSubmission.create = async (doc) => {
  const row = { ...doc, _id: pad(nextId++) };
  ledger.push(row);
  return row;
};
RequestSubmission.countDocuments = async (filter) =>
  ledger.filter(
    (row) => row.tenantId === filter.tenantId && row.at > filter.at.$gt && (!filter._id || row._id <= filter._id.$lte)
  ).length;
RequestSubmission.deleteOne = async ({ _id }) => {
  ledger = ledger.filter((row) => row._id !== _id);
};
RequestSubmission.find = (filter) => ({
  select: () => ({
    lean: async () => ledger.filter((row) => row.tenantId === filter.tenantId && row.at > filter.at.$gt),
  }),
});

const {
  DAY_MS,
  WEEK_MS,
  summarizeQuota,
  reserveSlot,
} = require("../../../services/request/requestQuota.service");

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-10-08T12:00:00Z");
const ago = (ms) => new Date(now.getTime() - ms);
const limits = { daily: 3, weekly: 7 };

async function main() {
  /* 1) rolling windows ---------------------------------------------------- */
  const mixed = summarizeQuota([ago(2 * HOUR), ago(30 * HOUR), ago(8 * 24 * HOUR)], now, limits);
  assert.strictEqual(mixed.daily.used, 1, "only the last 24 hours count today");
  assert.strictEqual(mixed.weekly.used, 2, "the 8-day-old one counts nowhere");
  assert.strictEqual(mixed.blocked, false);
  assert.strictEqual(mixed.nextAvailableAt, null);
  assert.strictEqual(mixed.daily.remaining, 2);

  /* 2) blocked: when the next slot frees ---------------------------------- */
  const dailyFull = summarizeQuota([ago(1 * HOUR), ago(3 * HOUR), ago(5 * HOUR)], now, limits);
  assert.strictEqual(dailyFull.blocked, true);
  assert.strictEqual(dailyFull.blockedBy, "daily");
  assert.strictEqual(
    dailyFull.nextAvailableAt.getTime(),
    ago(5 * HOUR).getTime() + DAY_MS,
    "the oldest of today's three ages out first"
  );

  // Seven this week, none today: the weekly window binds.
  const weekTimes = [1, 2, 3, 4, 5, 6].map((d) => ago(d * 24 * HOUR + HOUR)).concat([ago(26 * HOUR)]);
  const weeklyFull = summarizeQuota(weekTimes, now, limits);
  assert.strictEqual(weeklyFull.daily.used, 0);
  assert.strictEqual(weeklyFull.blockedBy, "weekly");
  assert.strictEqual(
    weeklyFull.nextAvailableAt.getTime(),
    ago(6 * 24 * HOUR + HOUR).getTime() + WEEK_MS,
    "the oldest of the week ages out first"
  );

  /* 3) reserveSlot --------------------------------------------------------- */
  ledger = [];
  const first = await reserveSlot({ tenantId: "t1", now });
  assert.strictEqual(first.allowed, true);
  await reserveSlot({ tenantId: "t1", now });
  await reserveSlot({ tenantId: "t1", now });
  assert.strictEqual(ledger.length, 3);
  const fourth = await reserveSlot({ tenantId: "t1", now });
  assert.strictEqual(fourth.allowed, false, "the fourth request today is refused");
  assert.strictEqual(fourth.quota.daily.used, 3);
  assert.strictEqual(ledger.length, 3, "a refused reservation leaves no row");
  const other = await reserveSlot({ tenantId: "t2", now });
  assert.strictEqual(other.allowed, true, "limits are per tenant");

  /* 4) the race for the last slot ----------------------------------------- */
  ledger = [];
  await reserveSlot({ tenantId: "t3", now });
  await reserveSlot({ tenantId: "t3", now });
  const [a, b] = await Promise.all([reserveSlot({ tenantId: "t3", now }), reserveSlot({ tenantId: "t3", now })]);
  assert.deepStrictEqual(
    [a.allowed, b.allowed].sort(),
    [false, true],
    "exactly one of two racing submits gets the last slot"
  );
  assert.strictEqual(ledger.filter((row) => row.tenantId === "t3").length, 3);

  /* env override ---------------------------------------------------------- */
  process.env.REQUEST_DAILY_LIMIT = "50";
  const raised = await reserveSlot({ tenantId: "t3", now });
  assert.strictEqual(raised.allowed, true, "the integration runner can raise the limits");
  delete process.env.REQUEST_DAILY_LIMIT;

  console.log("requestQuota.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
