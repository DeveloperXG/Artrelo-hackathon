const assert = require("assert");
const Completion = require("../../../models/JobCompletion");
const Ledger = require("../../../models/LedgerEntry");
const { payoutViewStatus, reconcileCompletionPaymentViews } = require("../../../services/completion/completionPaymentView.service");
assert.strictEqual(payoutViewStatus([]), null);
assert.strictEqual(payoutViewStatus([{ providerStatus: "paid" }]), "paid");
assert.strictEqual(payoutViewStatus([{ providerStatus: "paid" }, { providerStatus: "awaiting_funds" }]), "awaiting_funds");
assert.strictEqual(payoutViewStatus([{ providerStatus: "paid" }, { providerStatus: "paid" }]), "paid");
let writes = [], raced = false;
Completion.find = filter => {
  assert.strictEqual(filter.status, "closed");
  return { sort() { return this; }, limit(value) { assert.strictEqual(value, 50); return this; }, select() { return this; },
    lean: async () => [{ _id: "c1", landlordId: "l1", ledger: { payoutStatus: "pending", releaseEntryId: "p1" } }] };
};
Ledger.find = filter => { assert.deepStrictEqual(filter, { landlordId: "l1", completionId: "c1", type: "payout" });
  return { select() { return this; }, lean: async () => [{ providerStatus: "paid" }] }; };
Ledger.updateOne = () => { throw new Error("Must never mark a journal entry paid"); };
Completion.updateOne = async (filter, update) => { writes.push({ filter, update }); return { matchedCount: raced ? 0 : 1 }; };
async function run() {
  assert.strictEqual(await reconcileCompletionPaymentViews(new Date()), 1);
  assert.strictEqual(writes[0].update.$set["ledger.payoutStatus"], "paid");
  assert.strictEqual(writes[0].filter["ledger.payoutStatus"], "pending", "stale readers cannot overwrite a newer projection");
  assert.ok(Object.keys(writes[0].update.$set).every(key => key.startsWith("ledger.payout")), "only cache metadata changes");
  raced = true; assert.strictEqual(await reconcileCompletionPaymentViews(), 0);
  console.log("completion canonical payment cache tests passed");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
