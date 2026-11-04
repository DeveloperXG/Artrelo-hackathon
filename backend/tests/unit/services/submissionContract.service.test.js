const assert = require("node:assert/strict");
const { initialQuote, finalStatement } = require("../../../services/quotes/submissionContract.service");
const input = () => ({ pricingMode: "fixed", currency: "CAD", items: [
  { description: "Repair", category: "labour", amountMinor: 21000 },
], totals: { lowMinor: 21000, highMinor: 21000 } });
const resource = { quoteContractVersion: 2 };
const body = () => ({ itemization: input(), expectedRevision: 0 });
assert.equal(initialQuote({ bookingVersion: 2 }, { quoteLow: 1, quoteHigh: 2 }), null, "booking version cannot opt legacy links into the new contract");
assert.throws(() => initialQuote({}, body()), error => error.code === "itemization_not_enabled");
for (const invalid of [undefined, null, true, "0", 1]) {
  assert.throws(() => initialQuote(resource, { ...body(), expectedRevision: invalid }), error => error.status === 409);
}
assert.throws(() => initialQuote(resource, { expectedRevision: 0 }), "omitting a client version cannot bypass server-required items");
assert.throws(() => initialQuote(resource, { ...body(), quoteContractVersion: 1 }));
const quote = initialQuote(resource, body());
assert.equal(quote.quoteLow, 210); assert.equal(quote.quoteHigh, 210); assert.equal(quote.snapshot.revision, 1);
assert.throws(() => initialQuote(resource, { ...body(), quoteLow: 200, quoteHigh: 210 }), error => error.code === "quote_total_mismatch");
assert.throws(() => initialQuote(resource, { ...body(), quoteLow: "210", quoteHigh: 210 }), error => error.code === "invalid_money");
const final = finalStatement(resource, { ...body(), invoiceReference: " INV-001 " });
assert.equal(final.actualCost, 210); assert.equal(final.invoiceReference, "INV-001");
assert.equal(final.finalStatement.hash, quote.snapshot.hash);
assert.throws(() => finalStatement(resource, { ...body(), actualCost: 211 }), error => error.code === "quote_total_mismatch");
assert.throws(() => finalStatement(resource, { ...body(), invoiceReference: true }));
const range = body(); range.itemization.pricingMode = "range";
range.itemization.items = [{ description: "Repair", category: "labour", lowMinor: 21000, highMinor: 21000 }];
assert.throws(() => finalStatement(resource, range), error => error.code === "final_statement_must_be_fixed");
console.log("Submission contracts: server version/revision, legacy preservation and exact final totals PASS");
