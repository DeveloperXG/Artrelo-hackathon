const assert = require("assert");
const mongoose = require("mongoose");
const FundingDispute = require("../../../models/FundingDispute");
const LedgerEntry = require("../../../models/LedgerEntry");
const LandlordLedger = require("../../../models/LandlordLedger");
const VendorIdentity = require("../../../models/VendorIdentity");
const config = require("../../../config/stripe");
require("../../../services/audit/agentAction.service").logAgentAction = async () => {};
let entries, disputes, wallet, remote, intent, fail;
const clone = (value) => structuredClone(value);
const matches = (row, filter) => Object.entries(filter).every(([k, v]) => v && typeof v === "object" && "$ne" in v ? String(row[k]) !== String(v.$ne) : String(row[k]) === String(v));
const query = (read) => {
  const q = { session: () => q, select: () => q, lean: async () => read(),
    then: (ok, no) => Promise.resolve(read()).then(ok, no) };
  return q;
};
const update = (row, change) => {
  Object.assign(row, change.$set || {});
  for (const [k, n] of Object.entries(change.$inc || {})) row[k] = (row[k] || 0) + n;
};
FundingDispute.findOne = (filter) => query(() => disputes.find((r) => matches(r, filter)));
FundingDispute.find = (filter) => query(() => disputes.filter((r) => matches(r, filter)));
FundingDispute.updateOne = async (filter, change, opts = {}) => {
  let row = disputes.find((r) => matches(r, filter));
  if (!row && opts.upsert) {
    row = { _id: `d${disputes.length}`, reversedCents: 0, restoredCents: 0, ...change.$setOnInsert };
    disputes.push(row);
  }
  if (row) update(row, change);
};
LedgerEntry.findOne = (filter) => query(() => entries.find((r) => matches(r, filter)));
LedgerEntry.create = async (docs) => {
  if (fail) { fail = false; throw new Error("transaction interrupted"); }
  return docs.map((doc) => {
    assert.ok(LedgerEntry.linesBalance(doc.lines), "every posting balances");
    assert.ok(!entries.some((r) => r.idempotencyKey === doc.idempotencyKey));
    const row = { _id: `e${entries.length}`, ...doc }; entries.push(row); return row;
  });
};
LedgerEntry.updateOne = async (filter, change) => update(entries.find((r) => matches(r, filter)), change);
LandlordLedger.findOne = async () => wallet;
LandlordLedger.findOneAndUpdate = async (filter, change) => { update(wallet, change); return clone(wallet); };
VendorIdentity.findById = async () => null;
mongoose.connection.transaction = async (work) => {
  const before = clone({ entries, disputes, wallet });
  try { return await work({}); }
  catch (error) { ({ entries, disputes, wallet } = before); throw error; }
};
config.getStripe = () => ({ disputes: { retrieve: async () => clone(remote) }, paymentIntents: { retrieve: async () => clone(intent) } });
const { reconcileDispute, reconcileIntent, disputeAmounts } = require("../../../services/ledger/cardDispute.service");
const { settlePayout } = require("../../../services/ledger/ledger.service");

function reset({ available = 10000, deposit = true } = {}) {
  wallet = { landlordId: "landlord", available, held: 10000 - available, bankOwed: 0, lifetimeDeposited: 10000 };
  entries = deposit ? [{ _id: "deposit", landlordId: "landlord", amountCents: 10000, fundingSource: "stripe", idempotencyKey: "deposit:pi_card" }] : [];
  disputes = []; fail = false;
  intent = { id: "pi_card", amount_received: 10330, metadata: { artreloPurpose: "wallet_topup", artreloLandlordId: "landlord" }, payment_method_types: ["card"] };
  remote = { id: "dp_card", payment_intent: "pi_card", status: "needs_response", balance_transactions: [{ amount: -10330, fee: 1500 }] };
}
async function main() {
  reset();
  await reconcileDispute({ id: "dp_card", status: "won" }); // event snapshot must not win over Stripe
  assert.equal(wallet.available, 0); assert.equal(wallet.lifetimeDeposited, 0);
  await reconcileDispute("dp_card"); assert.equal(entries.length, 2, "duplicate withdrawal posts once");
  remote.status = "won";
  await reconcileDispute("dp_card"); assert.equal(wallet.available, 0, "won without returned cash restores nothing");
  remote.balance_transactions.push({ amount: 10330, fee: 0 });
  await reconcileDispute("dp_card"); await reconcileDispute("dp_card");
  assert.equal(wallet.available, 10000); assert.equal(wallet.lifetimeDeposited, 10000); assert.equal(entries.length, 3);

  reset({ available: 2500 }); await reconcileDispute("dp_card");
  assert.equal(wallet.bankOwed, 7500); assert.equal(wallet.available, 0); assert.equal(wallet.held, 7500);
  entries.push({ _id: "pay", type: "payout", landlordId: "landlord", providerStatus: "awaiting_clearance" });
  LedgerEntry.findById = async () => entries.find((r) => r._id === "pay");
  assert.equal((await settlePayout({ entryId: "pay" })).refused, "funding_reversed", "other landlords' cash cannot pay this vendor");
  wallet.bankOwed = 2500; // replacement cash already repaid part of the debt
  remote.balance_transactions.push({ amount: 10330, fee: 0 }); remote.status = "won";
  await reconcileDispute("dp_card");
  assert.equal(wallet.bankOwed, 0); assert.equal(wallet.available, 7500, "restoration clears current debt first");

  reset(); remote.amount = 5165; remote.balance_transactions = [{ amount: -5165, fee: 1500 }];
  await reconcileDispute("dp_card"); assert.equal(wallet.available, 5000, "partial dispute reverses proportional principal, not the surcharge");
  assert.equal(disputes[0].stripeCostCents, 1500);

  reset();
  disputes.push({ _id: "earlier", disputeId: "dp_earlier", paymentIntentId: "pi_card", landlordId: "landlord", reversedCents: 6000, restoredCents: 0 });
  wallet.available = 4000;
  await reconcileDispute("dp_card");
  assert.equal(disputes[1].reversedCents, 4000, "multiple disputes cannot reverse more than the original principal in total");

  reset({ deposit: false }); await reconcileDispute("dp_card");
  assert.equal(disputes[0].needsDeposit, true); assert.equal(entries.length, 0);
  entries.push({ _id: "late", landlordId: "landlord", amountCents: 10000, fundingSource: "stripe", idempotencyKey: "deposit:pi_card" });
  await reconcileIntent("pi_card"); assert.equal(wallet.available, 0, "late success is immediately reversed");

  reset(); fail = true;
  await assert.rejects(reconcileDispute("dp_card"), /interrupted/);
  assert.equal(wallet.available, 10000); assert.equal(disputes[0].reversedCents, 0);
  await reconcileDispute("dp_card"); assert.equal(wallet.available, 0, "crash recovers without a lost or duplicate debit");

  reset(); intent.metadata.artreloPurpose = "service_invoice";
  assert.equal((await reconcileDispute("dp_card")).ignored, true); assert.equal(wallet.available, 10000);
  reset(); intent.payment_method_types = ["acss_debit"];
  assert.equal((await reconcileDispute("dp_card")).ignored, true);
  reset(); remote.status = "warning_needs_response"; remote.balance_transactions = [];
  await reconcileDispute("dp_card"); assert.equal(wallet.available, 10000, "inquiry without withdrawal is informational");
  const a = disputeAmounts({ balance_transactions: [{ amount: -999999 }, { amount: 999999 }] }, 10000, 10330);
  assert.equal(a.reverse, 10000); assert.equal(a.restore, 10000);
  console.log("cardDispute.service tests passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
