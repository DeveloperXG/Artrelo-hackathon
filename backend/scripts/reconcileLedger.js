// Proves the ledger is telling the truth.
//
// Three independent checks, in increasing order of what they'd catch:
//
//  1. Every entry's lines sum to zero. A violation means a posting bug.
//  2. The LandlordLedger cache equals the journal replayed from scratch. A
//     violation means a crash between the entry insert and the cache $inc —
//     which is exactly the window the ordering rule leaves open on purpose,
//     because an unapplied entry is recoverable and a doubled payment is not.
//  3. `held` equals getStats' committedCost over the appointment-backed subset.
//  4. Every service fee the journal took matches what the job's JobCompletion
//     says was charged, and vice versa. The fee decision lives in two places
//     (the ledger entry, and the completion's record of it -- the only trace of
//     a fee waived in the beta), so they are checked against each other.
//
// Check 3 is the reason C1 ships in shadow before any UI. committedCost is
// computed independently, from request.estimatedCost over non-terminal requests
// with a selectedVendorId — so it is a FREE second opinion on the entire hold
// lifecycle, written by code that knows nothing about the ledger.
//
// One divergence is expected and encoded: committedCost also counts
// pending/queued requests that have a selectedVendorId but no appointment yet.
// Those were never held, so the comparison is restricted to the
// appointment-backed subset.
//
// Usage: node scripts/reconcileLedger.js [--fix-balance-after] [--landlord <id>]

const mongoose = require("mongoose");
const env = require("../config/env");
const LedgerEntry = require("../models/LedgerEntry");
const { linesBalance } = require("../models/LedgerEntry");
const LandlordLedger = require("../models/LandlordLedger");
const Appointment = require("../models/Appointment");
const MaintenanceRequest = require("../models/MaintenanceRequest");
const JobCompletion = require("../models/JobCompletion");
const { toCents, fromCents } = require("../services/ledger/money");

const TERMINAL = ["completed", "rejected", "cancelled"];

/**
 * Replays the journal into { available, held, arrears, feesOwed, bankOwed } from zero.
 *
 * Arrears, feesOwed and bankOwed are liabilities, so their sign is the other way round: a
 * credit (an under-funded hold, an uncovered payout, an uncovered fee) raises
 * them, and a debit (a release cancelling its own unfunded part, a settlement
 * out of a deposit) pays them down.
 */
function replayEntries(entries, landlordId) {
  const acct = {
    available: `landlord:${landlordId}:available`,
    held: `landlord:${landlordId}:held`,
    arrears: `landlord:${landlordId}:arrears`,
    feesOwed: `landlord:${landlordId}:fees_owed`,
    bankOwed: `landlord:${landlordId}:bank_owed`,
  };
  const balance = { available: 0, held: 0, arrears: 0, feesOwed: 0, bankOwed: 0 };

  for (const entry of entries) {
    for (const line of entry.lines) {
      const delta = line.direction === "debit" ? line.amountCents : -line.amountCents;
      if (line.account === acct.available) balance.available += delta;
      else if (line.account === acct.held) balance.held += delta;
      else if (line.account === acct.arrears) balance.arrears -= delta;
      else if (line.account === acct.feesOwed) balance.feesOwed -= delta;
      else if (line.account === acct.bankOwed) balance.bankOwed -= delta;
    }
  }
  return balance;
}

/**
 * Fees BILLED per completion, from the journal -- collected at the close plus
 * whatever was left owing. A fee entry that lost its race is marked shortfall
 * and reversed by `fee:<id>:void`; its replacement, `fee:<id>:owed`, is what
 * counts. Fees with no completion (a manual close of a job the vendor never
 * reported) have no record to compare against and are skipped.
 */
function feesTakenByCompletion(entries) {
  const taken = new Map();
  for (const entry of entries) {
    if (entry.type !== "fee" || !entry.completionId || entry.shortfall) continue;
    const key = String(entry.completionId);
    taken.set(key, (taken.get(key) || 0) + entry.amountCents);
  }
  return taken;
}

async function checkServiceFees({ landlordId, entries }) {
  const problems = [];
  const taken = feesTakenByCompletion(entries);
  const recorded = await JobCompletion.find({ landlordId, "ledger.serviceFee": { $ne: null } })
    .select("_id ledger.serviceFee")
    .lean();
  const recordedById = new Map(recorded.map((c) => [String(c._id), c.ledger.serviceFee.chargedCents || 0]));

  for (const [completionId, cents] of taken) {
    const claimed = recordedById.get(completionId);
    if (claimed === undefined) {
      problems.push(`fee of ${cents} cents billed for completion ${completionId}, which has no recorded fee decision`);
    } else if (claimed !== cents) {
      problems.push(`completion ${completionId} records a ${claimed}-cent fee but the journal billed ${cents}`);
    }
  }
  for (const [completionId, claimed] of recordedById) {
    if (claimed > 0 && !taken.has(completionId)) {
      problems.push(`completion ${completionId} records a ${claimed}-cent fee that the journal never billed`);
    }
  }
  return problems;
}

