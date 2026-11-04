// The payout rail. One interface, two implementations.
//
// Shaped exactly like notification/email.service.js — same field names, same
// {stub:true} convention — so the codebase has one provider contract rather
// than two:
//
//   { delivered, provider, reference, status, error }
//
// ONE RULE FROM EMAIL THAT MUST NOT BE COPIED HERE.
//
// vendorOutreach.service treats a stubbed email as sent, which is right: the
// alternative is a dev machine where no vendor can ever be contacted. Applying
// that to money would be catastrophic — a vendor marked paid who was never
// paid. So the offline rail returns `delivered: false, status: "pending_manual"`
// and the ledger records providerStatus "pending". The money leaves the BUDGET
// at close (held -> spent) but is not PAID until a human says so through
// markPayoutPaid. That endpoint is both the day-one offline rail and the exact
// seam the Stripe webhook writes through later.

const { getStripe, isConfigured, keyMode } = require("../../config/stripe");
const VendorIdentity = require("../../models/VendorIdentity");
const { grossUpForCardFee } = require("./cardFees");
const { assertCents } = require("./money");

const OFFLINE = "offline";
const STRIPE_CONNECT = "stripe_connect";

function activeProvider() {
  return isConfigured() ? STRIPE_CONNECT : OFFLINE;
}

/**
 * What the vendor does, for Stripe's underwriting. Internal to Stripe — the
 * vendor never sees it. Kept well past Stripe's 10-character minimum (it
 * recommends 30+ to avoid review delays) and true for every vendor Artrelo
 * pays: an independent trade doing repairs on rental properties.
 */
function describeVendorBusiness(trade) {
  const cleaned = String(trade || "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-zA-Z &/]/g, "")
    .trim()
    .toLowerCase();
  const work = cleaned ? `${cleaned} contractor` : "contractor";
  return (
    `Independent ${work} providing repair and maintenance services to residential rental properties, ` +
    "paid through Artrelo for completed work orders."
  );
}

/**
 * Create or resume a Connect Express onboarding session for a vendor.
 *
 * Called from the authenticated vendor hub, and skipped entirely
 * once connectStatus is "enabled" — which is the whole payoff for splitting
 * VendorIdentity out of the landlord-scoped Vendor: a contractor working for
 * three landlords onboards ONCE, not three times.
 *
 * Stripe owns identity verification and bank custody. We store only the account
 * reference. No banking details ever touch this database.
 *
 * `trade` (e.g. "plumbing") only shapes the product description below.
 */
async function ensureConnectAccount({ identity, returnUrl, refreshUrl, trade = null }) {
  const stripe = getStripe();
  if (!stripe) {
    return { configured: false, provider: OFFLINE, onboardingUrl: null, status: identity?.connectStatus || "none" };
  }

  let accountId = identity.stripeConnectAccountId;
  const profile = { product_description: describeVendorBusiness(trade),
    ...(identity.businessWebsite ? { business_url: identity.businessWebsite } : {}) };

  try {
    if (accountId && identity.connectStatus !== "enabled") {
      // Accounts created before the description existed are exactly the ones a
      // contractor is stuck on. Best effort: a failure here must not stop them
      // getting a fresh onboarding link.
      try {
        await stripe.v2.core.accounts.update(accountId, { defaults: { profile } });
      } catch (err) {
        console.error("[payoutProvider] profile backfill failed:", err.message);
      }
    }

    if (!accountId) {
      // Accounts v2. Stripe now refuses v1 account creation for new Connect
      // integrations ("Stripe no longer recommends Accounts v1..."), so v2 is
      // the path and v1 is only a fallback for platforms that have explicitly
      // re-enabled it.
      //
      // A vendor here is a RECIPIENT, not a merchant: they receive transfers
      // and never process payments on our behalf. Requesting merchant
      // capabilities would force them through KYC they do not need.
      const account = await stripe.v2.core.accounts.create({
        contact_email: identity.emailNormalized || undefined,
        display_name: identity.displayName || "Artrelo vendor",
        identity: {
          // CAD/Canada — quotes are hardcoded CAD and the outreach timezone is
          // America/Regina. Revisit when the product crosses a border.
          //
          // No entity_type: Stripe's hosted onboarding asks "individual or
          // company" itself. Hard-coding "individual" forced every plumbing
          // business through as a sole person.
          country: "ca",
        },
        configuration: {
          recipient: {
            capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
          },
        },
        // All three are REQUIRED once stripe_transfers is requested; Stripe
        // rejects the create without them.
        //
        // Both collectors must be "application" — Stripe enforces it for a
        // recipient-only configuration and rejects "stripe" outright. That is
        // consistent rather than surprising: a recipient never processes card
        // payments, so there are no chargebacks on their account. The platform
        // funds transfers from its own balance and therefore collects.
        dashboard: "express",
        defaults: {
          currency: "cad",
          responsibilities: { fees_collector: "application", losses_collector: "application" },
          // Stripe needs a business website OR a product description. An
          // independent contractor often has no website, and the hosted form
          // would not let them past that step. Supplying the description up
          // front can satisfy this requirement. Stripe may still request a real
          // business URL; the authenticated hub accepts one before redirect.
          profile,
        },
        include: ["configuration.recipient", "identity"],
        metadata: { artreloIdentityId: String(identity._id) },
      });

      accountId = account.id;
      await VendorIdentity.updateOne(
        { _id: identity._id },
        { $set: { stripeConnectAccountId: accountId, connectStatus: "pending" } }
      );
    }

    const link = await stripe.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["recipient"],
          return_url: returnUrl,
          refresh_url: refreshUrl,
        },
      },
    });

    return {
      configured: true,
      provider: STRIPE_CONNECT,
      accountId,
      onboardingUrl: link.url,
      status: "pending",
    };
  } catch (err) {
    // A secret key alone is not enough: the PLATFORM account must also have
    // signed up for Connect. Until it has, account creation 400s with a message
    // about signing up. That is an operator task, not a vendor-facing failure,
    // so it degrades to the offline rail rather than showing a contractor an
    // error they cannot act on.
    const notEnabled = /signed up for Connect/i.test(err.message || "");
    if (notEnabled) {
      console.error("[payoutProvider] Stripe Connect is not enabled on the platform account");
    } else {
      console.error("[payoutProvider] connect onboarding failed:", err.message);
    }
    return {
      configured: false,
      provider: OFFLINE,
      accountId: accountId || null,
      onboardingUrl: null,
      status: identity.connectStatus || "none",
      unavailableReason: notEnabled ? "connect_not_enabled" : "connect_error",
    };
  }
}

