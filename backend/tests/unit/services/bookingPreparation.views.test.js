const assert = require("assert");
const { landlordView, tenantView } = require("../../../services/vendor/bookingPreparation.service");
const row = { phase: "awaiting_funds", revision: 2, deadlineAt: new Date(), rounds: 0,
  amountCents: 24000, shortfallCents: 14000, reasonCode: "insufficient_funds",
  leaseToken: "PRIVATE_LEASE", identityId: "PRIVATE_ID", proposals: [{ start: "start", end: "end", private: "PRIVATE" }] };
assert.strictEqual(landlordView(row).shortfall, 140);
assert.strictEqual(landlordView(row).amount, 240);
const tenant = tenantView(row);
assert.strictEqual(tenant.phase, "preparing");
const text = JSON.stringify(tenant);
for (const forbidden of ["24000", "14000", "insufficient_funds", "PRIVATE", "amount", "shortfall", "lease"]) {
  assert.ok(!text.includes(forbidden), `tenant projection excludes ${forbidden}`);
}
assert.strictEqual(tenantView(null), null);
console.log("booking preparation projection tests passed");
