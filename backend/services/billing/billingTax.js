const env = require("../../config/env");
const { fail } = require("./billingPolicy");
async function ensureTaxReady(stripe, customerId) {
  if (!env.billing_automatic_tax) return;
  if (!env.billing_tax_reviewed || !env.billing_tax_code) throw fail("billing_tax_review_required", "Review tax treatment and configure the service tax code before collection.");
  const [settings, registrations, customer] = await Promise.all([
    stripe.tax.settings.retrieve(), stripe.tax.registrations.list({ status: "active", limit: 100 }), stripe.customers.retrieve(customerId),
  ]);
  if (settings.status !== "active") throw fail("billing_tax_setup_required", "Stripe Tax settings are not active.");
  if (!customer.address?.country) throw fail("billing_address_required", "Update your billing card with a billing address before collection.");
  if (!(registrations.data || []).some((registration) => registration.country === customer.address.country)) throw fail("billing_tax_registration_required", "Review tax registration for this customer's country before collecting tax.");
}
module.exports = { ensureTaxReady };
