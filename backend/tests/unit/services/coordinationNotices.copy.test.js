const assert = require("assert");
const { copy } = require("../../../services/vendor/coordinationNotices.service");
const row = { phase: "awaiting_funds", amountCents: 24000, shortfallCents: 14000, reasonCode: "insufficient_funds" };
assert.ok(copy(row, "landlord", "Plumber").message.includes("$140.00"));
for (const phase of ["awaiting_approval", "awaiting_funds", "awaiting_vendor", "awaiting_tenant", "scheduled", "closed", "expired", "paused"]) {
  const tenant = JSON.stringify(copy({ ...row, phase }, "tenant", "Plumber"));
  for (const privateText of ["$", "fund", "wallet", "240", "140"]) assert.ok(!tenant.includes(privateText), `${phase} tenant copy excludes ${privateText}`);
  assert.ok(copy({ ...row, phase }, "vendor", "Plumber").message);
}
assert.ok(copy(row, "vendor", "Plumber").message.includes("not attend"));
assert.ok(copy({ ...row, phase: "closed" }, "vendor", "Plumber").message.includes("new confirmation"));
const { rescheduleCopy } = require('../../../services/vendor/coordinationNotices.service');
const pendingChange = { status: 'awaiting_tenant', reason: 'Synthetic access route unavailable',
  oldSlot: { start: '2026-10-30T15:00:00Z', end: '2026-10-30T16:00:00Z' },
  proposedSlot: { start: '2026-10-31T15:00:00Z', end: '2026-10-31T16:00:00Z' } };
assert.match(rescheduleCopy(pendingChange).message, /original visit remains confirmed/);
assert.match(rescheduleCopy(pendingChange).message, /Synthetic access route unavailable/);
for (const status of ['declined', 'expired', 'conflict']) assert.match(rescheduleCopy({ ...pendingChange, status }).message, /original visit remains in place/);
assert(!rescheduleCopy({ ...pendingChange, status: 'invalidated' }).message.includes('remains confirmed'), 'unknown changed context does not assert an old visit is still confirmed');
console.log("coordination message copy tests passed");
