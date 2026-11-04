// The wallet statement is paged on the server.
//
// Paging is easy to get subtly wrong here because the statement is not the
// journal: a completed job's hold_release is folded into its payout as
// "returnedToBalance". So:
//   - folded releases must not count toward pages or the total, or pages come
//     back short and the last page is empty;
//   - a payout must still fold against its release and its sibling payouts
//     when those sit on a different page;
//   - totals the page can't see (external deposits, unsettled payouts) must be
//     summed over the whole journal, not the page.

const assert = require("assert");

const LedgerEntry = require("../../../models/LedgerEntry");
const JobCompletion = require("../../../models/JobCompletion");
const Landlord = require("../../../models/Landlord");
const env = require("../../../config/env");
const LandlordLedger = require("../../../models/LandlordLedger");

const LANDLORD = "landlord-1";
const AVAILABLE = `landlord:${LANDLORD}:available`;

// Chronological, oldest first, as written.
let entries = [];
let n = 0;
const at = (minutes) => new Date(Date.UTC(2026, 8, 1, 0, minutes));
const add = (row) => {
  n += 1;
  entries.push({ _id: `e${String(n).padStart(3, "0")}`, landlordId: LANDLORD, createdAt: at(n), ...row });
};

const getPath = (row, path) => path.split(".").reduce((value, key) => (value == null ? value : value[key]), row);
const matchesFilter = (row, filter = {}) =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === "landlordId") return true;
    if (key === "$nor") return !cond.some((sub) => matchesFilter(row, sub));
    const value = getPath(row, key);
    if (cond && typeof cond === "object" && "$gt" in cond) return value != null && value > cond.$gt;
    if (cond && typeof cond === "object" && "$in" in cond) return cond.$in.map(String).includes(String(value));
    if (cond && typeof cond === "object" && "$ne" in cond) return (value ?? null) !== cond.$ne;
    if (cond && typeof cond === "object" && "$regex" in cond) return cond.$regex.test(String(value ?? ""));
    return String(value) === String(cond);
  });

LedgerEntry.find = (filter) => {
  let skip = 0;
  let limit = Infinity;
  const chain = {
    populate: () => chain,
    select: () => chain,
    sort: () => chain,
    skip: (k) => {
      skip = k;
      return chain;
    },
    limit: (k) => {
      limit = k;
      return chain;
    },
    // Newest first, like sort({ createdAt: -1, _id: -1 }).
    lean: async () =>
      [...entries]
        .reverse()
        .filter((e) => matchesFilter(e, filter))
        .slice(skip, skip + limit),
  };
  return chain;
};
LedgerEntry.countDocuments = async (filter) => entries.filter((e) => matchesFilter(e, filter)).length;
LandlordLedger.findOne = async () => ({
  _id: "l1",
  available: 100000,
  held: 0,
  arrears: 0,
  lifetimeDeposited: 0,
  lifetimeReleased: 0,
  currency: "CAD",
});

// The landlord record behind the quiet founding-fee line (null = no such landlord).
let landlordDoc = null;
let landlordLookupFails = false;
Landlord.findById = () => ({
  select: () => ({
    lean: async () => {
      if (landlordLookupFails) throw new Error("mongo down");
      return landlordDoc;
    },
  }),
});

// The service-fee decision per completion (only the fee section below sets any).
let feeRecords = [];
JobCompletion.find = (filter) => {
  const ids = (filter._id?.$in || []).map(String);
  const chain = {
    select: () => chain,
    lean: () => chain,
    then: (resolve, reject) =>
      Promise.resolve(feeRecords.filter((r) => ids.includes(String(r._id)))).then(resolve, reject),
  };
  return chain;
};