/**
 * A link where an already-onboarded vendor can change their payout details
 * (a new bank account, a business name). Returning vendors used to see no
 * payout section at all once set up -- no reminder they were, and no way to
 * change anything.
 *
 * Stripe-hosted, like onboarding: banking details never touch this database.
 * The vendor lands in their Express dashboard, where payout details are edited.
 *
 * A login link, not a v2 `account_update` Account Link. Verified against the
 * sandbox (2026-10-03): for a v2 recipient account Stripe refuses
 * account_update outright -- "Valid types for this account are
 * ["account_onboarding"]" -- while a login link on an onboarded recipient
 * account (dashboard: "express") works. A login link also refuses an account
 * that hasn't finished onboarding, which is why callers only offer this once
 * connectStatus is "enabled".
 *
 * Login links take no return URL (the dashboard has its own way back);
 * the args are accepted so the call sites read like onboarding.
 */
async function createPayoutUpdateLink({ identity }) {
  const stripe = getStripe();
  if (!stripe) return { url: null, reason: "not_configured" };
  const accountId = identity?.stripeConnectAccountId;
  if (!accountId) return { url: null, reason: "no_account" };

  try {
    const login = await stripe.accounts.createLoginLink(accountId);
    return { url: login.url, kind: "dashboard_login" };
  } catch (err) {
    console.error("[payoutProvider] payout update link failed:", err.message);
    return { url: null, reason: "stripe_error" };
  }
}

