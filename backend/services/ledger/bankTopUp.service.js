// Bank top-ups (Canadian pre-authorized debit, Stripe acss_debit).
//
// The card path answers in seconds; this one answers in days, and can be
// undone after it has answered. The life of one bank top-up:
//
//   start      the landlord asks; the risk rules run; a WalletTopUp claims the
//              attempt (clientToken) and Stripe is asked with a matching
//              idempotency key. Nothing is credited.
//   processing the bank was asked (payment_intent.processing). The wallet says
//              "processing, expected between ... and ...". Still nothing credited.
//   succeeded  the ONLY credit, through the same handleDepositSucceeded every
//              card top-up uses (controllers/stripeWebhook.controller.js).
//   failed     the bank refused it. Nothing was credited; if a debit was
//              actually attempted, the disclosed failure fee is charged.
//   disputed   the account holder disputed it at their bank AFTER it
//              succeeded. Uncontestable: Stripe has already taken the money
//              back. The deposit is reversed (reverseBankDeposit), the dispute
//              fee charged, and bank top-ups are paused for this landlord.
//
// Every webhook step is idempotent: status moves are guarded on the status
// they move from, and every ledger entry is keyed on the Stripe object.

const stripeConfig = require("../../config/stripe");
const { getStripe } = stripeConfig;
const Landlord = require("../../models/Landlord");
const LedgerEntry = require("../../models/LedgerEntry");
const WalletTopUp = require("../../models/WalletTopUp");
const { bankDebitSettings } = require("./bankDebitSettings");
const { createBankDepositIntent, ensureStripeCustomer } = require("./payoutProvider.service");
const { reverseBankDeposit, chargeBankFee } = require("./ledger.service");
const { notifyUser } = require("../notification/notify.service");
const { logAgentAction } = require("../audit/agentAction.service");
const { publish } = require("../realtime/liveEvents.service");
const { fromCents } = require("./money");

const isBankIntent = (pi) =>
  pi?.metadata?.artreloPurpose === "wallet_topup" && pi?.metadata?.artreloMethod === "bank" && Boolean(pi.metadata.artreloLandlordId);

const money = (cents) =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(fromCents(cents || 0));

// UTC, like the expected dates themselves (addBusinessDays). A landlord far
// west may see a late-evening start as the next day -- acceptable for "when".
const day = (date) =>
  new Date(date).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });

// What the landlord is told: "3–5 business days". The wallet shows that as a
// date RANGE, never only the far end -- "expected by Wed 21 Oct" read as a
// week next to "3–5 business days", although both counted the same days.
const EARLIEST_BUSINESS_DAYS = 3;
const LATEST_BUSINESS_DAYS = 5;

/** The expected window for a debit that started processing at `start`. */
function expectedWindow(start, expectedAt = null) {
  return {
    from: addBusinessDays(start, EARLIEST_BUSINESS_DAYS),
    to: expectedAt ? new Date(expectedAt) : addBusinessDays(start, LATEST_BUSINESS_DAYS),
  };
}

/** `days` business days after `from` (weekends skipped; holidays are not known). */
function addBusinessDays(from, days) {
  const date = new Date(from);
  let left = days;
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return date;
}

/* ------------------------------------------------------------------ *
 * The risk rules. Pure, so they are tested as a table.
 * ------------------------------------------------------------------ */

/**
 * Why this bank top-up may not start, or null. `field` puts the reason beside
 * the amount input rather than in a toast.
 *
 *   blocked            a past dispute paused bank top-ups for this landlord
 *   below the minimum  the fixed costs of a debit dominate a small one
 *   not yet trusted    (fewer than `trustedAfter` cleared bank top-ups):
 *                        above the per-debit cap -> refused
 *                        another debit still processing -> refused
 *
 * The trust rules exist because a PAD dispute cannot be contested: a new
 * account's first debits are the riskiest, and limiting how much is in flight
 * at once limits what a dispute can take back.
 */
