// Informational settlement data only. A succeeded PaymentIntent already owns
// the wallet credit; delayed capture must never credit it a second time.
const { getStripe } = require("../../config/stripe");
const LedgerEntry = require("../../models/LedgerEntry");
const { publish } = require("../realtime/liveEvents.service");

async function recordCardSettlement({ entryId, paymentIntent, walletCents }) {
  try {
    const stripe = getStripe();
    if (!stripe) return false;
    const intent = await stripe.paymentIntents.retrieve(paymentIntent.id, {
      expand: ["latest_charge.balance_transaction"],
    });
    if (intent.status !== "succeeded" || intent.metadata?.artreloPurpose !== "wallet_topup" ||
        intent.payment_method_types?.includes("acss_debit")) return false;
    const txn = intent.latest_charge?.balance_transaction;
    const received = Number(intent.amount_received ?? paymentIntent.amount_received ?? 0);
    const fields = { "card.processingFeeCents": Math.max(0, received - walletCents) };
    // automatic_async can return a succeeded intent with no balance transaction
    // yet. Preserve known values and let charge.updated / recovery fill gaps.
    if (Number.isSafeInteger(txn?.fee)) fields["card.stripeFeeCents"] = txn.fee;
    if (Number.isSafeInteger(txn?.net)) fields["card.netCents"] = txn.net;
    if (txn?.available_on) fields["card.availableOn"] = new Date(txn.available_on * 1000);
    await LedgerEntry.updateOne({ _id: entryId }, { $set: fields });
    return !!txn?.available_on;
  } catch (error) {
    console.error("[cardSettlement] settlement read failed", error.code || "stripe_read_failed");
    return false;
  }
}

async function handleCardChargeUpdated(charge) {
  if (charge?.payment_method_details?.type && charge.payment_method_details.type !== "card") return;
  if (!charge?.balance_transaction || !charge.payment_intent) return;
  const intentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id;
  const entry = await LedgerEntry.findOne({ type: "deposit", provider: "stripe", fundingSource: "stripe",
    providerRef: intentId, "card.availableOn": null }).select("_id landlordId amountCents").lean();
  // A charge can update before its success event is processed. That event will
  // fetch the current intent itself; an unrelated payment never creates credit.
  if (!entry) return;
  const complete = await recordCardSettlement({ entryId: entry._id,
    paymentIntent: { id: intentId }, walletCents: entry.amountCents });
  if (!complete) throw new Error("Card settlement details are not available yet");
  publish(entry.landlordId, "wallet");
}

async function reconcileCardSettlements({ limit = 20 } = {}) {
  const rows = await LedgerEntry.find({ type: "deposit", provider: "stripe", fundingSource: "stripe",
    "card.availableOn": null, "card.processingFeeCents": { $ne: null },
    createdAt: { $gte: new Date(Date.now() - 30 * 86400_000) } })
    .sort({ createdAt: 1 }).limit(limit).select("_id landlordId amountCents providerRef").lean();
  let updated = 0;
  for (const row of rows) {
    if (await recordCardSettlement({ entryId: row._id, paymentIntent: { id: row.providerRef }, walletCents: row.amountCents })) {
      updated++;
      publish(row.landlordId, "wallet");
    }
  }
  return { found: rows.length, updated };
}

module.exports = { recordCardSettlement, handleCardChargeUpdated, reconcileCardSettlements };
