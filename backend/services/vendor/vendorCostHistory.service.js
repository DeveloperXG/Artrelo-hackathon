// What a vendor has actually been paid, per trade -- the estimate shown on a
// recommendation.
//
// The estimate used to be invented: hourlyRate .. hourlyRate + 75. No form sets
// hourlyRate, so every new vendor read "$0-75". Now a vendor with no paid
// history for this trade has NO estimate (null), and one with history shows
// the average of what they were paid for that trade.
//
// Derived on read rather than kept as a counter. A completed request with a
// selectedVendorId and finalCost > 0 already IS a paid job: both close paths
// write finalCost at the point money is released (closeJobCompletion before
// releaseHold, putMarkRequestCompleted before settleManualCompletion). So no
// schema change, no backfill, no counter to drift, and a corrected cost is
// reflected immediately.
//
// $0 closes are excluded: a warranty or goodwill job is not a payment, and
// would drag the average toward zero.
//
// Scoped to the landlord: one landlord's prices never inform another's.

const MaintenanceRequest = require("../../models/MaintenanceRequest");
const { resolveNeededCategory } = require("./vendorScoring.service");

/** The trade a request was routed under -- the same fallback chain as
 *  buildRequestContext, through the same normalizer routing matches on. */
function tradeKeyForRequest(request = {}) {
  return (
    resolveNeededCategory({
      vendorTypeNeeded:
        request.vendorTypeNeeded || request.incidentRecord?.trade || request.ai?.suggestedVendorType || null,
      category: request.category,
    }) || null
  );
}

/**
 * Map<vendorId, Map<tradeKey, { total, count }>> for the given vendors.
 * One query, however many vendors.
 */
async function loadPaidJobTotals({ landlordId, vendorIds = [] }) {
  const ids = [...new Set(vendorIds.filter(Boolean).map(String))];
  const totals = new Map();
  if (!ids.length) return totals;

  const rows = await MaintenanceRequest.find({
    landlordId,
    selectedVendorId: { $in: ids },
    status: "completed",
    finalCost: { $gt: 0 },
  })
    .select("selectedVendorId vendorTypeNeeded category incidentRecord.trade ai.suggestedVendorType finalCost")
    .lean();

  for (const row of rows) {
    const trade = tradeKeyForRequest(row);
    const cost = Number(row.finalCost);
    if (!trade || !Number.isFinite(cost) || cost <= 0) continue;
    const vendorId = String(row.selectedVendorId);
    if (!totals.has(vendorId)) totals.set(vendorId, new Map());
    const byTrade = totals.get(vendorId);
    const entry = byTrade.get(trade) || { total: 0, count: 0 };
    entry.total += cost;
    entry.count += 1;
    byTrade.set(trade, entry);
  }
  return totals;
}

/**
 * The estimate for one vendor on one trade, or null with no paid history.
 * Shaped like a provider price estimate so every reader handles it unchanged.
 */
function paidJobEstimate({ totals, vendorId, trade, providerVendorId = null }) {
  const entry = vendorId && trade ? totals.get(String(vendorId))?.get(trade) : null;
  if (!entry || !entry.count) return null;
  const average = Math.round(entry.total / entry.count);
  return {
    providerName: "preset",
    providerVendorId,
    amountLow: average,
    amountHigh: average,
    currency: "CAD",
    basis: "paid_job_average",
    sampleSize: entry.count,
    confidence: entry.count >= 3 ? "medium" : "low",
    summary: `Average of ${entry.count} paid ${trade} job${entry.count === 1 ? "" : "s"}`,
  };
}

module.exports = { tradeKeyForRequest, loadPaidJobTotals, paidJobEstimate };
