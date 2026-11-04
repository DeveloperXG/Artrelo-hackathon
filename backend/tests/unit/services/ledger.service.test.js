// Money movement.
//
// Three properties carry the whole design and each has a test that would fail
// loudly if it regressed:
//
//  1. The same idempotency key posts ONCE. This is the anti-double-pay guard;
//     everything else is bookkeeping.
//  2. Every entry's lines sum to zero, so the balance is derivable from the
//     journal and the cache is only ever a cache.
//  3. A spend past the balance FAILS THE GUARD rather than going negative. A
//     negative `available` silently breaks every { $gte } guard downstream.

const assert = require("assert");

const LedgerEntry = require("../../../models/LedgerEntry");
const { linesBalance } = require("../../../models/LedgerEntry");
const LandlordLedger = require("../../../models/LandlordLedger");

const LANDLORD = "landlord-1";
const APPT = "appt-1";
const COMPLETION = "comp-1";

let entries = [];
let ledgerRow = null;
let nextId = 1;

/* ---------------- Stubs: an in-memory collection that enforces the same
 * unique index and the same conditional-update semantics as Mongo. --------- */

LedgerEntry.create = async (doc) => {
  if (entries.some((e) => e.idempotencyKey === doc.idempotencyKey)) {
    const err = new Error("E11000 duplicate key");
    err.code = 11000;
    throw err;
  }
  // Mirror the pre-validate hook: a non-balancing entry must never persist.
  if (!linesBalance(doc.lines)) throw new Error("ledger entry lines do not balance to zero");
  const seq = nextId++;
  const row = { _id: `e${seq}`, _seq: seq, balanceAfter: {}, createdAt: new Date(), fundedCents: 0, ...doc };
  entries.push(row);
  return row;
};
LedgerEntry.findOne = async (filter) =>
  entries.find((e) =>
    Object.entries(filter).every(([k, v]) => String(e[k]) === String(v))
  ) || null;
LedgerEntry.updateOne = async (filter, update) => {
  const row = entries.find((e) => String(e._id) === String(filter._id));
  if (!row) return { modifiedCount: 0 };
  for (const [key, value] of Object.entries(update.$set || {})) {
    if (key.startsWith("balanceAfter.")) row.balanceAfter[key.split(".")[1]] = value;
    else row[key] = value;
  }
  return { modifiedCount: 1 };
};

// Equality-only filter matching, plus the one operator the service uses.
const matches = (row, filter) =>
  Object.entries(filter).every(([key, cond]) => {
    if (cond && typeof cond === "object" && "$lte" in cond) return (row[key] || 0) <= cond.$lte;
    return String(row[key]) === String(cond);
  });

// find() returns a chainable query; every link resolves to the same rows.
LedgerEntry.find = (filter) => {
  const rows = () =>
    entries.filter((e) => matches(e, filter)).sort((a, b) => a.createdAt - b.createdAt || a._seq - b._seq);
  const query = { select: () => query, sort: () => query, lean: async () => rows() };
  return query;
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
  ledgerRow = {
    _id: "ledger-1",
    available: 0,
    held: 0,
    arrears: 0,
    lifetimeDeposited: 0,
    lifetimeReleased: 0,
    currency: "CAD",
    version: 0,
    ...doc,
  };
  return ledgerRow;
};
LandlordLedger.findOneAndUpdate = async (filter, update) => {
  if (!ledgerRow) return null;
  // THE GUARD. This is the behaviour under test: the conditional and the
  // decrement are one operation, so there is no check-then-spend window.
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "landlordId") continue;
    if (cond && typeof cond === "object" && "$gte" in cond) {
      if ((ledgerRow[key] || 0) < cond.$gte) return null;
    }
  }
  for (const [key, delta] of Object.entries(update.$inc || {})) {
    ledgerRow[key] = (ledgerRow[key] || 0) + delta;
  }
  return { ...ledgerRow };
};
LandlordLedger.updateOne = async (filter, update) => {
  if (!ledgerRow) return { modifiedCount: 0 };
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "landlordId" || key === "_id") continue;
    if (cond && typeof cond === "object" && "$gte" in cond) {
      if ((ledgerRow[key] || 0) < cond.$gte) return { modifiedCount: 0 };
    }
  }
  for (const [key, delta] of Object.entries(update.$inc || {})) {
    ledgerRow[key] = (ledgerRow[key] || 0) + delta;
  }
  Object.assign(ledgerRow, update.$set || {});
  return { modifiedCount: 1 };
};

