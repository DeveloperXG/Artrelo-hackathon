// Inbound Stripe events.
//
// SIGNATURE VERIFICATION IS MANDATORY HERE, and it is genuine — not the pattern
// the (since removed) Vapi voice webhook used, whose verifier was a TODO that
// returned `true` unconditionally. That was a known hole on a low-stakes
// endpoint; repeating it on a money endpoint is how you get forged payout events from
// anyone who learns the URL.
//
// Verification needs the RAW body, so this route is mounted with express.raw
// BEFORE the global express.json in app.js. If it were mounted after, req.body
// would be a parsed object, the computed signature would never match, and every
// legitimate event would 400.
//
// TWO EVENT FORMATS ARRIVE HERE, and they are not interchangeable:
//
//   SNAPSHOT (v1) — `{"object": "event", "type": "transfer.created", "data": {...}}`
//       Carries the full resource inline. Verified with webhooks.constructEvent.
//       Our transfer.* events are these.
//
//   THIN (v2) — `{"object": "v2.core.event", "type": "v2.core.account.updated",
//                 "related_object": {"id": "acct_..."}}`
//       Carries ONLY an id; there is no `data.object` to read. Verified with
//       parseEventNotification, then the resource is fetched. Every event about
//       an Accounts v2 connected account is one of these — which is all of ours,
//       since Stripe now refuses v1 account creation for new integrations.
//
// Reading `event.data.object` on a thin event yields undefined and the handler
// throws, so the format has to be decided before anything else happens.

const { getStripe } = require("../config/stripe");
const { publish } = require("../services/realtime/liveEvents.service");
const env = require("../config/env");
const VendorIdentity = require("../models/VendorIdentity");
const LedgerEntry = require("../models/LedgerEntry");
const {
  deriveConnectStatus,
  retrieveConnectAccount,
} = require("../services/ledger/payoutProvider.service");
const {
  settlePayout,
  settleFundedPayouts,
  recordDeposit,
  drainParkedPayouts,
  releaseClearedPayouts,
} = require("../services/ledger/ledger.service");
const { logAgentAction } = require("../services/audit/agentAction.service");
// Called through the module object so a test can stand in for any step.
const bankTopUps = require("../services/ledger/bankTopUp.service");
const { recordCardSettlement, handleCardChargeUpdated } = require("../services/ledger/cardSettlement.service");
const cardDisputes = require("../services/ledger/cardDispute.service");
const walletRefunds = require("../services/ledger/walletRefund.service");

/**
 * Apply a connected account's current state.
 *
 * Takes the ACCOUNT OBJECT, not the event, so it is shared by the thin path
 * (which fetches it) and the v1 snapshot path (which has it inline).
 */
async function applyAccountState(account) {
  if (!account?.id) return;

  const identity = await VendorIdentity.findOne({ stripeConnectAccountId: account.id });
  if (!identity) return;

  // RE-FETCH rather than trusting the payload.
  //
  // A v2-created account emits BOTH v1 snapshot events (account.updated,
  // capability.updated, on the connected-account scope) and v2 thin events, and
  // in practice the v1 ones are what arrive. Their payload is the v1
  // projection, which reports a DIFFERENT and stricter picture than the v2
  // capability: a real sandbox account showed payouts_enabled:false while
  // stripe_transfers was already "active".
  //
  // Deriving from whichever shape happened to arrive made the answer depend on
  // the event type. Fetching the v2 truth makes every account event converge on
  // the same state.
  const authoritative = (await retrieveConnectAccount(getStripe(), account.id).catch(() => null)) || account;
  const status = deriveConnectStatus(authoritative);
  if (status === identity.connectStatus) return;

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

  // Newly enabled: drain anything parked waiting on onboarding. This is why a
  // payout is never lost when a vendor accepts a job before finishing their
  // bank setup — the debt sat in the ledger and settles now.
  //
  // Shared with syncConnectStatus rather than inlined, so the polling path gets
  // the same behaviour. This webhook is the primary route but not a guaranteed
  // one, and a missed event used to mean money parked forever.
  if (status === "enabled") {
    await drainParkedPayouts({ identityId: identity._id }).catch((err) =>
      console.error("[stripeWebhook] drain failed", err.message)
    );
  }
}

