// Paid-job history per vendor, per trade -- the source of a recommendation's
// estimate.
//
//   - grouped by vendor AND trade: plumbing history never prices electrical work
//   - the trade follows routing's own fallback chain and normalizer
//   - $0 closes are excluded (warranty/goodwill is not a payment)
//   - the query is scoped to the landlord, completed requests, finalCost > 0
//   - the average is rounded to the dollar; no history -> null

const assert = require("assert");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");

let lastFilter = null;
let rows = [];
MaintenanceRequest.find = (filter) => {
  lastFilter = filter;
  return { select: () => ({ lean: async () => rows }) };
};

const { loadPaidJobTotals, paidJobEstimate, tradeKeyForRequest } = require(
  "../../../services/vendor/vendorCostHistory.service"
);

async function main() {
  rows = [
    { selectedVendorId: "v1", vendorTypeNeeded: "Plumbing", finalCost: 200 },
    { selectedVendorId: "v1", category: "Plumbing", finalCost: 301 },
    { selectedVendorId: "v1", incidentRecord: { trade: "Electrical" }, finalCost: 900 },
    { selectedVendorId: "v1", vendorTypeNeeded: "Plumbing", finalCost: 0 }, // goodwill
    { selectedVendorId: "v2", vendorTypeNeeded: "Plumbing", finalCost: 150 },
  ];
  const totals = await loadPaidJobTotals({ landlordId: "land-1", vendorIds: ["v1", "v2", "v1", null] });

  assert.strictEqual(lastFilter.landlordId, "land-1", "scoped to the landlord");
  assert.strictEqual(lastFilter.status, "completed");
  assert.deepStrictEqual(lastFilter.finalCost, { $gt: 0 });
  assert.deepStrictEqual(lastFilter.selectedVendorId.$in.sort(), ["v1", "v2"], "deduped, nulls dropped");

  assert.deepStrictEqual(totals.get("v1").get("Plumbing"), { total: 501, count: 2 }, "$0 close excluded");
  assert.deepStrictEqual(totals.get("v1").get("Electrical"), { total: 900, count: 1 });
  assert.deepStrictEqual(totals.get("v2").get("Plumbing"), { total: 150, count: 1 });

  const plumbing = paidJobEstimate({ totals, vendorId: "v1", trade: "Plumbing" });
  assert.strictEqual(plumbing.amountLow, 251, "501 / 2 rounds to 251");
  assert.strictEqual(plumbing.amountHigh, 251);
  assert.strictEqual(plumbing.basis, "paid_job_average");
  assert.strictEqual(plumbing.sampleSize, 2);
  assert.strictEqual(plumbing.confidence, "low");
  assert.strictEqual(paidJobEstimate({ totals, vendorId: "v2", trade: "Electrical" }), null);
  assert.strictEqual(paidJobEstimate({ totals, vendorId: "v9", trade: "Plumbing" }), null);
  assert.strictEqual(paidJobEstimate({ totals, vendorId: "v1", trade: null }), null);

  // Nothing to look up, no query.
  lastFilter = null;
  assert.strictEqual((await loadPaidJobTotals({ landlordId: "land-1", vendorIds: [] })).size, 0);
  assert.strictEqual(lastFilter, null);

  // Same normalizer as routing: landlord spellings resolve, unknowns don't.
  assert.strictEqual(tradeKeyForRequest({ vendorTypeNeeded: "Plumbing" }), "Plumbing");
  assert.strictEqual(tradeKeyForRequest({ ai: { suggestedVendorType: "Electrical" } }), "Electrical");

  console.log("vendorCostHistory.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
