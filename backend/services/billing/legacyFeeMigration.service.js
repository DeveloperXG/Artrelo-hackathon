const mongoose = require("mongoose");
const Landlord = require("../../models/Landlord");
const Account = require("../../models/BillingAccount");
const Assessment = require("../../models/FeeAssessment");
const Ledger = require("../../models/LandlordLedger");
const Entry = require("../../models/LedgerEntry");
const { account } = require("../ledger/ledger.service");
const { replayEntries } = require("../../scripts/reconcileLedger");
async function migrateLegacyFees(landlordId, { apply = false } = {}) {
  let result;
  await mongoose.connection.transaction(async (session) => {
    const wallet = apply ? await Ledger.findOneAndUpdate({ landlordId }, { $inc: { version: 1 } }, { new: true, session }) : await Ledger.findOne({ landlordId }).session(session);
    const entries = await Entry.find({ landlordId }).sort({ createdAt: 1, _id: 1 }).session(session).lean();
    const replay = replayEntries(entries, String(landlordId));
    if (entries.some((e) => !Entry.linesBalance(e.lines)) || replay.feesOwed !== (wallet?.feesOwed || 0)) throw new Error("Reconcile the existing journal and fee debt before migration");
    const amount = wallet?.feesOwed || 0;
    result = { landlordId: String(landlordId), amountCents: amount, applied: false };
    if (!apply || !amount) return;
    const tail = entries.at(-1)._id;
    const sourceKey = `legacy:${landlordId}:${tail}`;
    const fees = entries.filter((e) => e.type === "fee" && !e.shortfall);
    const [assessment] = await Assessment.create([{ sourceKey, source: "legacy", landlordId,
      feeCents: amount, listCents: amount, closedAt: fees[0]?.createdAt || new Date(), legacyEntryIds: fees.map((e) => e._id) }], { session });
    const [transfer] = await Entry.create([{ landlordId, type: "fee_billing_transfer", amountCents: amount,
      idempotencyKey: `fee_billing_transfer:${assessment._id}`, memo: "Unpaid service fees transferred to monthly billing; no payment collected",
      lines: [{ account: account.feesOwed(landlordId), direction: "debit", amountCents: amount },
        { account: `billing:${landlordId}:receivable`, direction: "credit", amountCents: amount }] }], { session });
    const updated = await Ledger.findOneAndUpdate({ landlordId, feesOwed: amount }, { $inc: { feesOwed: -amount } }, { new: true, session });
    if (!updated) throw new Error("Fee debt changed during migration");
    await Entry.updateOne({ _id: transfer._id }, { $set: { balanceAfter: { available: updated.available, held: updated.held } } }, { session });
    const at = new Date();
    await Landlord.updateOne({ _id: landlordId, serviceBillingEnabledAt: null }, { $set: { serviceBillingEnabledAt: at } }, { session });
    await Account.updateOne({ landlordId }, { $setOnInsert: { landlordId, cutoverAt: at } }, { session, upsert: true });
    result = { ...result, applied: true, assessmentId: String(assessment._id) };
  });
  return result;
}
module.exports = { migrateLegacyFees };
