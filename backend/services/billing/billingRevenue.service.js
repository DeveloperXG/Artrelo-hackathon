const Assessment = require("../../models/FeeAssessment");
const Invoice = require("../../models/BillingInvoice");
const Dispute = require("../../models/BillingDispute");
function summarizeBillingRevenue({ assessments = [], invoices = [], disputes = [], range = null } = {}) {
  const byMonth = {}, perLandlord = new Map();
  const inRange = (at) => at && (!range?.from || new Date(at) >= range.from) && (!range?.to || new Date(at) <= range.to);
  const month = (at) => {
    const key = new Date(at).toISOString().slice(0, 7);
    return byMonth[key] ||= { billed: 0, collected: 0, waived: 0, jobs: 0, processing: 0, disputes: 0, unknownCosts: 0 };
  };
  const owner = (id) => {
    const key = String(id);
    if (!perLandlord.has(key)) perLandlord.set(key, { landlordId: key, invoiceCollectedCents: 0, invoiceOwedCents: 0 });
    return perLandlord.get(key);
  };
  let unpaidNowCents = 0;
  for (const fee of assessments) {
    if (!fee.invoiceId) { unpaidNowCents += fee.feeCents; owner(fee.landlordId).invoiceOwedCents += fee.feeCents; }
    if (fee.source === "legacy" || !inRange(fee.closedAt)) continue; // already billed in the old journal
    const row = month(fee.closedAt); row.billed += fee.feeCents; row.waived += fee.listCents - fee.feeCents; row.jobs++;
  }
  for (const invoice of invoices) {
    const owed = ["void", "paid"].includes(invoice.status) ? 0 : Math.max(0, invoice.totalCents - invoice.paidCents - invoice.creditedCents) + (invoice.disputedCents || 0);
    const feeOwed = ["void", "paid"].includes(invoice.status) ? 0 : invoice.totalCents > 0
      ? Math.round(owed * invoice.subtotalCents / invoice.totalCents) : ["creating", "draft"].includes(invoice.status) ? invoice.subtotalCents : 0;
    unpaidNowCents += feeOwed; owner(invoice.landlordId).invoiceOwedCents += feeOwed;
    owner(invoice.landlordId).invoiceCollectedCents += invoice.collectedFeeCents || 0;
    if (!inRange(invoice.paidAt)) continue;
    const row = month(invoice.paidAt); row.collected += invoice.collectedFeeCents || 0;
    if (invoice.processingFeeCents === null || invoice.processingFeeCents === undefined) row.unknownCosts++;
    else row.processing += invoice.processingFeeCents;
  }
  for (const dispute of disputes) {
    if (dispute.transactions?.length) {
      for (const tx of dispute.transactions) if (inRange(tx.createdAt)) month(tx.createdAt).disputes += tx.feeCents || 0;
    } else if (inRange(dispute.openedAt)) month(dispute.openedAt).disputes += dispute.stripeCostCents || 0;
  }
  return { byMonth, unpaidNowCents, perLandlord: [...perLandlord.values()] };
}
async function loadBillingRevenue(range = null) {
  const [assessments, invoices, disputes] = await Promise.all([
    Assessment.find({}).select("landlordId source invoiceId feeCents listCents closedAt").lean(),
    Invoice.find({}).select("landlordId status subtotalCents totalCents paidCents creditedCents disputedCents collectedFeeCents paidAt processingFeeCents").lean(),
    Dispute.find({}).select("openedAt stripeCostCents transactions").lean(),
  ]);
  return summarizeBillingRevenue({ assessments, invoices, disputes, range });
}
module.exports = { summarizeBillingRevenue, loadBillingRevenue };