// The rail is chosen from config/stripe, which reads the developer's own env
// file. Pin it to offline so this file means the same thing on every machine;
// the Stripe-rail tests below opt in with deferUncovered: true.
const stripeConfig = require("../../../config/stripe");
stripeConfig.isConfigured = () => false;
stripeConfig.getStripe = () => null;

const { toCents, fromCents, assertCents } = require("../../../services/ledger/money");
const {
  recordDeposit,
  createHold,
  voidHold,
  releaseHold,
  settlePayout,
  unfundedDeferredCents,
  getBalance,
  account,
} = require("../../../services/ledger/ledger.service");

/**
 * The journal must reproduce the cache, arrears included. Arrears is a
 * liability: a credit raises it, a debit pays it down.
 */
function assertJournalMatchesCache(label) {
  const replayed = { available: 0, held: 0, arrears: 0 };
  for (const entry of entries) {
    for (const line of entry.lines) {
      const debit = line.direction === "debit" ? line.amountCents : -line.amountCents;
      if (line.account === account.available(LANDLORD)) replayed.available += debit;
      if (line.account === account.held(LANDLORD)) replayed.held += debit;
      if (line.account === account.arrears(LANDLORD)) replayed.arrears -= debit;
    }
  }
  assert.strictEqual(replayed.available, ledgerRow.available, `${label}: available replays`);
  assert.strictEqual(replayed.held, ledgerRow.held, `${label}: held replays`);
  assert.strictEqual(replayed.arrears, ledgerRow.arrears, `${label}: arrears replays`);
}

const reset = async () => {
  entries = [];
  ledgerRow = null;
  nextId = 1;
  await LandlordLedger.create({ landlordId: LANDLORD });
};

/* ---------------- 1) Cents conversion ---------------------------------- */

assert.strictEqual(toCents(240.5), 24050);
assert.strictEqual(toCents(0.1) + toCents(0.2), toCents(0.3), "no float drift in the ledger");
// 240.50 * 100 is 24049.999999999996 in IEEE754; truncating would lose a cent.
assert.strictEqual(toCents(240.5), 24050);
assert.strictEqual(toCents(0), 0);
assert.strictEqual(fromCents(24050), 240.5);
assert.throws(() => toCents("abc"), TypeError);
assert.throws(() => toCents(undefined), TypeError);
assert.throws(() => assertCents(12.5), TypeError, "a fractional cent must never persist");

/* ---------------- 2) Lines must balance -------------------------------- */

assert.ok(
  linesBalance([
    { account: "a", direction: "debit", amountCents: 100 },
    { account: "b", direction: "credit", amountCents: 100 },
  ])
);
assert.ok(
  !linesBalance([
    { account: "a", direction: "debit", amountCents: 100 },
    { account: "b", direction: "credit", amountCents: 99 },
  ])
);

