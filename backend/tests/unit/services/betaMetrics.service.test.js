// The beta proof numbers: definitions pinned on fixtures.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * time-to-book is request -> FIRST vendor acceptance, split emergency/not,
//     and a request nobody accepted has no time (it is not zero);
//   * "autopilot" means a booked request with no landlord action before the
//     booking -- an action AFTER booking does not make it manual;
//   * GMV is payouts minus reversals, and deposits are never counted in it;
//   * a landlord whose beta is younger than N days is not yet eligible for the
//     DN mark -- not churned;
//   * the service-fee figures are zero, not an error, before the fee exists.

const assert = require("assert");
const m = require("../../../services/metrics/betaMetrics.service");

const at = (iso) => new Date(iso);

function main() {
  /* -------- 1) percentile is nearest-rank ------------------------------- */
  assert.strictEqual(m.percentile([], 50), null);
  assert.strictEqual(m.percentile([10], 75), 10);
  assert.strictEqual(m.percentile([10, 20, 30, 40], 50), 20);
  assert.strictEqual(m.percentile([40, 10, 30, 20], 75), 30, "input order does not matter");

  /* -------- 2) requests per month --------------------------------------- */
  const requests = [
    { _id: "r1", status: "completed", urgency: "medium", createdAt: at("2026-09-28T10:00:00Z"), completedAt: at("2026-10-02T10:00:00Z") },
    { _id: "r2", status: "assigned", urgency: "emergency", createdAt: at("2026-10-03T10:00:00Z") },
    { _id: "r3", status: "queued", urgency: "low", createdAt: at("2026-10-04T10:00:00Z") },
    { _id: "r4", status: "assigned", urgency: "medium", createdAt: at("2026-10-05T08:00:00Z") },
  ];
  const req = m.summarizeRequests(requests);
  assert.strictEqual(req.total, 4);
  assert.strictEqual(req.completed, 1);
  assert.deepStrictEqual(req.byMonth["2026-09"], { requests: 1 });
  assert.deepStrictEqual(req.byMonth["2026-10"], { requests: 3, emergencies: 1, completed: 1 });

  /* -------- 3) time to book --------------------------------------------- */
  const booked = new Map([
    ["r1", at("2026-09-28T12:00:00Z")], // 120 min
    ["r2", at("2026-10-03T10:30:00Z")], // 30 min, emergency
    ["r4", at("2026-10-05T14:00:00Z")], // 360 min
  ]);
  const ttb = m.summarizeTimeToBook(requests, booked);
  assert.strictEqual(ttb.count, 3, "r3 was never booked, so it has no time");
  assert.strictEqual(ttb.medianMinutes, 120);
  assert.strictEqual(ttb.p75Minutes, 360);
  assert.strictEqual(ttb.emergency.count, 1);
  assert.strictEqual(ttb.emergency.medianMinutes, 30);
  assert.strictEqual(ttb.nonEmergency.count, 2);

  // A booking dated before the request is bad data, never a negative time.
  const bad = m.summarizeTimeToBook(requests, new Map([["r1", at("2026-09-27T00:00:00Z")]]));
  assert.strictEqual(bad.count, 0);

  /* -------- 4) decisions avoided ---------------------------------------- */
  const actions = [
    { requestId: "r1", createdAt: at("2026-09-28T11:00:00Z") }, // before booking: a decision
    { requestId: "r1", createdAt: at("2026-09-28T11:30:00Z") },
    { requestId: "r2", createdAt: at("2026-10-03T11:00:00Z") }, // AFTER booking: not a decision
  ];
  const dec = m.summarizeDecisions(requests, booked, actions);
  assert.strictEqual(dec.bookedRequests, 3);
  assert.strictEqual(dec.autopilotRequests, 2, "r2 (action after booking) and r4 (none) ran on autopilot");
  assert.strictEqual(dec.autopilotPercent, 66.7);
  assert.strictEqual(dec.avgDecisionsPerBooked, 0.7);
  assert.strictEqual(m.summarizeDecisions([], new Map(), []).autopilotPercent, null, "nothing booked -> null, not 0%");

  /* -------- 5) approvals ------------------------------------------------ */
  const apr = m.summarizeApprovals([
    { type: "quota_increase", status: "approved" },
    { type: "quota_increase", status: "pending" },
    { type: "first_time_vendor", status: "approved" },
  ]);
  assert.deepStrictEqual(apr.byType, { quota_increase: 2, first_time_vendor: 1 });
  assert.deepStrictEqual(apr.byStatus, { approved: 2, pending: 1 });

  /* -------- 6) money: GMV excludes deposits ----------------------------- */
  const money = m.summarizeMoney([
    { type: "deposit", amountCents: 50000, createdAt: at("2026-09-20T00:00:00Z") },
    { type: "payout", amountCents: 12000, createdAt: at("2026-09-28T00:00:00Z") },
    { type: "payout", amountCents: 8000, createdAt: at("2026-10-02T00:00:00Z") },
    { type: "payout_reversal", amountCents: 2000, createdAt: at("2026-10-03T00:00:00Z") },
  ]);
  assert.strictEqual(money.gmvCents, 18000);
  assert.strictEqual(money.depositCents, 50000);
  assert.deepStrictEqual(money.byMonth["2026-10"], { payoutCents: 8000, reversalCents: 2000 });

  /* -------- 7) retention ------------------------------------------------ */
  const start = at("2026-07-01T00:00:00Z");
  const now = at("2026-10-09T00:00:00Z"); // 100 days in
  const kept = m.summarizeRetention({
    startedAt: start,
    activityDays: ["2026-07-01", "2026-07-30", "2026-08-29", "2026-09-28", "2026-09-28"],
    now,
  });
  assert.strictEqual(kept.activeDays, 4, "duplicate days collapse");
  assert.strictEqual(kept.marks.d30.retained, true, "active within the 7 days ending day 30");
  assert.strictEqual(kept.marks.d60.retained, true);
  assert.strictEqual(kept.marks.d90.retained, true);

  const lapsed = m.summarizeRetention({ startedAt: start, activityDays: ["2026-07-02"], now });
  assert.strictEqual(lapsed.marks.d30.eligible, true);
  assert.strictEqual(lapsed.marks.d30.retained, false);

  const young = m.summarizeRetention({ startedAt: at("2026-09-20T00:00:00Z"), activityDays: [], now });
  assert.deepStrictEqual(young.marks.d30, { eligible: false, retained: null }, "too young is not churned");

  // Edge of the window: day 30 ends 2026-07-31; the window is 07-25..07-31.
  const edge = m.summarizeRetention({ startedAt: start, activityDays: ["2026-07-24"], now });
  assert.strictEqual(edge.marks.d30.retained, false, "one day before the window does not count");
  const edgeIn = m.summarizeRetention({ startedAt: start, activityDays: ["2026-07-25"], now });
  assert.strictEqual(edgeIn.marks.d30.retained, true);

  /* -------- 8) satisfaction + service fee ------------------------------- */
  assert.deepStrictEqual(m.summarizeRatings([]), { count: 0, average: null });
  const rated = m.summarizeRatings([
    { tenantConfirmation: { rating: 5 } },
    { tenantConfirmation: { rating: 4 } },
    { tenantConfirmation: { rating: null } },
    {},
  ]);
  assert.deepStrictEqual(rated, { count: 2, average: 4.5 });

  assert.deepStrictEqual(m.summarizeServiceFee([{}, { ledger: {} }]), {
    jobs: 0, listedCents: 0, waivedCents: 0, chargedCents: 0, owedAtCloseCents: 0,
  });
  const fee = m.summarizeServiceFee([
    { ledger: { serviceFee: { listCents: 500, chargedCents: 0, waivedReason: "beta" } } },
    { ledger: { serviceFee: { listCents: 500, chargedCents: 500 } } },
    { ledger: { serviceFee: { listCents: 500, chargedCents: 500, owedCents: 200 } } },
  ]);
  assert.deepStrictEqual(fee, { jobs: 3, listedCents: 1500, waivedCents: 500, chargedCents: 1000, owedAtCloseCents: 200 });

  console.log("betaMetrics.service tests passed");
}

main();