function bankTopUpRefusal({ settings, amountCents, blocked, clearedCount, inFlightCount, pending = null, paused = null }) {
  if (!settings.enabled) {
    return { code: "bank_disabled", message: "Bank top-ups aren't available yet. Top up by card instead." };
  }
  // Every refusal below names the thing that causes it -- the top-up still
  // processing, the reversal that paused it, how far the landlord is from the
  // limits lifting. A landlord who dismissed the banner that said so days ago
  // must not be left with "you can't" and no why.
  if (blocked) {
    return {
      code: "bank_blocked",
      message:
        (paused
          ? `Bank top-ups are paused on your account because your bank reversed a ${money(paused.walletCents)} top-up on ${day(paused.disputedAt)}.`
          : "Bank top-ups are paused on your account after a reversed debit.") +
        " You can still top up by card, or contact support to resume them.",
    };
  }
  if (amountCents < settings.minCents) {
    return { code: "below_minimum", field: "amount", message: `Bank top-ups start at ${money(settings.minCents)}.` };
  }
  const trusted = clearedCount >= settings.trustedAfter;
  // "until 3 of your bank top-ups have cleared (1 so far)"
  const progress = `until ${settings.trustedAfter} of your bank top-ups have cleared (${clearedCount} so far)`;
  if (!trusted && amountCents > settings.newCapCents) {
    return {
      code: "over_new_cap",
      field: "amount",
      message: `Each bank top-up can be up to ${money(settings.newCapCents)} ${progress}. Top up a larger amount by card.`,
    };
  }
  if (!trusted && inFlightCount > 0) {
    return {
      code: "one_in_flight",
      message:
        (pending
          ? `Your ${money(pending.walletCents)} bank top-up from ${day(pending.processingAt || pending.createdAt)} is still processing` +
            (() => {
              const window = expectedWindow(pending.processingAt || pending.createdAt, pending.expectedAt);
              return `, expected between ${day(window.from)} and ${day(window.to)} (3–5 business days)`;
            })() +
            ". "
          : "You have a bank top-up still processing. ") +
        // No "top up by card" here: the form puts that choice right under it.
        `Only one can be processing at a time ${progress}.`,
    };
  }
  return null;
}

async function bankHistory(landlordId) {
  const [clearedCount, inFlightCount, pending, paused] = await Promise.all([
    // `succeeded` and never disputed: a disputed one moves to `disputed`.
    WalletTopUp.countDocuments({ landlordId, status: "succeeded" }),
    WalletTopUp.countDocuments({ landlordId, status: "processing" }),
    // What the reasons name: the oldest top-up still at the bank, and the
    // latest reversal (what a pause is for).
    WalletTopUp.findOne({ landlordId, status: "processing" })
      .sort({ processingAt: 1 })
      .select("walletCents processingAt expectedAt createdAt")
      .lean(),
    WalletTopUp.findOne({ landlordId, status: "disputed" })
      .sort({ disputedAt: -1 })
      .select("walletCents disputedAt")
      .lean(),
  ]);
  return { clearedCount, inFlightCount, pending, paused };
}

/**
 * What the Wallet needs to offer a bank top-up: whether it can, the saved
 * account, the limits that apply to THIS landlord. Never throws to the caller's
 * benefit -- the statement treats it as best-effort.
 */