async function main() {
  /* -------------- 3) Deposit ------------------------------------------- */

  await reset();
  const dep = await recordDeposit({
    landlordId: LANDLORD,
    amountCents: toCents(500),
    idempotencyKey: "deposit:test-1",
  });
  assert.strictEqual(dep.alreadyApplied, false);
  assert.strictEqual(ledgerRow.available, 50000);
  assert.strictEqual(ledgerRow.lifetimeDeposited, 50000);
  assert.strictEqual(dep.entry.balanceAfter.available, 50000, "balanceAfter is recorded");

  /* -------------- 4) THE ANTI-DOUBLE-PAY GUARD ------------------------- */
  // The single most important assertion in this file.

  const replay = await recordDeposit({
    landlordId: LANDLORD,
    amountCents: toCents(500),
    idempotencyKey: "deposit:test-1", // same key — a retry
  });
  assert.strictEqual(replay.alreadyApplied, true, "a replay must be reported, not re-applied");
  assert.strictEqual(ledgerRow.available, 50000, "the balance must NOT move twice");
  assert.strictEqual(entries.filter((e) => e.type === "deposit").length, 1, "one entry, not two");
  assert.strictEqual(String(replay.entry._id), String(dep.entry._id), "the original is returned");

  /* -------------- 5) Hold moves available -> held ---------------------- */

  const hold = await createHold({
    landlordId: LANDLORD,
    amountCents: toCents(300),
    appointmentId: APPT,
    requestId: "req-1",
  });
  assert.strictEqual(hold.guardFailed, false);
  assert.strictEqual(ledgerRow.available, 20000);
  assert.strictEqual(ledgerRow.held, 30000);
  assert.strictEqual(ledgerRow.available + ledgerRow.held, 50000, "money is conserved");

  // Re-holding the same appointment is a no-op — this is what makes
  // finalizeVendorAcceptance safe to re-enter after a quota approval.
  const rehold = await createHold({
    landlordId: LANDLORD,
    amountCents: toCents(300),
    appointmentId: APPT,
    requestId: "req-1",
  });
  assert.strictEqual(rehold.alreadyApplied, true);
  assert.strictEqual(ledgerRow.held, 30000, "one appointment, one hold");

  /* -------------- 6) Release: two entries, difference flows back ------- */

  const { release, payout, shortfall } = await releaseHold({
    landlordId: LANDLORD,
    appointmentId: APPT,
    completionId: COMPLETION,
    requestId: "req-1",
    heldCents: toCents(300),
    payoutCents: toCents(240), // came in under the ceiling
  });

  assert.strictEqual(shortfall, false);
  assert.strictEqual(release.guardFailed, false);
  assert.strictEqual(payout.guardFailed, false);
  assert.strictEqual(ledgerRow.held, 0, "escrow fully released");
  // 500 - 240 = 260. The unspent 60 of the 300 ceiling came back on its own.
  assert.strictEqual(ledgerRow.available, 26000, "the difference returns to available");
  assert.strictEqual(ledgerRow.lifetimeReleased, 24000);

  // The journal reads the way a human would describe it.
  const types = entries.map((e) => e.type);
  assert.deepStrictEqual(types, ["deposit", "hold", "hold_release", "payout"]);
  // Every entry, individually, balances.
  entries.forEach((e) => assert.ok(linesBalance(e.lines), `${e.type} lines must balance`));

  // The payout is owed to the vendor, not yet paid.
  const payoutEntry = entries.find((e) => e.type === "payout");
  assert.strictEqual(payoutEntry.providerStatus, "pending");
  assert.ok(payoutEntry.lines.some((l) => l.account.startsWith("vendor:")));

  /* -------------- 7) The balance is DERIVABLE from the journal --------- */
  // If this fails, the cache has become the truth, which it must never be.

  const replayed = entries.reduce(
    (acc, entry) => {
      for (const line of entry.lines) {
        const delta = line.direction === "debit" ? line.amountCents : -line.amountCents;
        if (line.account === account.available(LANDLORD)) acc.available += delta;
        if (line.account === account.held(LANDLORD)) acc.held += delta;
      }
      return acc;
    },
    { available: 0, held: 0 }
  );
  assert.strictEqual(replayed.available, ledgerRow.available, "journal must reproduce the cache");
  assert.strictEqual(replayed.held, ledgerRow.held);

  /* -------------- 8) Insufficient balance: arrears, never negative ----- */

  await reset();
  await recordDeposit({ landlordId: LANDLORD, amountCents: toCents(50), idempotencyKey: "d2" });

  // A hold beyond the balance does NOT block the booking — the vendor already
  // accepted, and cancelling on them because the wallet is light is pointless.
  const bigHold = await createHold({
    landlordId: LANDLORD,
    amountCents: toCents(400),
    appointmentId: "appt-2",
    requestId: "req-2",
  });
  assert.strictEqual(bigHold.guardFailed, true, "the caller must be warned");
  assert.ok(bigHold.entry, "but the obligation is still recorded");
  assert.strictEqual(bigHold.uncoveredCents, 35000, "the uncovered part is reported");
  assert.strictEqual(ledgerRow.available, 0, "every available cent is committed");
  assert.ok(ledgerRow.available >= 0, "available must NOT go negative");
  assert.strictEqual(ledgerRow.held, 40000, "held ALWAYS reflects the full commitment");
  assert.strictEqual(ledgerRow.arrears, 35000, "the uncovered part is booked as debt at hold time");

  // The three-line entry still balances: debit held 400 = credit available 50 +
  // credit arrears 350. An earlier two-line version created money here.
  const shortHold = entries.find((e) => e.type === "hold" && e.appointmentId === "appt-2");
  assert.ok(linesBalance(shortHold.lines), "an under-funded hold must still balance");
  assert.strictEqual(shortHold.lines.length, 3);
  assert.strictEqual(shortHold.shortfall, true);

  const shortRelease = await releaseHold({
    landlordId: LANDLORD,
    appointmentId: "appt-2",
    completionId: "comp-2",
    requestId: "req-2",
    heldCents: toCents(400),
    payoutCents: toCents(400),
  });

  // The release always succeeds — it gives money back, so escrow is never
  // stranded even when the payout then falls short.
  assert.strictEqual(ledgerRow.held, 0, "escrow is never stranded");
  assert.ok(ledgerRow.available >= 0, "available must NEVER go negative");
  // The release returns only the 50 that was deposited; the 350 it never had
  // cancels its own arrears. So the payout IS short, and saying so is what
  // tells the landlord to top up. (This used to read `false`: the release
  // handed back all 400, which is the bug that credited money never deposited.)
  assert.strictEqual(shortRelease.shortfall, true, "a 400 job against a 50 wallet is a shortfall");
  // Deposited 50, job cost 400 — so 350 is owed, and no more than 350.
  assert.strictEqual(ledgerRow.arrears, 35000, "the debt is not double-counted");
  assert.strictEqual(ledgerRow.available, 0);
  assertJournalMatchesCache("full-cost shortfall");

  /* -------------- 9) A deposit settles arrears first ------------------- */

  await recordDeposit({ landlordId: LANDLORD, amountCents: toCents(350), idempotencyKey: "d3" });
  assert.strictEqual(ledgerRow.arrears, 0, "new money pays the old debt first");
  assert.strictEqual(ledgerRow.available, 0, "and is not also spendable");
  // It used to be a bare cache $inc; now it is an entry, so the journal agrees.
  assert.ok(entries.some((e) => e.type === "arrears_settlement"), "the settlement is journaled");
  assertJournalMatchesCache("deposit settles arrears");

  /* -------------- 9b) An approved overage owes only the GAP ------------ */
  // The payout exceeds the hold. Only the uncovered part is a debt — booking
  // the whole payout as arrears would invent money by leaving `available`
  // untouched while claiming the full amount is owed.

  await reset();
  await recordDeposit({ landlordId: LANDLORD, amountCents: toCents(500), idempotencyKey: "d5" });
  await createHold({
    landlordId: LANDLORD,
    amountCents: toCents(300),
    appointmentId: "appt-4",
    requestId: "req-4",
  });

  const overage = await releaseHold({
    landlordId: LANDLORD,
    appointmentId: "appt-4",
    completionId: "comp-4",
    requestId: "req-4",
    heldCents: toCents(300),
    payoutCents: toCents(640), // landlord approved the overage
  });

  assert.strictEqual(ledgerRow.held, 0);
  assert.strictEqual(ledgerRow.available, 0, "the wallet is drained, not overdrawn");
  // Deposited 500, job cost 640 -> owes 140. NOT 640.
  assert.strictEqual(ledgerRow.arrears, 14000, "only the gap is owed");
  assert.strictEqual(overage.uncoveredCents, 14000);
  assert.strictEqual(overage.shortfall, true);

  const overagePayout = entries.find((e) => e.type === "payout" && e.completionId === "comp-4");
  assert.ok(linesBalance(overagePayout.lines), "the payout must still balance");
  // The vendor is owed the full 640 regardless of who funds it.
  assert.strictEqual(
    overagePayout.lines.find((l) => l.account.startsWith("vendor:")).amountCents,
    64000
  );

  /* -------------- 10) Void returns escrow ------------------------------ */

  await reset();
  await recordDeposit({ landlordId: LANDLORD, amountCents: toCents(500), idempotencyKey: "d4" });
  await createHold({
    landlordId: LANDLORD,
    amountCents: toCents(300),
    appointmentId: "appt-3",
    requestId: "req-3",
  });
  assert.strictEqual(ledgerRow.held, 30000);

  await voidHold({
    landlordId: LANDLORD,
    appointmentId: "appt-3",
    amountCents: toCents(300),
    requestId: "req-3",
  });
  assert.strictEqual(ledgerRow.held, 0);
  assert.strictEqual(ledgerRow.available, 50000, "a cancelled job returns every cent");

  // And voiding twice does not credit twice.
  await voidHold({
    landlordId: LANDLORD,
    appointmentId: "appt-3",
    amountCents: toCents(300),
    requestId: "req-3",
  });
  assert.strictEqual(ledgerRow.available, 50000, "a double void must not double credit");

  /* -------------- 11) getBalance read model ---------------------------- */

  const balance = await getBalance(LANDLORD);
  assert.strictEqual(balance.available, 50000);
  assert.strictEqual(balance.held, 0);
  assert.strictEqual(balance.currency, "CAD");

  /* -------------- 12) THE REPORTED BUG: a quote far over the wallet ----- */
  // Wallet 50. Vendor quotes 400, so 400 is held (350 of it unfunded). The job
  // finishes at 30. The landlord must end with 20 — not 370. Releasing the full
  // hold used to hand back 400, leaving 370 spendable that was never deposited.

  for (const deferUncovered of [false, true]) {
    await reset();
    await recordDeposit({ landlordId: LANDLORD, amountCents: toCents(50), idempotencyKey: "bug-d" });
    await createHold({ landlordId: LANDLORD, amountCents: toCents(400), appointmentId: "bug-a", requestId: "bug-r" });
    assert.strictEqual(ledgerRow.arrears, 35000);

    const closed = await releaseHold({
      landlordId: LANDLORD,
      appointmentId: "bug-a",
      completionId: "bug-c",
      requestId: "bug-r",
      heldCents: toCents(400),
      payoutCents: toCents(30),
      deferUncovered,
    });
    const rail = deferUncovered ? "stripe rail" : "offline rail";
    assert.strictEqual(ledgerRow.available, 2000, `${rail}: 50 deposited - 30 spent = 20, never 370`);
    assert.strictEqual(ledgerRow.arrears, 0, `${rail}: the unfunded part of the hold is cancelled, not owed`);
    assert.strictEqual(ledgerRow.held, 0);
    assert.strictEqual(closed.shortfall, false, `${rail}: 30 was covered`);
    assert.strictEqual(closed.deferred, null);
    assertJournalMatchesCache(`reported bug (${rail})`);
  }

  /* -------------- 13) Voiding an under-funded hold returns only real money */

  await reset();
  await recordDeposit({ landlordId: LANDLORD, amountCents: toCents(50), idempotencyKey: "void-d" });
  await createHold({ landlordId: LANDLORD, amountCents: toCents(400), appointmentId: "void-a", requestId: "void-r" });
  await voidHold({ landlordId: LANDLORD, appointmentId: "void-a", amountCents: toCents(400), requestId: "void-r" });
  assert.strictEqual(ledgerRow.available, 5000, "a cancelled job gives back what was deposited, not the quote");
  assert.strictEqual(ledgerRow.arrears, 0);
  assert.strictEqual(ledgerRow.held, 0);
  await voidHold({ landlordId: LANDLORD, appointmentId: "void-a", amountCents: toCents(400), requestId: "void-r" });
  assert.strictEqual(ledgerRow.available, 5000, "a double void must not double credit");
  assertJournalMatchesCache("under-funded void");

  /* -------------- 14) Stripe rail: send what is covered, hold the rest --- */

  await reset();
  await recordDeposit({ landlordId: LANDLORD, amountCents: toCents(50), idempotencyKey: "def-d", fundingSource: "stripe" });
  await createHold({ landlordId: LANDLORD, amountCents: toCents(400), appointmentId: "def-a", requestId: "def-r" });
  const split = await releaseHold({
    landlordId: LANDLORD,
    appointmentId: "def-a",
    completionId: "def-c",
    requestId: "def-r",
    identityId: "vendor-1",
    heldCents: toCents(400),
    payoutCents: toCents(120),
    deferUncovered: true,
  });

  assert.strictEqual(split.payout.entry.amountCents, 5000, "the 50 the wallet covers is sent now");
  assert.strictEqual(split.payout.entry.providerStatus, "pending");
  assert.strictEqual(split.deferred.entry.amountCents, 7000, "the other 70 waits");
  assert.strictEqual(split.deferred.entry.providerStatus, "awaiting_funds");
  assert.strictEqual(split.deferred.entry.idempotencyKey, "payout:def-c:deferred");
  assert.strictEqual(split.shortfall, true);
  assert.strictEqual(split.uncoveredCents, 7000);
  assert.strictEqual(ledgerRow.available, 0);
  assert.strictEqual(ledgerRow.arrears, 7000, "owed for completed work, and no more");
  assert.strictEqual(await unfundedDeferredCents(LANDLORD), 7000);
  assertJournalMatchesCache("covered + deferred split");

  // Nothing sends the unfunded part — not even a direct call.
  const refused = await settlePayout({ entryId: split.deferred.entry._id });
  assert.strictEqual(refused.refused, "awaiting_funds", "an unfunded remainder is never transferred");

  // A replay of the close returns what was written and writes nothing new.
  const before = entries.length;
  const replayedClose = await releaseHold({
    landlordId: LANDLORD,
    appointmentId: "def-a",
    completionId: "def-c",
    requestId: "def-r",
    identityId: "vendor-1",
    heldCents: toCents(400),
    payoutCents: toCents(120),
    deferUncovered: true,
  });
  assert.strictEqual(entries.length, before, "a replayed close posts nothing");
  assert.strictEqual(String(replayedClose.deferred.entry._id), String(split.deferred.entry._id));
  assert.strictEqual(replayedClose.uncoveredCents, 7000);

  /* -------------- 15) Top-ups fund the remainder; it sends once, in full -- */

  const partial = await recordDeposit({
    landlordId: LANDLORD,
    amountCents: toCents(40),
    idempotencyKey: "def-d2",
    fundingSource: "stripe",
  });
  const deferredRow = () => entries.find((e) => e.idempotencyKey === "payout:def-c:deferred");
  assert.deepStrictEqual(partial.fundedPayoutIds, [], "40 of 70 is not enough to send");
  assert.strictEqual(deferredRow().fundedCents, 4000);
  assert.strictEqual(deferredRow().providerStatus, "awaiting_funds");
  assert.strictEqual(ledgerRow.arrears, 3000);
  assert.strictEqual(ledgerRow.available, 0, "the top-up went to the vendor's remainder, not the wallet");
  assertJournalMatchesCache("partial funding");

  const releasedBefore = ledgerRow.lifetimeReleased;
  const full = await recordDeposit({
    landlordId: LANDLORD,
    amountCents: toCents(100),
    idempotencyKey: "def-d3",
    fundingSource: "stripe",
  });
  assert.deepStrictEqual(full.fundedPayoutIds.map(String), [String(deferredRow()._id)], "now it can go");
  assert.strictEqual(deferredRow().providerStatus, "pending", "handed to settleFundedPayouts by the caller");
  assert.strictEqual(deferredRow().fundedCents, 7000);
  assert.strictEqual(ledgerRow.arrears, 0);
  assert.strictEqual(ledgerRow.available, 7000, "100 - the 30 still owed = 70 spendable");
  assert.strictEqual(ledgerRow.lifetimeReleased - releasedBefore, 7000, "paid out to date counts it once funded");
  assertJournalMatchesCache("full funding");

  /* -------------- 15b) An external deposit cannot fund a transfer --------- */
  // It credits the wallet but puts nothing in the Stripe balance, so sending a
  // vendor's remainder from it would spend another landlord's money.

  await reset();
  await recordDeposit({ landlordId: LANDLORD, amountCents: toCents(50), idempotencyKey: "ext-d", fundingSource: "stripe" });
  await createHold({ landlordId: LANDLORD, amountCents: toCents(50), appointmentId: "ext-a", requestId: "ext-r" });
  await releaseHold({
    landlordId: LANDLORD,
    appointmentId: "ext-a",
    completionId: "ext-c",
    requestId: "ext-r",
    heldCents: toCents(50),
    payoutCents: toCents(120),
    deferUncovered: true,
  });
  const external = await recordDeposit({ landlordId: LANDLORD, amountCents: toCents(100), idempotencyKey: "ext-d2" });
  assert.deepStrictEqual(external.fundedPayoutIds, []);
  assert.strictEqual(entries.find((e) => e.idempotencyKey === "payout:ext-c:deferred").fundedCents, 0);
  assert.strictEqual(ledgerRow.arrears, 7000, "still owed until card money arrives");
  assert.strictEqual(ledgerRow.available, 10000);
  assertJournalMatchesCache("external deposit");

  /* -------------- 16) Releasing job B never pays job A's vendor debt ----- */

  await reset();
  await recordDeposit({ landlordId: LANDLORD, amountCents: toCents(50), idempotencyKey: "ab-d", fundingSource: "stripe" });
  await createHold({ landlordId: LANDLORD, amountCents: toCents(50), appointmentId: "a-appt", requestId: "a-req" });
  await releaseHold({
    landlordId: LANDLORD,
    appointmentId: "a-appt",
    completionId: "a-comp",
    requestId: "a-req",
    heldCents: toCents(50),
    payoutCents: toCents(120), // A owes its vendor 70 more
    deferUncovered: true,
  });
  assert.strictEqual(ledgerRow.arrears, 7000);

  await createHold({ landlordId: LANDLORD, amountCents: toCents(100), appointmentId: "b-appt", requestId: "b-req" });
  assert.strictEqual(ledgerRow.arrears, 17000, "B's hold is entirely unfunded");

  const jobB = await releaseHold({
    landlordId: LANDLORD,
    appointmentId: "b-appt",
    completionId: "b-comp",
    requestId: "b-req",
    heldCents: toCents(100),
    payoutCents: toCents(40),
    deferUncovered: true,
  });
  // B's release cancels B's own 100 of phantom arrears and nothing of A's 70.
  assert.strictEqual(jobB.payout, null, "nothing covered, so nothing sent");
  assert.strictEqual(jobB.deferred.entry.amountCents, 4000);
  assert.strictEqual(entries.find((e) => e.idempotencyKey === "payout:a-comp:deferred").fundedCents, 0);
  assert.strictEqual(ledgerRow.arrears, 11000, "A's 70 + B's 40, both owed to vendors");
  assert.strictEqual(await unfundedDeferredCents(LANDLORD), 11000, "every cent of arrears is a waiting vendor");
  assert.strictEqual(ledgerRow.available, 0);
  assertJournalMatchesCache("two jobs");

  console.log("ledger.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
