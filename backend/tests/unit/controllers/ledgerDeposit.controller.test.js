// Card-funded deposits.
//
// ONE RULE CARRIES THIS WHOLE FILE: starting a payment must not credit the
// ledger. Only a settled payment_intent.succeeded webhook may. Crediting at
// intent creation is how a wallet ends up reading $1,000 available while Stripe
// holds nothing to send — the exact gap this feature closes.
//
// The second rule is idempotency. Stripe retries webhooks freely, and a
// double-credited deposit is money invented out of nothing.

const assert = require("assert");

const LedgerEntry = require("../../../models/LedgerEntry");
const LandlordLedger = require("../../../models/LandlordLedger");
const AgentActionLog = require("../../../models/AgentActionLog");
const WalletTopUp = require("../../../models/WalletTopUp");

const LANDLORD = "landlord-1";

let entries = [];
let ledgerRow = null;
let audits = [];
let intentsCreated = [];
let intentOptions = [];
let nextId = 1;

/* ---------------- Stubs -------------------------------------------------- */

LedgerEntry.create = async (doc) => {
  if (entries.some((e) => e.idempotencyKey === doc.idempotencyKey)) {
    const err = new Error("E11000 duplicate key");
    err.code = 11000;
    throw err;
  }
  const row = { _id: `e${nextId++}`, balanceAfter: {}, createdAt: new Date(), ...doc };
  entries.push(row);
  return row;
};
LedgerEntry.findOne = async (filter) =>
  entries.find((e) => Object.entries(filter).every(([k, v]) => String(e[k]) === String(v))) || null;
// Dotted paths ("card.availableOn") are written and read as nested objects, as
// Mongo does.
const getPath = (row, path) => path.split(".").reduce((value, key) => (value == null ? value : value[key]), row);
LedgerEntry.updateOne = async (filter, update) => {
  const row = entries.find((e) => String(e._id) === String(filter._id));
  if (row) {
    for (const [key, value] of Object.entries(update.$set || {})) {
      const parts = key.split(".");
      const leaf = parts.pop();
      const parent = parts.reduce((node, part) => (node[part] = node[part] || {}), row);
      parent[leaf] = value;
    }
  }
  return { modifiedCount: 1 };
};
// getLedger reads the journal back; unstubbed this casts "landlord-1" to an
// ObjectId against a real connection. The chain mirrors the real one —
// .populate() twice, then sort/skip/limit/lean. Filters are honoured, because the
// clearing, owed-to-vendors and statement-paging reads depend on them.
const matchesFilter = (row, filter = {}) =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === "landlordId") return true;
    if (key === "$nor") return !cond.some((sub) => matchesFilter(row, sub));
    if (key === "$or") return cond.some((sub) => matchesFilter(row, sub));
    const value = getPath(row, key);
    if (cond && typeof cond === "object" && "$gt" in cond) return value != null && value > cond.$gt;
    if (cond && typeof cond === "object" && "$in" in cond) return cond.$in.map(String).includes(String(value));
    if (cond && typeof cond === "object" && "$nin" in cond) return !cond.$nin.map(String).includes(String(value));
    if (cond && typeof cond === "object" && "$ne" in cond) return (value ?? null) !== cond.$ne;
    return String(value) === String(cond);
  });
LedgerEntry.find = (filter) => {
  let skip = 0;
  let limit = Infinity;
  const chain = {
    populate: () => chain,
    select: () => chain,
    sort: () => chain,
    skip: (n) => {
      skip = n;
      return chain;
    },
    limit: (n) => {
      limit = n;
      return chain;
    },
    lean: async () =>
      [...entries]
        .reverse()
        .filter((e) => matchesFilter(e, filter))
        .slice(skip, skip + limit),
  };
  return chain;
};
LedgerEntry.countDocuments = async (filter) => entries.filter((e) => matchesFilter(e, filter)).length;

