// Operator-only bank refunds. Reserve wallet cash atomically BEFORE asking
// Stripe to return it; pending refunds cannot be spent on a new booking.
const mongoose = require("mongoose");
const config = require("../../config/stripe");
const WalletRefund = require("../../models/WalletRefund");
const Ledger = require("../../models/LandlordLedger");
const Entry = require("../../models/LedgerEntry");
const { account } = require("./ledger.service");
const { publish } = require("../realtime/liveEvents.service");

async function refundPlan(paymentIntentId, amountCents) {
  if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId || "") || !Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error("Provide an intent and a positive integer amount in cents");
  const stripe = config.getStripe();
  if (!stripe) throw new Error("Stripe is not configured");
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
  if (intent.status !== "succeeded" || intent.metadata?.artreloPurpose !== "wallet_topup" || intent.metadata?.artreloMethod !== "bank" || !intent.metadata.artreloLandlordId) throw new Error("Only successful Artrelo bank wallet top-ups can be refunded here");
  const charge = intent.latest_charge;
  if (!charge?.id || charge.disputed || !charge.balance_transaction?.available_on || charge.balance_transaction.available_on * 1000 > Date.now()) throw new Error("The debit must be settled and free of an active dispute");
  if (Date.now() - intent.created * 1000 > 180 * 86400_000) throw new Error("The bank refund window has expired");
  const landlordId = intent.metadata.artreloLandlordId;
  const wallet = await Ledger.findOne({ landlordId }).lean();
  return { paymentIntentId, landlordId, amountCents, availableCents: wallet?.available || 0,
    unrefundedCents: Math.max(0, intent.amount_received - (charge.amount_refunded || 0)), chargeId: charge.id };
}

async function post({ session, row, returning = false }) {
  const amount = row.amountCents, name = returning ? "return" : "reserve";
  const wallet = await Ledger.findOne({ landlordId: row.landlordId }).session(session);
  const repaid = returning ? Math.min(wallet.bankOwed || 0, amount) : 0;
  const available = amount - repaid;
  const lines = [{ account: account.funding(), direction: returning ? "credit" : "debit", amountCents: amount }];
  if (available) lines.push({ account: account.available(row.landlordId), direction: returning ? "debit" : "credit", amountCents: available });
  if (repaid) lines.push({ account: account.bankOwed(row.landlordId), direction: "debit", amountCents: repaid });
  const [entry] = await Entry.create([{ landlordId: row.landlordId, amountCents: amount,
    type: returning ? "deposit_restoration" : "refund", idempotencyKey: `wallet_refund:${row.operation}:${name}`,
    provider: "stripe", providerRef: row.paymentIntentId, fundingSource: "stripe", providerStatus: "paid",
    memo: returning ? "Failed bank refund returned to wallet" : `Bank wallet refund reserved: ${row.reason}`,
    lines,
  }], { session });
  const updated = await Ledger.findOneAndUpdate({ landlordId: row.landlordId,
    ...(!returning ? { available: { $gte: amount }, bankOwed: 0, arrears: 0 } : {}) },
  { $inc: { available: returning ? available : -amount, bankOwed: -repaid,
    lifetimeDeposited: returning ? amount : -amount } }, { new: true, session });
  if (!updated) throw new Error("Insufficient uncommitted wallet cash or outstanding funding debt");
  await Entry.updateOne({ _id: entry._id }, { $set: { balanceAfter: { available: updated.available, held: updated.held } } }, { session });
}

async function syncRefund(refundId) {
  const row = await WalletRefund.findOne({ refundId });
  if (!row) return { ignored: true };
  const refund = await config.getStripe().refunds.retrieve(refundId);
  if (refund.payment_intent !== row.paymentIntentId || refund.amount !== row.amountCents) throw new Error("Refund identity or amount mismatch");
  await mongoose.connection.transaction(async (session) => {
    await Ledger.findOneAndUpdate({ landlordId: row.landlordId }, { $inc: { version: 1 } }, { session });
    const current = await WalletRefund.findById(row._id).session(session);
    if (["failed", "canceled", "succeeded"].includes(current.status)) return;
    if (["failed", "canceled"].includes(refund.status)) await post({ session, row: current, returning: true });
    await WalletRefund.updateOne({ _id: current._id }, { $set: { status: refund.status } }, { session });
  });
  publish(row.landlordId, "wallet");
  return { refundId, status: refund.status };
}

async function executeRefund({ paymentIntentId, amountCents, operation, reason }) {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(operation || "") || !reason?.trim() || reason.length > 300) throw new Error("A stable operation ID and a reason are required");
  const plan = await refundPlan(paymentIntentId, amountCents);
  await mongoose.connection.transaction(async (session) => {
    await Ledger.findOneAndUpdate({ landlordId: plan.landlordId }, { $inc: { version: 1 } }, { session });
    const existing = await WalletRefund.findOne({ operation }).session(session);
    if (existing) {
      if (existing.paymentIntentId !== paymentIntentId || existing.amountCents !== amountCents || existing.reason !== reason) throw new Error("Operation ID reused with different refund details");
      return;
    }
    const pending = await WalletRefund.find({ paymentIntentId, status: { $in: ["reserved", "pending", "requires_action"] } }).session(session).lean();
    if (amountCents + pending.reduce((n, r) => n + r.amountCents, 0) > plan.unrefundedCents) throw new Error("Amount exceeds the unrefunded top-up");
    const [row] = await WalletRefund.create([{ operation, landlordId: plan.landlordId, paymentIntentId, amountCents, reason }], { session });
    await post({ session, row });
  });
  let row = await WalletRefund.findOne({ operation });
  if (["failed", "canceled"].includes(row.status)) return { status: row.status, refundId: row.refundId };
  if (!row.refundId) {
    const stripe = config.getStripe();
    let refund;
    for await (const item of stripe.refunds.list({ charge: plan.chargeId, limit: 100 })) {
      if (item.metadata?.artreloWalletRefundOperation === operation) { refund = item; break; }
    }
    if (!refund) {
      // After Stripe's key retention window, a lost response needs review,
      // rather than another charge/refund with an expired idempotency key.
      if (Date.now() - row.createdAt.getTime() > 23 * 3600_000) throw new Error("Reserved refund is older than 23 hours; review it in Stripe before retrying");
      refund = await stripe.refunds.create({ payment_intent: paymentIntentId, amount: amountCents,
        metadata: { artreloPurpose: "wallet_refund", artreloWalletRefundOperation: operation } }, { idempotencyKey: `wallet_refund:${operation}` });
    }
    await WalletRefund.updateOne({ _id: row._id }, { $set: { refundId: refund.id } });
    row.refundId = refund.id;
  }
  return syncRefund(row.refundId);
}

async function reconcileRefunds({ limit = 25 } = {}) {
  const rows = await WalletRefund.find({ status: { $in: ["reserved", "pending", "requires_action"] } }).sort({ updatedAt: 1 }).limit(limit).lean();
  for (const row of rows) {
    if (row.refundId) await syncRefund(row.refundId);
    else await executeRefund(row);
  }
}
module.exports = { refundPlan, executeRefund, syncRefund, reconcileRefunds };