/**
 * A transfer was created or reversed.
 *
 * NOTE THE MISSING CASES. There is no `transfer.paid` and no `transfer.failed`
 * in Stripe's catalogue — only created, reversed, and updated. Earlier revisions
 * of this file switched on the first two, which meant those branches could never
 * run and a reversal was the only failure ever recorded.
 *
 * A transfer into a connected account's Stripe balance is synchronous: it either
 * returns an object or throws, and sendPayout already records that. So
 * transfer.created is confirmation rather than news, and `reversed` is the one
 * that carries information we did not already have.
 *
 * The vendor's money reaching their BANK is a separate `payout.*` event on the
 * connected account, which requires a "Connected accounts"-scoped destination.
 * Not wired up: we currently report "paid" when the money reaches the vendor's
 * Stripe balance.
 */
async function handleTransferEvent(transfer, { reversed = false } = {}) {
  if (!transfer?.id) return;

  const entry = await LedgerEntry.findOne({ providerRef: transfer.id, type: "payout" });
  if (!entry) return;

  await LedgerEntry.updateOne(
    { _id: entry._id },
    {
      $set: {
        providerStatus: reversed ? "failed" : "paid",
        providerError: reversed ? "transfer reversed" : null,
      },
    }
  );
  publish(entry.landlordId, "wallet");

  if (reversed) {
    await logAgentAction({
      requestId: entry.requestId,
      landlordId: entry.landlordId,
      actor: "system",
      actionType: "payout_failed",
      summary: `Vendor payout of ${entry.amountCents / 100} ${entry.currency} was reversed`,
      input: { entryId: entry._id.toString(), transferId: transfer.id },
      output: { status: "failed" },
    });
  }
}

/**
 * A card or bank top-up settled. THE ONLY PLACE a stripe-funded deposit is
 * credited -- a bank top-up included, days after it started.
 *
 * Everything about this is deliberate:
 *
 *  - It runs on the webhook, not on intent creation. Crediting when the
 *    landlord starts a payment would let them spend money that never arrived.
 *  - The idempotency key is derived from the PaymentIntent id, so Stripe
 *    retrying this event (which it does, freely) credits exactly once.
 *  - The landlord comes from intent METADATA, because a webhook has no session.
 *    An intent without it is not ours and is ignored rather than guessed at.
 *  - fundingSource is "stripe": the money is really in the platform balance,
 *    which is what makes it transferable.
 */
async function handleDepositSucceeded(paymentIntent) {
  const landlordId = paymentIntent?.metadata?.artreloLandlordId;
  if (!landlordId) return; // not a wallet top-up
  if (paymentIntent.metadata.artreloPurpose !== "wallet_topup") return;

  // amount_received, not amount: a partially-captured intent must credit only
  // what was actually taken.
  const bank = bankTopUps.isBankIntent(paymentIntent);
  const receivedCents = Number(paymentIntent.amount_received ?? paymentIntent.amount ?? 0);
  if (!Number.isSafeInteger(receivedCents) || receivedCents <= 0) return;

  // A card charge includes the processing fee; the WALLET gets what the
  // landlord asked for (a bank debit has no fee on top, so the two match). Server-set metadata, so it is trustworthy. Intents from
  // before the fee existed carry none and credit what was received.
  const walletCents = Number(paymentIntent.metadata.artreloWalletCents);
  const amountCents =
    Number.isSafeInteger(walletCents) && walletCents > 0 ? Math.min(walletCents, receivedCents) : receivedCents;

  const result = await recordDeposit({
    landlordId,
    amountCents,
    idempotencyKey: `deposit:${paymentIntent.id}`,
    provider: "stripe",
    providerRef: paymentIntent.id,
    fundingSource: "stripe",
    actor: "system",
    memo: bank ? "Bank top-up" : "Card top-up",
  });

  // Also on a retry, if the first delivery could not read the charge: the
  // clearing date is what the wallet's "still clearing" banner is built from.
  if (bank) {
    if (result.entry) await bankTopUps.handleBankSucceeded(paymentIntent, { depositEntryId: result.entry._id, amountCents });
  } else if (result.entry && !result.entry.card?.availableOn) {
    await recordCardSettlement({ entryId: result.entry._id, paymentIntent, walletCents: amountCents });
  }
  // Also on a duplicate success: a dispute may have arrived before the credit.
  // Reconcile before any payout or booking recovery can consume that credit.
  if (!bank) await cardDisputes.reconcileIntent(paymentIntent.id);
  // Again after the clearing date lands: postEntry already nudged on the
  // credit, but the wallet's "still clearing" banner is built from this.
  publish(landlordId, "wallet");

  if (result.alreadyApplied) return; // a retry; already credited

  // Any vendor remainder this deposit funded in full goes out now.
  await settleFundedPayouts(result.fundedPayoutIds || []);
  // Resume already-accepted proposals, never start old waiting requests merely
  // because a wallet or policy changed. The interval sweep covers a missed nudge.
  if (require("mongoose").connection.readyState === 1) setImmediate(() =>
    require("../services/vendor/bookingRecovery.service").sweepPreparations({ landlordId }).catch(() =>
      console.error("[stripeWebhook] booking recovery nudge failed")));

  await logAgentAction({
    landlordId,
    actor: "system",
    actionType: "ledger_deposit",
    summary: `${bank ? "Bank" : "Card"} top-up of ${amountCents / 100} ${String(paymentIntent.currency).toUpperCase()} settled`,
    input: { paymentIntentId: paymentIntent.id },
    output: { amountCents, receivedCents, fundingSource: "stripe", fundedPayouts: (result.fundedPayoutIds || []).length },
  });
}

