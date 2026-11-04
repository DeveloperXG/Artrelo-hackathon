const assert = require("assert");
const { summarizeBillingRevenue } = require("../../../services/billing/billingRevenue.service");
const summary = summarizeBillingRevenue({
  assessments: [
    { landlordId: "one", source: "job", feeCents: 800, listCents: 800, invoiceId: "invoice", closedAt: "2026-10-15" },
    { landlordId: "one", source: "legacy", feeCents: 700, listCents: 700, invoiceId: null, closedAt: "2026-10-15" },
    { landlordId: "two", source: "job", feeCents: 0, listCents: 800, invoiceId: null, closedAt: "2026-10-15" },
  ],
  invoices: [
    { landlordId: "one", status: "paid", subtotalCents: 800, totalCents: 840, paidCents: 840, collectedFeeCents: 800, processingFeeCents: 60, paidAt: "2026-11-01" },
    { landlordId: "two", status: "paid", subtotalCents: 500, totalCents: 0, paidCents: 0, collectedFeeCents: 0, processingFeeCents: 0 },
  ],
  disputes: [{ openedAt: "2026-12-01", stripeCostCents: 1500 }],
});
assert.equal(summary.byMonth["2026-10"].billed, 800, "legacy fee debt was already billed in the wallet journal");
assert.equal(summary.byMonth["2026-10"].waived, 800);
assert.equal(summary.byMonth["2026-11"].collected, 800, "tax is excluded from fee revenue");
assert.equal(summary.byMonth["2026-11"].processing, 60);
assert.equal(summary.byMonth["2026-12"].disputes, 1500);
assert.equal(summary.unpaidNowCents, 700, "fully credited paid invoices leave no fee debt");
assert.equal(summary.perLandlord.find((r) => r.landlordId === "two").invoiceOwedCents, 0);
const unknown = summarizeBillingRevenue({ invoices: [{ landlordId: "one", status: "paid", subtotalCents: 800, totalCents: 800,
  paidCents: 800, collectedFeeCents: 800, processingFeeCents: null, paidAt: "2026-11-01" }] });
assert.equal(unknown.byMonth["2026-11"].unknownCosts, 1, "missing actual processing cost isn't silently called zero");
const dated = summarizeBillingRevenue({ disputes: [{ openedAt: "2026-11-01", stripeCostCents: 0, transactions: [
  { createdAt: "2026-11-01", feeCents: 1500 }, { createdAt: "2026-12-01", feeCents: -1500 },
] }] });
assert.equal(dated.byMonth["2026-11"].disputes, 1500);
assert.equal(dated.byMonth["2026-12"].disputes, -1500, "actual returned fees belong to the return month");
console.log("billing revenue tests passed");