/**
 * Map a Stripe account onto our connectStatus enum.
 *
 * TWO SHAPES, because the same logical account arrives in two forms:
 *
 *   v2 — stripe.v2.core.accounts.create/retrieve, and anything reached from a
 *        v2.core.account thin event. Has NO `payouts_enabled` at all; the
 *        status lives at configuration.recipient.capabilities.stripe_balance
 *        .stripe_transfers.status ("active" | "restricted" | "pending" | ...).
 *   v1 — stripe.accounts.retrieve, which still works on a v2-created account
 *        and projects the familiar `payouts_enabled` boolean.
 *
 * Verified against a real sandbox account: a freshly created v2 recipient
 * returns {status: "restricted", status_details: [{code: "requirements_past_due"}]}
 * on the v2 shape and payouts_enabled:false on the v1 projection.
 *
 * The v2 branch is checked FIRST. Reading payouts_enabled off a v2 object
 * yields undefined, which silently fell through to "pending" — so a vendor who
 * had actually finished onboarding would never be marked enabled, and their
 * payouts would park forever.
 */
function deriveConnectStatus(account) {
  if (!account) return "none";

  const transfers =
    account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers;

  if (transfers?.status) {
    if (transfers.status === "active") return "enabled";
    if (transfers.status === "restricted") {
      // `restricted` covers both "we still need documents from you" and "you
      // are blocked". Only the former is recoverable by the vendor, and only
      // it should read as still-in-progress.
      const pendingInfo = (transfers.status_details || []).some((detail) =>
        ["requirements_past_due", "requirements_pending_verification", "provide_info"].includes(
          detail.code || detail.resolution
        )
      );
      return pendingInfo ? "pending" : "restricted";
    }
    return "pending";
  }

  // v1 projection.
  //
  // Gate on the TRANSFERS capability, not payouts_enabled. They answer
  // different questions and conflating them cost a real test run:
  //
  //   capabilities.transfers  can WE send money into their Stripe balance
  //   payouts_enabled         can THEY withdraw from it to their bank
  //
  // A verified sandbox account sat at transfers:"active" with
  // payouts_enabled:false and disabled_reason:"requirements.past_due", still
  // owing a proof-of-liveness document. We could pay that vendor perfectly
  // well; whether Stripe will later move it to their bank is between them and
  // Stripe, and gating on it left $180 parked against a vendor who was ready
  // to receive it.
  if (account.capabilities?.transfers) {
    if (account.capabilities.transfers === "active") return "enabled";
    if (account.capabilities.transfers === "pending") return "pending";
    // "inactive" — genuinely cannot receive.
    return account.requirements?.disabled_reason ? "restricted" : "pending";
  }

  // No capability block at all (a very old or partial payload). Fall back to
  // the coarse flags rather than guessing "enabled".
  if (account.payouts_enabled && account.charges_enabled !== false) return "enabled";
  if (account.requirements?.disabled_reason) return "restricted";
  return "pending";
}

/**
 * Fetch a connected account in whichever shape is available.
 *
 * v2 first (that is how we created it, and it carries the capability detail),
 * falling back to the v1 projection — which does still resolve a v2 account, so
 * the fallback is a real safety net rather than decoration.
 */
async function retrieveConnectAccount(stripe, accountId) {
  try {
    return await stripe.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.recipient"],
    });
  } catch (err) {
    console.warn("[payoutProvider] v2 retrieve failed, falling back to v1:", err.message);
    return stripe.accounts.retrieve(accountId);
  }
}

/** Refresh a vendor's onboarding state from Stripe. Safe to call often. */
async function syncConnectStatus(identity) {
  const stripe = getStripe();
  if (!stripe || !identity?.stripeConnectAccountId) return identity?.connectStatus || "none";

  try {
    const account = await retrieveConnectAccount(stripe, identity.stripeConnectAccountId);
    const status = deriveConnectStatus(account);
    const becameEnabled = status === "enabled" && identity.connectStatus !== "enabled";

    await VendorIdentity.updateOne(
      { _id: identity._id },
      {
        $set: {
          connectStatus: status,
          ...(status === "enabled" && !identity.connectOnboardedAt
            ? { connectOnboardedAt: new Date() }
            : {}),
        },
      }
    );

    // THE SAFETY NET. The webhook is the primary route and normally gets here
    // first, but it is not guaranteed: Stripe gives up after its retry
    // schedule, and a dropped `stripe listen` tunnel loses the event outright.
    // Without this, one missed event leaves a vendor owed money with nothing in
    // the system that would ever settle it.
    //
    // Lazy require: ledger.service imports THIS module for sendPayout, so a
    // top-level import here would be a cycle. Deferring it to call time breaks
    // that without either module having to know about the other at load.
    if (becameEnabled) {
      try {
        const { drainParkedPayouts } = require("./ledger.service");
        await drainParkedPayouts({ identityId: identity._id });
      } catch (err) {
        console.error("[payoutProvider] drain after sync failed:", err.message);
      }
    }

    return status;
  } catch (err) {
    console.error("[payoutProvider] connect sync failed:", err.message);
    return identity.connectStatus || "none";
  }
}

