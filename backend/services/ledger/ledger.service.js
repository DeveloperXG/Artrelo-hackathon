// Money movement. The one module allowed to write LedgerEntry.
//
// THE ORDERING RULE, which is the whole design:
//
//   1. Insert the journal entry first. Its unique idempotencyKey CLAIMS the
//      operation. A retry produces the same key, collides, and returns the
//      existing entry — so the money moves exactly once.
//   2. Then update the balance cache with a guarded $inc.
//   3. Then patch balanceAfter onto the entry.
//
// A crash between 1 and 2 leaves an entry with balanceAfter: null, which
// reconcileLedger finds and replays. Doing it the other way round — cache
// first — can double-apply on retry, which is strictly worse: an unapplied
// entry is recoverable, a doubled payment is not.
//
// Historical settlement keeps its journal-first recovery contract. New strict
// booking reservations additionally require a transaction: money, appointment
// and the shared vendor calendar must either all commit or all remain pending.
// Tests of that path therefore use a replica set, as production Atlas does.

const LedgerEntry = require("../../models/LedgerEntry");
const LandlordLedger = require("../../models/LandlordLedger");
const VendorIdentity = require("../../models/VendorIdentity");
const { assertCents } = require("./money");
const { sendPayout, activeProvider, STRIPE_CONNECT } = require("./payoutProvider.service");
// Called through the module object so a test can stand in for it.
const payoutNotices = require("./payoutNotices.service");
// Wallet pages refetch on this nudge; see services/realtime/liveEvents.service.js.
const { publish } = require("../realtime/liveEvents.service");

/* ------------------------------------------------------------------ *
 * Account names. Namespaced strings, so hard per-property partitioning
 * later is a longer name rather than a new schema.
 * ------------------------------------------------------------------ */

const account = {
  available: (landlordId) => `landlord:${landlordId}:available`,
  held: (landlordId) => `landlord:${landlordId}:held`,
  arrears: (landlordId) => `landlord:${landlordId}:arrears`,
  vendorPayable: (identityId) => `vendor:${identityId || "unassigned"}:payable`,
  funding: () => "external:funding",
  fee: () => "platform:fee",
  // Service fees the wallet could not cover at the close. A liability, like
  // arrears -- and deliberately NOT arrears; see chargeServiceFee.
  feesOwed: (landlordId) => `landlord:${landlordId}:fees_owed`,
  // What a landlord owes after a bank top-up was reversed once spent, or a
  // bank fee the wallet could not cover. Its own account, like fees_owed, for
  // the same reason: arrears means exactly two things.
  bankOwed: (landlordId) => `landlord:${landlordId}:bank_owed`,
  // Failure and dispute fees recovered from landlords: Stripe charges Artrelo
  // for a failed or disputed debit, and the landlord was told they pay it.
  bankFees: () => "platform:bank_fees",
};

async function ensureLedger(landlordId) {
  const existing = await LandlordLedger.findOne({ landlordId });
  if (existing) return existing;
  try {
    return await LandlordLedger.create({ landlordId });
  } catch (err) {
    if (err?.code === 11000) return LandlordLedger.findOne({ landlordId });
    throw err;
  }
}

/**
 * Post an entry, then move the cache.
 *
 * `balanceGuard` is the conditional the cache update must satisfy — for a
 * spend it is { available: { $gte: amountCents } }. When the guard fails the
 * caller decides what that means: a hold treats it as a warning, a payout
 * treats it as arrears. Neither is decided here.
 *
 * Returns { entry, ledger, alreadyApplied, guardFailed }.
 */
