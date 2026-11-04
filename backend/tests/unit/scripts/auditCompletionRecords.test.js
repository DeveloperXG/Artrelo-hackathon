const assert = require("assert");
const { compareCompletion } = require("../../../scripts/audit_completion_records");
const context = { completion: { _id: "c1", requestId: "r1", appointmentId: "a1", report: { actualCost: 480 },
  overage: { decision: "approved", approvedAmount: 400 }, ledger: { payoutStatus: "pending" } },
request: { status: "completed", appointmentStatus: "completed", finalCost: 400 }, appointment: { status: "completed" },
payouts: [{ amountCents: 40000, providerStatus: "paid" }] };
const before = JSON.stringify(context);
let result = compareCompletion(context);
assert.strictEqual(result.payableCents, 40000);
assert.deepStrictEqual(result.issues, ["completion_payout_cache_stale"]);
assert.strictEqual(JSON.stringify(context), before, "dry-run comparison has no mutations");
result = compareCompletion({ ...context, request: { ...context.request, finalCost: 480 }, payouts: [] });
assert.ok(result.issues.includes("request_projection_mismatch")); assert.ok(result.issues.includes("payout_amount_mismatch"));
result = compareCompletion({ ...context, appointment: { status: "completed", paymentMode: "direct", directPayment: { status: "due", amountCents: 40000 } }, payouts: [] });
assert.deepStrictEqual(result.issues, [], "direct due is a valid record, independent of platform ledger");
console.log("completion dry-run audit tests passed");