const ctrl = require("../../../controllers/ledger.controller");

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}
const get = async (query = {}) => {
  const res = makeRes();
  await ctrl.getLedger({ user: { id: LANDLORD }, query }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.data;
};

const run = async () => {
  /* ---- The journal ---- */
  // 3 external transfers and 2 card top-ups.
  add({ type: "deposit", fundingSource: "external", amountCents: 10000 }); // e001
  add({ type: "deposit", fundingSource: "external", amountCents: 20000 }); // e002
  add({ type: "deposit", fundingSource: "stripe", amountCents: 50000 }); // e003
  // A job: reserved 400, completed for 300 across two payouts (sent now + the
  // deferred remainder), the release putting all 400 back to available.
  add({ type: "hold", amountCents: 40000 }); // e004
  add({
    type: "hold_release",
    completionId: "c1",
    amountCents: 40000,
    lines: [{ account: AVAILABLE, direction: "debit", amountCents: 40000 }],
  }); // e005 — folded, never a row
  add({ type: "payout", completionId: "c1", amountCents: 20000, providerStatus: "paid" }); // e006
  add({ type: "deposit", fundingSource: "external", amountCents: 5000 }); // e007
  add({ type: "payout", completionId: "c1", amountCents: 10000, providerStatus: "pending_manual" }); // e008
  // A release with no completion is not folded and stays a row.
  add({ type: "hold_release", completionId: null, amountCents: 1500 }); // e009
  add({ type: "refund", amountCents: 700 }); // e010
  add({ type: "hold_void", amountCents: 900 }); // e011
  add({ type: "deposit", fundingSource: "stripe", amountCents: 3000 }); // e012

  /* ===== 1) The total and pages describe statement rows, not journal rows ===== */
  const first = await get({ limit: "4" });
  assert.strictEqual(first.pagination.total, 11, "12 journal rows, one folded release");
  assert.strictEqual(first.pagination.totalPages, 3);
  assert.deepStrictEqual(
    first.entries.map((e) => e.id),
    ["e012", "e011", "e010", "e009"],
    "newest first, and the unfolded release is a row"
  );

  const last = await get({ limit: "4", page: "3" });
  assert.deepStrictEqual(last.entries.map((e) => e.id), ["e003", "e002", "e001"], "the last page is not short-changed");

  /* ===== 2) Folding works across a page boundary ===== */
  // Page 2 holds e008 (newest payout) and e006 (older payout); the release
  // e005 is folded away. With 2 per page the payouts land on different pages.
  const p3 = await get({ limit: "2", page: "3" });
  assert.deepStrictEqual(p3.entries.map((e) => e.id), ["e008", "e007"]);
  assert.strictEqual(p3.entries[0].returnedToBalance, 100, "400 released − 300 paid, though e006 is on another page");

  const p4 = await get({ limit: "2", page: "4" });
  assert.deepStrictEqual(p4.entries.map((e) => e.id), ["e006", "e004"]);
  assert.strictEqual(p4.entries[0].returnedToBalance, undefined, "said once, on the newest payout only");

  /* ===== 3) Kind filters ===== */
  const added = await get({ kind: "added" });
  assert.deepStrictEqual(added.entries.map((e) => e.type), ["deposit", "deposit", "deposit", "deposit", "deposit"]);
  const paid = await get({ kind: "paid" });
  assert.deepStrictEqual(paid.entries.map((e) => e.id), ["e008", "e006"]);
  assert.strictEqual(paid.entries[0].returnedToBalance, 100, "folding holds under a filter too");
  const refunded = await get({ kind: "refunded" });
  assert.deepStrictEqual(refunded.entries.map((e) => e.id), ["e011", "e010"]);
  const held = await get({ kind: "held" });
  assert.deepStrictEqual(held.entries.map((e) => e.id), ["e004"]);
  const unknown = await get({ kind: "nonsense" });
  assert.strictEqual(unknown.pagination.kind, "all", "an unknown kind falls back to everything");

  /* ===== 4) Paging parameters are clamped ===== */
  assert.strictEqual((await get()).pagination.limit, 20, "default page size");
  assert.strictEqual((await get({ limit: "999" })).pagination.limit, 50, "capped");
  const pastEnd = await get({ limit: "4", page: "99" });
  assert.strictEqual(pastEnd.pagination.page, 3, "a page past the end shows the last page");
  assert.ok(pastEnd.entries.length > 0);

  /* ===== 5) Whole-journal totals don't depend on the page ===== */
  const tiny = await get({ limit: "1" });
  assert.strictEqual(tiny.externalDeposits, 350, "every external transfer, not just the visible one");
  assert.strictEqual(tiny.pendingPayouts, 100, "the unsettled payout, wherever it sits");

  /* ===== 6) The service fee on the statement ===== */
  // A fresh journal: two completed jobs. c1 closed during the beta (fee
  // waived, so NO fee entry); c2 after it (fee charged, its own row). Then a
  // fee that lost its race -- written and reversed -- which must not show.
  entries = [];
  n = 0;
  add({ type: "deposit", fundingSource: "stripe", amountCents: 100000 }); // e001
  add({ type: "hold_release", completionId: "c1", amountCents: 40000, lines: [{ account: AVAILABLE, direction: "debit", amountCents: 40000 }] }); // e002
  add({ type: "payout", completionId: "c1", amountCents: 31200, providerStatus: "paid" }); // e003
  add({ type: "hold_release", completionId: "c2", amountCents: 40000, lines: [{ account: AVAILABLE, direction: "debit", amountCents: 40000 }] }); // e004
  add({ type: "payout", completionId: "c2", amountCents: 31200, providerStatus: "paid" }); // e005
  add({ type: "fee", completionId: "c2", amountCents: 500, idempotencyKey: "fee:c2" }); // e006
  add({ type: "fee", completionId: "c3", amountCents: 500, idempotencyKey: "fee:c3", shortfall: true }); // e007 hidden
  add({ type: "refund", completionId: "c3", amountCents: 500, idempotencyKey: "fee:c3:void" }); // e008 hidden
  add({ type: "refund", amountCents: 700, idempotencyKey: "refund:something-else" }); // e009 an ordinary refund
  feeRecords = [
    { _id: "c1", ledger: { serviceFee: { listCents: 500, chargedCents: 0, waivedReason: "beta", owedCents: 0 } } },
    { _id: "c2", ledger: { serviceFee: { listCents: 500, chargedCents: 500, waivedReason: null, owedCents: 0 } } },
  ];

  const fees = await get();
  const ids = fees.entries.map((e) => e.id);
  assert.ok(!ids.includes("e007") && !ids.includes("e008"), "a lost-race fee and its reversal never reach the landlord");
  assert.ok(ids.includes("e009"), "an ordinary refund still shows");
  assert.strictEqual(fees.pagination.total, 5, "and the hidden pair does not count toward the pages");

  const feeRow = fees.entries.find((e) => e.id === "e006");
  assert.strictEqual(feeRow.title, "Artrelo service fee");
  assert.strictEqual(feeRow.direction, "out");
  assert.strictEqual(feeRow.amount, 5);

  const waivedPayout = fees.entries.find((e) => e.id === "e003");
  assert.deepStrictEqual(
    waivedPayout.serviceFee,
    { amount: 5, charged: 0, waived: "beta", owed: 0 },
    "the waived fee is said on its payout -- there is no other trace of it"
  );
  assert.deepStrictEqual(fees.entries.find((e) => e.id === "e005").serviceFee, { amount: 5, charged: 5, waived: null, owed: 0 });

  // Filtered views hide the race pair too.
  const refundedOnly = await get({ kind: "refunded" });
  assert.deepStrictEqual(refundedOnly.entries.map((e) => e.id), ["e009"]);

  // The annotation is a nicety: if its lookup fails, the statement still loads.
  const origFind = JobCompletion.find;
  JobCompletion.find = () => ({
    select: () => ({ lean: () => ({ then: (_r, reject) => Promise.reject(new Error("mongo down")).then(_r, reject) }) }),
  });
  const origErr = console.error;
  console.error = () => {};
  const degraded = await get();
  console.error = origErr;
  JobCompletion.find = origFind;
  assert.strictEqual(degraded.entries.find((e) => e.id === "e003").serviceFee, undefined);
  assert.ok(degraded.entries.find((e) => e.id === "e006"), "the charged fee row does not depend on it");

  /* ===== 7) The quiet founding-fee line ===== */
  //
  // Only a FOUNDING landlord with a real founding rate has anything true to say,
  // and only once the beta is over. Everyone else's wallet is untouched.
  const DAY = 24 * 60 * 60 * 1000;
  const saved = [env.service_fee_cents, env.service_fee_percent, env.service_fee_founding_cents, env.service_fee_founding_percent];
  const setFees = ({ list = "", founding = "", foundingPct = "" } = {}) => {
    env.service_fee_cents = list;
    env.service_fee_percent = "";
    env.service_fee_founding_cents = founding;
    env.service_fee_founding_percent = foundingPct;
  };
  const inBeta = { startedAt: new Date(Date.now() - 10 * DAY), endsAt: new Date(Date.now() + 30 * DAY) };
  const pastBeta = { startedAt: new Date(Date.now() - 70 * DAY), endsAt: new Date(Date.now() - DAY) };
  const since = new Date("2026-10-11T12:00:00.000Z");
  const founding = (terms) => ({ acceptedAt: since, version: "v", terms: { serviceFee: terms, planDiscountPercent: 0 } });
  const realErr = console.error;

  try {
    // An ordinary landlord: nothing at all.
    setFees({ list: "500" });
    landlordDoc = { beta: pastBeta };
    assert.strictEqual((await get()).foundingFee, null, "ordinary wallets are untouched");
    let line = (await get()).serviceFeeLine;
    assert.deepStrictEqual([line.kind, line.rate.description], ["list", "$5.00 per completed job"], "but every landlord sees their fee");
    landlordDoc = { beta: inBeta };
    line = (await get()).serviceFeeLine;
    assert.strictEqual(line.kind, "waived");
    assert.strictEqual(new Date(line.waivedUntil).toISOString(), inBeta.endsAt.toISOString());
    assert.strictEqual(line.rate.description, "$5.00 per completed job", "and what comes after the beta");
    landlordDoc = null;
    assert.strictEqual((await get()).foundingFee, null, "a landlord that cannot be found says nothing");
    assert.strictEqual((await get()).serviceFeeLine, null);

    // Founding, beta over, locked rate: the line, worded by the one shared helper.
    setFees({ list: "900" });
    landlordDoc = { beta: pastBeta, foundingAgreement: founding({ flatCents: 400, percent: 1.5 }) };
    let ff = (await get()).foundingFee;
    assert.strictEqual(ff.founding, true);
    assert.strictEqual(ff.betaEnded, true);
    assert.strictEqual(ff.locked, true);
    assert.strictEqual(ff.declined, false);
    assert.strictEqual(ff.rate.description, "$4.00 per completed job plus 1.5% of the job payout");
    assert.deepStrictEqual([ff.rate.flat, ff.rate.percent], [4, 1.5], "dollars, like every other figure in this payload");
    assert.strictEqual(new Date(ff.since).toISOString(), since.toISOString());
    line = (await get()).serviceFeeLine;
    assert.deepStrictEqual([line.kind, line.locked], ["founding", true]);
    assert.strictEqual(line.rate.description, ff.rate.description, "the two fields never disagree");

    // Still in the beta: the payload is there but says the beta is not over, so
    // the page stays quiet (the per-row "waived" note covers it).
    landlordDoc = { beta: inBeta, foundingAgreement: founding({ flatCents: 400, percent: 0 }) };
    ff = (await get()).foundingFee;
    assert.strictEqual(ff.betaEnded, false);
    assert.strictEqual(ff.rate.description, "$4.00 per completed job");

    // Accepted before any rate existed (0/0) and a founding rate is NOW set: the
    // rate is real but still floating until their first charge freezes it.
    setFees({ list: "900", founding: "250" });
    landlordDoc = { beta: pastBeta, foundingAgreement: founding({ flatCents: 0, percent: 0 }) };
    ff = (await get()).foundingFee;
    assert.strictEqual(ff.rate.description, "$2.50 per completed job");
    assert.strictEqual(ff.locked, false, "a floating rate is not reported as locked");

    // Accepted at 0/0 and NO founding rate set: nothing true to say -- and NOT
    // the list rate, which is not a founding fee.
    setFees({ list: "900" });
    landlordDoc = { beta: pastBeta, foundingAgreement: founding({ flatCents: 0, percent: 0 }) };
    ff = (await get()).foundingFee;
    assert.strictEqual(ff.founding, true);
    assert.strictEqual(ff.rate, null, "no founding rate -> no founding fee line");

    // Declined: no label, no rate, but the "review it" link needs to know.
    landlordDoc = { beta: pastBeta, foundingAgreement: { declinedAt: since } };
    ff = (await get()).foundingFee;
    assert.deepStrictEqual([ff.founding, ff.declined, ff.rate], [false, true, null]);

    // An open offer (neither accepted nor declined) is not a founding landlord.
    landlordDoc = { beta: inBeta };
    assert.strictEqual((await get()).foundingFee, null);

    // A failing lookup never takes the statement down.
    landlordDoc = { beta: pastBeta, foundingAgreement: founding({ flatCents: 400, percent: 0 }) };
    landlordLookupFails = true;
    console.error = () => {};
    const degraded = await get();
    console.error = realErr;
    landlordLookupFails = false;
    assert.strictEqual(degraded.foundingFee, null, "best-effort, like the low-funds banner");
    assert.strictEqual(degraded.serviceFeeLine, null);
    assert.ok(degraded.entries.length > 0, "and the statement still loads");
  } finally {
    console.error = realErr;
    [env.service_fee_cents, env.service_fee_percent, env.service_fee_founding_cents, env.service_fee_founding_percent] = saved;
    landlordDoc = null;
  }

  console.log("ledgerStatement paging tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
