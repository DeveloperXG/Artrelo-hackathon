const env = require("../../config/env");
const Landlord = require("../../models/Landlord");
const Account = require("../../models/BillingAccount");
const Assessment = require("../../models/FeeAssessment");
const Invoice = require("../../models/BillingInvoice");
const { isBetaActive } = require("../beta/beta.service");
const { readiness } = require("./billingPolicy");
async function billingSummary(landlordId) {
  const [landlord, account, accrued, invoices] = await Promise.all([
    Landlord.findById(landlordId).select("beta paymentMode").lean(), Account.findOne({ landlordId }).lean(),
    Assessment.find({ landlordId, invoiceId: null }).sort({ closedAt: -1 }).limit(200).lean(),
    Invoice.find({ landlordId }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  if (!landlord) throw require("./billingPolicy").fail("not_found", "Landlord not found", 404);
  const oldestFailure = await Invoice.findOne({ landlordId, status: { $in: ["open", "uncollectible", "disputed"] }, firstFailedAt: { $ne: null } }).sort({ firstFailedAt: 1 }).select("firstFailedAt").lean();
  const totals = await Assessment.aggregate([{ $match: { landlordId: landlord._id, invoiceId: null } },
    { $group: { _id: null, accruedCents: { $sum: "$feeCents" }, waivedCents: { $sum: { $cond: [{ $eq: ["$feeCents", 0] }, "$listCents", 0] } } } }]);
  const state = readiness({ landlord, account, failedAt: oldestFailure?.firstFailedAt,
    enabled: env.service_billing_enabled, taxReviewed: env.billing_tax_reviewed });
  return { currency: "CAD", enabled: Boolean(env.service_billing_enabled), collectionEnabled: Boolean(env.service_billing_collection_enabled), betaActive: isBetaActive(landlord.beta), betaEndsAt: landlord.beta?.endsAt || null,
    offer: account?.offer?.version ? { version: account.offer.version, rate: account.offer.rate,
      noticeSentAt: account.offer.noticeSentAt || null, effectiveAt: account.offer.effectiveAt || null } : null,
    agreement: account?.agreement?.acceptedAt ? { version: account.agreement.version, rate: account.agreement.rate, acceptedAt: account.agreement.acceptedAt } : null,
    card: account?.card?.paymentMethodId ? { brand: account.card.brand, last4: account.card.last4 } : null,
    hasDisputedInvoice: invoices.some((invoice) => invoice.status === "disputed"),
    readiness: state, firstFailedAt: oldestFailure?.firstFailedAt || null,
    accruedCents: totals[0]?.accruedCents || 0, waivedCents: totals[0]?.waivedCents || 0,
    assessments: accrued.map((a) => ({ ref: String(a._id), jobRef: a.appointmentId ? String(a.appointmentId).slice(-6).toUpperCase() : null,
      source: a.source, feeCents: a.feeCents, listCents: a.listCents, waivedReason: a.waivedReason, closedAt: a.closedAt })),
    invoices: invoices.map((i) => ({ ref: String(i._id), period: i.period, status: i.status, totalCents: i.totalCents,
      subtotalCents: i.subtotalCents, paidCents: i.paidCents, creditedCents: i.creditedCents,
      disputedCents: i.disputedCents, refundedCents: i.refundedCents, hostedUrl: i.hostedUrl || null, pdfUrl: i.pdfUrl || null })),
  };
}
module.exports = { billingSummary };
