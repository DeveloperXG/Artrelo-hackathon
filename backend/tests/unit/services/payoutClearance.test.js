// Payouts that wait for Stripe to clear card money.
//
// The production incident this pins (2026-10-11): a landlord topped up by card
// and the job closed the same day. The card money was in Stripe's PENDING
// balance (clearing 5 days later), the transfer was refused with
// balance_insufficient, and the payout was recorded as "failed" with an email
// promising a retry that nothing would ever perform.
//
// What must hold now:
//   1. A payout the pending balance will cover PARKS (awaiting_clearance) and
//      the transfer is NOT attempted: Stripe replays a refused request's
//      response for its idempotency key for 24h+, so a doomed attempt would
//      make the eventual retry fail too (pinned in the sandbox, 2026-10-12).
//   2. It sends itself, with the SAME key, once the available balance covers it.
//   3. The landlord is told when it parks; the vendor and landlord when it goes;
//      the landlord when it genuinely fails. A re-park says nothing.
//   4. A refusal never overwrites a payout something else already sent.
//
// Stripe shapes below are copied off the sandbox: balance.retrieve buckets by
// currency, pending card charges carry available_on at 00:00 UTC.

const assert = require("assert");
require("../../../models/LandlordLedger").findOne = async () => ({ bankOwed: 0 });

/* ---------------- Stub everything the services touch, BEFORE requiring them -- */

const sent = { notifications: [], emails: [], actions: [], transfers: [] };

const notify = require("../../../services/notification/notify.service");
notify.notifyUser = async (args) => {
  sent.notifications.push(args);
  return {};
};
const email = require("../../../services/notification/email.service");
email.sendEmail = async (args) => {
  sent.emails.push(args);
  return { delivered: true };
};
const audit = require("../../../services/audit/agentAction.service");
audit.logAgentAction = async (args) => {
  sent.actions.push(args);
};

// A query that works awaited directly, or through .select()/.lean().
const query = (value) => {
  const q = {
    select: () => q,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
};

const LedgerEntry = require("../../../models/LedgerEntry");
const VendorIdentity = require("../../../models/VendorIdentity");
const VendorOutreach = require("../../../models/VendorOutreach");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const Landlord = require("../../../models/Landlord");

let rows = [];

// Equality plus the operators these services use.
const matches = (row, filter) =>
  Object.entries(filter).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$ne" in cond) return String(value) !== String(cond.$ne);
      if ("$lt" in cond) return value < cond.$lt;
      if ("$in" in cond) return cond.$in.map(String).includes(String(value));
    }
    return String(value) === String(cond);
  });

// findById hands back a SNAPSHOT, as a Mongoose document read would: a write
// that lands afterwards (the race in section 6) is not visible through it.
LedgerEntry.findById = (id) => query(rows.find((r) => String(r._id) === String(id)) ? { ...rows.find((r) => String(r._id) === String(id)) } : null);
LedgerEntry.findOne = async (filter) => {
  const row = rows.find((r) => matches(r, filter));
  return row ? { ...row } : null;
};
LedgerEntry.find = (filter) => {
  let limit = Infinity;
  const result = () => rows.filter((r) => matches(r, filter)).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
  const q = {
    select: () => q,
    sort: () => q,
    limit: (n) => {
      limit = n;
      return q;
    },
    lean: async () => result().map((r) => ({ ...r })),
  };
  return q;
};
LedgerEntry.updateOne = async (filter, update) => {
  const row = rows.find((r) => matches(r, filter));
  if (!row) return { modifiedCount: 0 };
  Object.assign(row, update.$set || {});
  return { modifiedCount: 1 };
};
LedgerEntry.findOneAndUpdate = async (filter, update) => {
  const row = rows.find((r) => matches(r, filter));
  if (!row) return null;
  Object.assign(row, update.$set || {});
  return { ...row };
};

const IDENTITY = { _id: "id-1", stripeConnectAccountId: "acct_vendor", connectStatus: "enabled", displayName: "Dana Pipes", emailNormalized: "dana@example.com" };
VendorIdentity.findById = () => query(IDENTITY);
VendorOutreach.findOne = () => query({ toEmail: "dana@pipes.example", vendorNameSnapshot: "Dana Pipes" });
MaintenanceRequest.findById = () => query({ issueTitle: "Kitchen tap leaking", category: "Plumbing" });
Landlord.findById = () => query({ companyName: "Ojeifo Properties" });

/* ---------------- A Stripe that behaves like the sandbox did ---------------- */

// Oct 16 00:00 UTC, exactly as Stripe dates a card charge's clearing.
const OCT_16 = Math.floor(Date.UTC(2026, 9, 16) / 1000);
const OCT_19 = Math.floor(Date.UTC(2026, 9, 19) / 1000);

const stripeState = { available: 0, pending: 0, pendingTxns: [], onTransfer: null };

