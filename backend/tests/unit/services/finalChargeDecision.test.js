const assert = require("node:assert/strict");
const { validateFinalChargeDecision } = require("../../../services/quotes/financialReview.service");
const completion = { quoteContractVersion: 2, report: { finalStatement: { revision: 1, hash: "current" } } };
const approval = { amountRequested: 194.37, payload: { quoteRevision: 1, quoteHash: "current" } };
const body = { status: "approved", expectedQuoteRevision: 1, expectedQuoteHash: "current", approvedAmount: 194.37 };
validateFinalChargeDecision({ completion, approval, body });
validateFinalChargeDecision({ completion, approval, body: { status: "approved", expectedQuoteRevision: 1, expectedQuoteHash: "current" } });
for (const value of [194.375, "194.37", null, false, NaN, Infinity, -1, 0]) {
  assert.throws(() => validateFinalChargeDecision({ completion, approval, body: { ...body, approvedAmount: value } }), error => error.statusCode === 400);
}
for (const value of [{ ...body, expectedQuoteRevision: 2 }, { ...body, expectedQuoteHash: "old" }, { status: "rejected" }]) {
  assert.throws(() => validateFinalChargeDecision({ completion, approval, body: value }), error => error.statusCode === 409);
}
validateFinalChargeDecision({ completion: {}, approval: {}, body: { status: "approved" } });
console.log("Final-charge authorization: exact immutable context, strict positive CAD cents and legacy compatibility PASS");
