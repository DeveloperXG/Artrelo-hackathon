const assert = require("assert");
const { bookingFunds } = require("../../../services/ledger/bookingFunds");
const funded = { available: 30000, held: 90000, bankOwed: 0, arrears: 0 };
assert.ok(bookingFunds({ amountCents: 30000, ledger: funded }).allowed,
  "credited funds count without checking Stripe's settlement balance");
assert.strictEqual(bookingFunds({ amountCents: 30001, ledger: funded }).shortfallCents, 1);
assert.ok(!bookingFunds({ amountCents: 40000, ledger: funded }).allowed, "other jobs' holds are unavailable");
assert.strictEqual(bookingFunds({ amountCents: 1, ledger: null }).shortfallCents, 1, "processing top-ups are not credit");
assert.strictEqual(bookingFunds({ amountCents: null, ledger: funded }).reasonCode, "quote_required");
assert.strictEqual(bookingFunds({ amountCents: 1, ledger: funded, externalCredits: true }).reasonCode, "funding_review_required");
assert.ok(bookingFunds({ amountCents: 1, ledger: { ...funded, platformFundingReviewedAt: new Date() }, externalCredits: true }).allowed);
assert.ok(!bookingFunds({ amountCents: 1, ledger: { ...funded, bankOwed: 100 } }).allowed, "reversed funds block a new commitment");
assert.ok(!bookingFunds({ amountCents: 1, ledger: { ...funded, arrears: 100 } }).allowed, "existing obligations come first");
assert.ok(bookingFunds({ amountCents: 0, ledger: funded }).allowed, "an explicitly free job remains free");
console.log("booking funds tests passed");