LandlordLedger.findOne = async () => ledgerRow;
LandlordLedger.create = async (doc) => {
  // Mirror the schema defaults — every cents field is 0, not undefined.
  ledgerRow = {
    _id: "l1",
    available: 0,
    held: 0,
    arrears: 0,
    lifetimeDeposited: 0,
    lifetimeReleased: 0,
    currency: "CAD",
    ...doc,
  };
  return ledgerRow;
};
LandlordLedger.findOneAndUpdate = async (filter, update) => {
  if (!ledgerRow) return null;
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "landlordId") continue;
    if (cond && typeof cond === "object" && "$gte" in cond && (ledgerRow[key] || 0) < cond.$gte) {
      return null;
    }
  }
  for (const [k, d] of Object.entries(update.$inc || {})) ledgerRow[k] = (ledgerRow[k] || 0) + d;
  return { ...ledgerRow };
};
LandlordLedger.updateOne = async (filter, update) => {
  if (!ledgerRow) return { modifiedCount: 0 };
  for (const [k, d] of Object.entries(update.$inc || {})) ledgerRow[k] = (ledgerRow[k] || 0) + d;
  return { modifiedCount: 1 };
};
// No bank top-ups in this file; the wallet's read of them must still run.
WalletTopUp.find = () => {
  const q = { select: () => q, sort: () => q, limit: () => q, lean: async () => [] };
  return q;
};
AgentActionLog.create = async (row) => {
  audits.push(row);
  return row;
};

const stripeConfig = require("../../../config/stripe");
let stripeOn = true;
// When a settled charge clears: two days out, like a real Canadian card.
const CLEARS_AT = Math.floor(Date.now() / 1000) + 2 * 86400;
const fakeStripe = {
  paymentIntents: {
    create: async (params, options) => {
      intentsCreated.push(params);
      intentOptions.push(options);
      return { id: `pi_${intentsCreated.length}`, client_secret: `pi_${intentsCreated.length}_secret_x` };
    },
    // The shape a real expand: ["latest_charge.balance_transaction"] returns.
    retrieve: async (id) => ({
      id,
      status: "succeeded",
      metadata: { artreloPurpose: "wallet_topup" },
      payment_method_types: ["card"],
      amount_received: 103018,
      latest_charge: { balance_transaction: { fee: 3018, net: 100000, available_on: CLEARS_AT } },
    }),
  },
  balance: {
    retrieve: async () => ({
      available: [{ amount: 500000, currency: "cad" }],
      pending: [{ amount: 12500, currency: "cad" }],
    }),
  },
};
stripeConfig.getStripe = () => (stripeOn ? fakeStripe : null);
stripeConfig.isConfigured = () => stripeOn;

require("../../../services/ledger/cardDispute.service").reconcileIntent = async () => {};
const ctrl = require("../../../controllers/ledger.controller");
const { handleDepositSucceeded, handleDepositFailed } = require("../../../controllers/stripeWebhook.controller");
const bankTopUps = require("../../../services/ledger/bankTopUp.service");

const makeRes = () => ({
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
});
const makeReq = (body = {}) => ({ user: { id: LANDLORD }, body, params: {} });

const reset = async () => {
  entries = [];
  audits = [];
  intentsCreated = [];
  intentOptions = [];
  ledgerRow = null;
  nextId = 1;
  stripeOn = true;
  await LandlordLedger.create({ landlordId: LANDLORD });
};

const intent = (overrides = {}) => ({
  id: "pi_settled",
  currency: "cad",
  amount: 100000,
  amount_received: 100000,
  metadata: { artreloLandlordId: LANDLORD, artreloPurpose: "wallet_topup" },
  ...overrides,
});

