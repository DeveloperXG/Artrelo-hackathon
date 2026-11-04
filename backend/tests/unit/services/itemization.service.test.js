const assert = require("node:assert/strict");
const { ItemizationError, normalizeItemization, createQuoteSnapshot, itemizationContentHash,
  dollarToMinor, reconcileLegacyTotals, calculateQuoteDeltas, MAX_MINOR } = require("../../../services/quotes/itemization.service");

const fixed = () => ({ pricingMode: "fixed", currency: "CAD", items: [
  { description: "Labour", category: "labour", amountMinor: 14000 },
  { description: "P-trap", category: "materials", amountMinor: 7000 },
], totals: { lowMinor: 21000, highMinor: 21000 } });
const range = () => ({ pricingMode: "range", currency: "CAD", items: [
  { description: "Labour", category: "labour", lowMinor: 12000, highMinor: 15000 },
  { description: "Parts", category: "materials", lowMinor: 6000, highMinor: 7000 },
], totals: { lowMinor: 18000, highMinor: 22000 } });
const rejects = (work, code) => assert.throws(work, error => error instanceof ItemizationError && (!code || error.code === code));

const source = fixed();
const accepted = createQuoteSnapshot(source, { revision: 1 });
assert.equal(accepted.quoteContractVersion, 2);
assert.deepEqual(accepted.itemization.totals, { lowMinor: 21000, highMinor: 21000 });
assert.equal(new Set(accepted.itemization.items.map(line => line.lineId)).size, 2);
assert.match(accepted.hash, /^[a-f0-9]{64}$/);
assert(Object.isFrozen(accepted.itemization.items[0]));
source.items[0].amountMinor = 1;
source.totals.highMinor = 1;
assert.equal(accepted.itemization.items[0].amountMinor, 14000, "no alias to the vendor input");
assert.equal(createQuoteSnapshot(fixed(), { revision: 2 }).hash, accepted.hash, "random server IDs/revisions do not change identical content");
assert.notEqual(createQuoteSnapshot(range(), { revision: 1 }).hash, accepted.hash);
const edited = fixed(); edited.items[0].description = "More labour";
assert.notEqual(createQuoteSnapshot(edited, { revision: 1 }).hash, accepted.hash);
const reordered = fixed(); reordered.items.reverse();
assert.notEqual(createQuoteSnapshot(reordered, { revision: 1 }).hash, accepted.hash, "line order is material to referenced content");
const repriced = fixed(); repriced.items[0].amountMinor++; repriced.totals.lowMinor++; repriced.totals.highMinor++;
assert.notEqual(createQuoteSnapshot(repriced, { revision: 1 }).hash, accepted.hash);

const originalIDs = accepted.itemization.items.map(line => line.lineId);
rejects(() => normalizeItemization(accepted.itemization), "foreign_line_id");
assert.equal(itemizationContentHash(normalizeItemization(accepted.itemization, { allowedLineIds: originalIDs })), accepted.hash);
const duplicate = JSON.parse(JSON.stringify(accepted.itemization)); duplicate.items[1].lineId = duplicate.items[0].lineId;
rejects(() => normalizeItemization(duplicate, { allowedLineIds: originalIDs }), "duplicate_line_id");
const foreign = fixed(); foreign.items[0].lineId = "another-request";
rejects(() => normalizeItemization(foreign, { allowedLineIds: originalIDs }), "foreign_line_id");
assert.throws(() => normalizeItemization(fixed(), { allowedLineIds: originalIDs, allocateLineId: () => originalIDs[0] }), TypeError);
rejects(() => normalizeItemization(fixed(), { allocateLineId: () => "same-id" }), "duplicate_line_id");