/**
 * Send money to a vendor.
 *
 * `idempotencyKey` is the SAME key the ledger entry carries, passed straight
 * through as Stripe's idempotency header — one key end to end, so a retry at
 * any layer converges on one transfer.
 *
 * Never throws: a payout failure must not unwind a completed job. The failure
 * is returned and recorded on the entry.
 *
 * CLEARED FUNDS ONLY. A transfer draws on Stripe's AVAILABLE balance, and a
 * card top-up sits in PENDING for days after it succeeds. So the balance is
 * checked BEFORE the transfer is attempted, not just inferred from its error,
 * because the error is sticky: Stripe stores a failed request's response
 * against its idempotency key and replays it (`idempotent-replayed: true`,
 * pinned in the sandbox 2026-10-12) for at least 24 hours. A doomed attempt
 * would make every retry in that window fail too, even after the money clears.
 *
 * `aheadCents` is what older parked payouts will take out of the same pending
 * money first. It only moves the estimated date, never the decision.
 */
async function sendPayout({
  identity,
  amountCents,
  currency = "CAD",
  idempotencyKey,
  memo = null,
  metadata = {},
  aheadCents = 0,
}) {
  const stripe = getStripe();

  if (!stripe) {
    return {
      stub: true,
      delivered: false,
      provider: OFFLINE,
      reference: null,
      // NOT "paid". A human must confirm an off-platform payment.
      status: "pending_manual",
      error: null,
    };
  }

  if (!identity?.stripeConnectAccountId || identity.connectStatus !== "enabled") {
    // The vendor has not finished onboarding. The debt is real and already in
    // the ledger; it settles when the webhook reports the account enabled.
    return {
      stub: false,
      delivered: false,
      provider: STRIPE_CONNECT,
      reference: null,
      status: "pending_onboarding",
      error: null,
    };
  }

  // Null when the balance could not be read: attempt the transfer as before
  // rather than block every payout on a read that is only an optimisation.
  const balance = await getPlatformBalance(currency);
  if (balance && balance.available < amountCents) {
    if (balance.available + balance.pending >= amountCents) {
      return {
        stub: false,
        delivered: false,
        provider: STRIPE_CONNECT,
        reference: null,
        status: "awaiting_clearance",
        error: null,
        clearsOn: await estimateClearanceDate({ shortCents: aheadCents + amountCents - balance.available, currency }),
      };
    }
    // Not a timing problem: even once everything pending clears, Stripe will
    // not hold enough. Typically an external deposit, which credits the ledger
    // and funds nothing at Stripe. A human has to look.
    return {
      stub: false,
      delivered: false,
      provider: STRIPE_CONNECT,
      reference: null,
      status: "failed",
      error:
        `Stripe balance cannot cover this transfer: ${formatCents(balance.available)} available and ` +
        `${formatCents(balance.pending)} still clearing, against ${formatCents(amountCents)}.`,
    };
  }

  try {
    const transfer = await stripe.transfers.create(
      {
        amount: amountCents,
        currency: String(currency).toLowerCase(),
        destination: identity.stripeConnectAccountId,
        description: memo || undefined,
        metadata: { ...metadata, artreloIdentityId: String(identity._id) },
      },
      { idempotencyKey }
    );

    return {
      stub: false,
      delivered: true,
      provider: STRIPE_CONNECT,
      reference: transfer.id,
      status: "paid",
      error: null,
    };
  } catch (err) {
    // The check above raced another payout for the same available money. Still
    // a timing problem, not a failure, but THIS key now replays the refusal for
    // a day, so the parked payout may not go until the key has expired. The
    // hourly sweep keeps trying past that.
    if (err?.code === "balance_insufficient") {
      return {
        stub: false,
        delivered: false,
        provider: STRIPE_CONNECT,
        reference: null,
        status: "awaiting_clearance",
        error: err.message,
        clearsOn: await estimateClearanceDate({ shortCents: aheadCents + amountCents, currency }),
      };
    }
    return {
      stub: false,
      delivered: false,
      provider: STRIPE_CONNECT,
      reference: null,
      status: "failed",
      error: err.message,
    };
  }
}

