// The payout rail and the Stripe webhook.
//
// The single most important assertion in this file is section 1: the offline
// rail must NOT report `delivered`. notification/email.service treats a stubbed
// send as sent — right for email, catastrophic for money, because it produces a
// vendor marked paid who was never paid. That rule must not be inherited here.
//
// Second most important: the webhook refuses to process anything it cannot
// verify. The (since removed) Vapi voice webhook had a signature verifier that
// returned true unconditionally; repeating that on a money endpoint means anyone
// who learns the URL can forge payout events.

const assert = require("assert");
require("../../../models/LandlordLedger").findOne = async () => ({ bankOwed: 0 });
const Module = require("module");

/* ---------------- Stub the Stripe client before anything requires it ----- */

let stripeConfigured = false;
let transfersCreated = [];
let accountsCreated = [];
let accountsUpdated = [];
let accountLinks = [];
let retrievedAccount = null;
let constructEventImpl = null;
let failNextTransfer = false;
// The account body a thin-event fetch resolves to.
let v2RetrieveShape = null;
// Records that the THIN verifier ran, so a test can prove constructEvent was
// not used for a v2 payload.
let parseEventNotificationCalls = [];
let loginLinks = [];
let loginLinkError = null;

// Accounts v2 for creation and onboarding links, v1 only for retrieve and
// transfers. Stripe refuses v1 account creation for new Connect integrations,
// so this mirrors what the service actually calls.
const fakeStripe = {
  v2: {
    core: {
      accounts: {
        create: async (params) => {
          accountsCreated.push(params);
          return { id: `acct_${accountsCreated.length}` };
        },
        // Thin events carry only an id, so the account is FETCHED.
        retrieve: async (id) => ({ id, ...(v2RetrieveShape || {}) }),
        update: async (id, params) => {
          accountsUpdated.push({ id, params });
          return { id };
        },
      },
      accountLinks: {
        create: async (params) => {
          accountLinks.push(params);
          return { url: `https://connect.stripe.test/${accountLinks.length}` };
        },
      },
    },
  },
  accounts: {
    retrieve: async () => retrievedAccount,
    // Pinned to the sandbox (2026-10-03): a login link works on an onboarded
    // v2 recipient account and is refused before onboarding finishes.
    createLoginLink: async (id) => {
      if (loginLinkError) throw new Error(loginLinkError);
      loginLinks.push(id);
      return { url: `https://connect.stripe.test/express/${id}` };
    },
  },
  transfers: {
    create: async (params, opts) => {
      transfersCreated.push({ params, opts });
      if (failNextTransfer) throw new Error("insufficient funds in platform balance");
      return { id: `tr_${transfersCreated.length}` };
    },
  },
  webhooks: {
    constructEvent: (...args) => constructEventImpl(...args),
  },
  // Thin events (v2) use this, NOT webhooks.constructEvent.
  parseEventNotification: async (payload, sig, secret) => {
    parseEventNotificationCalls.push({ payload, sig, secret });
    return JSON.parse(payload.toString("utf8"));
  },
};

const stripeConfig = require("../../../config/stripe");
stripeConfig.getStripe = () => (stripeConfigured ? fakeStripe : null);
stripeConfig.isConfigured = () => stripeConfigured;

const VendorIdentity = require("../../../models/VendorIdentity");
const LedgerEntry = require("../../../models/LedgerEntry");
const AgentActionLog = require("../../../models/AgentActionLog");

let identityRow = null;
let identityPatches = [];
let entryRows = [];
let entryPatches = [];

VendorIdentity.findById = async () => identityRow;
VendorIdentity.findOne = async () => identityRow;
VendorIdentity.updateOne = async (filter, update) => {
  identityPatches.push(update.$set || {});
  if (identityRow) Object.assign(identityRow, update.$set || {});
  return { modifiedCount: 1 };
};

LedgerEntry.findById = async (id) => entryRows.find((e) => String(e._id) === String(id)) || null;
LedgerEntry.findOne = async (filter) =>
  entryRows.find((e) =>
    Object.entries(filter).every(([k, v]) => String(e[k]) === String(v))
  ) || null;