async function main() {
  /* -------------- 1) STARTING a payment credits NOTHING ---------------- */
  // The single most important assertion here.

  await reset();
  let res = makeRes();
  await ctrl.createDepositIntentHandler(makeReq({ amount: 1000 }), res);

  assert.strictEqual(res.statusCode, 201);
  assert.ok(res.body.data.clientSecret, "the browser gets a client_secret");
  assert.strictEqual(intentsCreated.length, 1);
  // $1,000 to the wallet, grossed up for 2.9% + 30¢ so Stripe's cut never
  // comes out of it: ceil((100000 + 30) / 0.971) = 103018 cents.
  assert.strictEqual(intentsCreated[0].amount, 103018, "cents, and the card fee is ON TOP");
  assert.strictEqual(intentsCreated[0].metadata.artreloWalletCents, "100000", "the wallet credit rides on the intent");
  assert.strictEqual(intentsCreated[0].metadata.artreloFeeCents, "3018");
  assert.strictEqual(intentsCreated[0].currency, "cad");
  // Shown to the landlord before they pay.
  assert.strictEqual(res.body.data.walletAmount, 1000);
  assert.strictEqual(res.body.data.processingFee, 30.18);
  assert.strictEqual(res.body.data.chargeAmount, 1030.18);

  assert.strictEqual(entries.length, 0, "NO ledger entry may exist yet");
  assert.strictEqual(ledgerRow.available, 0, "the balance must NOT move on intent creation");

  // A webhook has no session, so the landlord must be recoverable from the
  // intent itself. Without this the settled payment cannot be attributed.
  assert.strictEqual(intentsCreated[0].metadata.artreloLandlordId, LANDLORD);
  assert.strictEqual(intentsCreated[0].metadata.artreloPurpose, "wallet_topup");

  /* -------------- 2) The webhook is what credits ----------------------- */

  await handleDepositSucceeded(intent());
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(ledgerRow.available, 100000, "now the money is real");

  const deposit = entries[0];
  assert.strictEqual(deposit.type, "deposit");
  assert.strictEqual(deposit.provider, "stripe");
  assert.strictEqual(deposit.providerRef, "pi_settled");
  // The tag that makes this balance transferable, as opposed to an external
  // top-up that Stripe knows nothing about.
  assert.strictEqual(deposit.fundingSource, "stripe");
  assert.strictEqual(deposit.idempotencyKey, "deposit:pi_settled", "keyed on the PaymentIntent");

  /* -------------- 3) A retried webhook credits ONCE -------------------- */
  // Stripe retries freely; a doubled deposit is money invented from nothing.

  await handleDepositSucceeded(intent());
  await handleDepositSucceeded(intent());
  assert.strictEqual(entries.length, 1, "still one entry");
  assert.strictEqual(ledgerRow.available, 100000, "still one credit");
  assert.strictEqual(
    audits.filter((a) => a.actionType === "ledger_deposit").length,
    1,
    "and only one audit line"
  );

  /* -------------- 4) Intents that are not ours are ignored ------------- */

  await reset();
  await handleDepositSucceeded(intent({ id: "pi_other", metadata: {} }));
  assert.strictEqual(entries.length, 0, "no metadata -> not ours -> never guessed at");

  await handleDepositSucceeded(
    intent({ id: "pi_wrong_purpose", metadata: { artreloLandlordId: LANDLORD, artreloPurpose: "something_else" } })
  );
  assert.strictEqual(entries.length, 0, "a non-topup intent must not credit the wallet");

  /* -------------- 5) amount_received, not amount ----------------------- */
  // A partially captured intent must credit only what was actually taken.

  await reset();
  await handleDepositSucceeded(intent({ id: "pi_partial", amount: 100000, amount_received: 40000 }));
  assert.strictEqual(ledgerRow.available, 40000, "credit what was received, not what was requested");

  // A zero or malformed amount credits nothing rather than throwing.
  await handleDepositSucceeded(intent({ id: "pi_zero", amount_received: 0 }));
  await handleDepositSucceeded(intent({ id: "pi_nan", amount_received: "abc" }));
  assert.strictEqual(ledgerRow.available, 40000, "nothing further credited");

  /* -------------- 5b) The wallet gets the requested amount, not the charge -- */
  // The charge includes the processing fee. Crediting the charge would hand the
  // landlord the fee as spendable money Stripe never kept.

  await reset();
  await handleDepositSucceeded(
    intent({
      id: "pi_grossed",
      amount: 103018,
      amount_received: 103018,
      metadata: { artreloLandlordId: LANDLORD, artreloPurpose: "wallet_topup", artreloWalletCents: "100000" },
    })
  );
  assert.strictEqual(ledgerRow.available, 100000, "the wallet credit, not the fee-inclusive charge");
  const grossed = entries[0];
  assert.strictEqual(grossed.card.processingFeeCents, 3018, "what the landlord paid on top");
  assert.strictEqual(grossed.card.stripeFeeCents, 3018, "what Stripe actually kept");
  assert.strictEqual(grossed.card.netCents, 100000);
  assert.strictEqual(grossed.card.availableOn.getTime(), CLEARS_AT * 1000, "when it clears for payouts");

  // The banner is built from THIS landlord's own uncleared deposit, at the
  // amount their wallet received. It used to be the platform's pending balance:
  // everyone's money, after fees ("$0.67 is still clearing" for a $1 top-up).
  res = makeRes();
  await ctrl.getLedger(makeReq(), res);
  assert.strictEqual(res.body.data.clearing.length, 1);
  assert.strictEqual(res.body.data.clearing[0].amount, 1000, "the wallet amount, not net of fees");
  assert.strictEqual(res.body.data.platformBalance, undefined, "the shared platform balance is never sent to a landlord");
  assert.strictEqual(res.body.data.stripeMode, undefined, "nor the operator's key mode");

  /* -------------- 6) A failed payment credits nothing ------------------ */

  await reset();
  await handleDepositFailed(
    intent({ id: "pi_failed", last_payment_error: { message: "Your card was declined." } })
  );
  assert.strictEqual(entries.length, 0, "a decline must never credit");
  assert.strictEqual(ledgerRow.available, 0);
  assert.ok(audits.some((a) => a.actionType === "ledger_deposit_failed"), "but it IS recorded");

  /* -------------- 7) Recording an external transfer is retired ---------- */
  // It credited money Stripe never received, and a payout could draw on it
  // from the shared platform balance. A landlord paying vendors themselves is
  // on direct pay now; this endpoint only explains that.

  await reset();
  res = makeRes();
  await ctrl.createDeposit(makeReq({ amount: 500, reference: "etransfer-991" }), res);

  assert.strictEqual(res.statusCode, 410, "the endpoint is gone, with a reason");
  assert.strictEqual(res.body.code, "external_deposits_retired");
  assert.strictEqual(entries.length, 0, "nothing is credited");
  assert.strictEqual(ledgerRow.available, 0);

  // Deposits recorded before the retirement stay on the statement, labelled.
  await require("../../../services/ledger/ledger.service").recordDeposit({
    landlordId: LANDLORD,
    amountCents: 50000,
    idempotencyKey: "deposit:legacy-etransfer",
    provider: "manual",
    providerRef: "etransfer-991",
    fundingSource: "external",
    actor: "landlord",
    memo: "External transfer",
  });
  assert.strictEqual(entries[0].fundingSource, "external");

  /* -------------- 8) The wallet says how much Stripe cannot send --------- */
  // A landlord whose balance is entirely external can see that Stripe has
  // nothing to send, instead of discovering it when a payout fails.

  res = makeRes();
  await ctrl.getLedger(makeReq(), res);

  assert.strictEqual(res.body.data.balance.available, 500);
  assert.strictEqual(res.body.data.externalDeposits, 500, "all of it is external");
  assert.deepStrictEqual(res.body.data.clearing, [], "an external transfer never 'clears' through Stripe");
  assert.strictEqual(res.body.data.owedToVendors, 0);
  assert.strictEqual(res.body.data.entries[0].fundingSource, "external");

  /* -------------- 8b) The statement reads as a record ------------------ */
  // The journal says "hold_release"; a landlord asking where their money went
  // needs a sentence, a direction, and the job it belongs to.

  const externalRow = res.body.data.entries[0];
  assert.strictEqual(externalRow.title, "Recorded an external transfer");
  assert.strictEqual(externalRow.direction, "in", "money arriving reads as a gain");

  // A card deposit is titled differently — the distinction is the whole point.
  await reset();
  await handleDepositSucceeded(intent({ id: "pi_titled" }));
  res = makeRes();
  await ctrl.getLedger(makeReq(), res);
  assert.strictEqual(res.body.data.entries[0].title, "Added funds by card");

  // A completed job writes BOTH a hold_release and a payout. They are ONE
  // event to a landlord, so the release is absorbed and the leftover surfaces
  // on the payout instead of appearing as a second, confusing movement.
  entries.push(
    {
      _id: "e-hold",
      type: "hold",
      amountCents: 30000,
      currency: "CAD",
      createdAt: new Date(),
      requestId: { _id: "req-1", issueTitle: "Kitchen sink leaking" },
      // createHold always passes identityId, so a fixture without it was
      // testing a shape production never produces.
      identityId: { _id: "id-1", displayName: "Northline Plumbing" },
      completionId: "comp-1",
    },
    {
      _id: "e-release",
      type: "hold_release",
      landlordId: LANDLORD,
      amountCents: 30000,
      // What "returned" is read from: the release's credit back to available.
      lines: [
        { account: `landlord:${LANDLORD}:available`, direction: "debit", amountCents: 30000 },
        { account: `landlord:${LANDLORD}:held`, direction: "credit", amountCents: 30000 },
      ],
      currency: "CAD",
      createdAt: new Date(),
      completionId: "comp-1",
    },
    {
      _id: "e-payout",
      type: "payout",
      landlordId: LANDLORD,
      amountCents: 24000,
      currency: "CAD",
      createdAt: new Date(),
      providerStatus: "paid",
      completionId: "comp-1",
      identityId: { _id: "id-1", displayName: "Northline Plumbing" },
      requestId: { _id: "req-1", issueTitle: "Kitchen sink leaking" },
    }
  );

  res = makeRes();
  await ctrl.getLedger(makeReq(), res);
  const rows = res.body.data.entries;

  assert.ok(
    !rows.some((r) => r.type === "hold_release"),
    "the release is absorbed, not shown as its own movement"
  );

  const payoutRow = rows.find((r) => r.type === "payout");
  assert.strictEqual(payoutRow.title, "Vendor payment to Northline Plumbing", "named without implying delivery");
  assert.strictEqual(payoutRow.direction, "out");
  assert.strictEqual(payoutRow.jobTitle, "Kitchen sink leaking", "tied to the job it paid for");
  // Held 300, paid 240 -> 60 came back. Without this the landlord sees a $300
  // reservation and a $240 payment and has to do the subtraction themselves.
  assert.strictEqual(payoutRow.returnedToBalance, 60);

  const holdRow = rows.find((r) => r.type === "hold");
  // Every vendor-facing row names the VENDOR and lets the job fall to the
  // subtitle, so the statement reads consistently down its left edge.
  assert.strictEqual(holdRow.title, "Reserved for Northline Plumbing");
  assert.strictEqual(holdRow.jobTitle, "Kitchen sink leaking", "the job is the subtitle");
  assert.strictEqual(
    holdRow.direction,
    "neutral",
    "a reservation moves the landlord's own money and must not read as a charge"
  );

  /* -------------- 9) No Stripe -> refuse, do not fake ------------------ */

  await reset();
  stripeOn = false;
  res = makeRes();
  await ctrl.createDepositIntentHandler(makeReq({ amount: 1000 }), res);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.code, "payments_not_configured");
  assert.ok(/isn't connected to Stripe/.test(res.body.message), "it says WHY, not just 'not available'");
  assert.strictEqual(entries.length, 0, "an unavailable rail must never credit optimistically");
  res = makeRes();
  await ctrl.getLedger(makeReq(), res);
  assert.strictEqual(res.body.data.onlinePayments, false, "and the wallet says so before anyone tries");
  stripeOn = true;
  res = makeRes();
  await ctrl.getLedger(makeReq(), res);
  assert.strictEqual(res.body.data.onlinePayments, true);

  /* -------------- 10) Amount validation -------------------------------- */

  stripeOn = true;
  // Below $20 the fixed 30¢ is a large share of the payment — a $1 top-up
  // would be a third fee — so card top-ups start there.
  for (const bad of [0, -5, 1, 19.99, 1000001, "abc", null, undefined]) {
    res = makeRes();
    await ctrl.createDepositIntentHandler(makeReq({ amount: bad }), res);
    assert.strictEqual(res.statusCode, 400, `should reject amount: ${bad}`);
    assert.strictEqual(res.body.field, "amount", "so the dialog shows it beside the amount field");
  }
  res = makeRes();
  await ctrl.createDepositIntentHandler(makeReq({ amount: 20 }), res);
  assert.strictEqual(res.statusCode, 201, "exactly the minimum is accepted");

  // Exact $1 exception: server-scoped, expiring, and one Stripe intent even
  // when two tabs supply different browser tokens.
  const pilotEnv = require("../../../config/env");
  const savedPilot = { card_pilot_landlord_id: pilotEnv.card_pilot_landlord_id,
    card_pilot_starts_at: pilotEnv.card_pilot_starts_at, card_pilot_expires_at: pilotEnv.card_pilot_expires_at };
  const pilotOwner = "000000000000000000000001";
  Object.assign(pilotEnv, { card_pilot_landlord_id: pilotOwner,
    card_pilot_starts_at: new Date(Date.now() - 1000).toISOString(),
    card_pilot_expires_at: new Date(Date.now() + 3600000).toISOString() });
  await reset();
  for (const clientToken of ["pilot-tab-1111", "pilot-tab-2222"]) {
    const req = makeReq({ amount: 1, clientToken }); req.user.id = pilotOwner;
    const result = makeRes(); await ctrl.createDepositIntentHandler(req, result);
    assert.equal(result.statusCode, 201); assert.equal(result.body.data.chargeAmount, 1.34);
  }
  assert.equal(intentOptions[0].idempotencyKey, intentOptions[1].idempotencyKey);
  assert.equal(intentsCreated[0].metadata.artreloWalletCents, "100");
  const wrongAmount = makeReq({ amount: 2 }); wrongAmount.user.id = pilotOwner;
  res = makeRes(); await ctrl.createDepositIntentHandler(wrongAmount, res); assert.equal(res.statusCode, 400);
  res = makeRes(); await ctrl.createDepositIntentHandler(makeReq({ amount: 1 }), res); assert.equal(res.statusCode, 400);
  Object.assign(pilotEnv, savedPilot);

  /* -------------- 11) Card, with the browser's attempt token ----------- */
  // Unchanged without one; with one, a double-click reuses ONE intent.
  await reset();
  await ctrl.createDepositIntentHandler(makeReq({ amount: 100 }), makeRes());
  assert.strictEqual(intentOptions[0], undefined, "no token, no key: exactly as before");
  await ctrl.createDepositIntentHandler(makeReq({ amount: 100, clientToken: "abcd-1234-efgh" }), makeRes());
  assert.strictEqual(intentOptions[1].idempotencyKey, `topup:${LANDLORD}:card:abcd-1234-efgh`);
  await ctrl.createDepositIntentHandler(makeReq({ amount: 100, clientToken: "<script>" }), makeRes());
  assert.strictEqual(intentOptions[2], undefined, "a malformed token is ignored, not trusted");

  /* -------------- 12) method: "bank" goes to the bank service ---------- */
  const realStart = bankTopUps.startBankTopUp;
  let startedWith = null;
  try {
    bankTopUps.startBankTopUp = async (args) => {
      startedWith = args;
      return { refused: { code: "over_new_cap", field: "amount", message: "Up to $2,000." } };
    };
    res = makeRes();
    await ctrl.createDepositIntentHandler(makeReq({ amount: 2500, method: "bank", clientToken: "tok-1234-abcd", useSaved: true }), res);
    assert.deepStrictEqual(startedWith, { landlordId: LANDLORD, amountCents: 250000, clientToken: "tok-1234-abcd", useSaved: true, transactionType: undefined });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual([res.body.code, res.body.field], ["over_new_cap", "amount"], "a limit goes beside the amount");

    bankTopUps.startBankTopUp = async () => ({ refused: { code: "one_in_flight", message: "One at a time." } });
    res = makeRes();
    await ctrl.createDepositIntentHandler(makeReq({ amount: 500, method: "bank", clientToken: "tok-1234-abcd" }), res);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.field, undefined);

    bankTopUps.startBankTopUp = async () => ({ clientSecret: null, paymentIntentId: "pi_b", status: "processing", walletCents: 50000 });
    res = makeRes();
    await ctrl.createDepositIntentHandler(makeReq({ amount: 500, method: "bank", clientToken: "tok-1234-abcd", useSaved: "yes" }), res);
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(
      [res.body.data.method, res.body.data.status, res.body.data.walletAmount, res.body.data.processingFee, res.body.data.chargeAmount],
      ["bank", "processing", 500, 0, 500],
      "no fee on top: debited exactly what the wallet gets"
    );
    assert.strictEqual(entries.length, 0, "starting a bank top-up credits nothing either");

    // Only `true` means "debit my saved account": a server-confirmed debit is
    // not something a truthy string should trigger.
    bankTopUps.startBankTopUp = async (args) => {
      startedWith = args;
      return { clientSecret: "s", paymentIntentId: "pi_c", status: "requires_payment_method", walletCents: 50000 };
    };
    await ctrl.createDepositIntentHandler(makeReq({ amount: 500, method: "bank", clientToken: "tok-1234-abcd", useSaved: "yes" }), makeRes());
    assert.strictEqual(startedWith.useSaved, false);
  } finally {
    bankTopUps.startBankTopUp = realStart;
  }

  // A reversed bank top-up is never "clearing": the bank took it back.
  await reset();
  const later = new Date(Date.now() + 5 * 86400000);
  entries.push(
    { _id: "bk1", landlordId: LANDLORD, type: "deposit", fundingSource: "stripe", memo: "Bank top-up", providerRef: "pi_kept", amountCents: 30000, bank: { availableOn: later }, lines: [], balanceAfter: {}, createdAt: new Date() },
    { _id: "bk2", landlordId: LANDLORD, type: "deposit", fundingSource: "stripe", memo: "Bank top-up", providerRef: "pi_gone", amountCents: 20000, bank: { availableOn: later }, lines: [], balanceAfter: {}, createdAt: new Date() },
    { _id: "bk3", landlordId: LANDLORD, type: "deposit_reversal", providerRef: "pi_gone", amountCents: 20000, shortfall: false, lines: [], balanceAfter: {}, createdAt: new Date() }
  );
  res = makeRes();
  await ctrl.getLedger(makeReq(), res);
  assert.deepStrictEqual(
    res.body.data.clearing.map((c) => [c.amount, c.method]),
    [[300, "bank"]],
    "only the top-up that will actually clear"
  );

  // The wallet payload: bank top-ups off by default, nothing pending.
  await reset();
  res = makeRes();
  await ctrl.getLedger(makeReq(), res);
  assert.deepStrictEqual(res.body.data.bankDebit, { enabled: false });
  assert.deepStrictEqual(res.body.data.pendingTopUps, []);
  assert.strictEqual(res.body.data.bankTopUpFailure, null);
  assert.strictEqual(res.body.data.bankOwed, 0);

  console.log("ledgerDeposit.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