const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;

// Pending money older than this has cleared on any Stripe schedule.
const CLEARING_LOOKBACK_DAYS = 30;
// A pre-launch platform has a handful; this only bounds a runaway listing.
const CLEARING_SCAN_LIMIT = 500;

/**
 * When Stripe's pending money will cover `shortCents` more than is available
 * now: walk the PENDING balance transactions in the order they clear and
 * return the `available_on` of the one that closes the gap.
 *
 * Read from Stripe rather than from our deposits, because the platform balance
 * is one pool and Stripe is what decides when it clears. Null when the pending
 * money never adds up, or when Stripe cannot be read; callers say "in a few
 * business days" then. Never throws: it is an estimate for people to read.
 */
async function estimateClearanceDate({ shortCents, currency = "cad" }) {
  const stripe = getStripe();
  if (!stripe || !(shortCents > 0)) return null;
  try {
    const since = Math.floor(Date.now() / 1000) - CLEARING_LOOKBACK_DAYS * 24 * 60 * 60;
    const pending = [];
    let scanned = 0;
    for await (const txn of stripe.balanceTransactions.list({ limit: 100, created: { gte: since } })) {
      if (txn.status === "pending" && txn.currency === String(currency).toLowerCase()) pending.push(txn);
      if (++scanned >= CLEARING_SCAN_LIMIT) break;
    }
    pending.sort((a, b) => a.available_on - b.available_on);

    let covered = 0;
    for (const txn of pending) {
      covered += txn.net;
      if (covered >= shortCents) return new Date(txn.available_on * 1000);
    }
    return null;
  } catch (err) {
    console.error("[payoutProvider] clearance estimate failed:", err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Funding the platform balance.
 *
 * THE RULE: creating a PaymentIntent does NOT credit the ledger. Only the
 * settled `payment_intent.succeeded` webhook does. Crediting at creation would
 * recreate the exact bug this closes — a ledger that reads $1,000 available
 * while Stripe holds nothing to send.
 * ------------------------------------------------------------------ */

/**
 * Start a card top-up. Returns a client_secret for Stripe Elements to confirm.
 * Writes nothing to the ledger.
 */
async function createDepositIntent({ landlordId, amountCents, currency = "CAD", idempotencyKey = null }) {
  const stripe = getStripe();
  if (!stripe) {
    return { configured: false, clientSecret: null, paymentIntentId: null };
  }

  // `amountCents` is what the WALLET receives. The card is charged that plus
  // the processing fee, so Stripe's cut never comes out of the wallet.
  const { walletCents, chargeCents, feeCents } = grossUpForCardFee(amountCents);

  const intent = await stripe.paymentIntents.create({
    amount: chargeCents,
    currency: String(currency).toLowerCase(),
    // Card only for now: async methods (ACSS/bank debit) settle days later and
    // would need a `processing` state in the wallet to be honest about it.
    payment_method_types: ["card"],
    description: "Artrelo maintenance wallet top-up",
    // The webhook has no session, so the landlord has to be identifiable from
    // the intent itself. This is the ONLY link back.
    //
    // The wallet credit rides here too, and is trustworthy for the same reason
    // the landlord id is: only a secret key can set intent metadata — the
    // browser's client_secret can confirm this payment and change nothing.
    metadata: {
      artreloLandlordId: String(landlordId),
      artreloPurpose: "wallet_topup",
      artreloWalletCents: String(walletCents),
      artreloFeeCents: String(feeCents),
    },
  }, idempotencyKey ? { idempotencyKey } : undefined);

  return {
    configured: true,
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    walletCents,
    feeCents,
    chargeCents,
  };
}

/**
 * The Stripe Customer a landlord's saved bank account and mandate belong to.
 * Created once; the idempotency key makes two racing first top-ups converge on
 * ONE customer (the caller then writes the id with a guard).
 */
async function ensureStripeCustomer({ landlordId, email, name }) {
  const stripe = getStripe();
  if (!stripe) return null;
  const customer = await stripe.customers.create(
    {
      email: email || undefined,
      name: name || undefined,
      metadata: { artreloLandlordId: String(landlordId) },
    },
    { idempotencyKey: `customer:${landlordId}` }
  );
  return customer.id;
}

/**
 * Start a BANK top-up (Canadian pre-authorized debit). Writes nothing to the
 * ledger -- the deposit is credited on payment_intent.succeeded, days later.
 *
 * No gross-up: the wallet receives exactly what is debited, and Artrelo
 * absorbs Stripe's fee (1% + $0.40, capped at $5). Recorded on the deposit
 * when it settles, for the revenue report.
 *
 * Two shapes:
 *   NEW ACCOUNT   the browser's Payment Element collects the account and shows
 *                 the mandate; `setup_future_usage` saves both to the customer.
 *                 `sporadic`: every debit is started by the landlord, which is
 *                 what lets the next one be a single click.
 *   SAVED ACCOUNT confirmed here, with the saved method and its mandate. The
 *                 landlord's click IS the sporadic authorization; there is no
 *                 form and no re-verification.
 *
 * `idempotencyKey` is required: a server-confirmed debit replayed by a
 * double-click would otherwise take the money twice.
 */
async function createBankDepositIntent({
  landlordId,
  amountCents,
  customerId,
  idempotencyKey,
  transactionType = "business",
  paymentMethodId = null,
  mandateId = null,
  topUpToken = null,
  currency = "CAD",
}) {
  const stripe = getStripe();
  if (!stripe) return { configured: false, clientSecret: null, paymentIntentId: null };
  if (!idempotencyKey) throw new Error("a bank debit needs an idempotency key");
  assertCents(amountCents, "amountCents");

  const saved = Boolean(paymentMethodId);
  const intent = await stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency: String(currency).toLowerCase(),
      customer: customerId,
      payment_method_types: ["acss_debit"],
      description: "Artrelo maintenance wallet top-up (bank)",
      metadata: {
        artreloLandlordId: String(landlordId),
        artreloPurpose: "wallet_topup",
        artreloMethod: "bank",
        artreloBankTransactionType: transactionType,
        artreloWalletCents: String(amountCents),
        artreloFeeCents: "0",
        // Finds the WalletTopUp even if the webhook beats the write of this
        // intent's id onto it (a saved account is confirmed in this very call).
        ...(topUpToken ? { artreloTopUpToken: String(topUpToken) } : {}),
      },
      ...(saved
        ? { payment_method: paymentMethodId, ...(mandateId ? { mandate: mandateId } : {}), confirm: true }
        : {
            setup_future_usage: "off_session",
            payment_method_options: {
              acss_debit: {
                mandate_options: { payment_schedule: "sporadic", transaction_type: transactionType },
                verification_method: "automatic",
              },
            },
          }),
    },
    { idempotencyKey }
  );

  return {
    configured: true,
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    status: intent.status,
    walletCents: amountCents,
  };
}

/**
 * The Stripe PLATFORM balance — a different pool from the internal ledger.
 *
 * `available` is what a Connect transfer can actually draw on right now.
 * `pending` is money that has settled from the customer but not yet cleared
 * into available; card funds sit here for a day or two in production, and
 * skip it entirely in test mode. A payout can fail for insufficient funds
 * while the ledger looks healthy, and this is the number that explains why.
 */
async function getPlatformBalance(currency = "cad") {
  const stripe = getStripe();
  if (!stripe) return null;
  try {
    const balance = await stripe.balance.retrieve();
    const pick = (bucket) =>
      (balance[bucket] || []).find((b) => b.currency === currency.toLowerCase())?.amount ?? 0;
    return { available: pick("available"), pending: pick("pending"), currency: currency.toUpperCase() };
  } catch (err) {
    console.error("[payoutProvider] balance retrieve failed:", err.message);
    return null;
  }
}

module.exports = {
  OFFLINE,
  STRIPE_CONNECT,
  createDepositIntent,
  createBankDepositIntent,
  ensureStripeCustomer,
  getPlatformBalance,
  estimateClearanceDate,
  activeProvider,
  ensureConnectAccount,
  describeVendorBusiness,
  createPayoutUpdateLink,
  syncConnectStatus,
  deriveConnectStatus,
  retrieveConnectAccount,
  sendPayout,
  isConfigured,
  keyMode,
};