async function reconcile({ landlordFilter = null, fixBalanceAfter = false } = {}) {
  const problems = [];
  const ledgerQuery = landlordFilter ? { landlordId: landlordFilter } : {};
  const ledgers = await LandlordLedger.find(ledgerQuery).lean();

  console.log(`Reconciling ${ledgers.length} landlord ledger(s)...\n`);

  for (const ledger of ledgers) {
    const landlordId = String(ledger.landlordId);
    const entries = await LedgerEntry.find({ landlordId: ledger.landlordId })
      .sort({ createdAt: 1 })
      .lean();

    console.log(`landlord ${landlordId} — ${entries.length} entr(ies)`);

    /* -- 1. Lines balance ------------------------------------------------- */
    for (const entry of entries) {
      if (!linesBalance(entry.lines)) {
        problems.push(`entry ${entry._id} (${entry.type}) lines do not sum to zero`);
      }
      if (entry.balanceAfter?.available === null || entry.balanceAfter?.available === undefined) {
        // Not necessarily a problem: a guard-failed entry legitimately has none.
        if (!entry.shortfall) {
          problems.push(
            `entry ${entry._id} (${entry.type}) has no balanceAfter — likely a crash between insert and cache update`
          );
          if (fixBalanceAfter) {
            const upTo = entries.filter((e) => e.createdAt <= entry.createdAt);
            const replayed = replayEntries(upTo, landlordId);
            await LedgerEntry.updateOne(
              { _id: entry._id },
              { $set: { "balanceAfter.available": replayed.available, "balanceAfter.held": replayed.held } }
            );
            console.log(`  repaired balanceAfter on ${entry._id}`);
          }
        }
      }
    }

    /* -- 2. Cache equals the replayed journal ----------------------------- */
    const replayed = replayEntries(entries, landlordId);
    // Every arrears movement is now a journal line — including a deposit paying
    // it down, which used to be a bare cache $inc. So available, held and
    // arrears must all match the replay EXACTLY. (This used to compare available
    // against "replay + arrears", a formula from an older shortfall design that
    // misreported every wallet that had ever been in arrears.)
    if (ledger.available !== replayed.available) {
      problems.push(
        `available mismatch: cache ${ledger.available}, journal ${replayed.available} ` +
          `(diff ${ledger.available - replayed.available} cents)`
      );
    } else {
      console.log(`  available OK: ${fromCents(ledger.available)}`);
    }

    if ((ledger.arrears || 0) !== replayed.arrears) {
      problems.push(`arrears mismatch: cache ${ledger.arrears || 0}, journal ${replayed.arrears}`);
    } else {
      console.log(`  arrears OK: ${fromCents(replayed.arrears)}`);
    }

    if ((ledger.feesOwed || 0) !== replayed.feesOwed) {
      problems.push(`feesOwed mismatch: cache ${ledger.feesOwed || 0}, journal ${replayed.feesOwed}`);
    } else {
      console.log(`  unpaid service fees OK: ${fromCents(replayed.feesOwed)}`);
    }

    if ((ledger.bankOwed || 0) !== replayed.bankOwed) {
      problems.push(`bankOwed mismatch: cache ${ledger.bankOwed || 0}, journal ${replayed.bankOwed}`);
    } else {
      console.log(`  owed on bank top-ups OK: ${fromCents(replayed.bankOwed)}`);
    }

    if (ledger.held !== replayed.held) {
      problems.push(`held mismatch: cache ${ledger.held}, journal ${replayed.held}`);
    } else {
      console.log(`  held OK: ${fromCents(ledger.held)}`);
    }

    /* -- 3. held vs committedCost (the free second opinion) --------------- */
    const openRequests = await MaintenanceRequest.find({
      landlordId: ledger.landlordId,
      status: { $nin: TERMINAL },
      selectedVendorId: { $ne: null },
    })
      .select("_id estimatedCost")
      .lean();

    const requestIds = openRequests.map((r) => r._id);
    // The appointment-backed subset only: a request with a selectedVendorId but
    // no appointment was never held. Nor was a direct-pay booking -- the
    // landlord pays that vendor themselves, so nothing is escrowed for it.
    const appointments = await Appointment.find({
      requestId: { $in: requestIds },
      status: { $nin: ["completed", "cancelled", "failed"] },
      paymentMode: { $ne: "direct" },
    })
      .select("requestId")
      .lean();

    const backed = new Set(appointments.map((a) => String(a.requestId)));
    const committedCents = openRequests
      .filter((r) => backed.has(String(r._id)))
      .reduce((total, r) => total + toCents(r.estimatedCost || 0), 0);

    if (committedCents !== ledger.held) {
      problems.push(
        `held (${ledger.held}) != committedCost over appointment-backed requests (${committedCents}), ` +
          `diff ${ledger.held - committedCents} cents`
      );
    } else {
      console.log(`  held == committedCost: ${fromCents(committedCents)}`);
    }

    /* -- 4. Service fees: the journal vs the completions' records --------- */
    const feeProblems = await checkServiceFees({ landlordId: ledger.landlordId, entries });
    if (feeProblems.length) problems.push(...feeProblems);
    else console.log("  service fees agree with completions");

    if (ledger.arrears > 0) console.log(`  arrears outstanding: ${fromCents(ledger.arrears)}`);
    console.log("");
  }

  if (problems.length) {
    console.error(`FAILED — ${problems.length} problem(s):`);
    problems.forEach((p) => console.error(`  - ${p}`));
    return { ok: false, problems };
  }

  console.log("OK — journal, cache, and committedCost all agree.");
  return { ok: true, problems: [] };
}

if (require.main === module) {
  const landlordArg = process.argv.indexOf("--landlord");

  (async () => {
    await mongoose.connect(env.mongodb_uri);
    const result = await reconcile({
      landlordFilter: landlordArg > -1 ? process.argv[landlordArg + 1] : null,
      fixBalanceAfter: process.argv.includes("--fix-balance-after"),
    });
    process.exitCode = result.ok ? 0 : 1;
  })()
    .catch((err) => {
      console.error("[reconcileLedger] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = { reconcile, replayEntries, feesTakenByCompletion, checkServiceFees };
