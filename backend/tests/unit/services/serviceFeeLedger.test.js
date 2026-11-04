// The service fee MOVING MONEY: chargeServiceFee and applyServiceFee running
// the REAL ledger over in-memory models that enforce the same unique
// idempotencyKey and the same { $gte } guards as Mongo.
//
// THE RULES THIS FILE EXISTS TO PROTECT, each one a way the fee could quietly
// take money it should not, or lose track of money it did:
//
//   1. Charged once. A replay -- or the vendor path and the manual path
//      converging on one settlement -- never takes a second fee.
//   2. After the payout, out of what the payout left. The vendor has first claim.
//   3. NEVER AVOIDABLE, NEVER ARREARS. A wallet that cannot cover the fee
//      leaves the rest OWED (fees_owed), so keeping exactly a job's cost in the
//      wallet does not dodge it. And owed is its own account: fee debt in
//      arrears would be cancelled by the next hold release and shown to the
//      landlord as "a booking your balance doesn't cover".
//   3b. A top-up pays a vendor waiting on funds FIRST, then unpaid fees, then
//      booking shortfall.
//   4. The journal reproduces the cache after every step, including after a
//      lost race -- which is the one path where postEntry leaves the two
//      disagreeing unless the fee compensates.
//   5. A fee waived in the beta stays waived on a replay after the beta ends.
//   6. Nothing is recorded, posted or shown when no fee is configured.

const assert = require("assert");

const env = require("../../../config/env");
const LedgerEntry = require("../../../models/LedgerEntry");
const { linesBalance } = require("../../../models/LedgerEntry");
const LandlordLedger = require("../../../models/LandlordLedger");
const Landlord = require("../../../models/Landlord");
const JobCompletion = require("../../../models/JobCompletion");

const LANDLORD = "landlord-1";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-10T12:00:00.000Z");

let entries = [];
let ledgerRow = null;
let nextId = 1;
let landlordDoc = null;
let completions = [];
// Runs once, just before the next guarded cache update -- a concurrent spend
// landing between chargeServiceFee's read and its guarded write.
let interfere = null;

/* ---------------- Stubs ------------------------------------------------- */

const matches = (row, filter) =>
  Object.entries(filter).every(([key, cond]) => {
    const value = key.includes(".") ? key.split(".").reduce((o, k) => (o == null ? o : o[k]), row) : row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$lte" in cond) return (value || 0) <= cond.$lte;
      if ("$gte" in cond) return (value || 0) >= cond.$gte;
    }
    if (cond === null) return value === null || value === undefined;
    return String(value) === String(cond);
  });

