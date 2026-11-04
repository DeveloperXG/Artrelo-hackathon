// Wallet principal follows Stripe's actual dispute balance transactions.
// Stripe calls happen outside the transaction; the wallet, journal and durable
// progress commit together. A retry can safely recover any interrupted step.
const mongoose = require("mongoose");
const config = require("../../config/stripe");
const FundingDispute = require("../../models/FundingDispute");
const LedgerEntry = require("../../models/LedgerEntry");
const LandlordLedger = require("../../models/LandlordLedger");
const { account } = require("./ledger.service");
const { publish } = require("../realtime/liveEvents.service");
const { logAgentAction } = require("../audit/agentAction.service");

const idOf = (value) => typeof value === "string" ? value : value?.id;
function disputeAmounts(dispute, walletCents, grossCents) {
  const transactions = dispute.balance_transactions || [];
  const withdrawn = transactions.reduce((n, tx) => n + Math.max(0, -(tx.amount || 0)), 0);
  const reinstated = transactions.reduce((n, tx) => n + Math.max(0, tx.amount || 0), 0);
  const principal = (gross) => Math.min(walletCents, Math.round(walletCents * Math.min(gross, grossCents) / grossCents));
  return { withdrawn, reinstated, reverse: principal(withdrawn), restore: principal(Math.min(withdrawn, reinstated)),
    stripeCostCents: transactions.reduce((n, tx) => n + (tx.fee || 0), 0) };
}