const fakeStripe = {
  balance: {
    retrieve: async () => ({
      available: [{ currency: "cad", amount: stripeState.available }],
      pending: [{ currency: "cad", amount: stripeState.pending }],
    }),
  },
  balanceTransactions: {
    // stripe-node's list result is async-iterable (auto-pagination).
    list: () => ({
      async *[Symbol.asyncIterator]() {
        yield* stripeState.pendingTxns;
      },
    }),
  },
  transfers: {
    create: async (params, opts) => {
      sent.transfers.push({ params, opts });
      if (stripeState.onTransfer) return stripeState.onTransfer(params, opts);
      stripeState.available -= params.amount;
      return { id: `tr_${sent.transfers.length}` };
    },
  },
};

const stripeConfig = require("../../../config/stripe");
stripeConfig.getStripe = () => fakeStripe;
stripeConfig.isConfigured = () => true;

const { settlePayout, releaseClearedPayouts, markPayoutPaid } = require("../../../services/ledger/ledger.service");

/* ---------------- Helpers ---------------- */

let seq = 0;
function payoutRow({ amountCents = 2000, providerStatus = "pending", createdAt } = {}) {
  seq += 1;
  const row = {
    _id: `payout-${seq}`,
    type: "payout",
    landlordId: "landlord-1",
    identityId: "id-1",
    requestId: "req-1",
    appointmentId: "appt-1",
    completionId: `comp-${seq}`,
    idempotencyKey: `payout:comp-${seq}`,
    amountCents,
    currency: "CAD",
    provider: "stripe_connect",
    providerStatus,
    providerRef: null,
    providerError: null,
    clearsOn: null,
    memo: "Job completed",
    createdAt: createdAt || new Date(Date.UTC(2026, 9, 11, 18, seq)),
  };
  rows.push(row);
  return row;
}

const row = (id) => rows.find((r) => r._id === id);

function reset() {
  rows = [];
  seq = 0;
  sent.notifications = [];
  sent.emails = [];
  sent.actions = [];
  sent.transfers = [];
  Object.assign(stripeState, { available: 0, pending: 0, pendingTxns: [], onTransfer: null });
}