LedgerEntry.create = async (doc) => {
  if (entries.some((e) => e.idempotencyKey === doc.idempotencyKey)) {
    throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  }
  if (!linesBalance(doc.lines)) throw new Error("ledger entry lines do not balance to zero");
  const seq = nextId++;
  const row = { _id: `e${seq}`, _seq: seq, balanceAfter: {}, createdAt: new Date(), fundedCents: 0, ...doc };
  entries.push(row);
  return row;
};
LedgerEntry.findOne = async (filter) => entries.find((e) => matches(e, filter)) || null;
LedgerEntry.updateOne = async (filter, update) => {
  const row = entries.find((e) => String(e._id) === String(filter._id));
  if (!row) return { modifiedCount: 0 };
  for (const [key, value] of Object.entries(update.$set || {})) {
    if (key.startsWith("balanceAfter.")) row.balanceAfter[key.split(".")[1]] = value;
    else row[key] = value;
  }
  return { modifiedCount: 1 };
};
LedgerEntry.find = (filter) => {
  const q = { select: () => q, sort: () => q, lean: async () => entries.filter((e) => matches(e, filter)) };
  return q;
};
LedgerEntry.findOneAndUpdate = async (filter, update) => {
  const row = entries.find((e) => matches(e, filter));
  if (!row) return null;
  for (const [key, delta] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + delta;
  Object.assign(row, update.$set || {});
  return { ...row };
};

LandlordLedger.findOne = async () => ledgerRow;
LandlordLedger.create = async (doc) => {
  ledgerRow = { available: 0, held: 0, arrears: 0, feesOwed: 0, lifetimeDeposited: 0, lifetimeReleased: 0, currency: "CAD", version: 0, ...doc };
  return ledgerRow;
};
LandlordLedger.findOneAndUpdate = async (filter, update) => {
  if (!ledgerRow) return null;
  if (interfere) {
    const run = interfere;
    interfere = null;
    run();
  }
  const { landlordId, ...guard } = filter;
  if (!matches(ledgerRow, guard)) return null;
  for (const [key, delta] of Object.entries(update.$inc || {})) ledgerRow[key] = (ledgerRow[key] || 0) + delta;
  return { ...ledgerRow };
};

const chain = (value) => {
  const q = { select: () => q, lean: async () => (value ? JSON.parse(JSON.stringify(value)) : value) };
  return q;
};
Landlord.findById = () => chain(landlordDoc);
let lockWrites = [];
let lockThrows = false;
Landlord.updateOne = async (filter, update) => {
  if (lockThrows) throw new Error("db down");
  const founding = landlordDoc?.foundingAgreement;
  const snapshot = founding?.terms?.serviceFee || {};
  // The guard the service sends: accepted, and the snapshot still all-zero.
  if (!founding?.acceptedAt || snapshot.flatCents > 0 || snapshot.percent > 0) return { modifiedCount: 0 };
  lockWrites.push(update.$set);
  founding.terms = { ...(founding.terms || {}), serviceFee: update.$set["foundingAgreement.terms.serviceFee"] };
  founding.feeLockedAt = update.$set["foundingAgreement.feeLockedAt"];
  return { modifiedCount: 1 };
};
JobCompletion.findById = (id) => chain(completions.find((c) => String(c._id) === String(id)) || null);
JobCompletion.updateOne = async (filter, update) => {
  const row = completions.find((c) => matches(c, filter));
  if (!row) return { matchedCount: 0 };
  row.ledger = row.ledger || {};
  row.ledger.serviceFee = update.$set["ledger.serviceFee"];
  return { matchedCount: 1 };
};

// Pin the rail; the Stripe-rail case opts in with deferUncovered: true.
const stripeConfig = require("../../../config/stripe");
stripeConfig.isConfigured = () => false;
stripeConfig.getStripe = () => null;

const { account, createHold, releaseHold, recordDeposit, chargeServiceFee } = require("../../../services/ledger/ledger.service");
const { applyServiceFee } = require("../../../services/ledger/serviceFee.service");
const { replayEntries } = require("../../../scripts/reconcileLedger");

/* ---------------- Helpers ----------------------------------------------- */

function assertJournalMatchesCache(label) {
  const replayed = replayEntries(entries, LANDLORD);
  assert.deepStrictEqual(
    { available: ledgerRow.available, held: ledgerRow.held, arrears: ledgerRow.arrears, feesOwed: ledgerRow.feesOwed || 0, bankOwed: ledgerRow.bankOwed || 0 },
    replayed,
    `${label}: the journal must reproduce the cache`
  );
  for (const e of entries) {
    assert.ok(linesBalance(e.lines), `${label}: ${e.idempotencyKey} balances`);
    const noBalanceAfter = e.balanceAfter?.available === undefined || e.balanceAfter?.available === null;
    assert.ok(!noBalanceAfter || e.shortfall, `${label}: ${e.idempotencyKey} has balanceAfter or is a marked shortfall`);
  }
}

const platformFeeTotal = () =>
  entries
    .flatMap((e) => e.lines)
    .filter((l) => l.account === account.fee())
    .reduce((t, l) => t + (l.direction === "debit" ? l.amountCents : -l.amountCents), 0);

const byKey = (key) => entries.find((e) => e.idempotencyKey === key) || null;

function setFees({ flat = "", percent = "", foundingFlat = "", foundingPercent = "" } = {}) {
  env.service_fee_cents = flat;
  env.service_fee_percent = percent;
  env.service_fee_founding_cents = foundingFlat;
  env.service_fee_founding_percent = foundingPercent;
}

const afterBeta = () => ({ _id: LANDLORD, beta: { status: "ended", startedAt: new Date(NOW - 70 * DAY), endsAt: new Date(NOW - DAY) } });
const inBeta = () => ({ _id: LANDLORD, beta: { status: "active", startedAt: new Date(NOW - 10 * DAY), endsAt: new Date(+NOW + 50 * DAY) } });

/**
 * A wallet, a $400 hold, and a close at `payoutCents` -- what closeJobCompletion
 * does up to step 9 -- then the fee, exactly as it is called there.
 */
async function closeJob({ walletCents = 100000, holdCents = 40000, payoutCents = 31200, deferUncovered = false, completionId = "comp-1", appointmentId = "appt-1" } = {}) {
  if (!ledgerRow) await LandlordLedger.create({ landlordId: LANDLORD });
  if (walletCents) {
    await recordDeposit({ landlordId: LANDLORD, amountCents: walletCents, idempotencyKey: `deposit:${completionId}` });
  }
  await createHold({ landlordId: LANDLORD, amountCents: holdCents, appointmentId, requestId: "req-1", identityId: "id-1" });
  if (!completions.some((c) => c._id === completionId)) completions.push({ _id: completionId, ledger: {} });
  const release = await releaseHold({
    landlordId: LANDLORD,
    appointmentId,
    completionId,
    requestId: "req-1",
    identityId: "id-1",
    heldCents: holdCents,
    payoutCents,
    deferUncovered,
  });
  const fee = await applyServiceFee({
    landlordId: LANDLORD,
    settlementId: completionId,
    payoutCents,
    completionId,
    requestId: "req-1",
    appointmentId,
    at: NOW,
  });
  return { release, fee };
}

function reset() {
  entries = [];
  ledgerRow = null;
  nextId = 1;
  completions = [];
  interfere = null;
  lockWrites = [];
  lockThrows = false;
  landlordDoc = afterBeta();
}

async function main() {
  const saved = ["service_fee_cents", "service_fee_percent", "service_fee_founding_cents", "service_fee_founding_percent"].map((k) => [k, env[k]]);
  const origWarn = console.warn;
  console.warn = () => {};

  try {
    /* -------- 1) Charged once, after the payout ----------------------- */
    reset();
    setFees({ flat: "500" });
    let { fee } = await closeJob();
    // $1000 wallet - $312 payout - $5 fee.
    assert.strictEqual(ledgerRow.available, 100000 - 31200 - 500);
    assert.strictEqual(ledgerRow.arrears, 0);
    assert.strictEqual(fee.chargedCents, 500);
    assert.strictEqual(fee.listCents, 500);
    const feeEntry = byKey("fee:comp-1");
    assert.ok(feeEntry, "posted under fee:<settlementId>");
    assert.strictEqual(feeEntry.type, "fee");
    assert.strictEqual(feeEntry.identityId ?? null, null, "a fee is never attributed to a vendor");
    assert.ok(feeEntry._seq > byKey("payout:comp-1")._seq, "the fee posts AFTER the payout");
    assert.strictEqual(platformFeeTotal(), 500, "and lands in platform:fee");
    assert.deepStrictEqual(completions[0].ledger.serviceFee.chargedCents, 500, "the decision is recorded on the completion");
    assertJournalMatchesCache("charged");

    // Replay: same completion, same settlement. Nothing moves.
    const before = { available: ledgerRow.available, entries: entries.length };
    fee = await applyServiceFee({ landlordId: LANDLORD, settlementId: "comp-1", payoutCents: 31200, completionId: "comp-1", at: NOW });
    assert.strictEqual(fee.replayed, true);
    assert.deepStrictEqual({ available: ledgerRow.available, entries: entries.length }, before, "a replay takes no second fee");

    // Even without the recorded decision (crash before it was written), the
    // ledger key stops a second charge.
    completions[0].ledger.serviceFee = null;
    fee = await applyServiceFee({ landlordId: LANDLORD, settlementId: "comp-1", payoutCents: 31200, completionId: "comp-1", at: NOW });
    assert.strictEqual(fee.chargedCents, 500);
    assert.deepStrictEqual({ available: ledgerRow.available, entries: entries.length }, before);
    assertJournalMatchesCache("replayed");

    /* -------- 2) Flat + percent --------------------------------------- */
    reset();
    setFees({ flat: "400", percent: "1.5" });
    ({ fee } = await closeJob());
    assert.strictEqual(fee.chargedCents, 400 + 468);
    assert.strictEqual(ledgerRow.available, 100000 - 31200 - 868);
    assertJournalMatchesCache("flat+percent");

    /* -------- 3) Waived in the beta, and stays waived ------------------- */
    reset();
    setFees({ flat: "500" });
    landlordDoc = inBeta();
    ({ fee } = await closeJob());
    assert.deepStrictEqual(
      [fee.listCents, fee.chargedCents, fee.waivedReason, fee.owedCents],
      [500, 0, "beta", 0],
      "listed, waived, and nothing owed"
    );
    assert.strictEqual(byKey("fee:comp-1"), null, "a waived fee posts NO ledger entry");
    assert.strictEqual(ledgerRow.available, 100000 - 31200);
    assert.strictEqual(completions[0].ledger.serviceFee.waivedReason, "beta", "the waiver is recorded -- it is the only trace");

    // The beta ends; something replays the close. The recorded decision wins.
    landlordDoc = afterBeta();
    fee = await applyServiceFee({ landlordId: LANDLORD, settlementId: "comp-1", payoutCents: 31200, completionId: "comp-1", at: new Date() });
    assert.strictEqual(fee.chargedCents, 0);
    assert.strictEqual(byKey("fee:comp-1"), null, "no fee is charged after the fact on a job closed in the beta");
    assertJournalMatchesCache("waived");

    /* -------- 4) The wallet cannot cover it: the rest is OWED ------------ */
    reset();
    setFees({ flat: "500" });
    // $315 in the wallet, a $312 job: $3 left for a $5 fee.
    ({ fee } = await closeJob({ walletCents: 31500, holdCents: 31200, payoutCents: 31200 }));
    assert.strictEqual(fee.chargedCents, 500, "billed in full");
    assert.strictEqual(fee.owedCents, 200, "the $2 the wallet could not cover is owed");
    assert.strictEqual(ledgerRow.available, 0);
    assert.strictEqual(ledgerRow.feesOwed, 200);
    assert.strictEqual(ledgerRow.arrears, 0, "owed fees are NEVER arrears");
    assert.strictEqual(platformFeeTotal(), 500, "platform:fee earns the whole fee");
    assertJournalMatchesCache("partial");

    // The next top-up pays it, and only the rest becomes spendable.
    await recordDeposit({ landlordId: LANDLORD, amountCents: 10000, idempotencyKey: "deposit:after-partial", fundingSource: "stripe" });
    assert.strictEqual(ledgerRow.feesOwed, 0, "the debt is paid");
    assert.strictEqual(ledgerRow.available, 10000 - 200);
    assert.ok(byKey("fee_settlement:deposit:after-partial"), "as its own settlement entry");
    assertJournalMatchesCache("partial, then paid");

    /* -------- 4b) THE EXPLOIT: keeping exactly a job's cost in the wallet -- */
    // A landlord who tops up exactly what each job costs must not avoid the fee.
    reset();
    setFees({ flat: "500" });
    ({ fee } = await closeJob({ walletCents: 31200, holdCents: 31200, payoutCents: 31200, completionId: "comp-a", appointmentId: "appt-a" }));
    assert.strictEqual(fee.owedCents, 500, "an exactly-funded job owes its whole fee");
    // The next job, funded exactly again: the top-up pays the old fee first, so
    // this job's booking is now $5 short -- the fee cannot be skipped.
    ({ fee } = await closeJob({ walletCents: 31200, holdCents: 31200, payoutCents: 31200, completionId: "comp-b", appointmentId: "appt-b" }));
    // Job B's exact top-up paid job A's $5 fee first, so job B came up $5 short:
    // the vendor is owed that $5 (arrears) and job B's own fee is owed too.
    assert.strictEqual(ledgerRow.feesOwed, 500, "job B's fee is owed");
    assert.strictEqual(ledgerRow.arrears, 500, "and the dodged $5 surfaces as money owed to the vendor");
    const billed = entries.filter((e) => e.type === "fee").reduce((t, e) => t + e.amountCents, 0);
    const paidDown = entries.filter((e) => e.type === "fee_settlement").reduce((t, e) => t + e.amountCents, 0);
    assert.strictEqual(billed, 1000, "both jobs billed");
    assert.strictEqual(ledgerRow.feesOwed + paidDown, 1000, "every cent billed is either paid or still owed -- none forgiven");
    assertJournalMatchesCache("exploit");

    /* -------- 5) Stripe rail, short wallet: the vendor first, fee owed ---- */
    reset();
    setFees({ flat: "500" });
    let release;
    ({ release, fee } = await closeJob({ walletCents: 20000, holdCents: 40000, payoutCents: 31200, deferUncovered: true }));
    assert.ok(release.deferred, "part of the vendor's payment is waiting on funds");
    assert.strictEqual(fee.chargedCents, 500);
    assert.strictEqual(fee.owedCents, 500, "nothing was left, so the whole fee is owed");
    assert.strictEqual(ledgerRow.arrears, release.uncoveredCents, "arrears is exactly the vendor's remainder -- no fee in it");
    assert.strictEqual(ledgerRow.feesOwed, 500);
    assertJournalMatchesCache("stripe short");

    // A top-up SMALLER than the vendor's remainder pays the vendor only.
    const remainder = release.uncoveredCents;
    await recordDeposit({ landlordId: LANDLORD, amountCents: remainder - 100, idempotencyKey: "deposit:small", fundingSource: "stripe" });
    assert.strictEqual(ledgerRow.feesOwed, 500, "a vendor still owed outranks the fee");
    assert.strictEqual(byKey("fee_settlement:deposit:small"), null);
    assertJournalMatchesCache("small deposit");

    // A bigger one finishes the vendor, THEN pays the fee.
    await recordDeposit({ landlordId: LANDLORD, amountCents: 20000, idempotencyKey: "deposit:late", fundingSource: "stripe" });
    assert.strictEqual(ledgerRow.arrears, 0, "the vendor's remainder is paid");
    assert.strictEqual(ledgerRow.feesOwed, 0, "then the fee");
    const vendorStep = entries.find((e) => e.idempotencyKey.startsWith("arrears_settlement:deposit:late:"));
    const feeStep = byKey("fee_settlement:deposit:late");
    assert.ok(vendorStep && feeStep && vendorStep._seq < feeStep._seq, "in that order");
    assert.strictEqual(ledgerRow.available, (remainder - 100) + 20000 - remainder - 500);
    assertJournalMatchesCache("after deposit");

    /* -------- 6) The race: a spend lands between the read and the guard -- */
    reset();
    setFees({ flat: "500" });
    await LandlordLedger.create({ landlordId: LANDLORD });
    await recordDeposit({ landlordId: LANDLORD, amountCents: 31500, idempotencyKey: "deposit:race" });
    await createHold({ landlordId: LANDLORD, amountCents: 31200, appointmentId: "appt-1", requestId: "req-1", identityId: "id-1" });
    completions.push({ _id: "comp-1", ledger: {} });
    await releaseHold({ landlordId: LANDLORD, appointmentId: "appt-1", completionId: "comp-1", requestId: "req-1", heldCents: 31200, payoutCents: 31200 });
    assert.strictEqual(ledgerRow.available, 300);

    // Something else spends $2 of the $3 just as the fee reads it.
    interfere = () => {
      ledgerRow.available -= 200;
      entries.push({
        _id: "concurrent",
        _seq: nextId++,
        idempotencyKey: "concurrent-spend",
        type: "adjustment",
        lines: [
          { account: account.available(LANDLORD), direction: "credit", amountCents: 200 },
          { account: "external:other", direction: "debit", amountCents: 200 },
        ],
        balanceAfter: { available: 100, held: 0 },
      });
    };
    fee = await applyServiceFee({ landlordId: LANDLORD, settlementId: "comp-1", payoutCents: 31200, completionId: "comp-1", at: NOW });
    assert.strictEqual(fee.chargedCents, 500, "the lost race still bills the fee");
    assert.strictEqual(fee.owedCents, 500, "as owed, since no balance can safely be read now");
    assert.strictEqual(ledgerRow.available, 100, "never overdrawn");
    assert.strictEqual(ledgerRow.feesOwed, 500);
    assert.ok(byKey("fee:comp-1").shortfall, "the stranded entry is marked, so reconcile does not read it as a crash");
    assert.ok(byKey("fee:comp-1:void"), "reversed");
    assert.ok(byKey("fee:comp-1:owed"), "and re-billed as owed");
    assert.strictEqual(platformFeeTotal(), 500, "platform:fee holds the fee exactly once");
    assertJournalMatchesCache("race");

    // A replay after the race reports the same outcome and moves nothing.
    completions[0].ledger.serviceFee = null;
    const n = entries.length;
    fee = await applyServiceFee({ landlordId: LANDLORD, settlementId: "comp-1", payoutCents: 31200, completionId: "comp-1", at: NOW });
    assert.strictEqual(fee.chargedCents, 500);
    assert.strictEqual(fee.owedCents, 500);
    assert.strictEqual(entries.length, n, "a replay after the race moves nothing");

    // A crash AFTER the reversal but BEFORE the re-bill resumes, not repeats.
    reset();
    setFees({ flat: "500" });
    await LandlordLedger.create({ landlordId: LANDLORD });
    await recordDeposit({ landlordId: LANDLORD, amountCents: 10000, idempotencyKey: "deposit:crash" });
    interfere = () => {
      ledgerRow.available -= 10000;
      entries.push({
        _id: "concurrent2",
        _seq: nextId++,
        idempotencyKey: "concurrent-spend-2",
        type: "adjustment",
        lines: [
          { account: account.available(LANDLORD), direction: "credit", amountCents: 10000 },
          { account: "external:other", direction: "debit", amountCents: 10000 },
        ],
        balanceAfter: { available: 0, held: 0 },
      });
    };
    // Simulate the crash: run the race, then delete the re-bill as if it never ran.
    await chargeServiceFee({ landlordId: LANDLORD, settlementId: "crash", amountCents: 500 });
    const rebill = byKey("fee:crash:owed");
    entries = entries.filter((e) => e !== rebill);
    ledgerRow.feesOwed -= 500;
    const resumed = await chargeServiceFee({ landlordId: LANDLORD, settlementId: "crash", amountCents: 500 });
    assert.strictEqual(resumed.owedCents, 500);
    assert.ok(byKey("fee:crash:owed"), "the re-bill is finished on the next call");
    assert.strictEqual(entries.filter((e) => e.idempotencyKey === "fee:crash:void").length, 1, "the reversal is not repeated");
    assertJournalMatchesCache("resumed race");

    /* -------- 7) Nothing configured: nothing anywhere ------------------- */
    reset();
    setFees({});
    ({ fee } = await closeJob());
    assert.strictEqual(fee, null);
    assert.strictEqual(byKey("fee:comp-1"), null);
    assert.strictEqual(completions[0].ledger.serviceFee, undefined, "no record, so no row is ever shown");
    assertJournalMatchesCache("unconfigured");

    /* -------- 8) The manual path and the vendor path converge ------------ */
    reset();
    setFees({ flat: "500" });
    await closeJob();
    const manual = await chargeServiceFee({ landlordId: LANDLORD, settlementId: "comp-1", amountCents: 500 });
    assert.strictEqual(manual.alreadyApplied, true, "the same settlementId finds the same fee");
    assert.strictEqual(entries.filter((e) => e.type === "fee").length, 1);

    /* -------- 9) The founding rate is what gets charged ----------------- */
    reset();
    setFees({ flat: "900" });
    landlordDoc = {
      ...afterBeta(),
      foundingAgreement: { acceptedAt: NOW, version: "v", terms: { serviceFee: { flatCents: 300, percent: 0 } } },
    };
    ({ fee } = await closeJob());
    assert.strictEqual(fee.chargedCents, 300);
    assert.strictEqual(fee.rateSource, "founding_locked");
    assertJournalMatchesCache("founding");

    /* -------- 10) A FLOATING founding rate is frozen at the first real charge */
    //
    // Accepted before any rate existed: the snapshot is 0/0, which promises
    // "today's founding rate, told in advance". Left floating, changing the
    // setting would change what they pay -- so "fixed" would be only a word.
    const founding00 = () => ({
      ...afterBeta(),
      foundingAgreement: { acceptedAt: NOW, version: "v", terms: { serviceFee: { flatCents: 0, percent: 0 }, planDiscountPercent: 0 } },
    });

    reset();
    setFees({ flat: "900", foundingFlat: "400" });
    landlordDoc = founding00();
    ({ fee } = await closeJob({ completionId: "lock-1", appointmentId: "appt-l1" }));
    assert.strictEqual(fee.chargedCents, 400, "charged at the current founding rate");
    assert.strictEqual(fee.rateSource, "founding");
    assert.strictEqual(lockWrites.length, 1, "and the rate was frozen onto their agreement");
    assert.deepStrictEqual(landlordDoc.foundingAgreement.terms.serviceFee, { flatCents: 400, percent: 0 });
    assert.ok(landlordDoc.foundingAgreement.feeLockedAt, "with a timestamp");
    assertJournalMatchesCache("locked");

    // The setting moves. Their rate does not.
    setFees({ flat: "900", foundingFlat: "700" });
    ({ fee } = await closeJob({ walletCents: 0, completionId: "lock-2", appointmentId: "appt-l2" }));
    assert.strictEqual(fee.chargedCents, 400, "still $4: the lock held");
    assert.strictEqual(fee.rateSource, "founding_locked");
    assert.strictEqual(lockWrites.length, 1, "nothing is re-locked");

    // Not frozen while the fee is WAIVED: nothing was charged, so nothing is
    // fixed yet -- the beta's whole point is that the rate is still to be set.
    reset();
    setFees({ flat: "900", foundingFlat: "400" });
    landlordDoc = { ...founding00(), beta: inBeta().beta };
    ({ fee } = await closeJob({ completionId: "lock-3", appointmentId: "appt-l3" }));
    assert.strictEqual(fee.waivedReason, "beta");
    assert.strictEqual(lockWrites.length, 0, "a waived fee freezes nothing");
    assert.deepStrictEqual(landlordDoc.foundingAgreement.terms.serviceFee, { flatCents: 0, percent: 0 });

    // An already-locked snapshot is never rewritten, and the guard means the
    // FIRST rate wins if two jobs close together.
    reset();
    setFees({ flat: "900", foundingFlat: "700" });
    landlordDoc = {
      ...afterBeta(),
      foundingAgreement: { acceptedAt: NOW, version: "v", terms: { serviceFee: { flatCents: 300, percent: 0 }, planDiscountPercent: 0 } },
    };
    ({ fee } = await closeJob({ completionId: "lock-4", appointmentId: "appt-l4" }));
    assert.strictEqual(fee.chargedCents, 300, "the snapshot wins over the current founding rate");
    assert.strictEqual(lockWrites.length, 0, "a locked snapshot is left alone");

    // A failed lock never undoes or blocks the charge.
    reset();
    setFees({ flat: "900", foundingFlat: "400" });
    landlordDoc = founding00();
    lockThrows = true;
    const realErr = console.error;
    console.error = () => {};
    ({ fee } = await closeJob({ completionId: "lock-5", appointmentId: "appt-l5" }));
    console.error = realErr;
    assert.strictEqual(fee.chargedCents, 400, "the fee is still billed");
    assert.ok(byKey("fee:lock-5"), "and still in the journal");
    assert.deepStrictEqual(landlordDoc.foundingAgreement.terms.serviceFee, { flatCents: 0, percent: 0 }, "just not frozen yet");
    assertJournalMatchesCache("lock failed");
    // ...so the next job freezes it.
    lockThrows = false;
    setFees({ flat: "900", foundingFlat: "400" });
    ({ fee } = await closeJob({ walletCents: 0, completionId: "lock-6", appointmentId: "appt-l6" }));
    assert.strictEqual(lockWrites.length, 1, "retried on the next charge");

    // A founding landlord with NO founding rate set is charged the LIST rate --
    // almost certainly a forgotten deploy setting -- so it is flagged loudly.
    reset();
    setFees({ flat: "900", foundingFlat: "" });
    landlordDoc = founding00();
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (m) => warnings.push(String(m));
    ({ fee } = await closeJob({ completionId: "lock-7", appointmentId: "appt-l7" }));
    console.warn = realWarn;
    assert.strictEqual(fee.rateSource, "list");
    assert.strictEqual(fee.chargedCents, 900);
    assert.ok(warnings.some((w) => /founding landlord .* LIST rate/.test(w)), "the misconfiguration is logged");
    assert.strictEqual(lockWrites.length, 0, "and nothing is frozen at a list rate");

    // An ordinary landlord at the list rate: no warning, no lock.
    reset();
    setFees({ flat: "900" });
    const quiet = [];
    console.warn = (m) => quiet.push(String(m));
    ({ fee } = await closeJob({ completionId: "lock-8", appointmentId: "appt-l8" }));
    console.warn = realWarn;
    assert.ok(!quiet.some((w) => /LIST rate/.test(w)), "no false alarm for an ordinary landlord");
  } finally {
    for (const [k, v] of saved) env[k] = v;
    console.warn = origWarn;
  }

  console.log("serviceFee ledger tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