LedgerEntry.find = (filter) => ({
  select: () => ({
    lean: async () =>
      entryRows.filter((e) =>
        Object.entries(filter).every(([k, v]) => String(e[k]) === String(v))
      ),
  }),
});
LedgerEntry.updateOne = async (filter, update) => {
  const row = entryRows.find((e) => String(e._id) === String(filter._id));
  if (row) {
    Object.assign(row, update.$set || {});
    entryPatches.push(update.$set || {});
  }
  return { modifiedCount: 1 };
};
AgentActionLog.create = async () => ({});

const {
  sendPayout,
  ensureConnectAccount,
  deriveConnectStatus,
  activeProvider,
  OFFLINE,
  STRIPE_CONNECT,
} = require("../../../services/ledger/payoutProvider.service");

const reset = () => {
  transfersCreated = [];
  accountsCreated = [];
  accountLinks = [];
  identityPatches = [];
  entryPatches = [];
  entryRows = [];
  identityRow = {
    _id: "identity-1",
    emailNormalized: "pat@fixit.example",
    stripeConnectAccountId: null,
    connectStatus: "none",
    connectOnboardedAt: null,
  };
};

async function main() {
  /* -------------- 1) THE RULE NOT INHERITED FROM EMAIL ---------------- */

  reset();
  stripeConfigured = false;

  const offline = await sendPayout({
    identity: identityRow,
    amountCents: 24000,
    idempotencyKey: "payout:comp-1",
  });

  assert.strictEqual(offline.stub, true);
  assert.strictEqual(offline.provider, OFFLINE);
  assert.strictEqual(
    offline.delivered,
    false,
    "the offline rail must NEVER report delivered — that is a vendor marked paid who was not"
  );
  assert.strictEqual(offline.status, "pending_manual", "a human must confirm an off-platform payment");
  assert.strictEqual(offline.reference, null);
  assert.strictEqual(activeProvider(), OFFLINE);

  /* -------------- 2) An un-onboarded vendor parks, never fails --------- */

  reset();
  stripeConfigured = true;
  assert.strictEqual(activeProvider(), STRIPE_CONNECT);

  const notOnboarded = await sendPayout({
    identity: { ...identityRow, stripeConnectAccountId: null, connectStatus: "none" },
    amountCents: 24000,
    idempotencyKey: "payout:comp-2",
  });
  assert.strictEqual(notOnboarded.status, "pending_onboarding");
  assert.strictEqual(notOnboarded.delivered, false);
  assert.strictEqual(transfersCreated.length, 0, "no transfer is attempted without an account");

  // Having an account id but not being enabled is the same story.
  const pendingAccount = await sendPayout({
    identity: { ...identityRow, stripeConnectAccountId: "acct_x", connectStatus: "pending" },
    amountCents: 24000,
    idempotencyKey: "payout:comp-3",
  });
  assert.strictEqual(pendingAccount.status, "pending_onboarding");
  assert.strictEqual(transfersCreated.length, 0);

  /* -------------- 3) A real transfer passes the key straight through --- */

  reset();
  stripeConfigured = true;
  const enabled = { ...identityRow, stripeConnectAccountId: "acct_ok", connectStatus: "enabled" };

  const paid = await sendPayout({
    identity: enabled,
    amountCents: 24000,
    currency: "CAD",
    idempotencyKey: "payout:comp-4",
    memo: "Job completed at $240",
  });

  assert.strictEqual(paid.delivered, true);
  assert.strictEqual(paid.status, "paid");
  assert.ok(paid.reference.startsWith("tr_"));
  assert.strictEqual(transfersCreated[0].params.amount, 24000, "cents, not dollars");
  assert.strictEqual(transfersCreated[0].params.currency, "cad");
  assert.strictEqual(transfersCreated[0].params.destination, "acct_ok");
  // ONE key end to end: the ledger entry's key is Stripe's idempotency header,
  // so a retry at any layer converges on a single transfer.
  assert.strictEqual(transfersCreated[0].opts.idempotencyKey, "payout:comp-4");

  /* -------------- 4) A provider failure never throws ------------------- */

  // A transfer that Stripe rejects must return the failure, not throw it: an
  // exception here would propagate into closeJobCompletion and could unwind a
  // job that is genuinely finished.

  reset();
  stripeConfigured = true;
  failNextTransfer = true;

  let threw = false;
  let failed;
  try {
    failed = await sendPayout({
      identity: { ...identityRow, stripeConnectAccountId: "acct_ok", connectStatus: "enabled" },
      amountCents: 24000,
      idempotencyKey: "payout:comp-5",
    });
  } catch {
    threw = true;
  }
  failNextTransfer = false;

  assert.strictEqual(threw, false, "a payout failure must never throw into the close path");
  assert.strictEqual(failed.delivered, false);
  assert.strictEqual(failed.status, "failed");
  assert.strictEqual(failed.reference, null);
  assert.ok(failed.error.includes("insufficient funds"), "the reason is carried for the operator");

  /* -------------- 5) Connect status derivation ------------------------- */

  assert.strictEqual(deriveConnectStatus({ payouts_enabled: true }), "enabled");
  assert.strictEqual(
    deriveConnectStatus({ payouts_enabled: false, requirements: { disabled_reason: "rejected.fraud" } }),
    "restricted"
  );
  assert.strictEqual(deriveConnectStatus({ payouts_enabled: false }), "pending");
  assert.strictEqual(deriveConnectStatus(null), "none");
  // charges_enabled explicitly false must not read as enabled.
  assert.strictEqual(
    deriveConnectStatus({ payouts_enabled: true, charges_enabled: false }),
    "pending"
  );

  /* -------------- 5b) The ACCOUNTS V2 shape ---------------------------- */
  // A v2 account has NO payouts_enabled at all. Reading it yields undefined and
  // fell through to "pending" forever, so a vendor who HAD finished onboarding
  // was never marked enabled and their payouts parked indefinitely. Shapes below
  // are copied from a real sandbox account.

  const v2Account = (status, statusDetails = []) => ({
    id: "acct_v2",
    configuration: {
      recipient: {
        capabilities: {
          stripe_balance: { stripe_transfers: { status, status_details: statusDetails } },
        },
      },
    },
  });

  assert.strictEqual(deriveConnectStatus(v2Account("active")), "enabled");
  assert.strictEqual(deriveConnectStatus(v2Account("pending")), "pending");

  // Exactly what a freshly created v2 recipient returns. It says "restricted",
  // but the vendor simply has not filled the form in yet — reading that as a
  // hard block would strand a contractor who is mid-onboarding.
  assert.strictEqual(
    deriveConnectStatus(
      v2Account("restricted", [{ code: "requirements_past_due", resolution: "provide_info" }])
    ),
    "pending",
    "a recoverable restriction is still in progress, not blocked"
  );

  // Restricted with no recoverable reason IS a block.
  assert.strictEqual(deriveConnectStatus(v2Account("restricted", [])), "restricted");
  assert.strictEqual(
    deriveConnectStatus(v2Account("restricted", [{ code: "rejected.fraud" }])),
    "restricted"
  );

  /* -------------- 5c) transfers capability, NOT payouts_enabled -------- */
  // These answer different questions and conflating them stranded a real $180
  // payout against a vendor who was ready to receive it:
  //
  //   capabilities.transfers  can WE send money into their Stripe balance
  //   payouts_enabled         can THEY withdraw from it to their bank
  //
  // Shape copied from the sandbox account that exposed this.
  const v1MidOnboarding = {
    id: "acct_v1",
    capabilities: { transfers: "active" },
    payouts_enabled: false,
    charges_enabled: true,
    requirements: {
      disabled_reason: "requirements.past_due",
      past_due: ["individual.verification.proof_of_liveness"],
    },
  };
  assert.strictEqual(
    deriveConnectStatus(v1MidOnboarding),
    "enabled",
    "a vendor whose transfers capability is active CAN be paid, whatever payouts_enabled says"
  );

  assert.strictEqual(
    deriveConnectStatus({ capabilities: { transfers: "pending" }, payouts_enabled: false }),
    "pending"
  );
  assert.strictEqual(
    deriveConnectStatus({
      capabilities: { transfers: "inactive" },
      requirements: { disabled_reason: "rejected.fraud" },
    }),
    "restricted"
  );

  // With no capability block at all, fall back to the coarse flags rather than
  // optimistically reading "enabled".
  assert.strictEqual(deriveConnectStatus({ payouts_enabled: true, charges_enabled: true }), "enabled");
  assert.strictEqual(
    deriveConnectStatus({ requirements: { disabled_reason: "requirements.past_due" } }),
    "restricted"
  );

  // The v2 branch must win when both shapes are somehow present.
  assert.strictEqual(
    deriveConnectStatus({ ...v2Account("active"), payouts_enabled: false }),
    "enabled",
    "the v2 capability is authoritative over a stale v1 projection"
  );

  /* -------------- 6) Onboarding is once per IDENTITY ------------------- */

  reset();
  stripeConfigured = true;
  const first = await ensureConnectAccount({
    identity: identityRow,
    returnUrl: "https://app.test/done",
    refreshUrl: "https://app.test/retry",
  });
  assert.strictEqual(accountsCreated.length, 1);
  assert.strictEqual(accountsCreated[0].identity.country, "ca", "CAD quotes, Canadian vendors");
  // A vendor RECEIVES money and never processes payments on our behalf.
  // Requesting merchant capabilities would push them through KYC they do not
  // need in order to get paid.
  assert.ok(
    accountsCreated[0].configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested,
    "the vendor is configured as a payout recipient"
  );
  assert.strictEqual(accountsCreated[0].configuration.merchant, undefined, "not a merchant");
  // Stripe REJECTS "stripe" for a recipient-only configuration; both collectors
  // must be the application. Pinned so a well-meaning change does not 400 in
  // production.
  assert.strictEqual(accountsCreated[0].defaults.responsibilities.fees_collector, "application");
  assert.strictEqual(accountsCreated[0].defaults.responsibilities.losses_collector, "application");
  assert.strictEqual(accountsCreated[0].defaults.currency, "cad");
  // Stripe needs a website OR a product description. An independent contractor
  // with no website could not get past that step of the hosted form, so the
  // description is supplied up front and the website is never asked for.
  const description = accountsCreated[0].defaults.profile.product_description;
  assert.ok(description.length >= 30, "past Stripe's 30-character review threshold");
  assert.match(description, /repair and maintenance services to residential rental properties/);
  assert.strictEqual(accountsCreated[0].defaults.profile.business_url, undefined, "no invented website");
  assert.ok(first.onboardingUrl.startsWith("https://connect.stripe.test/"));
  assert.strictEqual(identityPatches[0].connectStatus, "pending");

  // The onboarding link targets the recipient configuration, not a merchant
  // flow — otherwise the vendor is asked for business details they don't have.
  assert.strictEqual(accountLinks[0].use_case.type, "account_onboarding");
  assert.deepStrictEqual(accountLinks[0].use_case.account_onboarding.configurations, ["recipient"]);

  // A second landlord hiring the same contractor must NOT create a second
  // Stripe account. This is the whole payoff for splitting VendorIdentity out
  // of the landlord-scoped Vendor.
  identityRow.stripeConnectAccountId = "acct_1";
  await ensureConnectAccount({
    identity: identityRow,
    returnUrl: "https://app.test/done",
    refreshUrl: "https://app.test/retry",
  });
  assert.strictEqual(accountsCreated.length, 1, "one contractor, one Connect account");
  assert.strictEqual(accountLinks.length, 2, "but a fresh onboarding link each time");

  // A vendor already stuck mid-onboarding (account made before the description
  // existed) gets it backfilled on resume — that is who the fix is for.
  assert.strictEqual(accountsUpdated.length, 1);
  assert.strictEqual(accountsUpdated[0].id, "acct_1");
  assert.ok(accountsUpdated[0].params.defaults.profile.product_description);

  // The trade shapes the wording; junk in it does not reach Stripe.
  const { describeVendorBusiness } = require("../../../services/ledger/payoutProvider.service");
  assert.match(describeVendorBusiness("plumbing"), /^Independent plumbing contractor providing/);
  assert.match(describeVendorBusiness("hvac_repair"), /^Independent hvac repair contractor/);
  assert.match(describeVendorBusiness(null), /^Independent contractor providing/);
  assert.doesNotMatch(describeVendorBusiness("<script>9"), /[<>0-9]/);

  // A backfill failure must not cost the vendor their onboarding link.
  accountsUpdated = [];
  const originalUpdate = fakeStripe.v2.core.accounts.update;
  fakeStripe.v2.core.accounts.update = async () => {
    throw new Error("stripe down");
  };
  const stillLinked = await ensureConnectAccount({
    identity: identityRow,
    returnUrl: "https://app.test/done",
    refreshUrl: "https://app.test/retry",
  });
  assert.ok(stillLinked.onboardingUrl, "the link is still minted");
  fakeStripe.v2.core.accounts.update = originalUpdate;

  /* -------------- 7) The webhook refuses what it cannot verify --------- */

  const env = require("../../../config/env");
  const originalSecret = env.stripe_webhook_secret;

  const { handleStripeWebhook } = require("../../../controllers/stripeWebhook.controller");
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

  // No secret configured -> refuse, do not process.
  stripeConfigured = true;
  env.stripe_webhook_secret = undefined;
  let res = makeRes();
  await handleStripeWebhook({ body: Buffer.from("{}"), headers: {} }, res);
  assert.strictEqual(res.statusCode, 503, "an unconfigured webhook must refuse, not accept");
  assert.strictEqual(res.body.received, false);

  // Bad signature -> 400, and the reason is never echoed back to the caller.
  env.stripe_webhook_secret = "whsec_test";
  constructEventImpl = () => {
    throw new Error("No signatures found matching the expected signature");
  };
  res = makeRes();
  await handleStripeWebhook(
    { body: Buffer.from("{}"), headers: { "stripe-signature": "t=1,v1=deadbeef" } },
    res
  );
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.received, false);
  assert.strictEqual(
    JSON.stringify(res.body).includes("signature"),
    false,
    "a prober must learn nothing from the response body"
  );

  /* -------------- 8) A verified event settles parked payouts ----------- */

  reset();
  stripeConfigured = true;
  identityRow = {
    _id: "identity-1",
    stripeConnectAccountId: "acct_ok",
    connectStatus: "pending",
    connectOnboardedAt: null,
  };
  entryRows = [
    {
      _id: "entry-1",
      type: "payout",
      identityId: "identity-1",
      providerStatus: "pending_onboarding",
      amountCents: 24000,
      currency: "CAD",
      idempotencyKey: "payout:comp-9",
      memo: null,
      completionId: "comp-9",
    },
  ];

  constructEventImpl = () => ({
    type: "account.updated",
    data: { object: { id: "acct_ok", payouts_enabled: true } },
  });
  // applyAccountState no longer trusts the event payload — it re-fetches the
  // authoritative v2 account, because the v1 projection in an account.updated
  // event reports a stricter picture than the capability actually allows. The
  // stub therefore has to supply what that fetch returns.
  v2RetrieveShape = {
    configuration: {
      recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "active" } } } },
    },
  };

  res = makeRes();
  await handleStripeWebhook(
    { body: Buffer.from("{}"), headers: { "stripe-signature": "sig" } },
    res
  );

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.received, true);
  assert.strictEqual(identityRow.connectStatus, "enabled");
  assert.ok(identityRow.connectOnboardedAt, "onboarding completion is stamped");
  // The parked payout was drained — this is why a payout is never lost when a
  // vendor accepts a job before finishing their bank setup.
  assert.strictEqual(transfersCreated.length, 1, "the parked payout settled on enablement");
  assert.strictEqual(entryRows[0].providerStatus, "paid");

  /* -------------- 9) THIN EVENTS — the path that actually fires -------- */
  //
  // Accounts v2 emits v2.core.account.* thin events, which carry only an id and
  // have NO data.object. The previous handler called constructEvent and read
  // event.data.object, so the real onboarding-complete event either failed
  // verification or threw — meaning a vendor could finish onboarding and their
  // payouts would stay parked forever.

  const { isThinPayload, isAccountEventType } = require("../../../controllers/stripeWebhook.controller");

  const thinBody = Buffer.from(
    JSON.stringify({
      object: "v2.core.event",
      type: "v2.core.account.updated",
      related_object: { id: "acct_ok", type: "v2.core.account" },
    })
  );
  const snapshotBody = Buffer.from(JSON.stringify({ object: "event", type: "transfer.created" }));

  assert.strictEqual(isThinPayload(thinBody), true);
  assert.strictEqual(isThinPayload(snapshotBody), false);
  assert.strictEqual(isThinPayload(Buffer.from("not json")), false, "garbage must not crash");

  // Both the broad update and the narrow capability event must route.
  assert.strictEqual(isAccountEventType("v2.core.account.updated"), true);
  assert.strictEqual(
    isAccountEventType("v2.core.account[configuration.recipient].capability_status_updated"),
    true
  );
  assert.strictEqual(isAccountEventType("transfer.created"), false);

  reset();
  stripeConfigured = true;
  identityRow = {
    _id: "identity-1",
    stripeConnectAccountId: "acct_ok",
    connectStatus: "pending",
    connectOnboardedAt: null,
  };
  entryRows = [
    {
      _id: "entry-2",
      type: "payout",
      identityId: "identity-1",
      providerStatus: "pending_onboarding",
      amountCents: 24000,
      currency: "CAD",
      idempotencyKey: "payout:comp-thin",
      memo: null,
      completionId: "comp-thin",
    },
  ];

  // A thin event must be verified with parseEventNotification, NOT
  // constructEvent — so make constructEvent throw to prove it isn't used.
  parseEventNotificationCalls = [];
  constructEventImpl = () => {
    throw new Error("constructEvent must not be used for a thin event");
  };
  // The account the thin-event fetch resolves to: fully onboarded, in the v2
  // shape that has no payouts_enabled at all.
  v2RetrieveShape = {
    configuration: {
      recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "active" } } } },
    },
  };

  res = makeRes();
  await handleStripeWebhook({ body: thinBody, headers: { "stripe-signature": "sig" } }, res);

  assert.strictEqual(
    parseEventNotificationCalls.length,
    1,
    "a thin event must go through parseEventNotification"
  );
  assert.ok(
    Buffer.isBuffer(parseEventNotificationCalls[0].payload),
    "the RAW body is verified, not a parsed object"
  );
  assert.strictEqual(parseEventNotificationCalls[0].secret, "whsec_test");
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(identityRow.connectStatus, "enabled", "the v2 shape resolved to enabled");
  assert.ok(identityRow.connectOnboardedAt);
  assert.strictEqual(transfersCreated.length, 1, "the parked payout settled off a THIN event");
  assert.strictEqual(entryRows[0].providerStatus, "paid");

  v2RetrieveShape = null;

  /* -------- 9b) Each format is verified with its OWN destination's secret ---- */

  // A deployed account has one snapshot and one thin destination, each with its
  // own whsec_. The section above is the `stripe listen` case: thin with no
  // thin secret falls back to the one secret. This is the deployed case.
  const originalThinSecret = env.stripe_webhook_secret_thin;
  env.stripe_webhook_secret_thin = "whsec_thin";

  // A non-account thin type, so this checks verification and nothing else.
  parseEventNotificationCalls = [];
  res = makeRes();
  await handleStripeWebhook(
    {
      body: Buffer.from(JSON.stringify({ object: "v2.core.event", type: "v2.core.event_destination.ping" })),
      headers: { "stripe-signature": "sig" },
    },
    res
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(
    parseEventNotificationCalls[0].secret,
    "whsec_thin",
    "a thin event is verified with the thin destination's secret"
  );

  let snapshotSecretSeen = null;
  constructEventImpl = (payload, sig, secret) => {
    snapshotSecretSeen = secret;
    return { type: "invoice.paid", data: { object: {} } };
  };
  res = makeRes();
  await handleStripeWebhook({ body: Buffer.from("{}"), headers: { "stripe-signature": "sig" } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(
    snapshotSecretSeen,
    "whsec_test",
    "a snapshot event is never verified with the thin secret"
  );

  env.stripe_webhook_secret_thin = originalThinSecret;

  /* -------------- 9b) THE SAFETY NET: polling also drains -------------- */
  //
  // The webhook is primary but not guaranteed — Stripe gives up after its retry
  // schedule, and a dropped `stripe listen` tunnel loses the event outright.
  // Before this, one missed event left a vendor owed money with nothing in the
  // system that would ever settle it.

  const { syncConnectStatus } = require("../../../services/ledger/payoutProvider.service");

  reset();
  stripeConfigured = true;
  identityRow = {
    _id: "identity-1",
    stripeConnectAccountId: "acct_ok",
    // Onboarding finished at Stripe, but the event never reached us.
    connectStatus: "pending",
    connectOnboardedAt: null,
  };
  entryRows = [
    {
      _id: "entry-poll",
      type: "payout",
      identityId: "identity-1",
      providerStatus: "pending_onboarding",
      amountCents: 18000,
      currency: "CAD",
      idempotencyKey: "payout:comp-poll",
      memo: null,
      completionId: "comp-poll",
    },
  ];
  v2RetrieveShape = {
    configuration: {
      recipient: { capabilities: { stripe_balance: { stripe_transfers: { status: "active" } } } },
    },
  };

  const polled = await syncConnectStatus(identityRow);
  assert.strictEqual(polled, "enabled");
  assert.strictEqual(
    transfersCreated.length,
    1,
    "polling must settle a payout the webhook never arrived for"
  );
  assert.strictEqual(entryRows[0].providerStatus, "paid");

  // Polling again must NOT pay a second time.
  await syncConnectStatus({ ...identityRow, connectStatus: "enabled" });
  assert.strictEqual(transfersCreated.length, 1, "an already-settled payout is not re-sent");

  // And a vendor who was ALREADY enabled triggers no drain at all — the net
  // fires on the transition, not on every poll.
  reset();
  stripeConfigured = true;
  identityRow = {
    _id: "identity-1",
    stripeConnectAccountId: "acct_ok",
    connectStatus: "enabled",
    connectOnboardedAt: new Date(),
  };
  entryRows = [];
  await syncConnectStatus(identityRow);
  assert.strictEqual(transfersCreated.length, 0, "no transition, no drain");

  v2RetrieveShape = null;

  /* -------------- 10) Transfer events that actually exist -------------- */
  // There is no transfer.paid and no transfer.failed in Stripe's catalogue.
  // Switching on them meant those branches could never run.

  reset();
  stripeConfigured = true;
  entryRows = [
    {
      _id: "entry-3",
      type: "payout",
      providerRef: "tr_real",
      providerStatus: "pending",
      amountCents: 24000,
      currency: "CAD",
      requestId: "req-1",
      landlordId: "l1",
    },
  ];

  constructEventImpl = () => ({
    type: "transfer.created",
    data: { object: { id: "tr_real" } },
  });
  res = makeRes();
  await handleStripeWebhook({ body: snapshotBody, headers: { "stripe-signature": "sig" } }, res);
  assert.strictEqual(entryRows[0].providerStatus, "paid");

  constructEventImpl = () => ({
    type: "transfer.reversed",
    data: { object: { id: "tr_real" } },
  });
  res = makeRes();
  await handleStripeWebhook({ body: snapshotBody, headers: { "stripe-signature": "sig" } }, res);
  assert.strictEqual(entryRows[0].providerStatus, "failed", "a reversal is the real failure signal");
  assert.strictEqual(entryRows[0].providerError, "transfer reversed");

  // An unknown type is acknowledged, never errored — Stripe would otherwise
  // retry it forever.
  constructEventImpl = () => ({ type: "invoice.paid", data: { object: {} } });
  res = makeRes();
  await handleStripeWebhook({ body: snapshotBody, headers: { "stripe-signature": "sig" } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.received, true);

  env.stripe_webhook_secret = originalSecret;

  /* ---------------- Returning vendors: change payout details ------------ */
  const { createPayoutUpdateLink, ensureConnectAccount: ensure } = require("../../../services/ledger/payoutProvider.service");
  stripeConfigured = true;

  // Business vendors are asked by Stripe's form, not forced to "individual".
  accountsCreated = [];
  await ensure({ identity: { _id: "id-biz", emailNormalized: "biz@example.com" }, returnUrl: "r", refreshUrl: "f" });
  assert.ok(accountsCreated.length >= 1);
  assert.strictEqual(accountsCreated.at(-1).identity.entity_type, undefined, "no entity_type is forced");
  assert.strictEqual(accountsCreated.at(-1).identity.country, "ca");

  let link = await createPayoutUpdateLink({ identity: { stripeConnectAccountId: "acct_done" } });
  assert.deepStrictEqual(link, { url: "https://connect.stripe.test/express/acct_done", kind: "dashboard_login" });

  // Stripe's real refusal before onboarding finishes: reported, never thrown.
  loginLinkError = "Cannot create a login link for an account that has not completed onboarding.";
  link = await createPayoutUpdateLink({ identity: { stripeConnectAccountId: "acct_new" } });
  assert.deepStrictEqual(link, { url: null, reason: "stripe_error" });
  loginLinkError = null;

  link = await createPayoutUpdateLink({ identity: {} });
  assert.deepStrictEqual(link, { url: null, reason: "no_account" });

  console.log("payoutProvider.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
