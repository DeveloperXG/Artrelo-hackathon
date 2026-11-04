const assert = require("assert");
const config = require("../../../config/stripe");
const LedgerEntry = require("../../../models/LedgerEntry");
require("../../../services/realtime/liveEvents.service").publish = () => {};
let intent;
let row;
const writes = [];
config.getStripe = () => ({ paymentIntents: { retrieve: async () => intent } });
LedgerEntry.updateOne = async (filter, update) => { writes.push({ filter, update }); };
LedgerEntry.findOne = () => ({ select: () => ({ lean: async () => row }) });
LedgerEntry.find = () => ({ sort() { return this; }, limit() { return this; },
  select() { return this; }, lean: async () => row ? [row] : [] });
const service = require("../../../services/ledger/cardSettlement.service");
async function main() {
  intent = { id: "pi_card", status: "succeeded", metadata: { artreloPurpose: "wallet_topup" },
    payment_method_types: ["card"], amount_received: 2091, latest_charge: { balance_transaction: null } };
  const args = { entryId: "deposit", paymentIntent: intent, walletCents: 2000 };
  assert.strictEqual(await service.recordCardSettlement(args), false);
  assert.deepStrictEqual(writes[0].update.$set, { "card.processingFeeCents": 91 },
    "No invented settlement date, fee, or net during asynchronous capture");
  row = { _id: "deposit", landlordId: "owner", providerRef: "pi_card", amountCents: 2000 };
  intent.latest_charge.balance_transaction = { fee: 107, net: 1984, available_on: 1792886400 };
  await service.handleCardChargeUpdated({ payment_intent: "pi_card", balance_transaction: "txn_delayed",
    payment_method_details: { type: "card" } });
  assert.strictEqual(writes[1].update.$set["card.stripeFeeCents"], 107);
  assert.strictEqual(writes[1].update.$set["card.netCents"], 1984);
  assert.strictEqual(writes[1].update.$set["card.availableOn"].toISOString(), "2026-10-25T00:00:00.000Z");
  assert.ok(!writes.some(write => write.update.$inc), "Settlement metadata never credits money");
  const before = writes.length;
  await service.handleCardChargeUpdated({ payment_intent: "pi_bank", balance_transaction: "txn_bank",
    payment_method_details: { type: "acss_debit" } });
  row = null;
  await service.handleCardChargeUpdated({ payment_intent: "pi_unrelated", balance_transaction: "txn_unrelated" });
  assert.strictEqual(writes.length, before, "Bank or unrecorded payments do not enter card recovery");
  row = { _id: "deposit", landlordId: "owner", providerRef: "pi_card", amountCents: 2000 };
  assert.deepStrictEqual(await service.reconcileCardSettlements(), { found: 1, updated: 1 });
  intent = { ...intent, status: "processing" };
  const count = writes.length;
  assert.strictEqual(await service.recordCardSettlement(args), false);
  assert.strictEqual(writes.length, count);
  console.log("cardSettlement.service tests passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