/** A top-up failed. Logged, never credited. A bank one may also carry a fee (bankTopUp.service). */
async function handleDepositFailed(paymentIntent) {
  const landlordId = paymentIntent?.metadata?.artreloLandlordId;
  if (!landlordId || paymentIntent.metadata.artreloPurpose !== "wallet_topup") return;
  if (bankTopUps.isBankIntent(paymentIntent)) {
    await bankTopUps.handleBankFailed(paymentIntent);
    return;
  }

  await logAgentAction({
    landlordId,
    actor: "system",
    actionType: "ledger_deposit_failed",
    summary: "A card top-up did not go through",
    input: { paymentIntentId: paymentIntent.id },
    output: { error: paymentIntent.last_payment_error?.message || null },
  });
}

/** Cheap, unverified peek at the payload just to choose a verifier. */
function isThinPayload(rawBody) {
  try {
    return JSON.parse(rawBody.toString("utf8"))?.object === "v2.core.event";
  } catch {
    return false;
  }
}

/** Any v2 event about a connected account. */
const isAccountEventType = (type) => typeof type === "string" && type.startsWith("v2.core.account");

/**
 * The signing secret for one payload format.
 *
 * A deployed account has two event destinations pointed at this one URL — one
 * snapshot, one thin — and Stripe gives each its own whsec_. Verifying both
 * with a single secret fails one of them on every delivery: thin failing means
 * vendors finish onboarding and are never marked payable; snapshot failing
 * means deposits are never credited. Locally, `stripe listen` signs both
 * formats with one secret, hence the fallback.
 */
function webhookSecretFor(thin) {
  return thin
    ? env.stripe_webhook_secret_thin || env.stripe_webhook_secret
    : env.stripe_webhook_secret;
}