async function bankStatusFor(landlordId) {
  const settings = bankDebitSettings();
  // Switched on but no Stripe key: nothing could be debited, so nothing is offered.
  if (!settings.enabled || !stripeConfig.isConfigured()) return { enabled: false };
  const [landlord, history] = await Promise.all([
    Landlord.findById(landlordId).select("bankDebit").lean(),
    bankHistory(landlordId),
  ]);
  const bank = landlord?.bankDebit || {};
  const trusted = history.clearedCount >= settings.trustedAfter;
  return {
    enabled: true,
    saved: bank.paymentMethodId ? { last4: bank.last4 || null, institution: bank.institution || null } : null,
    blocked: Boolean(bank.blockedAt),
    trusted,
    inFlight: history.inFlightCount,
    // So the form can say WHY before the landlord tries, not only after.
    cleared: history.clearedCount,
    trustedAfter: settings.trustedAfter,
    pendingTopUp: history.pending
      ? {
          amountCents: history.pending.walletCents,
          startedAt: history.pending.processingAt || history.pending.createdAt,
          expectedAt: history.pending.expectedAt || null,
        }
      : null,
    pausedFor: bank.blockedAt && history.paused
      ? { amountCents: history.paused.walletCents, at: history.paused.disputedAt }
      : null,
    // The server's own words, for the form to show as-is.
    reason: bank.blockedAt || (!trusted && history.inFlightCount > 0)
      ? bankTopUpRefusal({
          settings,
          amountCents: settings.minCents,
          blocked: Boolean(bank.blockedAt),
          ...history,
        })?.message || null
      : null,
    minCents: settings.minCents,
    capCents: trusted ? null : settings.newCapCents,
    failureFeeCents: settings.failureFeeCents,
    disputeFeeCents: settings.disputeFeeCents,
  };
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

/** The landlord's Stripe Customer id, created once and written with a guard. */
async function customerFor(landlord) {
  if (landlord.stripeCustomerId) return landlord.stripeCustomerId;
  const customerId = await ensureStripeCustomer({
    landlordId: landlord._id,
    email: landlord.email,
    name: [landlord.firstName, landlord.lastName].filter(Boolean).join(" ") || undefined,
  });
  if (!customerId) return null;
  // The idempotency key makes a racing first top-up get the SAME customer, so
  // whichever write lands first is right and the other changes nothing.
  await Landlord.updateOne({ _id: landlord._id, stripeCustomerId: { $in: [null, undefined] } }, { $set: { stripeCustomerId: customerId } });
  return customerId;
}

/**
 * Start a bank top-up. Returns { refused } or { topUp, clientSecret, status }.
 *
 * `useSaved`: debit the saved account now (server-confirmed, no form). Else a
 * new account: the browser mounts the Payment Element on the returned secret.
 */
async function startBankTopUp({ landlordId, amountCents, clientToken, useSaved = false, transactionType = null }) {
  const settings = bankDebitSettings();
  const token = String(clientToken || "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(token)) {
    return { refused: { code: "bad_token", message: "Please try again." } };
  }

  // A retry of THIS attempt (same token) skips the rules: it was already let
  // through, and "one at a time" would otherwise refuse its own retry.
  let topUp = await WalletTopUp.findOne({ landlordId, clientToken: token }).lean();
  if (topUp && topUp.walletCents !== amountCents) {
    return { refused: { code: "token_reused", message: "Please try again." } };
  }

  const landlord = await Landlord.findById(landlordId)
    .select("email firstName lastName stripeCustomerId bankDebit")
    .lean();
  if (!landlord) return { refused: { code: "not_found", message: "Landlord not found." } };

  const saved = landlord.bankDebit?.paymentMethodId ? landlord.bankDebit : null;
  if (!useSaved && !["personal", "business"].includes(transactionType)) {
    return { refused: { code: "bank_account_type_required", message: "Choose whether this is a personal or business bank account." } };
  }
  if (topUp && (topUp.savedBank !== Boolean(useSaved) ||
      (!useSaved && topUp.transactionType && topUp.transactionType !== transactionType))) {
    return { refused: { code: "token_reused", message: "Please start a new top-up after changing the account type." } };
  }

  // A pause outranks everything below: it is the reason, and the one worth
  // telling (a dispute also forgets the saved account, so "no saved account"
  // would otherwise answer first and explain nothing).
  if (landlord.bankDebit?.blockedAt) {
    return {
      refused: bankTopUpRefusal({ settings, amountCents, blocked: true, ...(await bankHistory(landlordId)) }),
    };
  }
  if (useSaved && !saved) {
    return { refused: { code: "no_saved_bank", message: "No saved bank account. Add one to continue." } };
  }

  if (!topUp) {
    const refusal = bankTopUpRefusal({
      settings,
      amountCents,
      blocked: Boolean(landlord.bankDebit?.blockedAt),
      ...(await bankHistory(landlordId)),
    });
    if (refusal) return { refused: refusal };
  } else if (!settings.enabled || landlord.bankDebit?.blockedAt) {
    // Even a retry stops if bank top-ups were switched off or paused meanwhile.
    return {
      refused: bankTopUpRefusal({
        settings,
        amountCents,
        blocked: Boolean(landlord.bankDebit?.blockedAt),
        ...(await bankHistory(landlordId)),
        // A retry of an attempt already let through: only a pause stops it.
        clearedCount: settings.trustedAfter,
        inFlightCount: 0,
      }),
    };
  }

  const notSetUp = { code: "payments_not_configured", message: "Card and bank top-ups aren't set up on this server: it isn't connected to Stripe, so nothing can be charged here. You can still record a transfer you've already sent." };
  const customerId = await customerFor(landlord);
  if (!customerId) return { refused: notSetUp };

  if (!topUp) {
    try {
      const created = await WalletTopUp.create({ landlordId, clientToken: token, walletCents: amountCents, savedBank: Boolean(useSaved), transactionType: useSaved ? saved?.transactionType || "personal" : transactionType });
      topUp = typeof created.toObject === "function" ? created.toObject() : created;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      topUp = await WalletTopUp.findOne({ landlordId, clientToken: token }).lean();
    }
  }

  const intent = await createBankDepositIntent({
    landlordId,
    amountCents,
    customerId,
    idempotencyKey: `topup:${landlordId}:${token}`,
    transactionType: topUp.transactionType || "personal",
    paymentMethodId: useSaved ? saved.paymentMethodId : null,
    mandateId: useSaved ? saved.mandateId || null : null,
    topUpToken: token,
  });
  if (!intent.configured) return { refused: notSetUp };

  const now = new Date();
  // A saved account is confirmed in that call and is usually `processing`
  // already; the webhook says the same thing again, harmlessly.
  const processing = intent.status === "processing";
  await WalletTopUp.updateOne(
    { _id: topUp._id },
    {
      $set: {
        paymentIntentId: intent.paymentIntentId,
        ...(processing && topUp.status === "created"
          ? { status: "processing", processingAt: now, expectedAt: addBusinessDays(now, LATEST_BUSINESS_DAYS) }
          : {}),
      },
    }
  );
  if (processing) publish(landlordId, "wallet");

  return {
    topUp: { ...topUp, paymentIntentId: intent.paymentIntentId },
    clientSecret: intent.clientSecret,
    paymentIntentId: intent.paymentIntentId,
    status: intent.status,
    walletCents: amountCents,
  };
}

/* ------------------------------------------------------------------ *
 * Webhook steps
 * ------------------------------------------------------------------ */

/** The WalletTopUp for an intent: by id, else by the token in its metadata. */
async function topUpForIntent(pi) {
  const byId = await WalletTopUp.findOne({ paymentIntentId: pi.id }).lean();
  if (byId) return byId;
  const token = pi.metadata?.artreloTopUpToken;
  if (!token) return null;
  const row = await WalletTopUp.findOne({ landlordId: pi.metadata.artreloLandlordId, clientToken: token }).lean();
  if (row && !row.paymentIntentId) {
    await WalletTopUp.updateOne({ _id: row._id, paymentIntentId: null }, { $set: { paymentIntentId: pi.id } });
  }
  return row ? { ...row, paymentIntentId: pi.id } : null;
}

/**
 * On a SUCCEEDED debit: save its account and mandate for one-click top-ups
 * (replacing any earlier saved account -- the latest that worked), and record
 * what Stripe kept. Best-effort: neither moves money, so a
 * failure is logged and the webhook still succeeds.
 */
async function readBankDetails(pi, { depositEntryId = null } = {}) {
  try {
    const stripe = getStripe();
    if (!stripe) return;
    const intent = await stripe.paymentIntents.retrieve(pi.id, {
      expand: ["payment_method", "latest_charge.balance_transaction"],
    });
    const pm = intent?.payment_method && typeof intent.payment_method === "object" ? intent.payment_method : null;
    const mandateId = intent?.latest_charge?.payment_method_details?.acss_debit?.mandate || null;
    // Only an account that was set up for reuse, i.e. has a customer and a
    // mandate. A blocked landlord keeps the block: only these fields are set.
    if (pm?.id && mandateId && intent.customer) {
      await Landlord.updateOne(
        { _id: pi.metadata.artreloLandlordId },
        {
          $set: {
            "bankDebit.paymentMethodId": pm.id,
            "bankDebit.mandateId": mandateId,
            "bankDebit.last4": pm.acss_debit?.last4 || null,
            "bankDebit.institution": pm.acss_debit?.bank_name || null,
            "bankDebit.savedAt": new Date(),
            "bankDebit.transactionType": intent.payment_method_options?.acss_debit?.mandate_options?.transaction_type || pi.metadata?.artreloBankTransactionType || "personal",
          },
        }
      );
    }
    const txn = intent?.latest_charge?.balance_transaction;
    if (depositEntryId && txn && typeof txn === "object") {
      await LedgerEntry.updateOne(
        { _id: depositEntryId },
        {
          $set: {
            "bank.stripeFeeCents": Number.isSafeInteger(txn.fee) ? txn.fee : null,
            "bank.netCents": Number.isSafeInteger(txn.net) ? txn.net : null,
            "bank.availableOn": txn.available_on ? new Date(txn.available_on * 1000) : null,
          },
        }
      );
    }
  } catch (err) {
    console.error("[bankTopUp] reading bank details failed:", err.message);
  }
}

// Stripe's failure messages are written about "the customer". These are said
// TO the landlord, about their own account. Matched on the code first, then on
// the message (the sandbox reported insufficient funds as generic_decline).
const FAILURE_REASONS = [
  { codes: ["insufficient_funds"], pattern: /insufficient funds/i, text: "your account didn't have enough funds" },
  { codes: ["account_closed"], pattern: /closed/i, text: "the account is closed" },
  { codes: ["no_account", "invalid_account_number"], pattern: /no account|account number/i, text: "the bank couldn't find that account" },
  { codes: ["debit_not_authorized"], pattern: /not authori[sz]ed/i, text: "your bank says the debit wasn't authorized" },
  { codes: ["account_frozen", "bank_account_restricted"], pattern: /frozen|restricted|blocked/i, text: "your bank has blocked debits on that account" },
];

/** A plain reason for a failed debit, in the landlord's terms. Pure. */
function failureReason(error = {}) {
  const codes = [error.decline_code, error.code].filter(Boolean);
  const byCode = FAILURE_REASONS.find((r) => r.codes.some((c) => codes.includes(c)));
  if (byCode) return byCode.text;
  const byMessage = FAILURE_REASONS.find((r) => r.pattern.test(error.message || ""));
  return byMessage ? byMessage.text : "your bank declined it";
}

/** payment_intent.processing: the bank was asked. No ledger entry. */
async function handleBankProcessing(pi) {
  if (!isBankIntent(pi)) return;
  const topUp = await topUpForIntent(pi);
  if (!topUp) return;
  const now = new Date();
  // From created, or from a failed VERIFICATION retried on the same intent.
  // Never back from succeeded or disputed: events arrive out of order.
  const moved = await WalletTopUp.updateOne(
    { _id: topUp._id, status: { $in: ["created", "failed"] } },
    { $set: { status: "processing", processingAt: now, expectedAt: addBusinessDays(now, LATEST_BUSINESS_DAYS), failureCode: null, failureMessage: null } }
  );
  if (moved.modifiedCount) publish(pi.metadata.artreloLandlordId, "wallet");
  // The account is NOT saved here. A debit that is only processing may still
  // fail, and saving it now replaced the landlord's working saved account with
  // one that then failed -- and whose mandate Stripe then deactivated, which
  // (handleMandateUpdated) left them with no saved account at all. Found in the
  // sandbox run. An account becomes the saved one only once a debit from it
  // SUCCEEDS (handleBankSucceeded).
}

/** After payment_intent.succeeded credited the deposit (the shared card/bank handler). */
async function handleBankSucceeded(pi, { depositEntryId, amountCents = null }) {
  if (!isBankIntent(pi)) return;
  const topUp = await topUpForIntent(pi);
  // Events arrive out of order. A dispute processed BEFORE this credit found
  // no deposit to reverse; reverse it now, under the dispute's own key, so the
  // wallet never keeps money the bank has already taken back.
  if (topUp?.status === "disputed" && topUp.disputeId && amountCents > 0) {
    await reverseBankDeposit({
      landlordId: String(topUp.landlordId),
      disputeId: topUp.disputeId,
      amountCents,
      paymentIntentId: pi.id,
    });
    publish(String(topUp.landlordId), "wallet");
  }
  if (topUp) {
    await WalletTopUp.updateOne(
      { _id: topUp._id, status: { $in: ["created", "processing", "failed"] } },
      { $set: { status: "succeeded", succeededAt: new Date() } }
    );
  }
  await readBankDetails(pi, { depositEntryId });
}

/**
 * payment_intent.payment_failed. Never credited, so nothing to reverse. The
 * failure fee applies only when a DEBIT was attempted -- the intent had gone
 * to processing (it has a charge). A failed account verification never
 * reached the bank and costs nothing.
 */
async function handleBankFailed(pi) {
  if (!isBankIntent(pi)) return;
  const landlordId = pi.metadata.artreloLandlordId;
  const topUp = await topUpForIntent(pi);
  const settings = bankDebitSettings();
  const attempted = Boolean(pi.latest_charge) || topUp?.status === "processing";
  const error = pi.last_payment_error || {};

  if (topUp) {
    await WalletTopUp.updateOne(
      { _id: topUp._id, status: { $in: ["created", "processing"] } },
      {
        $set: {
          status: "failed",
          failedAt: new Date(),
          failureCode: error.decline_code || error.code || null,
          // Shown in the wallet's banner, so in the landlord's words.
          failureMessage: failureReason(error),
        },
      }
    );
  }

  let fee = null;
  if (attempted && settings.failureFeeCents > 0) {
    fee = await chargeBankFee({
      landlordId,
      key: pi.id,
      amountCents: settings.failureFeeCents,
      memo: "Bank fee: a top-up debit was refused by your bank",
      paymentIntentId: pi.id,
    });
  }
  publish(landlordId, "wallet");

  // A replay (the fee already existed) has already told them.
  if (fee?.alreadyApplied) return;
  const amount = Number(pi.metadata.artreloWalletCents) || pi.amount || 0;
  await notifyUser({
    userId: landlordId,
    type: "payment_failed",
    title: "Your bank top-up didn't go through",
    message:
      `Your bank top-up of ${money(amount)} didn't go through: ${failureReason(error)}. Nothing was added to your wallet.` +
      (fee?.entry ? ` A ${money(settings.failureFeeCents)} bank fee applies, as shown when you started it.` : "") +
      " You can try again, or top up by card.",
    metadata: { paymentId: pi.id, amount: fromCents(amount) },
    email: (await Landlord.findById(landlordId).select("email").lean())?.email || undefined,
    emailSubject: "Your Artrelo bank top-up didn't go through",
  });
  await logAgentAction({
    landlordId,
    actor: "system",
    actionType: "ledger_bank_topup_failed",
    summary: `A bank top-up of ${money(amount)} failed${attempted ? " at the bank" : " before a debit was attempted"}`,
    input: { paymentIntentId: pi.id },
    output: { code: error.decline_code || error.code || null, feeCents: fee?.entry ? settings.failureFeeCents : 0 },
  });
}

/** Stripe's fee for a dispute, off its balance transactions; else the setting. */
function disputeFeeCents(dispute, settings) {
  const txns = Array.isArray(dispute?.balance_transactions) ? dispute.balance_transactions : [];
  const fee = txns.reduce((total, txn) => total + (Number.isSafeInteger(txn?.fee) ? txn.fee : 0), 0);
  return fee > 0 ? fee : settings.disputeFeeCents;
}

/**
 * charge.dispute.created. For a bank top-up this is final -- a PAD dispute is
 * not contested -- so act now: reverse the deposit, charge the dispute fee,
 * pause bank top-ups for this landlord, and tell them.
 *
 * A card dispute is NOT handled here (it can be won, and its money comes back
 * if so); it is logged for a human.
 */
async function handleDisputeCreated(dispute) {
  const piId = typeof dispute?.payment_intent === "string" ? dispute.payment_intent : dispute?.payment_intent?.id;
  if (!dispute?.id || !piId) return;
  const topUp = await WalletTopUp.findOne({ paymentIntentId: piId }).lean();
  const deposit = await LedgerEntry.findOne({ idempotencyKey: `deposit:${piId}` }).lean();

  if (!topUp) {
    if (deposit) {
      await logAgentAction({
        landlordId: deposit.landlordId,
        actor: "system",
        actionType: "ledger_card_dispute",
        summary: `A card top-up was disputed (${money(dispute.amount)}). Review it in Stripe.`,
        input: { disputeId: dispute.id, paymentIntentId: piId },
        output: { reason: dispute.reason || null },
      });
    }
    return;
  }

  const landlordId = String(topUp.landlordId);
  const settings = bankDebitSettings();

  let reversal = null;
  if (deposit) {
    const amountCents = Math.min(Number(dispute.amount) || deposit.amountCents, deposit.amountCents);
    reversal = await reverseBankDeposit({ landlordId, disputeId: dispute.id, amountCents, paymentIntentId: piId });
  }
  const feeCents = disputeFeeCents(dispute, settings);
  const fee = await chargeBankFee({
    landlordId,
    key: dispute.id,
    amountCents: feeCents,
    memo: "Bank fee: a top-up was disputed at your bank",
    paymentIntentId: piId,
  });

  const now = new Date();
  await WalletTopUp.updateOne(
    { _id: topUp._id, status: { $ne: "disputed" } },
    { $set: { status: "disputed", disputeId: dispute.id, disputedAt: now } }
  );
  await Landlord.updateOne(
    { _id: landlordId, "bankDebit.blockedAt": { $in: [null, undefined] } },
    { $set: { "bankDebit.blockedAt": now, "bankDebit.blockedReason": `dispute ${dispute.id}` } }
  );
  // The disputed account must never be debited again. If it is the saved
  // one-click account -- it succeeded before the dispute, so it became the
  // saved account -- forget it, so lifting the pause does not put it back one
  // click away. (Seen in the sandbox run.) Best-effort: the pause holds anyway.
  await forgetDisputedAccount(landlordId, piId);
  publish(landlordId, "wallet");

  if (fee.alreadyApplied && (!reversal || reversal.alreadyApplied)) return; // a replay

  const owed = (reversal?.owedCents || 0) + (fee.owedCents || 0);
  await notifyUser({
    userId: landlordId,
    type: "payment_failed",
    title: "A bank top-up was reversed",
    message:
      (deposit
        ? `Your bank reversed a ${money(deposit.amountCents)} wallet top-up, so it has been taken back out of your wallet, along with the ${money(feeCents)} dispute fee.`
        : `Your bank disputed a ${money(topUp.walletCents)} top-up before it was added to your wallet. A ${money(feeCents)} dispute fee applies.`) +
      (owed > 0 ? ` ${money(owed)} of that was already spent and is now owed; your next top-up pays it first.` : "") +
      " Bank top-ups are paused on your account. You can still top up by card.",
    metadata: { paymentId: piId, amount: fromCents(topUp.walletCents) },
    email: (await Landlord.findById(landlordId).select("email").lean())?.email || undefined,
    emailSubject: "A bank top-up to your Artrelo wallet was reversed",
  });
  await logAgentAction({
    landlordId,
    actor: "system",
    actionType: "ledger_bank_topup_disputed",
    summary: `A bank top-up of ${money(topUp.walletCents)} was disputed and reversed; bank top-ups paused`,
    input: { disputeId: dispute.id, paymentIntentId: piId, reason: dispute.reason || null },
    output: {
      reversedCents: reversal ? reversal.takenCents + reversal.owedCents : 0,
      owedCents: owed,
      feeCents,
      credited: Boolean(deposit),
    },
  });
}

async function forgetDisputedAccount(landlordId, piId) {
  try {
    const stripe = getStripe();
    if (!stripe) return;
    const intent = await stripe.paymentIntents.retrieve(piId);
    const pmId = typeof intent?.payment_method === "string" ? intent.payment_method : intent?.payment_method?.id;
    if (!pmId) return;
    await Landlord.updateOne(
      { _id: landlordId, "bankDebit.paymentMethodId": pmId },
      {
        $unset: {
          "bankDebit.paymentMethodId": 1,
          "bankDebit.mandateId": 1,
          "bankDebit.last4": 1,
          "bankDebit.institution": 1,
          "bankDebit.savedAt": 1,
        },
      }
    );
  } catch (err) {
    console.error("[bankTopUp] could not check the disputed account against the saved one:", err.message);
  }
}

/** charge.dispute.closed: a PAD dispute is never won; this is a record. */
async function handleDisputeClosed(dispute) {
  const piId = typeof dispute?.payment_intent === "string" ? dispute.payment_intent : dispute?.payment_intent?.id;
  const topUp = piId ? await WalletTopUp.findOne({ paymentIntentId: piId }).lean() : null;
  const deposit = !topUp && piId ? await LedgerEntry.findOne({ idempotencyKey: `deposit:${piId}` }).lean() : null;
  const landlordId = topUp?.landlordId || deposit?.landlordId;
  if (!landlordId) return;
  await logAgentAction({
    landlordId,
    actor: "system",
    actionType: "ledger_dispute_closed",
    summary: `A top-up dispute closed: ${dispute.status}`,
    input: { disputeId: dispute.id, paymentIntentId: piId },
    output: { status: dispute.status, method: topUp ? "bank" : "card" },
  });
}

/**
 * mandate.updated. A mandate that is no longer active (the landlord revoked it
 * at their bank) cannot be debited again: forget the saved account so the
 * next top-up asks for one. The block, if any, stays.
 */
async function handleMandateUpdated(mandate) {
  if (!mandate?.id || mandate.status === "active") return;
  const result = await Landlord.updateOne(
    { "bankDebit.mandateId": mandate.id },
    {
      $unset: {
        "bankDebit.paymentMethodId": 1,
        "bankDebit.mandateId": 1,
        "bankDebit.last4": 1,
        "bankDebit.institution": 1,
        "bankDebit.savedAt": 1,
      },
    }
  );
  if (result.modifiedCount) console.log(`[bankTopUp] mandate ${mandate.id} is ${mandate.status}; saved bank account removed`);
}

/** payment_intent.canceled: an abandoned new-account form, or an operator cancel. */
async function handleBankCanceled(pi) {
  if (!isBankIntent(pi)) return;
  const topUp = await topUpForIntent(pi);
  if (!topUp) return;
  await WalletTopUp.updateOne({ _id: topUp._id, status: { $in: ["created", "processing"] } }, { $set: { status: "canceled" } });
  publish(pi.metadata.artreloLandlordId, "wallet");
}

module.exports = {
  bankTopUpRefusal,
  bankStatusFor,
  startBankTopUp,
  handleBankProcessing,
  handleBankSucceeded,
  handleBankFailed,
  handleBankCanceled,
  handleDisputeCreated,
  handleDisputeClosed,
  handleMandateUpdated,
  disputeFeeCents,
  failureReason,
  addBusinessDays,
  expectedWindow,
  isBankIntent,
};
