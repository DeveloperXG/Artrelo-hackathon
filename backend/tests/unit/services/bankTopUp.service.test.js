// Bank top-ups (Canadian pre-authorized debit), end to end over the REAL
// ledger and webhook handlers, with in-memory models that enforce the same
// unique keys and { $gte } guards as Mongo, and a fake Stripe.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//
//   1. Nothing is credited until the debit SUCCEEDS -- not at start, not at
//      processing. And it is credited once, however often Stripe repeats itself.
//   2. One click, one debit. A saved account is debited by the SERVER, so a
//      double-click must converge on one intent (the attempt's token is both
//      the WalletTopUp's unique key and Stripe's idempotency key).
//   3. No gross-up: the landlord is debited exactly what reaches the wallet.
//   4. The risk rules: minimum; and until `trustedAfter` top-ups have cleared,
//      a per-debit cap and one debit at a time. A paused landlord is refused.
//   5. A debit the bank REFUSED costs the disclosed failure fee; a failed
//      account verification (no debit attempted) costs nothing.
//   6. A dispute takes the money back -- out of the wallet first, the rest as
//      bank_owed, NEVER arrears -- charges the dispute fee, and pauses bank
//      top-ups. A replay changes nothing; a dispute that arrives before the
//      credit still ends with the money reversed.
//   7. The next CASH top-up repays bank_owed after any vendor waiting on funds
//      and before unpaid service fees; an external deposit never repays it.
//   8. The journal reproduces the cache after every step.

const assert = require("assert");

const env = require("../../../config/env");
const LedgerEntry = require("../../../models/LedgerEntry");
const { linesBalance } = require("../../../models/LedgerEntry");
const LandlordLedger = require("../../../models/LandlordLedger");
const Landlord = require("../../../models/Landlord");
const WalletTopUp = require("../../../models/WalletTopUp");
const AgentActionLog = require("../../../models/AgentActionLog");
const { Notification } = require("../../../models/Notification");

const LANDLORD = "landlord-1";

let entries = [];
let ledgerRow = null;
let topUps = [];
let landlordDoc = null;
let notices = [];
let audits = [];
let nextId = 1;
let interfere = null;

/* ---------------- A small Mongo ---------------------------------------- */

const getPath = (row, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), row);
const missing = (v) => v === null || v === undefined;

function matches(row, filter = {}) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return cond.some((sub) => matches(row, sub));
    if (key === "$nor") return !cond.some((sub) => matches(row, sub));
    const value = getPath(row, key);
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("$in" in cond) return cond.$in.some((c) => (missing(c) ? missing(value) : String(c) === String(value)));
      if ("$ne" in cond) return missing(cond.$ne) ? !missing(value) : String(value) !== String(cond.$ne);
      if ("$gte" in cond) return (value || 0) >= cond.$gte;
      if ("$lte" in cond) return (value || 0) <= cond.$lte;
      if ("$gt" in cond) return !missing(value) && value > cond.$gt;
      if ("$exists" in cond) return cond.$exists ? !missing(value) : missing(value);
    }
    if (cond === null) return missing(value);
    return String(value) === String(cond);
  });
}

function applyUpdate(row, update) {
  for (const [key, value] of Object.entries(update.$set || {})) {
    const parts = key.split(".");
    const leaf = parts.pop();
    parts.reduce((node, part) => (node[part] = node[part] || {}), row)[leaf] = value;
  }
  for (const key of Object.keys(update.$unset || {})) {
    const parts = key.split(".");
    const leaf = parts.pop();
    const parent = parts.reduce((node, part) => (node == null ? node : node[part]), row);
    if (parent) delete parent[leaf];
  }
  for (const [key, delta] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + delta;
}

const query = (getRows) => {
  const q = { select: () => q, sort: () => q, limit: () => q, populate: () => q, lean: async () => clone(getRows()) };
  return q;
};
const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v), reviveDates));
function reviveDates(key, value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : value;
}

LedgerEntry.create = async (doc) => {
  if (entries.some((e) => e.idempotencyKey === doc.idempotencyKey)) {
    throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  }
  if (!linesBalance(doc.lines)) throw new Error("ledger entry lines do not balance to zero");
  const row = { _id: `e${nextId++}`, balanceAfter: {}, createdAt: new Date(), fundedCents: 0, ...doc };
  entries.push(row);
  return row;
};
LedgerEntry.findOne = (filter) => {
  const found = entries.find((e) => matches(e, filter)) || null;
  // Awaited directly by the ledger, `.lean()`ed by the bank service.
  const p = Promise.resolve(found);
  p.lean = async () => clone(found);
  return p;
};
LedgerEntry.updateOne = async (filter, update) => {
  const row = entries.find((e) => matches(e, filter));
  if (!row) return { modifiedCount: 0 };
  applyUpdate(row, update);
  return { modifiedCount: 1 };
};
LedgerEntry.find = (filter) => query(() => entries.filter((e) => matches(e, filter)));
LedgerEntry.findOneAndUpdate = async (filter, update) => {
  const row = entries.find((e) => matches(e, filter));
  if (!row) return null;
  applyUpdate(row, update);
  return { ...row };
};

