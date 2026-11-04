const mongoose = require("mongoose");
const crypto = require("crypto");
const env = require("../../config/env");
const Landlord = require("../../models/Landlord");
const Account = require("../../models/BillingAccount");
const Setup = require("../../models/BillingSetup");
const Invoice = require("../../models/BillingInvoice");
const stripeConfig = require("../../config/stripe");
const email = require("../notification/email.service");
const { resolveRate, isZeroRate } = require("../ledger/serviceFee");
const { ensureStripeCustomer } = require("../ledger/payoutProvider.service");
const { isBetaActive } = require("../beta/beta.service");
const { describeFee } = require("../../config/beta");
const { NOTICE_DAYS, DAY, offerVersion, readiness, fail } = require("./billingPolicy");

async function getAccount(landlordId) {
  try { return await Account.findOneAndUpdate({ landlordId }, { $setOnInsert: { landlordId } }, { upsert: true, new: true }); }
  catch (error) { if (error.code !== 11000) throw error; return Account.findOne({ landlordId }); }
}
async function issueNotice(landlordId) {
  const landlord = await Landlord.findById(landlordId).lean();
  if (!landlord) throw fail("not_found", "Landlord not found", 404);
  const { rate, source } = resolveRate(landlord);
  if (isZeroRate(rate)) throw fail("rate_not_configured", "Configure and review the published service fee before sending a notice.");
  const account = await getAccount(landlordId);
  const version = offerVersion(rate);
  if (account.offer?.version && account.offer.version !== version) throw fail("offer_locked", "An offer already exists. Changing accepted pricing requires a separate reviewed migration.");
  if (account.offer?.noticeSentAt) return account;
  await Account.updateOne({ _id: account._id }, { $set: { offer: { version, rate, rateSource: source, createdAt: account.offer?.createdAt || new Date() } } });
  const url = `${String(env.app_public_url || "").replace(/\/$/, "")}/dashboard/billing`;
  const sent = await email.sendEmail({ to: landlord.email, subject: "Your Artrelo service fee and monthly billing",
    text: `Your Artrelo service fee is ${describeFee(rate)} plus applicable tax. It applies when a job is verified complete, whether you pay the vendor directly or use platform payouts. We collect these fees in one itemized monthly invoice using the billing card you authorize. There is no subscription or monthly minimum. Your beta remains free. No charges begin before your beta ends, at least ${NOTICE_DAYS} days after this notice, and after you explicitly accept this pricing and save a billing card. Existing bookings without this authorization remain free of new billing fees. Failed payments have a 14-day grace period before new non-emergency bookings and outreach pause; existing jobs, payments, account access and emergency alerts remain available. Review your terms: ${url}`,
    categories: ["billing_price_notice"] });
  if (!sent.delivered) throw fail("notice_not_delivered", "The notice was not delivered; the paid-billing notice period has not started.", 502);
  const at = new Date();
  await Account.updateOne({ _id: account._id, "offer.noticeSentAt": null }, { $set: {
    "offer.noticeSentAt": at, "offer.effectiveAt": new Date(at.getTime() + NOTICE_DAYS * DAY) } });
  return Account.findById(account._id);
}
async function acceptPricing(landlordId, version, ip = "") {
  const landlord = await Landlord.findById(landlordId).lean();
  if (isBetaActive(landlord?.beta)) throw fail("beta_active", "Your beta is free. Paid billing setup opens after it ends.");
  const account = await getAccount(landlordId);
  if (!account.offer?.noticeSentAt || version !== account.offer.version) throw fail("billing_offer_changed", "Reload billing and review the current fee before accepting.");
  if (account.agreement?.acceptedAt && account.agreement.version === version) return account;
  const at = new Date();
  await mongoose.connection.transaction(async (session) => {
    const current = await Account.findById(account._id).session(session);
    if (current?.agreement?.version === version && current.agreement.acceptedAt) return;
    const updated = await Account.findOneAndUpdate({ _id: account._id, "offer.version": version }, { $set: {
      agreement: { version, rate: account.offer.rate, rateSource: account.offer.rateSource, acceptedAt: at,
        ipHash: crypto.createHash("sha256").update(String(ip)).digest("hex") }, cutoverAt: account.cutoverAt || at } }, { session });
    if (!updated) throw fail("billing_offer_changed", "Reload the billing offer before accepting.");
    await Landlord.updateOne({ _id: landlordId, serviceBillingEnabledAt: null }, { $set: { serviceBillingEnabledAt: at } }, { session });
  });
  return Account.findById(account._id);
}
async function customerFor(landlordId) {
  const landlord = await Landlord.findById(landlordId).lean();
  if (landlord.stripeCustomerId) return landlord.stripeCustomerId;
  const id = await ensureStripeCustomer({ landlordId, email: landlord.email, name: `${landlord.firstName} ${landlord.lastName}` });
  if (!id) throw fail("stripe_unavailable", "Billing is not configured yet.", 503);
  await Landlord.updateOne({ _id: landlordId, stripeCustomerId: null }, { $set: { stripeCustomerId: id } });
  return (await Landlord.findById(landlordId).select("stripeCustomerId").lean()).stripeCustomerId;
}
async function setupCard(landlordId, attempt) {
  if (!env.service_billing_enabled) throw fail("billing_disabled", "Paid billing is not active yet.");
  if (!/^[A-Za-z0-9-]{8,80}$/.test(attempt || "")) throw fail("invalid_attempt", "Please retry billing setup.", 400);
  const account = await getAccount(landlordId);
  if (!account.agreement?.acceptedAt) throw fail("billing_consent_required", "Accept the displayed fee and automatic billing terms first.");
  const stripe = stripeConfig.getStripe(), configurationId = env.stripe_billing_payment_method_configuration_id;
  if (!stripe || !configurationId) throw fail("billing_configuration_pending", "Billing card setup is not configured yet.", 503);
  const configuration = await stripe.paymentMethodConfigurations.retrieve(configurationId);
  // Card-only billing configuration is separate from wallet PAD. Fail closed
  // if a dashboard change would offer another method on this setup flow.
  if (configuration.card?.available !== true || configuration.card?.display_preference?.value !== "on") throw fail("billing_configuration_pending", "The billing card configuration is unavailable.", 503);
  for (const [key, value] of Object.entries(configuration)) {
    if (key !== "card" && value && typeof value === "object" && value.available === true && value.display_preference?.value === "on") throw fail("billing_configuration_pending", "The billing configuration must offer only cards.", 503);
  }
  const customerId = await customerFor(landlordId);
  let setup;
  try { setup = await Setup.findOneAndUpdate({ landlordId, attempt }, { $setOnInsert: { landlordId, attempt, customerId } }, { upsert: true, new: true }); }
  catch (error) { if (error.code !== 11000) throw error; setup = await Setup.findOne({ landlordId, attempt }); }
  if (setup.customerId !== customerId) throw fail("customer_changed", "Reload before updating your billing card.");
  if (setup.checkoutSessionId) {
    const existing = await stripe.checkout.sessions.retrieve(setup.checkoutSessionId);
    if (existing.status === "open") return { url: existing.url };
    throw fail("setup_finished", "Reload billing before starting another card update.");
  }
  const base = String(env.app_public_url || "").replace(/\/$/, "");
  // Recover a response lost before the local session ID was recorded.
  for await (const prior of stripe.checkout.sessions.list({ customer: customerId, limit: 100 })) {
    if (prior.metadata?.artreloBillingSetup !== String(setup._id)) continue;
    await Setup.updateOne({ _id: setup._id }, { $set: { checkoutSessionId: prior.id } });
    if (prior.status === "open") return { url: prior.url };
    throw fail("setup_finished", "Reload billing before starting another card update.");
  }
  if (Date.now() - setup.createdAt.getTime() > 23 * 3600_000) throw fail("setup_review_required", "Start a new card setup after reviewing the expired attempt.");
  const label = Array.from(crypto.createHash("sha256").update(String(setup._id)).digest().subarray(0, 8), byte => String.fromCharCode(97 + byte % 26)).join("");
  const session = await stripe.checkout.sessions.create({ mode: "setup", customer: customerId,
    managed_payments: { enabled: false },
    payment_method_configuration: configurationId, currency: "cad",
    integration_identifier: `artrelo_billing_${label}`,
    metadata: { artreloPurpose: "service_billing_setup", artreloBillingSetup: String(setup._id) },
    ...(env.billing_automatic_tax ? { billing_address_collection: "required", customer_update: { address: "auto" } } : {}),
    setup_intent_data: { metadata: { artreloPurpose: "service_billing_setup", artreloBillingSetup: String(setup._id) } },
    success_url: `${base}/dashboard/billing?setup=complete`, cancel_url: `${base}/dashboard/billing?setup=canceled`,
  }, { idempotencyKey: `billing_setup:${setup._id}` });
  await Setup.updateOne({ _id: setup._id }, { $set: { checkoutSessionId: session.id } });
  return { url: session.url };
}
async function syncSetup(setupIntentOrId) {
  const stripe = stripeConfig.getStripe();
  const id = typeof setupIntentOrId === "string" ? setupIntentOrId : setupIntentOrId.id;
  const intent = await stripe.setupIntents.retrieve(id, { expand: ["payment_method"] });
  if (intent.metadata?.artreloPurpose !== "service_billing_setup") return { ignored: true };
  if (!/^[a-f0-9]{24}$/.test(intent.metadata.artreloBillingSetup || "")) return { ignored: true };
  const setup = await Setup.findById(intent.metadata.artreloBillingSetup);
  if (!setup || intent.customer !== setup.customerId) throw fail("setup_ownership_mismatch", "Billing setup ownership mismatch");
  if (intent.status !== "succeeded" || setup.completedAt) return { ignored: false };
  const method = intent.payment_method;
  if (method?.type !== "card" || method.customer !== setup.customerId) throw fail("billing_card_required", "A customer-owned card is required for billing.");
  // A delayed webhook from an older setup must not replace a newer card.
  const saved = await Account.updateOne({ landlordId: setup.landlordId, "agreement.acceptedAt": { $exists: true },
    $or: [{ "card.setupStartedAt": null }, { "card.setupStartedAt": { $lt: setup.createdAt } },
      { "card.setupStartedAt": setup.createdAt, "card.setupRef": { $lte: String(setup._id) } }] }, { $set: {
      card: { paymentMethodId: method.id, brand: method.card.brand, last4: method.card.last4,
        setupIntentId: id, savedAt: new Date(), setupStartedAt: setup.createdAt, setupRef: String(setup._id) } } });
  await Setup.updateOne({ _id: setup._id }, { $set: { setupIntentId: id, completedAt: new Date() } });
  if (saved.modifiedCount) await require("./invoiceCollection.service").retryOpenInvoices(setup.landlordId, method.id);
  return { ignored: false };
}
async function bookingSnapshot({ landlordId, request, session = null, now = new Date() }) {
  if (!env.service_billing_enabled) return undefined;
  const load = (query) => session ? query.session(session).lean() : query.lean();
  const landlord = await load(Landlord.findById(landlordId));
  const account = session
    ? await Account.findOneAndUpdate({ landlordId }, { $inc: { version: 1 } }, { session, new: true }).lean()
    : await Account.findOne({ landlordId }).lean();
  const failed = await load(Invoice.findOne({ landlordId, status: { $in: ["open", "uncollectible", "disputed"] }, firstFailedAt: { $ne: null } }).sort({ firstFailedAt: 1 }));
  const gate = readiness({ landlord, account, failedAt: failed?.firstFailedAt, now,
    emergency: require("../vendor/vendorOutreachPolicy.service").resolveOutreachTier(request) === "emergency",
    enabled: env.service_billing_enabled, taxReviewed: env.billing_tax_reviewed });
  if (!gate.allowed) throw fail(gate.reason, gate.reason === "billing_past_due"
    ? "Your Artrelo invoice is overdue. Update your billing card or pay the invoice to resume new non-emergency bookings."
    : "Review your Artrelo billing terms and add a billing card before starting new paid bookings.");
  return { managed: true, chargeable: gate.chargeable, waivedReason: gate.reason,
    rate: account?.agreement?.rate || account?.offer?.rate || resolveRate(landlord).rate,
    agreementVersion: account?.agreement?.version || null, rateSource: account?.agreement?.rateSource || null, bookedAt: now };
}
module.exports = { getAccount, issueNotice, acceptPricing, customerFor, setupCard, syncSetup, bookingSnapshot };