exports.handleStripeWebhook = async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ received: false, error: "stripe not configured" });

  const signature = req.headers["stripe-signature"];
  const thin = isThinPayload(req.body);

  const secret = webhookSecretFor(thin);
  if (!secret) {
    // Refuse rather than accept unverified events. An endpoint that processes
    // whatever it is sent is worse than one that is switched off.
    console.error("[stripeWebhook] STRIPE_WEBHOOK_SECRET is not set — refusing events");
    return res.status(503).json({ received: false, error: "webhook secret not configured" });
  }

  let event;
  try {
    // Both paths verify the signature against the raw body; only the parsed
    // shape differs. The discriminator above is read from unverified bytes, but
    // it only chooses a verifier — nothing is acted on until one of these
    // succeeds.
    event = thin
      ? await stripe.parseEventNotification(req.body, signature, secret)
      : stripe.webhooks.constructEvent(req.body, signature, secret);
  } catch (err) {
    // Never echo the reason: a caller probing signatures learns nothing.
    console.error("[stripeWebhook] signature verification failed:", err.message);
    if (thin && !env.stripe_webhook_secret_thin) {
      // The likeliest cause in a deployed account, and invisible otherwise.
      console.error("[stripeWebhook] thin event checked against the snapshot secret — set STRIPE_WEBHOOK_SECRET_THIN");
    }
    return res.status(400).json({ received: false });
  }

  try {
    if (thin) {
      // Thin events carry an id, not an object. Covers v2.core.account.updated
      // AND the narrower capability events such as
      // v2.core.account[configuration.recipient].capability_status_updated,
      // which is the one that actually fires when a vendor finishes onboarding.
      if (isAccountEventType(event.type)) {
        const accountId = event.related_object?.id;
        if (accountId) {
          const account = await retrieveConnectAccount(stripe, accountId);
          await applyAccountState(account);
        }
      }
    } else if (!await require("../services/billing/invoiceCollection.service").handleEvent(event)) {
      switch (event.type) {
        // Kept for a platform that re-enabled Accounts v1. Harmless otherwise:
        // applyAccountState no-ops when no identity matches.
        case "account.updated":
          await applyAccountState(event.data.object);
          break;
        // Fires when a capability flips to active — which for a recipient IS
        // the onboarding-complete signal, and arrives alongside account.updated
        // rather than instead of it. The payload is a Capability, whose
        // `account` field is the id; applyAccountState re-fetches from there,
        // so both events converge on the same state and whichever lands first
        // does the work.
        case "capability.updated":
          await applyAccountState({ id: event.data.object?.account });
          break;
        case "transfer.created":
        case "transfer.updated":
          await handleTransferEvent(event.data.object);
          break;
        case "transfer.reversed":
          await handleTransferEvent(event.data.object, { reversed: true });
          break;
        case "payment_intent.succeeded":
          await handleDepositSucceeded(event.data.object);
          break;
        case "charge.updated":
          await handleCardChargeUpdated(event.data.object);
          break;
        case "payment_intent.payment_failed":
          await handleDepositFailed(event.data.object);
          break;
        // Bank top-ups (Canadian pre-authorized debit) only. Each must be
        // ENABLED on the snapshot destination in the dashboard.
        case "payment_intent.processing":
          await bankTopUps.handleBankProcessing(event.data.object);
          break;
        case "payment_intent.canceled":
          await bankTopUps.handleBankCanceled(event.data.object);
          break;
        case "charge.dispute.created":
        case "charge.dispute.closed":
        case "charge.dispute.funds_withdrawn":
        case "charge.dispute.funds_reinstated": {
          const outcome = await cardDisputes.reconcileDispute(event.data.object);
          if (outcome.ignored) {
            const dispute = event.data.object;
            if (!dispute.payment_intent && dispute.charge) {
              const charge = typeof dispute.charge === "string" ? await getStripe().charges.retrieve(dispute.charge) : dispute.charge;
              dispute.payment_intent = charge.payment_intent;
            }
            if (["charge.dispute.created", "charge.dispute.funds_withdrawn"].includes(event.type)) await bankTopUps.handleDisputeCreated(dispute);
            if (event.type === "charge.dispute.closed") await bankTopUps.handleDisputeClosed(dispute);
          }
          break;
        }
        case "mandate.updated":
          await bankTopUps.handleMandateUpdated(event.data.object);
          break;
        case "refund.created":
        case "refund.updated":
        case "refund.failed":
          await walletRefunds.syncRefund(event.data.object.id);
          break;
        // Pending card money just became spendable. Payouts parked at
        // awaiting_clearance can go now. The payload (a Balance) is not read:
        // settlePayout re-checks the live balance per payout, so an old or
        // replayed event can only cause a harmless re-check. Must be ENABLED on
        // the snapshot destination in the dashboard; the hourly
        // clearanceSweeper covers an account where it is not.
        case "balance.available":
          await releaseClearedPayouts();
          break;
        default:
          break; // Unhandled types are acknowledged, not errored.
      }
    }
  } catch (err) {
    console.error("[stripeWebhook] handler failed:", event.type, err.message);
    // 500 so Stripe retries. Every handler above is idempotent, so a retry is
    // safe: settlePayout short-circuits on an already-paid entry, and the
    // status writes are assignments rather than increments.
    return res.status(500).json({ received: false });
  }

  return res.json({ received: true });
};

exports.applyAccountState = applyAccountState;
exports.handleTransferEvent = handleTransferEvent;
exports.handleDepositSucceeded = handleDepositSucceeded;
exports.handleDepositFailed = handleDepositFailed;
exports.isThinPayload = isThinPayload;
exports.webhookSecretFor = webhookSecretFor;
exports.isAccountEventType = isAccountEventType;