LandlordLedger.findOne = async () => ledgerRow;
LandlordLedger.create = async (doc) => {
  ledgerRow = { available: 0, held: 0, arrears: 0, feesOwed: 0, bankOwed: 0, lifetimeDeposited: 0, lifetimeReleased: 0, currency: "CAD", ...doc };
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
  applyUpdate(ledgerRow, update);
  return { ...ledgerRow };
};

WalletTopUp.create = async (doc) => {
  if (topUps.some((t) => String(t.landlordId) === String(doc.landlordId) && t.clientToken === doc.clientToken)) {
    throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  }
  const row = { _id: `t${nextId++}`, status: "created", paymentIntentId: null, createdAt: new Date(), ...doc };
  topUps.push(row);
  return { ...row, toObject: () => clone(row) };
};
WalletTopUp.findOne = (filter) => query(() => topUps.find((t) => matches(t, filter)) || null);
WalletTopUp.find = (filter) => query(() => topUps.filter((t) => matches(t, filter)).reverse());
WalletTopUp.countDocuments = async (filter) => topUps.filter((t) => matches(t, filter)).length;
WalletTopUp.updateOne = async (filter, update) => {
  const row = topUps.find((t) => matches(t, filter));
  if (!row) return { modifiedCount: 0 };
  applyUpdate(row, update);
  return { modifiedCount: 1 };
};

Landlord.findById = () => query(() => landlordDoc);
Landlord.updateOne = async (filter, update) => {
  if (!landlordDoc) return { modifiedCount: 0 };
  const { _id, ...rest } = filter;
  if (_id !== undefined && String(_id) !== String(landlordDoc._id)) return { modifiedCount: 0 };
  if (!matches(landlordDoc, rest)) return { modifiedCount: 0 };
  applyUpdate(landlordDoc, update);
  return { modifiedCount: 1 };
};

Notification.create = async (row) => {
  notices.push(row);
  return row;
};
AgentActionLog.create = async (row) => {
  audits.push(row);
  return row;
};

/* ---------------- A small Stripe -------------------------------------- */

let intentsCreated = [];
let customersCreated = 0;
// What retrieve(expand) reports for an intent: the saved method, its mandate,
// and Stripe's fee on the settled debit.
const BANK_FEE_CENTS = 500;
const fakeStripe = {
  customers: {
    create: async () => {
      customersCreated += 1;
      return { id: "cus_1" };
    },
  },
  paymentIntents: {
    create: async (params, options) => {
      // Stripe's idempotency: the same key replays the first response.
      const prior = intentsCreated.find((i) => i.options?.idempotencyKey && i.options.idempotencyKey === options?.idempotencyKey);
      if (prior) return prior.response;
      const id = `pi_${intentsCreated.length + 1}`;
      const response = { id, client_secret: `${id}_secret`, status: params.confirm ? "processing" : "requires_payment_method" };
      intentsCreated.push({ params, options, response });
      return response;
    },
    retrieve: async (id) => ({
      id,
      customer: "cus_1",
      payment_method: { id: "pm_bank_1", acss_debit: { last4: "6789", bank_name: "Test Bank" } },
      latest_charge: {
        payment_method_details: { acss_debit: { mandate: "mandate_1" } },
        balance_transaction: { fee: BANK_FEE_CENTS, net: 100000 - BANK_FEE_CENTS, available_on: Math.floor(Date.now() / 1000) + 86400 },
      },
    }),
  },
  balance: { retrieve: async () => ({ available: [], pending: [] }) },
};
const stripeConfig = require("../../../config/stripe");
stripeConfig.getStripe = () => fakeStripe;
stripeConfig.isConfigured = () => true;

const bank = require("../../../services/ledger/bankTopUp.service");
const webhook = require("../../../controllers/stripeWebhook.controller");
const ledger = require("../../../services/ledger/ledger.service");
const { replayEntries } = require("../../../scripts/reconcileLedger");
const { bankDebitSettings } = require("../../../services/ledger/bankDebitSettings");
const { summarizeBankFees, summarizeRevenue } = require("../../../services/metrics/revenueReport.service");

/* ---------------- Helpers ---------------------------------------------- */

function reset({ bankDebit = undefined } = {}) {
  entries = [];
  ledgerRow = null;
  topUps = [];
  notices = [];
  audits = [];
  intentsCreated = [];
  customersCreated = 0;
  landlordDoc = { _id: LANDLORD, email: "dana@example.com", firstName: "Dana", lastName: "Ng", stripeCustomerId: null, ...(bankDebit ? { bankDebit } : {}) };
}