for (const bad of [undefined, null, "", "14000", true, false, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
  const input = fixed(); input.items[0].amountMinor = bad;
  rejects(() => normalizeItemization(input));
}
for (const mutate of [
  x => { x.items = []; }, x => { x.items = Array(51).fill(x.items[0]); }, x => { x.items = Array(1); },
  x => { x.items[0] = null; }, x => { x.items[0].description = " "; },
  x => { x.items[0].description = "x".repeat(241); }, x => { x.items[0].category = "discount"; },
  x => { x.items[0].lowMinor = 0; }, x => { x.currency = "USD"; }, x => { x.pricingMode = "estimate"; },
  x => { x.totals.lowMinor--; }, x => { x.totals.highMinor = "21000"; }, x => { delete x.totals; },
  x => { x.extra = "ignored?"; }, x => { delete x.items[0].amountMinor; },
]) { const input = fixed(); mutate(input); rejects(() => normalizeItemization(input)); }
const inverted = range(); inverted.items[0].lowMinor = 16000;
rejects(() => normalizeItemization(inverted), "inverted_range");
const overflow = fixed(); overflow.items[0].amountMinor = MAX_MINOR; overflow.items[1].amountMinor = 1;
rejects(() => normalizeItemization(overflow), "quote_limit_exceeded");
const zero = { pricingMode: "fixed", currency: "CAD", items: [{ description: "No charge", category: "other", amountMinor: 0 }],
  totals: { lowMinor: 0, highMinor: 0 } };
assert.equal(normalizeItemization(zero).totals.highMinor, 0, "no-charge is data, not authorization to bypass later gates");
const max = fixed(); max.items = [{ description: "Bound", category: "other", amountMinor: MAX_MINOR }];
max.totals = { lowMinor: MAX_MINOR, highMinor: MAX_MINOR };
assert.equal(normalizeItemization(max).totals.highMinor, MAX_MINOR);
for (const revision of [undefined, null, 0, 6, 1.5, "1", true]) rejects(() => createQuoteSnapshot(fixed(), { revision }), "invalid_quote_revision");

assert.equal(dollarToMinor(1.15, "quote"), 115, "ordinary decimal dollars must survive binary float representation");
for (const bad of [null, "1.15", true, NaN, Infinity, -1, 1.001, 1.1500000000000001]) rejects(() => dollarToMinor(bad, "quote"));
const normalizedRange = normalizeItemization(range());
assert.deepEqual(reconcileLegacyTotals(normalizedRange, { quoteLow: 180, quoteHigh: 220 }), { quoteLow: 180, quoteHigh: 220 });
assert.deepEqual(reconcileLegacyTotals(accepted.itemization, { actualCost: 210 }), { quoteLow: 210, quoteHigh: 210 });
rejects(() => reconcileLegacyTotals(normalizedRange, { quoteLow: 180 }), "invalid_money");
rejects(() => reconcileLegacyTotals(normalizedRange, { quoteLow: 180, quoteHigh: 221 }), "quote_total_mismatch");
rejects(() => reconcileLegacyTotals(normalizedRange, { actualCost: 220 }), "quote_total_mismatch");
rejects(() => reconcileLegacyTotals(accepted.itemization, { actualCost: null }), "invalid_money");
const originalRange = { originalLowMinor: 10000, originalHighMinor: 30000, agreedMinor: 20000, finalMinor: 25000 };
const delta = calculateQuoteDeltas(originalRange);
assert.equal(delta.finalVsAgreed.amountMinor, 5000);
assert.equal(delta.finalVsAgreed.percent, 25);
assert.equal(delta.finalVsEstimate.versusHighMinor, -5000, "within old range does not erase an overage against the agreement");
assert.equal(calculateQuoteDeltas({ finalMinor: 100 }).finalVsAgreed, null, "missing agreement is unknown, not zero or range midpoint");
assert.equal(calculateQuoteDeltas({ agreedMinor: 0, finalMinor: 100 }).finalVsAgreed.percent, null);
assert.equal(calculateQuoteDeltas({ agreedMinor: 100, finalMinor: 0 }).finalVsAgreed.percent, -100);
rejects(() => calculateQuoteDeltas({ originalLowMinor: 0 }), "incomplete_estimate_basis");
rejects(() => calculateQuoteDeltas({ originalLowMinor: 2, originalHighMinor: 1 }), "inverted_range");
rejects(() => calculateQuoteDeltas({ agreedMinor: true }), "invalid_money");
console.log("Itemization: strict money/range reconciliation, owned IDs, stable immutable snapshots and grounded deltas PASS");
