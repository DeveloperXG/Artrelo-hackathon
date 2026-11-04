// The audit spine accepts landlord-level events.
//
// This log started as a per-request trail with requestId required. The money
// path then added events that belong to no maintenance request — a wallet
// top-up, a payout marked paid by hand, a declined card. Every one of those
// failed validation, and because logAgentAction swallows its own errors (right:
// an audit failure must not break a payment) they disappeared with only a
// console line.
//
// So the audit trail was silently dropping precisely the entries about money.

const assert = require("assert");
const mongoose = require("mongoose");
const AgentActionLog = require("../../../models/AgentActionLog");

const landlordId = new mongoose.Types.ObjectId();
const requestId = new mongoose.Types.ObjectId();

/* ---------------- 1) A landlord-level event needs no request ------------- */

const walletTopUp = new AgentActionLog({
  landlordId,
  actor: "system",
  actionType: "ledger_deposit",
  summary: "Card top-up of 1000 CAD settled",
  input: { paymentIntentId: "pi_123" },
});

const walletError = walletTopUp.validateSync();
assert.strictEqual(
  walletError,
  undefined,
  `a wallet event must validate without a requestId, got: ${walletError?.message}`
);
assert.strictEqual(walletTopUp.requestId, null, "and it defaults to null, not undefined");

// The four call sites that were failing, by name.
for (const actionType of [
  "ledger_deposit_intent",
  "ledger_deposit",
  "ledger_deposit_failed",
  "payout_marked_paid",
]) {
  const entry = new AgentActionLog({
    landlordId,
    actor: "landlord",
    actionType,
    summary: `${actionType} happened`,
  });
  assert.strictEqual(
    entry.validateSync(),
    undefined,
    `${actionType} must be recordable without a requestId`
  );
}

/* ---------------- 2) landlordId is still required ------------------------ */
// Optional requestId must not become "anything goes" — every entry stays
// attributable to someone.

const orphan = new AgentActionLog({
  actor: "system",
  actionType: "ledger_deposit",
  summary: "unattributable",
});
const orphanError = orphan.validateSync();
assert.ok(orphanError, "an entry with no landlord must still be rejected");
assert.ok(orphanError.errors.landlordId, "specifically for landlordId");

// And the other required fields still bite.
for (const missing of ["actor", "actionType", "summary"]) {
  const doc = new AgentActionLog({
    landlordId,
    actor: "system",
    actionType: "x",
    summary: "y",
  });
  doc[missing] = undefined;
  assert.ok(doc.validateSync()?.errors[missing], `${missing} must stay required`);
}

/* ---------------- 3) Request-scoped events are unaffected ---------------- */

const jobEvent = new AgentActionLog({
  requestId,
  landlordId,
  actor: "vendor",
  actionType: "vendor_completion_submitted",
  summary: "Vendor submitted completion evidence",
});
assert.strictEqual(jobEvent.validateSync(), undefined);
assert.strictEqual(String(jobEvent.requestId), String(requestId), "still carried when present");

/* ---------------- 4) The actor enum is still closed ---------------------- */

const badActor = new AgentActionLog({
  landlordId,
  actor: "stripe",
  actionType: "ledger_deposit",
  summary: "x",
});
assert.ok(badActor.validateSync()?.errors.actor, "an unknown actor must be rejected");

console.log("agentActionLog tests passed");