async function reconcileDispute(disputeOrId) {
  const stripe = config.getStripe();
  const disputeId = idOf(disputeOrId);
  if (!stripe || !disputeId) return { ignored: true };
  // Never apply an old event snapshot over newer state. Expanded charge also
  // covers events where payment_intent isn't present on the dispute object.
  const dispute = await stripe.disputes.retrieve(disputeId, { expand: ["charge"] });
  const piId = idOf(dispute.payment_intent) || idOf(dispute.charge?.payment_intent);
  if (!piId) return { ignored: true };
  const intent = await stripe.paymentIntents.retrieve(piId);
  if (intent.metadata?.artreloPurpose !== "wallet_topup" || !intent.metadata?.artreloLandlordId ||
      intent.metadata.artreloMethod === "bank" || intent.payment_method_types?.includes("acss_debit")) return { ignored: true };
  const landlordId = intent.metadata.artreloLandlordId;
  const grossCents = intent.amount_received || intent.amount;
  if (!Number.isSafeInteger(grossCents) || grossCents <= 0) throw new Error("Invalid disputed charge amount");
  const wallet = await LandlordLedger.findOne({ landlordId });
  if (!wallet) {
    try { await LandlordLedger.create({ landlordId }); } catch (error) { if (error.code !== 11000) throw error; }
  }
  try {
    await FundingDispute.updateOne({ disputeId }, { $setOnInsert: { disputeId, paymentIntentId: piId, landlordId } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  let changed = false;
  await mongoose.connection.transaction(async (session) => {
    // The same wallet document is written by every wallet operation. Taking
    // this write first serializes against a spend or another dispute update.
    const ledger = await LandlordLedger.findOneAndUpdate({ landlordId }, { $inc: { version: 1 } }, { new: true, session });
    const row = await FundingDispute.findOne({ disputeId }).session(session);
    if (String(row.landlordId) !== String(landlordId) || row.paymentIntentId !== piId) throw new Error("Dispute ownership changed");
    const deposit = await LedgerEntry.findOne({ idempotencyKey: `deposit:${piId}`, fundingSource: "stripe" }).session(session);
    const values = { status: dispute.status, checkedAt: new Date(), needsDeposit: !deposit };
    if (!deposit) {
      await FundingDispute.updateOne({ _id: row._id }, { $set: values }, { session });
      return;
    }
    if (String(deposit.landlordId) !== String(landlordId)) throw new Error("Deposit ownership changed");
    const amounts = disputeAmounts(dispute, deposit.amountCents, grossCents);
    const otherDisputes = await FundingDispute.find({ paymentIntentId: piId, _id: { $ne: row._id } }).session(session).lean();
    const otherPrincipal = otherDisputes.reduce((n, d) => n + d.reversedCents - d.restoredCents, 0);
    // Stripe may return less complete data briefly. Never undo posted progress.
    const targetReverse = Math.max(row.reversedCents, Math.min(amounts.reverse, Math.max(0, deposit.amountCents - otherPrincipal)));
    const targetRestore = Math.min(targetReverse, Math.max(row.restoredCents, amounts.restore));
    const reverse = targetReverse - row.reversedCents;
    const restore = targetRestore - row.restoredCents;
    const post = async (type, amountCents, lines, cacheUpdate, target) => {
      const [entry] = await LedgerEntry.create([{
        landlordId, type, amountCents, lines, fundingSource: "stripe", provider: "stripe",
        providerRef: piId, providerStatus: "paid", idempotencyKey: `card_dispute:${disputeId}:${type}:${target}`,
        memo: type === "deposit_reversal" ? "Card top-up reversed by a dispute" : "Disputed card top-up funds reinstated",
      }], { session });
      const updated = await LandlordLedger.findOneAndUpdate({ landlordId }, { $inc: cacheUpdate,
        $set: { lastEntryAt: new Date() } }, { new: true, session });
      await LedgerEntry.updateOne({ _id: entry._id }, { $set: { balanceAfter: { available: updated.available, held: updated.held } } }, { session });
      Object.assign(ledger, { available: updated.available, bankOwed: updated.bankOwed });
      changed = true;
    };
    if (reverse > 0) {
      const taken = Math.min(ledger.available, reverse), owed = reverse - taken;
      const lines = [{ account: account.funding(), direction: "debit", amountCents: reverse }];
      if (taken) lines.push({ account: account.available(landlordId), direction: "credit", amountCents: taken });
      if (owed) lines.push({ account: account.bankOwed(landlordId), direction: "credit", amountCents: owed });
      await post("deposit_reversal", reverse, lines, { available: -taken, bankOwed: owed, lifetimeDeposited: -reverse }, targetReverse);
    }
    if (restore > 0) {
      const repaid = Math.min(ledger.bankOwed || 0, restore), available = restore - repaid;
      const lines = [{ account: account.funding(), direction: "credit", amountCents: restore }];
      if (available) lines.push({ account: account.available(landlordId), direction: "debit", amountCents: available });
      if (repaid) lines.push({ account: account.bankOwed(landlordId), direction: "debit", amountCents: repaid });
      await post("deposit_restoration", restore, lines, { available, bankOwed: -repaid, lifetimeDeposited: restore }, targetRestore);
    }
    await FundingDispute.updateOne({ _id: row._id }, { $set: { ...values,
      reversedCents: targetReverse, restoredCents: targetRestore, withdrawnGrossCents: amounts.withdrawn,
      reinstatedGrossCents: amounts.reinstated, stripeCostCents: amounts.stripeCostCents,
      transactions: (dispute.balance_transactions || []).map((tx) => ({ id: tx.id,
        createdAt: tx.created ? new Date(tx.created * 1000) : new Date(dispute.created * 1000),
        amountCents: tx.amount, feeCents: tx.fee || 0 })) } }, { session });
  });
  if (changed) {
    publish(landlordId, "wallet");
    await logAgentAction({ landlordId, actor: "system", actionType: "ledger_card_dispute",
      summary: "Card top-up dispute reconciled with Stripe", input: { disputeId, paymentIntentId: piId },
      output: { status: dispute.status } });
  }
  return { ignored: false, changed };
}

async function reconcileIntent(paymentIntentId) {
  const rows = await FundingDispute.find({ paymentIntentId }).select("disputeId").lean();
  for (const row of rows) await reconcileDispute(row.disputeId);
}

async function reconcileCardDisputes({ limit = 25 } = {}) {
  const rows = await FundingDispute.find({ $or: [{ needsDeposit: true }, { status: { $nin: ["won", "warning_closed"] } },
    { $expr: { $lt: ["$restoredCents", "$reversedCents"] } }] }).sort({ checkedAt: 1 }).limit(limit).select("disputeId").lean();
  for (const row of rows) await reconcileDispute(row.disputeId);
  return { checked: rows.length };
}

module.exports = { reconcileDispute, reconcileIntent, reconcileCardDisputes, disputeAmounts };