function assertJournal(label) {
  const replayed = replayEntries(entries, LANDLORD);
  assert.deepStrictEqual(
    { available: ledgerRow.available, held: ledgerRow.held, arrears: ledgerRow.arrears, feesOwed: ledgerRow.feesOwed || 0, bankOwed: ledgerRow.bankOwed || 0 },
    replayed,
    `${label}: the journal must reproduce the cache`
  );
}

const intentFor = (id, { amount = 100000, token = null, latestCharge = null, error = null } = {}) => ({
  id,
  amount,
  amount_received: amount,
  currency: "cad",
  latest_charge: latestCharge,
  last_payment_error: error,
  metadata: {
    artreloLandlordId: LANDLORD,
    artreloPurpose: "wallet_topup",
    artreloMethod: "bank",
    artreloWalletCents: String(amount),
    ...(token ? { artreloTopUpToken: token } : {}),
  },
});

const ofType = (type) => entries.filter((e) => e.type === type);

async function main() {
  const savedEnv = { ...env };
  env.bank_debit_enabled = true;
  env.bank_topup_min_cents = undefined;
  env.bank_topup_new_cap_cents = undefined;
  env.bank_trusted_after = undefined;
  env.bank_failure_fee_cents = undefined;
  env.bank_dispute_fee_cents = undefined;
  const settings = bankDebitSettings();

  try {
    /* -------- 0) Settings degrade safely ------------------------------- */
    assert.deepStrictEqual(
      [settings.minCents, settings.newCapCents, settings.trustedAfter, settings.failureFeeCents, settings.transactionType],
      [10000, 200000, 3, 500, "business"]
    );
    assert.strictEqual(bankDebitSettings({ bank_topup_min_cents: "abc", bank_mandate_transaction_type: "weekly" }).minCents, 10000);
    assert.strictEqual(bankDebitSettings({ bank_mandate_transaction_type: " Personal " }).transactionType, "personal");
    assert.strictEqual(bankDebitSettings({}).enabled, false, "off unless switched on");

    /* -------- 0b) The expected window is the promised 3–5 BUSINESS days -- */
    // Wed 14 Oct: 3 business days is Mon 19, 5 is Wed 21. Weekends never count.
    const win = bank.expectedWindow(new Date("2026-10-14T10:00:00Z"));
    assert.deepStrictEqual(
      [win.from.toISOString().slice(0, 10), win.to.toISOString().slice(0, 10)],
      ["2026-10-19", "2026-10-21"]
    );
    // From a Friday: Wed to Fri of the next week.
    const fri = bank.expectedWindow(new Date("2026-10-16T10:00:00Z"));
    assert.deepStrictEqual(
      [fri.from.toISOString().slice(0, 10), fri.to.toISOString().slice(0, 10)],
      ["2026-10-21", "2026-10-23"]
    );

    /* -------- 0c) Failure reasons, in the landlord's words -------------- */
    // The sandbox sent insufficient funds as generic_decline, with Stripe's
    // message about "the customer"; the landlord must read neither.
    assert.strictEqual(
      bank.failureReason({ decline_code: "generic_decline", message: "The customer's account has insufficient funds to cover this payment." }),
      "your account didn't have enough funds"
    );
    assert.strictEqual(bank.failureReason({ code: "account_closed" }), "the account is closed");
    assert.strictEqual(bank.failureReason({ decline_code: "debit_not_authorized" }), "your bank says the debit wasn't authorized");
    assert.strictEqual(bank.failureReason({ message: "Something odd" }), "your bank declined it");
    assert.strictEqual(bank.failureReason(), "your bank declined it");

    /* -------- 1) The risk rules, as a table ---------------------------- */
    const refuse = (over) =>
      bank.bankTopUpRefusal({ settings, amountCents: 50000, blocked: false, clearedCount: 0, inFlightCount: 0, ...over })?.code || null;
    assert.strictEqual(refuse({}), null, "a new landlord, $500, nothing in flight: fine");
    assert.strictEqual(refuse({ settings: { ...settings, enabled: false } }), "bank_disabled");
    assert.strictEqual(refuse({ blocked: true }), "bank_blocked");
    assert.strictEqual(refuse({ amountCents: 9999 }), "below_minimum");
    assert.strictEqual(refuse({ amountCents: 200001 }), "over_new_cap");
    assert.ok(
      /up to \$2,000\.00 until 3 of your bank top-ups have cleared \(1 so far\)/.test(
        bank.bankTopUpRefusal({ settings, amountCents: 300000, blocked: false, clearedCount: 1, inFlightCount: 0 }).message
      ),
      "the cap says how far along they are"
    );
    assert.strictEqual(refuse({ amountCents: 200000 }), null, "the cap itself is allowed");
    assert.strictEqual(refuse({ inFlightCount: 1 }), "one_in_flight");
    assert.strictEqual(refuse({ clearedCount: 3, amountCents: 900000, inFlightCount: 2 }), null, "trusted: no cap, no queue");
    assert.strictEqual(refuse({ clearedCount: 3, blocked: true }), "bank_blocked", "trust never outranks a pause");
    assert.strictEqual(refuse({ amountCents: 9999 }), "below_minimum");
    assert.strictEqual(
      bank.bankTopUpRefusal({ settings, amountCents: 300000, blocked: false, clearedCount: 0, inFlightCount: 0 }).field,
      "amount",
      "amount problems go beside the field"
    );

    /* -------- 2) A new account: the intent Stripe is asked for ---------- */
    reset();
    const unclassified = await bank.startBankTopUp({ landlordId: LANDLORD, amountCents: 100000, clientToken: "tok-unclassified-1111" });
    assert.equal(unclassified.refused.code, "bank_account_type_required", "new mandates cannot assume a business account");
    let started = await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 100000, clientToken: "tok-aaaa-1111" });
    assert.ok(!started.refused, JSON.stringify(started.refused));
    assert.strictEqual(intentsCreated.length, 1);
    let { params, options } = intentsCreated[0];
    assert.strictEqual(params.amount, 100000, "no gross-up: the wallet amount is the debit");
    assert.deepStrictEqual(params.payment_method_types, ["acss_debit"]);
    assert.strictEqual(params.customer, "cus_1");
    assert.strictEqual(params.setup_future_usage, "off_session", "saved for one-click next time");
    assert.deepStrictEqual(params.payment_method_options.acss_debit.mandate_options, {
      payment_schedule: "sporadic",
      transaction_type: "business",
    });
    assert.strictEqual(params.confirm, undefined, "a new account is confirmed by the landlord, in the form");
    assert.strictEqual(params.metadata.artreloMethod, "bank");
    assert.strictEqual(params.metadata.artreloTopUpToken, "tok-aaaa-1111");
    assert.strictEqual(options.idempotencyKey, `topup:${LANDLORD}:tok-aaaa-1111`);
    assert.strictEqual(landlordDoc.stripeCustomerId, "cus_1", "the customer is remembered");
    assert.strictEqual(topUps.length, 1);
    assert.strictEqual(topUps[0].status, "created");
    assert.strictEqual(entries.length, 0, "RULE 1: starting credits nothing");

    // The same attempt again (a double-click, a retried request): one intent.
    started = await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 100000, clientToken: "tok-aaaa-1111" });
    assert.strictEqual(intentsCreated.length, 1, "RULE 2: one attempt, one intent");
    assert.strictEqual(topUps.length, 1);
    assert.strictEqual(started.paymentIntentId, "pi_1");
    // The same token for a DIFFERENT amount is a client bug, not a new debit.
    started = await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 120000, clientToken: "tok-aaaa-1111" });
    assert.strictEqual(started.refused.code, "token_reused");
    started = await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 100000, clientToken: "x" });
    assert.strictEqual(started.refused.code, "bad_token");

    /* -------- 3) processing: still nothing credited --------------------- */
    await bank.handleBankProcessing(intentFor("pi_1", { token: "tok-aaaa-1111", latestCharge: "ch_1" }));
    assert.strictEqual(topUps[0].status, "processing");
    assert.ok(topUps[0].expectedAt > topUps[0].processingAt, "an expected date is shown");
    assert.strictEqual(entries.length, 0, "RULE 1: processing credits nothing");
    assert.strictEqual(landlordDoc.bankDebit?.paymentMethodId, undefined, "not saved while it can still fail");

    // While it is processing, a new landlord cannot start another.
    started = await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 50000, clientToken: "tok-bbbb-2222" });
    assert.strictEqual(started.refused.code, "one_in_flight", "RULE 4");
    // ...and it says WHICH top-up, since when, until when, and what lifts the rule.
    assert.ok(/Your \$1,000\.00 bank top-up from \w+\.? \d+ is still processing, expected between \w+\.? \d+ and \w+\.? \d+ \(3–5 business days\)\./.test(started.refused.message), started.refused.message);
    assert.ok(/until 3 of your bank top-ups have cleared \(0 so far\)/.test(started.refused.message), started.refused.message);
    let status0 = await bank.bankStatusFor(LANDLORD);
    assert.strictEqual(status0.reason, started.refused.message, "the form can show the same reason before anyone clicks");
    assert.strictEqual(status0.pendingTopUp.amountCents, 100000);
    assert.deepStrictEqual([status0.cleared, status0.trustedAfter], [0, 3]);
    // ...but a retry of the in-flight attempt itself is not refused by its own rule.
    started = await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 100000, clientToken: "tok-aaaa-1111" });
    assert.ok(!started.refused, "a retry of the same attempt is let through");
    assert.strictEqual(intentsCreated.length, 1);

    /* -------- 4) succeeded: credited once, as a bank top-up ------------- */
    const succeeded = intentFor("pi_1", { token: "tok-aaaa-1111", latestCharge: "ch_1" });
    await webhook.handleDepositSucceeded(succeeded);
    await webhook.handleDepositSucceeded(succeeded); // Stripe repeats itself
    const deposits = ofType("deposit");
    assert.strictEqual(deposits.length, 1, "RULE 1: credited once");
    assert.strictEqual(deposits[0].amountCents, 100000);
    assert.strictEqual(deposits[0].memo, "Bank top-up");
    assert.strictEqual(deposits[0].fundingSource, "stripe", "real money at Stripe: it can fund transfers");
    assert.strictEqual(deposits[0].bank.stripeFeeCents, BANK_FEE_CENTS, "the absorbed fee is recorded");
    assert.ok(deposits[0].bank.availableOn, "and when it clears");
    assert.strictEqual(deposits[0].card?.processingFeeCents ?? null, null, "no card fields on a bank deposit");
    assert.strictEqual(topUps[0].status, "succeeded");
    assert.strictEqual(ledgerRow.available, 100000);
    // Only now -- it worked -- is the account saved for one-click top-ups.
    assert.strictEqual(landlordDoc.bankDebit.paymentMethodId, "pm_bank_1", "the account is saved once it succeeds");
    assert.strictEqual(landlordDoc.bankDebit.mandateId, "mandate_1");
    assert.strictEqual(landlordDoc.bankDebit.last4, "6789");
    assertJournal("after the credit");

    /* -------- 5) a saved account: one click, server-confirmed ----------- */
    started = await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 30000, clientToken: "tok-cccc-3333", useSaved: true });
    assert.ok(!started.refused, JSON.stringify(started.refused));
    ({ params, options } = intentsCreated[1]);
    assert.strictEqual(params.payment_method, "pm_bank_1");
    assert.strictEqual(params.mandate, "mandate_1");
    assert.strictEqual(params.confirm, true, "the click is the authorization; no form");
    assert.strictEqual(params.payment_method_options, undefined, "no new mandate");
    assert.strictEqual(params.setup_future_usage, undefined);
    assert.strictEqual(params.amount, 30000);
    assert.strictEqual(customersCreated, 1, "the same customer, not a new one");
    assert.strictEqual(topUps[1].status, "processing", "server-confirmed: processing straight away");
    // Double-click on the one-click button: the SAME key, so no second debit.
    await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 30000, clientToken: "tok-cccc-3333", useSaved: true });
    assert.strictEqual(intentsCreated.length, 2, "RULE 2: a double-click debits once");
    assert.strictEqual(intentsCreated.filter((i) => i.options.idempotencyKey === `topup:${LANDLORD}:tok-cccc-3333`).length, 1);

    /* -------- 6) the bank refuses it: the failure fee ------------------- */
    const refused = intentFor("pi_2", { amount: 30000, token: "tok-cccc-3333", latestCharge: "ch_2", error: { code: "payment_intent_payment_attempt_failed", message: "Insufficient funds" } });
    await webhook.handleDepositFailed(refused);
    await webhook.handleDepositFailed(refused); // replay
    assert.strictEqual(topUps[1].status, "failed");
    assert.strictEqual(ofType("deposit").length, 1, "never credited");
    const fees = ofType("bank_fee");
    assert.strictEqual(fees.length, 1, "RULE 5: the fee once, however often the event comes");
    assert.strictEqual(fees[0].amountCents, 500);
    assert.strictEqual(ledgerRow.available, 99500, "taken from the wallet, which had it");
    assert.strictEqual(notices.length, 1, "told once");
    assert.ok(/didn't go through/.test(notices[0].title));
    assert.ok(/\$5\.00 bank fee/.test(notices[0].message), "and told about the fee");
    assertJournal("after a failed debit");

    /* -------- 7) a failed VERIFICATION costs nothing --------------------- */
    reset();
    await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 50000, clientToken: "tok-dddd-4444" });
    await webhook.handleDepositFailed(intentFor("pi_1", { amount: 50000, token: "tok-dddd-4444", latestCharge: null, error: { message: "Verification failed" } }));
    assert.strictEqual(topUps[0].status, "failed");
    assert.strictEqual(ofType("bank_fee").length, 0, "RULE 5: no debit attempted, no fee");
    assert.ok(!/bank fee/.test(notices[0].message));

    /* -------- 7b) another account's debit FAILS: the saved one survives --- */
    // Found in the sandbox: saving at "processing" let a failing account
    // replace the working one, and its deactivated mandate then erased both.
    reset({ bankDebit: { paymentMethodId: "pm_good", mandateId: "mandate_good", last4: "1111", institution: "Good Bank" } });
    await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 50000, clientToken: "tok-kkkk-1212" });
    await bank.handleBankProcessing(intentFor("pi_1", { amount: 50000, token: "tok-kkkk-1212", latestCharge: "ch_1" }));
    await webhook.handleDepositFailed(intentFor("pi_1", { amount: 50000, token: "tok-kkkk-1212", latestCharge: "ch_1", error: { message: "Insufficient funds" } }));
    await bank.handleMandateUpdated({ id: "mandate_1", status: "inactive" }); // the failed account's mandate
    assert.deepStrictEqual(
      [landlordDoc.bankDebit.paymentMethodId, landlordDoc.bankDebit.mandateId, landlordDoc.bankDebit.last4],
      ["pm_good", "mandate_good", "1111"],
      "a failed debit from another account never costs the landlord their saved one"
    );

    /* -------- 8) a dispute, the wallet still has the money --------------- */
    reset();
    await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 100000, clientToken: "tok-eeee-5555" });
    await bank.handleBankProcessing(intentFor("pi_1", { token: "tok-eeee-5555", latestCharge: "ch_1" }));
    await webhook.handleDepositSucceeded(intentFor("pi_1", { token: "tok-eeee-5555", latestCharge: "ch_1" }));
    const dispute = { id: "dp_1", payment_intent: "pi_1", amount: 100000, reason: "debit_not_authorized", balance_transactions: [{ fee: 1500 }] };
    await bank.handleDisputeCreated(dispute);
    await bank.handleDisputeCreated(dispute); // replay
    assert.strictEqual(ofType("deposit_reversal").length, 1, "RULE 6: reversed once");
    assert.strictEqual(ofType("bank_fee").length, 1);
    assert.strictEqual(ofType("bank_fee")[0].amountCents, 1500, "Stripe's own dispute fee, when it says");
    assert.strictEqual(ledgerRow.available, 0, "the $1,000 back out of the wallet");
    assert.strictEqual(ledgerRow.bankOwed, 1500, "the fee the wallet could no longer cover is owed");
    assert.strictEqual(ledgerRow.arrears, 0, "RULE 6: NEVER arrears");
    assert.strictEqual(ledgerRow.lifetimeDeposited, 0, "a reversed top-up stops counting as deposited");
    assert.strictEqual(topUps[0].status, "disputed");
    assert.ok(landlordDoc.bankDebit.blockedAt, "bank top-ups are paused");
    // It succeeded first, so it had become the saved account; the dispute
    // forgets it, so unpausing never leaves the disputed account one click away.
    assert.strictEqual(landlordDoc.bankDebit.paymentMethodId, undefined, "the disputed account is no longer saved");
    assert.strictEqual(notices.length, 1, "told once");
    assert.ok(/reversed/.test(notices[0].title));
    assertJournal("after a dispute");

    // Paused means paused, even for the saved account.
    started = await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 20000, clientToken: "tok-ffff-6666", useSaved: true });
    assert.strictEqual(started.refused.code, "bank_blocked");
    assert.ok(/because your bank reversed a \$1,000\.00 top-up on /.test(started.refused.message), started.refused.message);
    const pausedStatus = await bank.bankStatusFor(LANDLORD);
    assert.strictEqual(pausedStatus.pausedFor.amountCents, 100000);
    assert.strictEqual(pausedStatus.reason, started.refused.message);
    // A retry of an attempt let through before the pause is stopped too, with the same reason.
    started = await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 100000, clientToken: "tok-eeee-5555" });
    assert.strictEqual(started.refused.code, "bank_blocked");

    /* -------- 9) a dispute after the money was SPENT --------------------- */
    reset();
    await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 100000, clientToken: "tok-gggg-7777" });
    await webhook.handleDepositSucceeded(intentFor("pi_1", { token: "tok-gggg-7777", latestCharge: "ch_1" }));
    // Spend $700 of it on a job (a hold), outside the bank code.
    await ledger.createHold({ landlordId: LANDLORD, amountCents: 70000, appointmentId: "appt-1", requestId: null });
    await bank.handleDisputeCreated({ id: "dp_2", payment_intent: "pi_1", amount: 100000, balance_transactions: [] });
    const reversal = ofType("deposit_reversal")[0];
    assert.strictEqual(reversal.amountCents, 100000);
    assert.strictEqual(ledgerRow.available, 0);
    assert.strictEqual(ledgerRow.bankOwed, 70000 + 500, "the spent part plus the fallback dispute fee, owed");
    assert.strictEqual(ledgerRow.arrears, 0, "RULE 6: NEVER arrears");
    assert.strictEqual(ledgerRow.held, 70000, "the booked job is untouched");
    assertJournal("after a dispute on spent money");

    /* -------- 10) the next CASH top-up repays bank_owed, in order -------- */
    // Also owe a service fee; a card top-up of $1,000 arrives.
    ledgerRow.feesOwed = 400;
    entries.push({
      _id: "seed-fee", idempotencyKey: "fee:seed", type: "fee", amountCents: 400, balanceAfter: {}, createdAt: new Date(),
      lines: [
        { account: "platform:fee", direction: "debit", amountCents: 400 },
        { account: `landlord:${LANDLORD}:fees_owed`, direction: "credit", amountCents: 400 },
      ],
    });
    // An external deposit first: it never repays bank_owed (RULE 7)...
    await ledger.recordDeposit({ landlordId: LANDLORD, amountCents: 10000, idempotencyKey: "deposit:ext-1", fundingSource: "external" });
    assert.strictEqual(ledgerRow.bankOwed, 70500, "RULE 7: an external deposit does not repay it");
    assert.strictEqual(ledgerRow.feesOwed, 0, "but it can pay a fee (not a cash question)");
    ledgerRow.feesOwed = 400;
    entries.push({
      _id: "seed-fee-2", idempotencyKey: "fee:seed2", type: "fee", amountCents: 400, balanceAfter: {}, createdAt: new Date(),
      lines: [
        { account: "platform:fee", direction: "debit", amountCents: 400 },
        { account: `landlord:${LANDLORD}:fees_owed`, direction: "credit", amountCents: 400 },
      ],
    });
    const before = ledgerRow.available;
    await ledger.recordDeposit({ landlordId: LANDLORD, amountCents: 100000, idempotencyKey: "deposit:pi_card", fundingSource: "stripe", provider: "stripe" });
    const settlements = entries.filter((e) => ["bank_settlement", "fee_settlement"].includes(e.type) && e.idempotencyKey.includes("pi_card"));
    assert.deepStrictEqual(settlements.map((e) => e.type), ["bank_settlement", "fee_settlement"], "RULE 7: bank_owed before fees");
    assert.strictEqual(ledgerRow.bankOwed, 0);
    assert.strictEqual(ledgerRow.feesOwed, 0);
    assert.strictEqual(ledgerRow.available, before + 100000 - 70500 - 400);
    assertJournal("after repayment");

    /* -------- 11) the reversal loses a race: still exact ---------------- */
    reset();
    await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 100000, clientToken: "tok-hhhh-8888" });
    await webhook.handleDepositSucceeded(intentFor("pi_1", { token: "tok-hhhh-8888", latestCharge: "ch_1" }));
    // Between the reversal reading "$1,000 covered" and spending it, $300 goes.
    interfere = () => {
      ledgerRow.available -= 30000;
      entries.push({
        _id: "race", idempotencyKey: "race-spend", type: "adjustment", amountCents: 30000, balanceAfter: {}, createdAt: new Date(),
        lines: [
          { account: "external:funding", direction: "debit", amountCents: 30000 },
          { account: `landlord:${LANDLORD}:available`, direction: "credit", amountCents: 30000 },
        ],
      });
    };
    const raced = await ledger.reverseBankDeposit({ landlordId: LANDLORD, disputeId: "dp_race", amountCents: 100000, paymentIntentId: "pi_1" });
    assert.strictEqual(raced.owedCents, 100000, "re-posted entirely as owed");
    assert.strictEqual(ledgerRow.available, 70000, "the wallet is not touched by the lost attempt");
    assert.strictEqual(ledgerRow.bankOwed, 100000);
    assert.strictEqual(ledgerRow.lifetimeDeposited, 0, "lifetime adjusted exactly once");
    assertJournal("after a lost race");
    // A replay of the same dispute changes nothing.
    await ledger.reverseBankDeposit({ landlordId: LANDLORD, disputeId: "dp_race", amountCents: 100000, paymentIntentId: "pi_1" });
    assert.strictEqual(ledgerRow.bankOwed, 100000);
    assertJournal("after a replayed lost race");

    /* -------- 12) the dispute arrives BEFORE the credit ----------------- */
    reset();
    await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 100000, clientToken: "tok-iiii-9999" });
    await bank.handleBankProcessing(intentFor("pi_1", { token: "tok-iiii-9999", latestCharge: "ch_1" }));
    await bank.handleDisputeCreated({ id: "dp_3", payment_intent: "pi_1", amount: 100000, balance_transactions: [] });
    assert.strictEqual(ofType("deposit_reversal").length, 0, "nothing to reverse yet");
    await webhook.handleDepositSucceeded(intentFor("pi_1", { token: "tok-iiii-9999", latestCharge: "ch_1" }));
    assert.strictEqual(ofType("deposit").length, 1);
    assert.strictEqual(ofType("deposit_reversal").length, 1, "RULE 6: reversed as soon as it is credited");
    assert.strictEqual(ledgerRow.available, 0, "the wallet never keeps money the bank took back");
    assert.strictEqual(topUps[0].status, "disputed", "and it stays disputed");
    assertJournal("after an out-of-order dispute");

    /* -------- 13) a card dispute is logged, not reversed ----------------- */
    reset();
    await ledger.recordDeposit({ landlordId: LANDLORD, amountCents: 5000, idempotencyKey: "deposit:pi_cardx", fundingSource: "stripe" });
    await bank.handleDisputeCreated({ id: "dp_card", payment_intent: "pi_cardx", amount: 5000 });
    assert.strictEqual(ofType("deposit_reversal").length, 0, "a card dispute can be won; a human decides");
    assert.ok(audits.some((a) => a.actionType === "ledger_card_dispute"));

    /* -------- 14) mandate revoked: the saved account is forgotten -------- */
    reset({ bankDebit: { paymentMethodId: "pm_1", mandateId: "mandate_9", last4: "1234", blockedAt: new Date() } });
    await bank.handleMandateUpdated({ id: "mandate_9", status: "active" });
    assert.strictEqual(landlordDoc.bankDebit.paymentMethodId, "pm_1", "an active mandate changes nothing");
    await bank.handleMandateUpdated({ id: "mandate_9", status: "inactive" });
    assert.strictEqual(landlordDoc.bankDebit.paymentMethodId, undefined);
    assert.strictEqual(landlordDoc.bankDebit.mandateId, undefined);
    assert.ok(landlordDoc.bankDebit.blockedAt, "a pause survives");

    /* -------- 15) the wallet's view ---------------------------------------- */
    reset({ bankDebit: { paymentMethodId: "pm_1", mandateId: "m", last4: "6789", institution: "Test Bank" } });
    let status = await bank.bankStatusFor(LANDLORD);
    assert.deepStrictEqual(status.saved, { last4: "6789", institution: "Test Bank" });
    assert.strictEqual(status.capCents, 200000, "a new landlord sees the cap");
    assert.strictEqual(status.reason, null, "nothing in the way, nothing to explain");
    topUps.push(...[1, 2, 3].map((i) => ({ _id: `old${i}`, landlordId: LANDLORD, clientToken: `old-${i}-xxxx`, status: "succeeded", walletCents: 1 })));
    status = await bank.bankStatusFor(LANDLORD);
    assert.strictEqual(status.trusted, true);
    assert.strictEqual(status.capCents, null, "a trusted landlord has none");
    stripeConfig.isConfigured = () => false;
    assert.deepStrictEqual(await bank.bankStatusFor(LANDLORD), { enabled: false }, "no Stripe key: nothing offered");
    stripeConfig.isConfigured = () => true;
    env.bank_debit_enabled = false;
    assert.deepStrictEqual(await bank.bankStatusFor(LANDLORD), { enabled: false }, "flag off: nothing offered");
    started = await bank.startBankTopUp({ transactionType: "business", landlordId: LANDLORD, amountCents: 50000, clientToken: "tok-jjjj-0000" });
    assert.strictEqual(started.refused.code, "bank_disabled", "flag off: refused, even if called");
    env.bank_debit_enabled = true;

    /* -------- 16) the revenue report -------------------------------------- */
    const month = "2026-10";
    const at = new Date("2026-10-05T12:00:00Z");
    const summary = summarizeBankFees({
      deposits: [
        { type: "deposit", fundingSource: "stripe", memo: "Bank top-up", bank: { stripeFeeCents: 500 }, createdAt: at },
        { type: "deposit", fundingSource: "stripe", memo: "Bank top-up", bank: {}, createdAt: at },
        { type: "deposit", fundingSource: "stripe", memo: "Card top-up", card: { stripeFeeCents: 3000 }, createdAt: at },
      ],
      bankFeeEntries: [
        { type: "bank_fee", amountCents: 500, createdAt: at, lines: [{ account: `landlord:${LANDLORD}:available`, direction: "credit", amountCents: 500 }] },
        { type: "bank_fee", amountCents: 1500, createdAt: at, lines: [{ account: `landlord:${LANDLORD}:bank_owed`, direction: "credit", amountCents: 1500 }] },
        { type: "bank_fee", amountCents: 999, shortfall: true, createdAt: at, lines: [] },
      ],
      firstBankTopUps: [at],
      verificationFeeCents: 100,
    }).get(month);
    assert.deepStrictEqual(
      [summary.deposits, summary.withoutFee, summary.absorbed, summary.verificationCost, summary.charged, summary.recovered],
      [2, 1, 500, 100, 2000, 500],
      "card deposits and lost-race originals are not counted"
    );
    const rev = summarizeRevenue({
      deposits: [{ type: "deposit", fundingSource: "stripe", memo: "Bank top-up", bank: { stripeFeeCents: 500 }, createdAt: at }],
      bankFeeEntries: [
        { type: "bank_fee", amountCents: 500, createdAt: at, lines: [{ account: "landlord:x:available", direction: "credit", amountCents: 500 }] },
        // A $100,000 repayment of a REVERSAL must not become revenue.
        { type: "bank_settlement", amountCents: 100000, createdAt: at, lines: [] },
      ],
      firstBankTopUps: [at],
      verificationFeeCents: 100,
    }).byMonth[month];
    assert.strictEqual(rev.bankFeesAbsorbedCents, 600);
    assert.strictEqual(rev.bankFeesRecoveredCents, 500, "recovery is capped at what was charged");
    assert.strictEqual(rev.netCents, -600 + 500);
  } finally {
    Object.assign(env, savedEnv);
  }

  console.log("bankTopUp.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