async function postEntry({
  landlordId,
  idempotencyKey,
  type,
  lines,
  amountCents,
  scope = {},
  requestId = null,
  appointmentId = null,
  completionId = null,
  identityId = null,
  holdEntryId = null,
  provider = "internal",
  providerStatus = "none",
  providerRef = null,
  fundingSource = "none",
  actor = "system",
  memo = null,
  cacheUpdate = {},
  balanceGuard = {},
  shortfall = false,
}) {
  assertCents(amountCents, "amountCents");

  // 1. Claim the operation.
  let entry;
  try {
    entry = await LedgerEntry.create({
      landlordId,
      idempotencyKey,
      type,
      lines,
      amountCents,
      scope,
      requestId,
      appointmentId,
      completionId,
      identityId,
      holdEntryId,
      provider,
      providerStatus,
      providerRef,
      fundingSource,
      actor,
      memo,
      shortfall,
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    // Already done. This is the retry path and it is a SUCCESS, not an error.
    const existing = await LedgerEntry.findOne({ idempotencyKey });
    const ledger = await ensureLedger(landlordId);
    return { entry: existing, ledger, alreadyApplied: true, guardFailed: false };
  }

  await ensureLedger(landlordId);

  // 2. Move the cache. The guard and the decrement are ONE atomic operation, so
  //    there is no window between checking the balance and spending it.
  const updated = await LandlordLedger.findOneAndUpdate(
    { landlordId, ...balanceGuard },
    { $inc: { ...cacheUpdate, version: 1 }, $set: { lastEntryAt: new Date() } },
    { new: true }
  );

  if (!updated) {
    // The guard failed — insufficient funds. The entry stays: it is a real
    // obligation and deleting it would erase the record of work already done.
    // The caller compensates (arrears) and marks it.
    publish(landlordId, "wallet");
    return { entry, ledger: await ensureLedger(landlordId), alreadyApplied: false, guardFailed: true };
  }

  // 3. Record where the balance landed.
  await LedgerEntry.updateOne(
    { _id: entry._id },
    { $set: { "balanceAfter.available": updated.available, "balanceAfter.held": updated.held } }
  );

  publish(landlordId, "wallet");
  return { entry, ledger: updated, alreadyApplied: false, guardFailed: false };
}

/* ------------------------------------------------------------------ *
 * Arrears has two sources, and they must never be confused.
 *
 *   1. An under-funded HOLD. createHold books the part the wallet could not
 *      cover as arrears, so `held` can rise by the full commitment. That debt
 *      is phantom until the job closes: if the job is released or voided, the
 *      escrow coming back includes money that was never deposited.
 *   2. Completed work the wallet could not cover — awaiting_funds payouts. That
 *      debt is real: a vendor is waiting for it.
 *
 * Releasing a hold must cancel only ITS OWN phantom part. Cancelling all
 * arrears would let job B's release quietly pay off job A's vendor debt
 * without job A's vendor ever receiving a transfer.
 * ------------------------------------------------------------------ */

const AWAITING_FUNDS = "awaiting_funds";
// Funded in the ledger, not yet cleared at Stripe. See LedgerEntry.PROVIDER_STATUSES.
const AWAITING_CLEARANCE = "awaiting_clearance";

/** Sum of the given direction's lines on one account. */
function lineTotal(lines = [], accountName, direction) {
  return lines
    .filter((line) => line.account === accountName && line.direction === direction)
    .reduce((total, line) => total + line.amountCents, 0);
}

/** What completed work still owes vendors: the unfunded part of every awaiting_funds payout. */
async function unfundedDeferredCents(landlordId) {
  const rows = await LedgerEntry.find({ landlordId, type: "payout", providerStatus: AWAITING_FUNDS })
    .select("amountCents fundedCents")
    .lean();
  return rows.reduce((total, row) => total + (row.amountCents - (row.fundedCents || 0)), 0);
}

/**
 * How much of this hold's uncovered part is still unpaid, and therefore phantom.
 *
 * Bounded three ways: by the arrears the hold itself booked; by the arrears
 * that is hold-sourced at all (deposits since may have paid some of it, and
 * money is fungible, so which hold they paid does not matter — only the total);
 * and by the escrow being returned.
 */
async function holdShortfallOutstanding({ landlordId, appointmentId, heldCents }) {
  const hold = await LedgerEntry.findOne({ idempotencyKey: `hold:${appointmentId}` });
  const uncovered = hold ? lineTotal(hold.lines, account.arrears(landlordId), "credit") : 0;
  if (!uncovered) return 0;

  const ledger = await ensureLedger(landlordId);
  const holdArrears = Math.max(0, (ledger.arrears || 0) - (await unfundedDeferredCents(landlordId)));
  return Math.min(uncovered, holdArrears, heldCents);
}

/**
 * Escrow coming back to the wallet: the phantom part cancels its own arrears,
 * and only what was really deposited becomes spendable again.
 *
 *     debit  available  held - repay
 *     debit  arrears    repay
 *     credit held       held
 */
function escrowReturnPosting({ landlordId, heldCents, repay }) {
  const returned = heldCents - repay;
  const lines = [];
  if (returned > 0) {
    lines.push({ account: account.available(landlordId), direction: "debit", amountCents: returned });
  }
  if (repay > 0) {
    lines.push({ account: account.arrears(landlordId), direction: "debit", amountCents: repay });
  }
  lines.push({ account: account.held(landlordId), direction: "credit", amountCents: heldCents });

  return {
    lines,
    cacheUpdate: { available: returned, held: -heldCents, ...(repay > 0 ? { arrears: -repay } : {}) },
  };
}

/* ------------------------------------------------------------------ *
 * The four operations the job lifecycle actually performs.
 * ------------------------------------------------------------------ */

/** Landlord funds the wallet. external:funding -> available. */
async function recordDeposit({
  landlordId,
  amountCents,
  idempotencyKey,
  provider = "manual",
  providerRef = null,
  actor = "landlord",
  memo = null,
  // "stripe" only when a PaymentIntent has actually SETTLED. Callers must not
  // pass it optimistically: a deposit recorded before Stripe confirms the
  // charge lets a landlord spend money that never arrived, which is the exact
  // failure this whole split exists to prevent.
  fundingSource = "external",
}) {
  const result = await postEntry({
    landlordId,
    idempotencyKey,
    type: "deposit",
    amountCents,
    lines: [
      { account: account.available(landlordId), direction: "debit", amountCents },
      { account: account.funding(), direction: "credit", amountCents },
    ],
    provider,
    providerRef,
    providerStatus: "paid",
    fundingSource,
    actor,
    memo,
    cacheUpdate: { available: amountCents, lifetimeDeposited: amountCents },
  });

  // A deposit settles arrears before it becomes spendable — otherwise a
  // landlord in arrears could spend new money while still owing for old work.
  if (result.alreadyApplied || result.guardFailed) return { ...result, fundedPayoutIds: [] };

  const fundedPayoutIds = await applyDepositToArrears({
    landlordId,
    amountCents,
    depositKey: idempotencyKey,
    // Only money that is actually IN the Stripe balance may fund a transfer.
    // An external deposit credits the ledger but leaves Stripe with nothing to
    // send, so letting it release a vendor's remainder would pay that vendor
    // out of other landlords' money.
    canFundTransfers: fundingSource === "stripe",
  });

  return { ...result, ledger: await ensureLedger(landlordId), fundedPayoutIds };
}

/**
 * Pay arrears down out of a deposit, as journal entries.
 *
 * It used to be a bare cache $inc with no entry, so the journal could not
 * reproduce the balance and reconcileLedger misreported every wallet that had
 * ever been in arrears.
 *
 * Order: completed work first (awaiting_funds payouts, oldest first), because a
 * vendor is waiting for that money; then a reversed bank top-up's debt (cash
 * deposits only); then unpaid service fees; open-hold shortfall last.
 *
 * Returns the ids of payouts this deposit funded IN FULL. They are now
 * `pending` and the caller sends them with settleFundedPayouts — kept out of
 * here so the ledger stays a ledger and never calls a payment provider itself.
 */
async function applyDepositToArrears({ landlordId, amountCents, depositKey, canFundTransfers }) {
  let budget = amountCents;
  const funded = [];

  if (canFundTransfers) {
    const deferred = await LedgerEntry.find({ landlordId, type: "payout", providerStatus: AWAITING_FUNDS })
      .sort({ createdAt: 1 })
      .lean();

    for (const payout of deferred) {
      if (budget <= 0) break;
      const ledger = await ensureLedger(landlordId);
      const outstanding = payout.amountCents - (payout.fundedCents || 0);
      const step = Math.min(budget, outstanding, ledger.arrears || 0, ledger.available || 0);
      if (step <= 0) continue;
      const completes = step === outstanding;

      const settle = await postEntry({
        landlordId,
        idempotencyKey: `arrears_settlement:${depositKey}:${payout._id}`,
        type: "arrears_settlement",
        amountCents: step,
        lines: [
          { account: account.arrears(landlordId), direction: "debit", amountCents: step },
          { account: account.available(landlordId), direction: "credit", amountCents: step },
        ],
        requestId: payout.requestId || null,
        appointmentId: payout.appointmentId || null,
        completionId: payout.completionId || null,
        identityId: payout.identityId || null,
        holdEntryId: payout._id,
        memo: completes ? "Funded the rest of a vendor payout" : "Part of a vendor payout's remainder",
        // "Paid out to date" counts the remainder once it can actually go.
        cacheUpdate: { available: -step, arrears: -step, ...(completes ? { lifetimeReleased: payout.amountCents } : {}) },
        balanceGuard: { available: { $gte: step }, arrears: { $gte: step } },
      });
      if (settle.alreadyApplied || settle.guardFailed) continue;
      budget -= step;

      // Guarded so two deposits racing cannot over-fund one payout.
      const updated = await LedgerEntry.findOneAndUpdate(
        { _id: payout._id, providerStatus: AWAITING_FUNDS, fundedCents: { $lte: payout.amountCents - step } },
        { $inc: { fundedCents: step } },
        { new: true }
      );
      if (updated && updated.fundedCents >= updated.amountCents) {
        const ready = await LedgerEntry.findOneAndUpdate(
          { _id: payout._id, providerStatus: AWAITING_FUNDS },
          { $set: { providerStatus: "pending" } },
          { new: true }
        );
        if (ready) funded.push(ready._id);
      }
    }
  }

  // Second: money a reversed bank top-up left owing. CASH ONLY (canFundTransfers),
  // because this debt is cash that really left the platform balance -- a
  // disputed debit is taken back out of it by Stripe. An external deposit adds
  // nothing at Stripe, so letting it clear this would leave the hole where it is.
  if (budget > 0 && canFundTransfers) {
    const ledger = await ensureLedger(landlordId);
    const step = Math.min(budget, ledger.bankOwed || 0, ledger.available || 0);
    if (step > 0) {
      const settled = await postEntry({
        landlordId,
        idempotencyKey: `bank_settlement:${depositKey}`,
        type: "bank_settlement",
        amountCents: step,
        lines: [
          { account: account.bankOwed(landlordId), direction: "debit", amountCents: step },
          { account: account.available(landlordId), direction: "credit", amountCents: step },
        ],
        memo: "Paid back a reversed bank top-up",
        cacheUpdate: { available: -step, bankOwed: -step },
        balanceGuard: { available: { $gte: step }, bankOwed: { $gte: step } },
      });
      if (!settled.alreadyApplied && !settled.guardFailed) budget -= step;
    }
  }

  // Third: unpaid service fees, ahead of booking shortfall. Booking shortfall
  // can still evaporate (a cancelled job voids its own phantom part), while a
  // fee is owed for work that is already done.
  //
  // Not gated on canFundTransfers: nothing is SENT for a fee -- it is a claim
  // between the landlord and Artrelo inside the ledger. Whether the platform
  // balance really holds the cash is the revenue sweep's question, and it is
  // the same question for a fee taken at the close.
  if (budget > 0) {
    const ledger = await ensureLedger(landlordId);
    const step = Math.min(budget, ledger.feesOwed || 0, ledger.available || 0);
    if (step > 0) {
      const settled = await postEntry({
        landlordId,
        idempotencyKey: `fee_settlement:${depositKey}`,
        type: "fee_settlement",
        amountCents: step,
        lines: [
          { account: account.feesOwed(landlordId), direction: "debit", amountCents: step },
          { account: account.available(landlordId), direction: "credit", amountCents: step },
        ],
        memo: "Paid unpaid service fees",
        cacheUpdate: { available: -step, feesOwed: -step },
        balanceGuard: { available: { $gte: step }, feesOwed: { $gte: step } },
      });
      if (!settled.alreadyApplied && !settled.guardFailed) budget -= step;
    }
  }

  if (budget > 0) {
    const ledger = await ensureLedger(landlordId);
    const holdArrears = Math.max(0, (ledger.arrears || 0) - (await unfundedDeferredCents(landlordId)));
    const step = Math.min(budget, holdArrears, ledger.available || 0);
    if (step > 0) {
      await postEntry({
        landlordId,
        idempotencyKey: `arrears_settlement:${depositKey}:holds`,
        type: "arrears_settlement",
        amountCents: step,
        lines: [
          { account: account.arrears(landlordId), direction: "debit", amountCents: step },
          { account: account.available(landlordId), direction: "credit", amountCents: step },
        ],
        memo: "Covered an under-funded booking",
        cacheUpdate: { available: -step, arrears: -step },
        balanceGuard: { available: { $gte: step }, arrears: { $gte: step } },
      });
    }
  }

  return funded;
}

/** Send the payouts a deposit just funded. Never throws: the ledger already says they are owed. */
async function settleFundedPayouts(entryIds = []) {
  for (const entryId of entryIds) {
    try {
      await settlePayout({ entryId });
    } catch (err) {
      console.error("[ledger] funded payout settle failed", String(entryId), err.message);
    }
  }
}

/**
 * Escrow the booked amount at vendor acceptance.
 *
 * A failed guard does NOT block the booking — the vendor has already accepted
 * and cancelling on them because the wallet is light would be both rude and
 * pointless. It writes the hold with shortfall: true and lets the caller warn,
 * which is the entire reason to hold at acceptance rather than at release:
 * days of notice before the money is actually needed.
 */
async function createHold({
  landlordId,
  amountCents,
  appointmentId,
  requestId,
  identityId = null,
  scope = {},
  memo = null,
}) {
  const existing = await LedgerEntry.findOne({ idempotencyKey: `hold:${appointmentId}` });
  if (existing) {
    return { entry: existing, ledger: await ensureLedger(landlordId), alreadyApplied: true, guardFailed: false };
  }

  // `held` must ALWAYS rise by the full commitment, so that it stays equal to
  // getStats' committedCost — the free second opinion reconcileLedger checks
  // the whole hold lifecycle against. When the wallet cannot cover it, the
  // uncovered part is booked as arrears rather than left as a silent gap:
  //
  //     debit  held      400
  //     credit available  50   (all there was)
  //     credit arrears   350   (a liability — what is now owed)
  //
  // Three lines that still sum to zero. The earlier two-line version
  // incremented `held` without debiting `available`, which CREATED money: the
  // release later credited back 400 that was never taken.
  const ledger = await ensureLedger(landlordId);
  const covered = Math.max(0, Math.min(ledger.available, amountCents));
  const uncovered = amountCents - covered;

  const lines = [{ account: account.held(landlordId), direction: "debit", amountCents }];
  if (covered > 0) {
    lines.push({ account: account.available(landlordId), direction: "credit", amountCents: covered });
  }
  if (uncovered > 0) {
    lines.push({ account: account.arrears(landlordId), direction: "credit", amountCents: uncovered });
  }

  const result = await postEntry({
    landlordId,
    idempotencyKey: `hold:${appointmentId}`,
    type: "hold",
    amountCents,
    lines,
    appointmentId,
    requestId,
    identityId,
    scope,
    memo,
    shortfall: uncovered > 0,
    cacheUpdate: {
      available: -covered,
      held: amountCents,
      ...(uncovered > 0 ? { arrears: uncovered } : {}),
    },
    // Guard on what we actually intend to spend. A concurrent spend between the
    // read above and this update trips it rather than overdrawing.
    balanceGuard: { available: { $gte: covered } },
  });

  // Surfaced so the caller can warn the landlord days before the money is
  // needed — the entire reason to hold at acceptance rather than at release.
  return { ...result, guardFailed: result.guardFailed || uncovered > 0, uncoveredCents: uncovered };
}

/** New bookings must be fully funded. No booking obligation exists yet, so a
 * failed guard ABORTS the caller's transaction instead of recording arrears.
 * Keep journal writes here: the calendar/booking services never write money.
 */
async function reserveBookingFunds({ landlordId, amountCents, appointmentId, requestId, identityId,
  scope = {}, session }) {
  if (!session?.inTransaction()) throw new Error("Booking funds require a transaction");
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error("Invalid booking amount");
  const { bookingFunds } = require("./bookingFunds");
  const ledger = await LandlordLedger.findOne({ landlordId }).session(session);
  const externalCredits = !!await LedgerEntry.exists({ landlordId, type: "deposit", fundingSource: "external" }).session(session);
  const gate = bookingFunds({ amountCents, ledger, externalCredits });
  if (!gate.allowed) {
    const error = new Error("Funding is required before this booking can be confirmed.");
    Object.assign(error, gate, { code: gate.reasonCode, status: 409 }); throw error;
  }
  if (!amountCents) return { amountCents: 0 };
  const prior = await LedgerEntry.findOne({ idempotencyKey: `hold:${appointmentId}` }).session(session);
  if (prior) return { entry: prior, alreadyApplied: true };
  const [entry] = await LedgerEntry.create([{
    landlordId, idempotencyKey: `hold:${appointmentId}`, type: "hold", amountCents,
    appointmentId, requestId, identityId, scope,
    lines: [{ account: account.held(landlordId), direction: "debit", amountCents },
      { account: account.available(landlordId), direction: "credit", amountCents }],
    memo: "Reserved for a funded booking", shortfall: false,
  }], { session });
  // Older wallets may predate either debt counter. Mongoose supplies zero when
  // reading those documents, but an equality query does not match absent fields.
  // Keep the debt check in the atomic write, accepting only zero or absent.
  const updated = await LandlordLedger.findOneAndUpdate({ landlordId, available: { $gte: amountCents },
    $and: [
      { $or: [{ arrears: 0 }, { arrears: { $exists: false } }] },
      { $or: [{ bankOwed: 0 }, { bankOwed: { $exists: false } }] },
    ] }, { $inc: { available: -amountCents, held: amountCents, version: 1 },
    $set: { lastEntryAt: new Date() } }, { session, new: true });
  if (!updated) {
    const error = new Error("The available balance changed. Funding is required before booking.");
    error.code = "insufficient_funds"; error.status = 409; throw error;
  }
  await LedgerEntry.updateOne({ _id: entry._id }, { $set: { balanceAfter: {
    available: updated.available, held: updated.held } } }, { session });
  return { entry, ledger: updated };
}

// Only for a new fully-funded booking that has not started work. Historical
// shortfall holds retain voidHold's separate arrears reconciliation rules.
async function releaseBookingFunds({ appointmentId, session }) {
  if (!session?.inTransaction()) throw new Error("Booking release requires a transaction");
  const hold = await LedgerEntry.findOne({ appointmentId, type: "hold" }).session(session);
  if (!hold) return;
  const key = `hold_void:${appointmentId}`;
  if (await LedgerEntry.exists({ idempotencyKey: key }).session(session)) return;
  if (hold.shortfall || await LedgerEntry.exists({ appointmentId, type: "hold_release" }).session(session)) {
    const error = new Error("This booking needs manual payment review."); error.code = "payment_review_required"; error.status = 409; throw error;
  }
  const amountCents = hold.amountCents;
  const [entry] = await LedgerEntry.create([{ landlordId: hold.landlordId, idempotencyKey: key,
    type: "hold_void", amountCents, appointmentId, requestId: hold.requestId, identityId: hold.identityId,
    scope: hold.scope, lines: [{ account: account.held(hold.landlordId), direction: "credit", amountCents },
      { account: account.available(hold.landlordId), direction: "debit", amountCents }], memo: "Booking proposal closed" }], { session });
  const ledger = await LandlordLedger.findOneAndUpdate({ landlordId: hold.landlordId, held: { $gte: amountCents } },
    { $inc: { available: amountCents, held: -amountCents, version: 1 }, $set: { lastEntryAt: new Date() } }, { new: true, session });
  if (!ledger) throw new Error("The held balance requires reconciliation");
  await LedgerEntry.updateOne({ _id: entry._id }, { $set: { balanceAfter: {
    available: ledger.available, held: ledger.held } } }, { session });
}

/**
 * Job cancelled before the work happened. held -> available, minus whatever
 * part of the hold was never funded.
 *
 * Returning the full hold used to credit money that never arrived: a $400 hold
 * against a $50 wallet came back as $400 spendable, with the $350 debt still
 * sitting in arrears beside it.
 */
async function voidHold({ landlordId, appointmentId, amountCents, requestId = null, memo = null }) {
  // Checked up front so a retry never recomputes the split against a balance
  // that has moved since.
  const existing = await LedgerEntry.findOne({ idempotencyKey: `hold_void:${appointmentId}` });
  if (existing) {
    return { entry: existing, ledger: await ensureLedger(landlordId), alreadyApplied: true, guardFailed: false };
  }

  const repay = await holdShortfallOutstanding({ landlordId, appointmentId, heldCents: amountCents });
  const { lines, cacheUpdate } = escrowReturnPosting({ landlordId, heldCents: amountCents, repay });

  return postEntry({
    landlordId,
    idempotencyKey: `hold_void:${appointmentId}`,
    type: "hold_void",
    amountCents,
    lines,
    appointmentId,
    requestId,
    memo,
    cacheUpdate,
    balanceGuard: { held: { $gte: amountCents } },
  });
}

/**
 * The close. Two entries, deliberately:
 *
 *   hold_release  the full ceiling comes back out of escrow
 *   payout        the ACTUAL cost goes to the vendor
 *
 * The difference flows back to available on its own, and the journal reads the
 * way a human would describe it: held 400, released the hold, paid 312.
 *
 * Ordering matters — the release runs FIRST and always succeeds (it gives money
 * back), so the held bucket is never stranded even if the payout then falls
 * short.
 *
 * `settlementId` is the domain identity both keys hang off. It is the
 * completion whenever there is one; a landlord's manual completion of a job the
 * vendor never reported on has no completion, and passes `manual:<appointmentId>`.
 *
 * `deferUncovered` decides what happens to a payout the wallet cannot cover.
 * On the Stripe rail (the default there) the covered part is a `payout` sent
 * now and the rest is a separate `payout:<id>:deferred` entry, awaiting_funds,
 * that nothing sends until a card deposit funds it in full. On the offline rail
 * the landlord pays the vendor directly, so the whole amount is one entry and
 * the gap is simply arrears.
 */
async function releaseHold({
  landlordId,
  appointmentId,
  completionId,
  settlementId = completionId,
  requestId,
  identityId = null,
  heldCents,
  payoutCents,
  scope = {},
  memo = null,
  deferUncovered = activeProvider() === STRIPE_CONNECT,
}) {
  const releaseKey = `release:${settlementId}`;
  const payoutKey = `payout:${settlementId}`;
  const deferredKey = `${payoutKey}:deferred`;

  // A replay returns what the first run wrote. Recomputing the split against a
  // balance that has moved since could disagree with it. A run that crashed
  // after the release but before the payout falls through and posts the payout
  // (the release's own key makes re-posting it a no-op).
  const priorRelease = await LedgerEntry.findOne({ idempotencyKey: releaseKey });
  const priorPayout = priorRelease ? await LedgerEntry.findOne({ idempotencyKey: payoutKey }) : null;
  const priorDeferred = priorRelease ? await LedgerEntry.findOne({ idempotencyKey: deferredKey }) : null;
  if (priorRelease && (priorPayout || priorDeferred)) {
    const ledger = await ensureLedger(landlordId);
    const wrap = (entry) => (entry ? { entry, ledger, alreadyApplied: true, guardFailed: false } : null);
    const uncoveredCents = priorDeferred
      ? priorDeferred.amountCents
      : priorPayout
        ? lineTotal(priorPayout.lines, account.arrears(landlordId), "credit")
        : 0;
    return {
      release: wrap(priorRelease),
      payout: wrap(priorPayout),
      deferred: wrap(priorDeferred),
      shortfall: uncoveredCents > 0,
      uncoveredCents,
    };
  }

  // The escrow comes back minus its own never-funded part. Releasing the full
  // amount was the bug that credited money which never arrived: hold $400
  // against $50, finish at $30, and the wallet read $370 while still owing $350.
  const repay = await holdShortfallOutstanding({ landlordId, appointmentId, heldCents });
  const escrow = escrowReturnPosting({ landlordId, heldCents, repay });

  const release = await postEntry({
    landlordId,
    idempotencyKey: releaseKey,
    type: "hold_release",
    amountCents: heldCents,
    lines: escrow.lines,
    appointmentId,
    completionId,
    requestId,
    identityId,
    scope,
    memo,
    cacheUpdate: escrow.cacheUpdate,
    // No guard: releasing escrow can never overdraw. If held is somehow short,
    // reconcile surfaces it rather than this silently refusing.
  });

  // Same split as createHold, and for the same reason: only the UNCOVERED part
  // is a debt. Booking the whole payout as arrears (as a naive shortfall branch
  // does) invents money — it leaves `available` untouched while claiming the
  // full amount is owed. Reachable whenever the payout exceeds the hold, which
  // is exactly what an approved overage is.
  const afterRelease = await ensureLedger(landlordId);
  const covered = Math.max(0, Math.min(afterRelease.available, payoutCents));
  const uncovered = payoutCents - covered;

  const common = {
    landlordId,
    type: "payout",
    appointmentId,
    completionId,
    requestId,
    identityId,
    holdEntryId: release.entry?._id || null,
    scope,
    memo,
  };

  if (!deferUncovered) {
    const payoutLines = [
      { account: account.vendorPayable(identityId), direction: "debit", amountCents: payoutCents },
    ];
    if (covered > 0) {
      payoutLines.push({ account: account.available(landlordId), direction: "credit", amountCents: covered });
    }
    if (uncovered > 0) {
      payoutLines.push({ account: account.arrears(landlordId), direction: "credit", amountCents: uncovered });
    }

    const payout = await postEntry({
      ...common,
      idempotencyKey: payoutKey,
      amountCents: payoutCents,
      lines: payoutLines,
      providerStatus: "pending",
      shortfall: uncovered > 0,
      cacheUpdate: {
        available: -covered,
        lifetimeReleased: payoutCents,
        ...(uncovered > 0 ? { arrears: uncovered } : {}),
      },
      balanceGuard: { available: { $gte: covered } },
    });

    // The work is done and the vendor is owed either way. The completion closes
    // regardless — a work record must never be held hostage to a wallet.
    return { release, payout, deferred: null, shortfall: uncovered > 0, uncoveredCents: uncovered };
  }

  const payout =
    covered > 0
      ? await postEntry({
          ...common,
          idempotencyKey: payoutKey,
          amountCents: covered,
          lines: [
            { account: account.vendorPayable(identityId), direction: "debit", amountCents: covered },
            { account: account.available(landlordId), direction: "credit", amountCents: covered },
          ],
          providerStatus: "pending",
          cacheUpdate: { available: -covered, lifetimeReleased: covered },
          balanceGuard: { available: { $gte: covered } },
        })
      : null;

  // Owed to the vendor, recorded as the landlord's debt, and NOT sent: the
  // shared Stripe balance holds other landlords' money too.
  const deferred =
    uncovered > 0
      ? await postEntry({
          ...common,
          idempotencyKey: deferredKey,
          amountCents: uncovered,
          lines: [
            { account: account.vendorPayable(identityId), direction: "debit", amountCents: uncovered },
            { account: account.arrears(landlordId), direction: "credit", amountCents: uncovered },
          ],
          providerStatus: AWAITING_FUNDS,
          shortfall: true,
          memo: memo ? `${memo} (remainder awaiting funds)` : "Remainder awaiting funds",
          cacheUpdate: { arrears: uncovered },
        })
      : null;

  return { release, payout, deferred, shortfall: uncovered > 0, uncoveredCents: uncovered };
}

/**
 * Bill Artrelo's service fee for one settled job.
 *
 *     debit  platform:fee   fee        (billed in full, always)
 *     credit available      covered    (what the wallet had after the payout)
 *     credit fees_owed      owed       (the rest, a debt)
 *
 * Called AFTER the job's payout: the vendor has first claim on the wallet, so
 * the fee only ever takes what the payout left behind.
 *
 * THE REST IS A DEBT, NOT A LOSS. An earlier version simply did not collect
 * what the wallet could not cover -- which let a landlord avoid the fee by
 * keeping exactly a job's cost in the wallet. The shortfall is now owed and a
 * later top-up pays it (applyDepositToArrears), after any vendor is paid.
 *
 * NOT ARREARS. fees_owed is its own account and its own cache field,
 * `feesOwed`. Arrears is read as having exactly two sources (see
 * unfundedDeferredCents / holdShortfallOutstanding): anything that is not an
 * awaiting_funds payout counts as booking shortfall. Fee debt in arrears would
 * be cancelled by the next hold release and shown to the landlord as "a
 * booking your balance doesn't cover".
 *
 * Own key, `fee:<settlementId>`, separate from releaseHold's: its replay
 * returns early, so a fee posted inside it would be skipped forever by a crash
 * between the payout and the fee.
 *
 * THE RACE. `covered` is read, then spent under a guard. If another spend lands
 * in between, the guard fails and postEntry has already written the entry
 * WITHOUT moving the cache. settleLostFeeRace marks it, reverses it (also
 * without moving the cache) and re-bills the whole fee as owed -- so even a
 * lost race costs Artrelo nothing and the journal still reproduces the cache.
 *
 * Returns { entry, feeCents, collectedCents, owedCents, alreadyApplied }.
 */
async function chargeServiceFee({
  landlordId,
  settlementId,
  amountCents,
  requestId = null,
  appointmentId = null,
  completionId = null,
  scope = {},
  memo = null,
}) {
  assertCents(amountCents, "amountCents");
  const feeKey = `fee:${settlementId}`;
  const common = { landlordId, requestId, appointmentId, completionId, scope };

  // A replay reports what the first run did rather than recomputing it against
  // a balance that has moved since.
  const prior = await LedgerEntry.findOne({ idempotencyKey: feeKey });
  if (prior) {
    if (prior.shortfall) return settleLostFeeRace({ entry: prior, common, alreadyApplied: true });
    return { ...describeFeeEntry(prior, landlordId), alreadyApplied: true };
  }

  if (amountCents <= 0) return { entry: null, feeCents: 0, collectedCents: 0, owedCents: 0, alreadyApplied: false };

  const ledger = await ensureLedger(landlordId);
  const covered = Math.max(0, Math.min(ledger.available || 0, amountCents));
  const owed = amountCents - covered;

  const lines = [{ account: account.fee(), direction: "debit", amountCents }];
  if (covered > 0) lines.push({ account: account.available(landlordId), direction: "credit", amountCents: covered });
  if (owed > 0) lines.push({ account: account.feesOwed(landlordId), direction: "credit", amountCents: owed });

  const result = await postEntry({
    ...common,
    idempotencyKey: feeKey,
    type: "fee",
    amountCents,
    lines,
    memo: memo || "Artrelo service fee",
    cacheUpdate: { available: -covered, ...(owed > 0 ? { feesOwed: owed } : {}) },
    balanceGuard: { available: { $gte: covered } },
  });

  if (result.alreadyApplied) {
    // Lost a race with an identical call; report the winner's outcome.
    if (result.entry.shortfall) return settleLostFeeRace({ entry: result.entry, common, alreadyApplied: true });
    return { ...describeFeeEntry(result.entry, landlordId), alreadyApplied: true };
  }
  if (result.guardFailed) return settleLostFeeRace({ entry: result.entry, common, alreadyApplied: false });

  return { entry: result.entry, feeCents: amountCents, collectedCents: covered, owedCents: owed, alreadyApplied: false };
}

/** What a fee entry collected and left owing, read off its own lines. */
function describeFeeEntry(entry, landlordId) {
  return {
    entry,
    feeCents: entry.amountCents,
    collectedCents: lineTotal(entry.lines, account.available(landlordId), "credit"),
    owedCents: lineTotal(entry.lines, account.feesOwed(landlordId), "credit"),
  };
}

/**
 * A fee entry whose guard failed: it is in the journal but never moved the
 * cache. Three steps, each keyed so a crash anywhere resumes rather than
 * repeats:
 *   1. mark it shortfall, so reconcile does not mistake it for a crash;
 *   2. reverse its lines exactly (`fee:<id>:void`), cache untouched -- the two
 *      net to zero, which is what the unmoved cache already says;
 *   3. re-bill the whole fee as owed (`fee:<id>:owed`), which DOES move the
 *      cache. No balance is read, so there is nothing left to race.
 */
async function settleLostFeeRace({ entry, common, alreadyApplied }) {
  const feeKey = entry.idempotencyKey;
  if (!entry.shortfall) await LedgerEntry.updateOne({ _id: entry._id }, { $set: { shortfall: true } });

  await postEntry({
    ...common,
    idempotencyKey: `${feeKey}:void`,
    type: "refund",
    amountCents: entry.amountCents,
    lines: entry.lines.map((line) => ({
      account: line.account,
      direction: line.direction === "debit" ? "credit" : "debit",
      amountCents: line.amountCents,
    })),
    holdEntryId: entry._id,
    memo: "Service fee re-billed (the balance changed while it was being taken)",
    // The fee entry never moved the cache, so its reversal must not either.
    cacheUpdate: {},
  });

  const owed = await postEntry({
    ...common,
    idempotencyKey: `${feeKey}:owed`,
    type: "fee",
    amountCents: entry.amountCents,
    lines: [
      { account: account.fee(), direction: "debit", amountCents: entry.amountCents },
      { account: account.feesOwed(common.landlordId), direction: "credit", amountCents: entry.amountCents },
    ],
    holdEntryId: entry._id,
    memo: entry.memo,
    cacheUpdate: { feesOwed: entry.amountCents },
  });

  return {
    entry: owed.entry,
    feeCents: entry.amountCents,
    collectedCents: 0,
    owedCents: entry.amountCents,
    alreadyApplied: alreadyApplied || owed.alreadyApplied,
  };
}

/* ------------------------------------------------------------------ *
 * Bank top-ups going wrong. See services/ledger/bankTopUp.service.js.
 * ------------------------------------------------------------------ */

/**
 * Take `amountCents` off a landlord: what the wallet has, the rest as bank_owed.
 *
 *     debit  <debitAccount>   amount
 *     credit available        covered
 *     credit bank_owed        the rest
 *
 * The same shape and the same lost race as chargeServiceFee: `covered` is read,
 * then spent under a guard; if another spend lands in between, the entry is in
 * the journal without having moved the cache. It is then marked, reversed
 * exactly (cache untouched) and re-posted entirely as owed -- keyed so a crash
 * anywhere resumes rather than repeats, and no balance is read the second time.
 *
 * `extraCache` rides on whichever entry actually moves the cache, exactly once.
 */
async function takeOrOwe({ landlordId, idempotencyKey, type, amountCents, debitAccount, memo, extraCache = {}, common = {} }) {
  assertCents(amountCents, "amountCents");
  const prior = await LedgerEntry.findOne({ idempotencyKey });
  if (prior && !prior.shortfall) return { ...describeTakeOrOwe(prior, landlordId), alreadyApplied: true };

  let entry = prior;
  let alreadyApplied = Boolean(prior);
  if (!prior) {
    const ledger = await ensureLedger(landlordId);
    const covered = Math.max(0, Math.min(ledger.available || 0, amountCents));
    const owed = amountCents - covered;
    const lines = [{ account: debitAccount, direction: "debit", amountCents }];
    if (covered > 0) lines.push({ account: account.available(landlordId), direction: "credit", amountCents: covered });
    if (owed > 0) lines.push({ account: account.bankOwed(landlordId), direction: "credit", amountCents: owed });

    const result = await postEntry({
      landlordId,
      ...common,
      idempotencyKey,
      type,
      amountCents,
      lines,
      memo,
      cacheUpdate: { ...extraCache, available: -covered, ...(owed > 0 ? { bankOwed: owed } : {}) },
      balanceGuard: { available: { $gte: covered } },
    });
    if (!result.guardFailed && !(result.alreadyApplied && result.entry?.shortfall)) {
      const described = describeTakeOrOwe(result.entry, landlordId);
      return { ...described, alreadyApplied: result.alreadyApplied };
    }
    entry = result.entry;
    alreadyApplied = result.alreadyApplied;
  }

  // The lost race (now, or by an earlier run that crashed part-way).
  if (!entry.shortfall) await LedgerEntry.updateOne({ _id: entry._id }, { $set: { shortfall: true } });
  await postEntry({
    landlordId,
    ...common,
    idempotencyKey: `${idempotencyKey}:void`,
    type: "refund",
    amountCents,
    lines: entry.lines.map((line) => ({
      account: line.account,
      direction: line.direction === "debit" ? "credit" : "debit",
      amountCents: line.amountCents,
    })),
    holdEntryId: entry._id,
    memo: "Re-posted (the balance changed while it was being taken)",
    cacheUpdate: {},
  });
  const owed = await postEntry({
    landlordId,
    ...common,
    idempotencyKey: `${idempotencyKey}:owed`,
    type,
    amountCents,
    lines: [
      { account: debitAccount, direction: "debit", amountCents },
      { account: account.bankOwed(landlordId), direction: "credit", amountCents },
    ],
    holdEntryId: entry._id,
    memo,
    cacheUpdate: { ...extraCache, bankOwed: amountCents },
  });
  return { entry: owed.entry, takenCents: 0, owedCents: amountCents, alreadyApplied: alreadyApplied || owed.alreadyApplied };
}

function describeTakeOrOwe(entry, landlordId) {
  return {
    entry,
    takenCents: lineTotal(entry.lines, account.available(landlordId), "credit"),
    owedCents: lineTotal(entry.lines, account.bankOwed(landlordId), "credit"),
  };
}

/**
 * A disputed bank top-up, taken back. Stripe has already pulled the money out
 * of the platform balance; this makes the wallet say so.
 *
 *     debit  external:funding   amount
 *     credit available          what the wallet still has
 *     credit bank_owed          what was already spent
 *
 * NEVER ARREARS: arrears is read as a vendor waiting or an under-funded booking,
 * and a reversal booked there would be cancelled by the next hold release.
 * Keyed on the dispute, so Stripe re-sending the event reverses once.
 */
async function reverseBankDeposit({ landlordId, disputeId, amountCents, paymentIntentId = null }) {
  return takeOrOwe({
    landlordId,
    idempotencyKey: `deposit_reversal:${disputeId}`,
    type: "deposit_reversal",
    amountCents,
    debitAccount: account.funding(),
    memo: "Bank top-up reversed (disputed at the bank)",
    // Lifetime deposits stop counting money that did not, in the end, arrive.
    extraCache: { lifetimeDeposited: -amountCents },
    common: { provider: "stripe", providerRef: paymentIntentId, providerStatus: "paid", fundingSource: "stripe" },
  });
}

/** The fee for a failed or disputed debit. `key` names the event: bank_fee:<pi> or bank_fee:<disputeId>. */
async function chargeBankFee({ landlordId, key, amountCents, memo, paymentIntentId = null }) {
  if (!(amountCents > 0)) return { entry: null, takenCents: 0, owedCents: 0, alreadyApplied: false };
  return takeOrOwe({
    landlordId,
    idempotencyKey: `bank_fee:${key}`,
    type: "bank_fee",
    amountCents,
    debitAccount: account.bankFees(),
    memo,
    common: { providerRef: paymentIntentId },
  });
}

/**
 * Attempt the external transfer for a payout entry that is already in the
 * journal.
 *
 * Split from releaseHold on purpose: the LEDGER is authoritative about what is
 * owed, and the provider only ever reports what happened to the transfer. A
 * failed transfer therefore changes providerStatus and nothing else — the debt
 * to the vendor stays exactly where it was.
 *
 * Never throws, for the same reason.
 */
async function settlePayout({ entryId }) {
  const entry = await LedgerEntry.findById(entryId);
  if (!entry || entry.type !== "payout") return null;
  if (entry.providerStatus === "paid") return { alreadyPaid: true, entry };
  // Unfunded. Sending it would draw on other landlords' money in the shared
  // platform balance; applyDepositToArrears flips it to pending once funded.
  if (entry.providerStatus === AWAITING_FUNDS) return { alreadyPaid: false, refused: "awaiting_funds", entry };

  // A reversed top-up can invalidate funds that were already held for a job.
  // Check on EVERY attempt, including onboarding and clearance retries.
  const funding = await ensureLedger(entry.landlordId);
  if ((funding.bankOwed || 0) > 0) return { alreadyPaid: false, refused: "funding_reversed", entry };

  const identity = entry.identityId ? await VendorIdentity.findById(entry.identityId) : null;
  const previousStatus = entry.providerStatus;

  const result = await sendPayout({
    identity,
    amountCents: entry.amountCents,
    currency: entry.currency,
    // The SAME key the entry carries, so a retry at any layer converges on one
    // transfer rather than two.
    idempotencyKey: entry.idempotencyKey,
    memo: entry.memo,
    metadata: {
      artreloEntryId: String(entry._id),
      artreloCompletionId: entry.completionId ? String(entry.completionId) : "",
    },
    aheadCents: await clearanceQueueAheadCents(entry),
  });

  // A refusal never overwrites a payout something else has meanwhile SENT: a
  // sweep and a webhook can settle the same entry at once, and the one that
  // lost must not turn "paid" back into "awaiting_clearance".
  await LedgerEntry.updateOne(
    result.status === "paid" ? { _id: entry._id } : { _id: entry._id, providerStatus: { $ne: "paid" } },
    {
      $set: {
        provider: result.provider,
        providerStatus: result.status,
        providerRef: result.reference,
        providerError: result.error,
        clearsOn: result.clearsOn || null,
      },
    }
  );

  publish(entry.landlordId, "wallet");

  // Telling people is never the reason money did not move.
  try {
    await payoutNotices.announcePayoutTransition({ entry, from: previousStatus, result });
  } catch (err) {
    console.error("[ledger] payout announcement failed", String(entry._id), err.message);
  }

  return { alreadyPaid: false, entry, result };
}

/** Older payouts parked on the same pending money, which will be sent first. */
async function clearanceQueueAheadCents(entry) {
  const ahead = await LedgerEntry.find({
    type: "payout",
    providerStatus: AWAITING_CLEARANCE,
    _id: { $ne: entry._id },
    createdAt: { $lt: entry.createdAt },
  })
    .select("amountCents")
    .lean();
  return ahead.reduce((total, row) => total + row.amountCents, 0);
}

/**
 * Send every payout that was waiting on Stripe to clear funds, oldest first.
 *
 * Platform-wide, not per landlord: Stripe's balance is one pool, so whatever
 * cleared may be able to pay any of them. Each settlePayout re-checks the
 * available balance before it transfers, so a payout the cleared money does
 * not yet cover simply stays parked (with a fresh estimate) and costs nothing.
 *
 * Runs from the balance.available webhook and from the hourly sweep. Safe from
 * both at once for the same reasons drainParkedPayouts is.
 */
async function releaseClearedPayouts({ limit = 50 } = {}) {
  const parked = await LedgerEntry.find({ type: "payout", providerStatus: AWAITING_CLEARANCE })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select("_id")
    .lean();

  let sent = 0;
  for (const row of parked) {
    try {
      const outcome = await settlePayout({ entryId: row._id });
      if (outcome?.result?.status === "paid" || outcome?.alreadyPaid) sent += 1;
    } catch (err) {
      console.error("[ledger] cleared payout settle failed", String(row._id), err.message);
    }
  }

  if (sent) console.log(`[ledger] sent ${sent} payout(s) that were waiting on Stripe to clear funds`);
  return { found: parked.length, sent };
}

/**
 * Settle every payout parked against a vendor who has just become payable.
 *
 * Shared by the webhook and the polling path ON PURPOSE. The webhook is the
 * primary route, but it is not guaranteed: Stripe gives up after its retry
 * schedule, and in development a dropped `stripe listen` tunnel loses the event
 * outright. Without a second route, a single missed event leaves a vendor owed
 * money with nothing in the system that will ever nudge it — the payout sits at
 * pending_onboarding forever.
 *
 * Safe to run from both. settlePayout short-circuits on an already-paid entry
 * and passes the ledger idempotency key through as Stripe's, so a webhook and a
 * poll racing each other converge on one transfer rather than two.
 */
async function drainParkedPayouts({ identityId }) {
  if (!identityId) return { settled: 0 };

  const parked = await LedgerEntry.find({
    identityId,
    type: "payout",
    providerStatus: "pending_onboarding",
  })
    .select("_id")
    .lean();

  let settled = 0;
  for (const entry of parked) {
    try {
      const result = await settlePayout({ entryId: entry._id });
      if (result?.result?.status === "paid" || result?.alreadyPaid) settled += 1;
    } catch (err) {
      console.error("[ledger] drain settle failed", String(entry._id), err.message);
    }
  }

  if (settled) console.log(`[ledger] drained ${settled} parked payout(s) for ${identityId}`);
  return { settled, found: parked.length };
}

/**
 * Record an OFF-PLATFORM payment by hand.
 *
 * "Paid" is a claim about the world, and who is entitled to make it depends on
 * the rail:
 *
 *   offline rail   — there is no transfer to observe, so a human saying "I
 *                    e-transferred them" IS the evidence. That is the point of
 *                    the rail and this is how it settles.
 *   Stripe rail    — a transfer either happened or it did not, and the webhook
 *                    knows. A person asserting it adds nothing and can be
 *                    wrong.
 *
 * The refusals below exist because they were not there before: a landlord
 * marked a payout paid for a vendor with NO Connect account and no transfer,
 * and the system recorded $176 as delivered to someone who had never said where
 * to send it. The vendor's hub showed "Paid".
 *
 * Returns { entry, refused } so the caller can explain rather than fail silently.
 */
const MANUAL_PAYABLE_STATUSES = ["pending_manual", "failed"];

async function markPayoutPaid({ entryId, reference = null, actor = "landlord" }) {
  const entry = await LedgerEntry.findOne({ _id: entryId, type: "payout" });
  if (!entry) return { entry: null, refused: "not_found" };
  if (entry.providerStatus === "paid") return { entry, refused: "already_paid" };

  // No destination exists. Whatever happened, it was not a payment to this
  // vendor — they have never told anyone where to send it.
  if (entry.providerStatus === "pending_onboarding") {
    return { entry, refused: "no_payout_destination" };
  }

  // Mid-flight on the Stripe rail. settlePayout or the webhook will resolve it,
  // and overwriting that with a human guess loses the real outcome.
  if (entry.providerStatus === "pending" && entry.provider === "stripe_connect") {
    return { entry, refused: "settles_automatically" };
  }

  // Paid for and queued to send by itself the moment Stripe clears the money.
  // Paying by hand as well would pay the vendor twice: the sweep does not know
  // about an e-transfer.
  if (entry.providerStatus === AWAITING_CLEARANCE) {
    return { entry, refused: "settles_automatically" };
  }

  if (!MANUAL_PAYABLE_STATUSES.includes(entry.providerStatus)) {
    return { entry, refused: "not_manually_payable" };
  }

  const updated = await LedgerEntry.findOneAndUpdate(
    { _id: entryId, type: "payout", providerStatus: entry.providerStatus },
    {
      $set: {
        providerStatus: "paid",
        providerRef: reference,
        // Recorded as an out-of-band settlement, not as a Stripe transfer —
        // there is no transfer id and never will be for this entry.
        provider: "offline",
        actor,
        providerError: null,
      },
    },
    { new: true }
  );

  return { entry: updated, refused: updated ? null : "raced" };
}

/** Read model for the wallet UI and getStats. */
async function getBalance(landlordId) {
  const ledger = await ensureLedger(landlordId);
  return {
    available: ledger.available,
    held: ledger.held,
    arrears: ledger.arrears,
    feesOwed: ledger.feesOwed || 0,
    bankOwed: ledger.bankOwed || 0,
    currency: ledger.currency,
    lifetimeDeposited: ledger.lifetimeDeposited,
    lifetimeReleased: ledger.lifetimeReleased,
  };
}

module.exports = {
  account,
  ensureLedger,
  postEntry,
  recordDeposit,
  createHold,
  reserveBookingFunds,
  releaseBookingFunds,
  voidHold,
  releaseHold,
  chargeServiceFee,
  reverseBankDeposit,
  chargeBankFee,
  settlePayout,
  settleFundedPayouts,
  unfundedDeferredCents,
  drainParkedPayouts,
  releaseClearedPayouts,
  markPayoutPaid,
  getBalance,
};
