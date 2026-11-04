const assert = require("assert");
const env = require("../../../config/env");
const { ensureTaxReady } = require("../../../services/billing/billingTax");
const fixture = { settings: { status: "active" }, registrations: { data: [{ country: "CA" }] }, customer: { address: { country: "CA" } } };
const stripe = { tax: { settings: { retrieve: async () => fixture.settings }, registrations: { list: async () => fixture.registrations } }, customers: { retrieve: async () => fixture.customer } };
async function main() {
  env.billing_automatic_tax = false; await ensureTaxReady(null, "cus_test");
  env.billing_automatic_tax = true; env.billing_tax_reviewed = false;
  await assert.rejects(ensureTaxReady(stripe, "cus_test"), (e) => e.code === "billing_tax_review_required");
  env.billing_tax_reviewed = true; env.billing_tax_code = "txcd_reviewed_fixture";
  fixture.registrations = { data: [] };
  await assert.rejects(ensureTaxReady(stripe, "cus_test"), (e) => e.code === "billing_tax_registration_required");
  fixture.registrations = { data: [{ country: "CA" }] }; fixture.customer.address = null;
  await assert.rejects(ensureTaxReady(stripe, "cus_test"), (e) => e.code === "billing_address_required");
  fixture.customer.address = { country: "CA" }; await ensureTaxReady(stripe, "cus_test");
  console.log("billing tax gates passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