async function main() {
  /* ---- 1) The incident: $0.60 available, the $20 top-up still clearing ---- */

  reset();
  Object.assign(stripeState, {
    available: 60,
    pending: 2000,
    pendingTxns: [{ id: "txn_card", status: "pending", currency: "cad", net: 2000, available_on: OCT_16 }],
  });
  const p1 = payoutRow();

  const parked = await settlePayout({ entryId: p1._id });

  assert.strictEqual(parked.result.status, "awaiting_clearance");
  assert.strictEqual(sent.transfers.length, 0, "no doomed transfer: its refusal would replay for a day");
  assert.strictEqual(row(p1._id).providerStatus, "awaiting_clearance");
  assert.strictEqual(row(p1._id).clearsOn.getTime(), OCT_16 * 1000, "the date Stripe will clear it");
  assert.strictEqual(row(p1._id).providerError, null, "parking is not an error");

  // The landlord hears, with the date, and is told there is nothing to do.
  assert.strictEqual(sent.notifications.length, 1);
  const clearing = sent.notifications[0];
  assert.strictEqual(clearing.type, "vendor_payout_clearing");
  assert.strictEqual(String(clearing.userId), "landlord-1");
  assert.match(clearing.message, /\$20\.00 to Dana Pipes for "Kitchen tap leaking"/);
  assert.match(clearing.message, /around Fri, Oct 16/, "Stripe's day, formatted in UTC");
  assert.match(clearing.message, /Nothing to do/);
  assert.strictEqual(sent.actions[0].actionType, "payout_awaiting_clearance");
  // The vendor is told in the "Job complete" email, not here.
  assert.strictEqual(sent.emails.length, 0);

  /* ---- 2) A sweep before it clears: re-checks, stays parked, says nothing - */

  await releaseClearedPayouts();
  assert.strictEqual(sent.transfers.length, 0);
  assert.strictEqual(row(p1._id).providerStatus, "awaiting_clearance");
  assert.strictEqual(sent.notifications.length, 1, "an hourly re-park must not notify every hour");

  /* ---- 3) Oct 16: the money clears and the payout sends itself ----------- */

  Object.assign(stripeState, { available: 2060, pending: 0, pendingTxns: [] });
  const released = await releaseClearedPayouts();

  assert.deepStrictEqual(released, { found: 1, sent: 1 });
  assert.strictEqual(sent.transfers.length, 1);
  assert.strictEqual(sent.transfers[0].opts.idempotencyKey, "payout:comp-1", "the SAME key: one transfer, ever");
  assert.strictEqual(sent.transfers[0].params.destination, "acct_vendor");
  assert.strictEqual(row(p1._id).providerStatus, "paid");
  assert.strictEqual(row(p1._id).providerRef, "tr_1");
  assert.strictEqual(row(p1._id).clearsOn, null);

  // The vendor was told it was coming, so they are told it went.
  assert.strictEqual(sent.emails.length, 1);
  assert.strictEqual(sent.emails[0].to, "dana@pipes.example");
  assert.match(sent.emails[0].subject, /Payment sent — \$20 for your plumbing job/);
  assert.ok(!/Kitchen tap|tenant/i.test(sent.emails[0].text), "no request title or tenant in a vendor email");
  const paidNote = sent.notifications.find((n) => n.type === "vendor_payout_sent");
  assert.ok(paidNote, "the landlord hears it went");
  assert.ok(sent.actions.some((a) => a.actionType === "payout_sent"));

  // Once paid, a stray sweep or webhook does nothing.
  await releaseClearedPayouts();
  assert.strictEqual(sent.transfers.length, 1);

  /* ---- 4) Pending money that can never cover it is a real failure -------- */

  reset();
  Object.assign(stripeState, { available: 0, pending: 500 });
  const p4 = payoutRow();
  const failed = await settlePayout({ entryId: p4._id });

  assert.strictEqual(failed.result.status, "failed");
  assert.strictEqual(sent.transfers.length, 0);
  assert.match(row(p4._id).providerError, /\$0\.00 available and \$5\.00 still clearing, against \$20\.00/);
  const failNote = sent.notifications.find((n) => n.type === "payment_failed");
  assert.ok(failNote, "a failed payout reaches the landlord, who has to act");
  assert.match(failNote.message, /Retry it from your wallet, or pay them directly/);

  /* ---- 5) Lost the race for the available money: still parks ------------ */

  reset();
  Object.assign(stripeState, {
    available: 5000,
    pending: 3000,
    pendingTxns: [{ id: "txn_a", status: "pending", currency: "cad", net: 3000, available_on: OCT_19 }],
    onTransfer: async () => {
      const err = new Error("You have insufficient available funds in your Stripe account.");
      err.code = "balance_insufficient";
      throw err;
    },
  });
  const p5 = payoutRow();
  const raced = await settlePayout({ entryId: p5._id });

  assert.strictEqual(raced.result.status, "awaiting_clearance", "balance_insufficient is timing, not failure");
  assert.match(row(p5._id).providerError, /insufficient available funds/, "kept for the operator: this key now replays");
  assert.ok(!sent.notifications.some((n) => n.type === "payment_failed"));

  /* ---- 6) A refusal never overwrites a payout that was SENT meanwhile ---- */

  reset();
  Object.assign(stripeState, { available: 5000 });
  const p6 = payoutRow({ providerStatus: "awaiting_clearance" });
  stripeState.onTransfer = async () => {
    // Another worker's transfer for this entry lands while ours is in flight.
    row(p6._id).providerStatus = "paid";
    row(p6._id).providerRef = "tr_other";
    const err = new Error("insufficient");
    err.code = "balance_insufficient";
    throw err;
  };
  await settlePayout({ entryId: p6._id });
  assert.strictEqual(row(p6._id).providerStatus, "paid", "paid stays paid");
  assert.strictEqual(row(p6._id).providerRef, "tr_other");

  /* ---- 7) The estimate counts older parked payouts ahead in the queue ---- */

  reset();
  Object.assign(stripeState, {
    available: 0,
    pending: 4000,
    pendingTxns: [
      { id: "txn_late", status: "pending", currency: "cad", net: 2000, available_on: OCT_19 },
      { id: "txn_early", status: "pending", currency: "cad", net: 2000, available_on: OCT_16 },
      { id: "txn_old", status: "available", currency: "cad", net: 9999, available_on: OCT_16 - 86400 },
    ],
  });
  const first = payoutRow({ createdAt: new Date(Date.UTC(2026, 9, 11, 9)) });
  const second = payoutRow({ createdAt: new Date(Date.UTC(2026, 9, 11, 10)) });
  await settlePayout({ entryId: first._id });
  await settlePayout({ entryId: second._id });
  assert.strictEqual(row(first._id).clearsOn.getTime(), OCT_16 * 1000, "the first $20 clears with the earlier charge");
  assert.strictEqual(row(second._id).clearsOn.getTime(), OCT_19 * 1000, "the second waits for the later one");

  // No date when pending money does not add up for the queue: say "a few
  // business days", never a date that is wrong.
  stripeState.pendingTxns = [{ id: "txn_small", status: "pending", currency: "cad", net: 100, available_on: OCT_16 }];
  stripeState.pending = 2000;
  const third = payoutRow({ createdAt: new Date(Date.UTC(2026, 9, 11, 11)) });
  await settlePayout({ entryId: third._id });
  assert.strictEqual(row(third._id).providerStatus, "awaiting_clearance");
  assert.strictEqual(row(third._id).clearsOn, null);
  assert.match(sent.notifications.at(-1).message, /in a few business days/);

  /* ---- 8) Nobody pays a parked payout by hand: it sends itself ----------- */

  const manual = await markPayoutPaid({ entryId: first._id, reference: "etransfer-123" });
  assert.strictEqual(manual.refused, "settles_automatically", "paying by hand too would pay the vendor twice");
  assert.strictEqual(row(first._id).providerStatus, "awaiting_clearance");

  console.log("payoutClearance tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
