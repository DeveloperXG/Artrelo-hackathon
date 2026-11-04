const mongoose = require("mongoose");
const env = require("../../config/env");
const config = require("../../config/stripe");
const Landlord = require("../../models/Landlord");
const Account = require("../../models/BillingAccount");
const Assessment = require("../../models/FeeAssessment");
const Invoice = require("../../models/BillingInvoice");
const Dispute = require("../../models/BillingDispute");
const Setup = require("../../models/BillingSetup");
const { periodStart, fail } = require("./billingPolicy");
const { publish } = require("../realtime/liveEvents.service");
const { notifyUser } = require("../notification/notify.service");
const idOf = (v) => typeof v === "string" ? v : v?.id;

async function syncInvoice(stripeInvoiceId, { failedAt = null } = {}) {
  if (!/^in_[A-Za-z0-9_]+$/.test(stripeInvoiceId || "")) return { ignored: true };
  const row = await Invoice.findOne({ stripeInvoiceId });
  if (!row) return { ignored: true };
  const stripe = config.getStripe();
  const invoice = await stripe.invoices.retrieve(stripeInvoiceId);
  if (idOf(invoice.customer) !== row.customerId || invoice.currency !== "cad") throw fail("invoice_ownership_mismatch", "Invoice ownership mismatch");
  let cash = 0, refunded = 0, processing = 0, feesKnown = true;
  for await (const payment of stripe.invoicePayments.list({ invoice: stripeInvoiceId, status: "paid", limit: 100 })) {
    const piId = idOf(payment.payment?.payment_intent);
    if (!piId) continue; // Manual/out-of-band records are not confirmed Stripe cash.
    const intent = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge.balance_transaction"] });
    if (idOf(intent.customer) !== row.customerId || intent.status !== "succeeded") continue;
    cash += payment.amount_paid || 0;
    const charge = intent.latest_charge;
    refunded += Math.min(payment.amount_paid || 0, charge?.amount_refunded || 0);
    if (Number.isSafeInteger(charge?.balance_transaction?.fee)) processing += charge.balance_transaction.fee;
    else feesKnown = false;
  }
  // Recover a missed failure webhook from Stripe's attempted-but-unpaid state.
  // Start grace at observation time if the exact failure event was unavailable.
  const observedFailure = failedAt || (["open", "uncollectible"].includes(invoice.status) && invoice.attempted &&
    (invoice.amount_remaining ?? invoice.total - invoice.amount_paid) > 0 ? new Date() : null);
  let fields, newFailure = false;
  await mongoose.connection.transaction(async (session) => {
    await Account.findOneAndUpdate({ landlordId: row.landlordId }, { $inc: { version: 1 } }, { session });
    const current = await Invoice.findById(row._id).session(session);
    const disputes = await Dispute.find({ invoiceId: row._id }).session(session).lean();
    const disputed = disputes.reduce((n, d) => n + (d.outstandingCents || 0), 0);
    const firstDispute = disputes.filter((d) => d.outstandingCents > 0).sort((a, b) => a.openedAt - b.openedAt)[0];
    const failure = [current.firstFailedAt, observedFailure, firstDispute?.openedAt].filter(Boolean).map((v) => new Date(v)).sort((a, b) => a - b)[0];
    const received = Math.max(current.cashCollectedCents || 0, cash);
    const returned = Math.max(current.refundedCents || 0, refunded);
    let status = disputed > 0 ? "disputed" : invoice.status;
    const staleDraft = current.status === "paid" && ["open", "draft"].includes(invoice.status);
    const total = staleDraft ? current.totalCents : (invoice.total || 0);
    // A delayed pre-payment read cannot reopen an already paid invoice. Actual
    // dispute debt is recomputed under the same lock as dispute updates.
    if (disputed === 0 && current.status === "paid" && ["open", "draft"].includes(status)) status = "paid";
    fields = { status, totalCents: total, paidCents: Math.max(current.paidCents || 0, invoice.amount_paid || 0),
      cashCollectedCents: received, refundedCents: returned, disputedCents: disputed,
      creditedCents: Math.max(current.creditedCents || 0, (invoice.pre_payment_credit_notes_amount || 0) + (invoice.post_payment_credit_notes_amount || 0)),
      collectedFeeCents: total > 0 ? Math.max(0, Math.min(row.subtotalCents,
        Math.round(Math.max(0, received - returned - disputed) * row.subtotalCents / total))) : 0,
      hostedUrl: invoice.hosted_invoice_url || current.hostedUrl || null, pdfUrl: invoice.invoice_pdf || current.pdfUrl || null,
      checkedAt: new Date(), ...(failure ? { firstFailedAt: failure } : {}),
      ...(invoice.status_transitions?.paid_at ? { paidAt: new Date(invoice.status_transitions.paid_at * 1000) } : {}),
      ...(cash >= (current.cashCollectedCents || 0) ? { processingFeeCents: feesKnown ? processing : null } : {}),
    };
    newFailure = Boolean(failure && !current.firstFailedAt && ["open", "uncollectible", "disputed"].includes(status));
    await Invoice.updateOne({ _id: row._id }, { $set: fields }, { session });
  });
  publish(row.landlordId, "billing");
  if (newFailure) {
    await notifyUser({ userId: row.landlordId, type: "payment_overdue", title: "Your Artrelo invoice needs attention",
      message: fields.status === "disputed"
        ? "A disputed invoice needs review with Artrelo support. We do not automatically charge the disputed amount again. After 14 days unpaid, new non-emergency bookings and outreach pause; existing jobs and emergency alerts continue."
        : "Update your billing card or pay the invoice from Billing. After 14 days unpaid, new non-emergency bookings and outreach pause. Your existing jobs, vendor payments and emergency alerts continue.",
      metadata: { invoiceId: String(row._id), actionUrl: "/dashboard/billing" } });
  }
  return { ignored: false, ...fields };
}

async function invoiceForIntent(piId) {
  const stripe = config.getStripe();
  if (!piId) return null;
  for await (const payment of stripe.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: piId }, limit: 100 })) {
    const row = await Invoice.findOne({ stripeInvoiceId: idOf(payment.invoice) });
    if (row) return { row, payment };
  }
  return null;
}
async function syncDispute(disputeId) {
  const stripe = config.getStripe();
  const dispute = await stripe.disputes.retrieve(disputeId, { expand: ["charge"] });
  const piId = idOf(dispute.payment_intent) || idOf(dispute.charge?.payment_intent);
  const match = await invoiceForIntent(piId);
  if (!match) return { ignored: true };
  await mongoose.connection.transaction(async (session) => {
    await Account.findOneAndUpdate({ landlordId: match.row.landlordId }, { $inc: { version: 1 } }, { session });
    const prior = await Dispute.findOne({ disputeId }).session(session).lean();
    const transactions = new Map((prior?.transactions || []).map((tx) => [tx.id, tx]));
    for (const tx of dispute.balance_transactions || []) if (tx.id) transactions.set(tx.id, { id: tx.id, amountCents: tx.amount, feeCents: tx.fee || 0, createdAt: new Date((tx.created || dispute.created) * 1000) });
    const all = [...transactions.values()];
    const withdrawn = all.reduce((n, tx) => n + Math.max(0, -tx.amountCents), 0);
    const returned = all.reduce((n, tx) => n + Math.max(0, tx.amountCents), 0);
    await Dispute.findOneAndUpdate({ disputeId }, { $set: { invoiceId: match.row._id, landlordId: match.row.landlordId,
      status: dispute.status, openedAt: new Date(dispute.created * 1000), checkedAt: new Date(), transactions: all,
      outstandingCents: Math.min(match.payment.amount_paid || 0, Math.max(0, withdrawn - returned)),
      stripeCostCents: all.reduce((n, tx) => n + tx.feeCents, 0) } }, { session, upsert: true });
  });
  await syncInvoice(match.row.stripeInvoiceId);
  return { ignored: false };
}

async function createMonthlyInvoice(landlordId, now = new Date()) {
  if (!env.service_billing_collection_enabled || !env.billing_tax_reviewed) return null;
  const stripe = config.getStripe(); if (!stripe) throw fail("stripe_unavailable", "Stripe is unavailable");
  const cutoff = periodStart(now), period = cutoff.toISOString().slice(0, 7);
  let row;
  await mongoose.connection.transaction(async (session) => {
    const account = await Account.findOneAndUpdate({ landlordId }, { $inc: { version: 1 } }, { session, new: true });
    if (!account?.agreement?.acceptedAt || !account.card?.paymentMethodId || !account.offer?.effectiveAt || account.offer.effectiveAt > now) return;
    const landlord = await Landlord.findById(landlordId).session(session);
    if (landlord?.beta?.endsAt > now) return;
    row = await Invoice.findOne({ landlordId, period }).session(session);
    if (row) return;
    const assessments = await Assessment.find({ landlordId, invoiceId: null, feeCents: { $gt: 0 }, closedAt: { $lt: cutoff } }).session(session);
    const subtotalCents = assessments.reduce((n, a) => n + a.feeCents, 0);
    if (subtotalCents < 50) return; // Carry small amounts; never forgive or charge below Stripe's minimum.
    const [created] = await Invoice.create([{ landlordId, period, customerId: landlord.stripeCustomerId, subtotalCents }], { session });
    row = created;
    await Assessment.updateMany({ _id: { $in: assessments.map((a) => a._id) }, invoiceId: null }, { $set: { invoiceId: row._id } }, { session });
  });
  if (row && ["creating", "draft"].includes(row.status)) await finishInvoice(row._id);
  return row;
}
async function finishInvoice(id) {
  if (!env.service_billing_collection_enabled || !env.billing_tax_reviewed) return;
  const stripe = config.getStripe(), row = await Invoice.findById(id);
  const account = await Account.findOne({ landlordId: row.landlordId }).lean();
  if (!account?.card?.paymentMethodId) throw fail("billing_card_required", "Billing card needed before collection");
  let invoice;
  if (row.stripeInvoiceId) invoice = await stripe.invoices.retrieve(row.stripeInvoiceId);
  else {
    for await (const item of stripe.invoices.list({ customer: row.customerId, limit: 100 })) {
      if (item.metadata?.artreloBillingInvoice === String(row._id)) { invoice = item; break; }
    }
    if (!invoice) {
      if (Date.now() - row.createdAt.getTime() > 23 * 3600_000) throw fail("invoice_creation_review", "Review the unresolved invoice creation before retrying beyond Stripe's key window");
      await require("./billingTax").ensureTaxReady(stripe, row.customerId);
      invoice = await stripe.invoices.create({ customer: row.customerId, currency: "cad", collection_method: "charge_automatically",
        auto_advance: false, pending_invoice_items_behavior: "exclude", default_payment_method: account.card.paymentMethodId,
        automatic_tax: { enabled: Boolean(env.billing_automatic_tax) },
        description: "Artrelo service fees for verified completed jobs", metadata: { artreloPurpose: "service_billing", artreloBillingInvoice: String(row._id) } },
      { idempotencyKey: `billing_invoice:${row._id}` });
    }
    if (idOf(invoice.customer) !== row.customerId) throw fail("invoice_ownership_mismatch", "Invoice customer mismatch");
    await Invoice.updateOne({ _id: row._id }, { $set: { stripeInvoiceId: invoice.id, status: invoice.status } });
  }
  if (invoice.status === "draft") {
    const existing = new Map();
    for await (const item of stripe.invoiceItems.list({ invoice: invoice.id, limit: 100 })) {
      if (item.metadata?.artreloAssessment) existing.set(item.metadata.artreloAssessment, item);
    }
    const assessments = await Assessment.find({ invoiceId: row._id });
    for (const assessment of assessments) {
      let item = existing.get(String(assessment._id));
      if (item && item.amount !== assessment.feeCents) throw fail("invoice_item_mismatch", "Review the changed invoice line amount");
      if (!item) item = await stripe.invoiceItems.create({ customer: row.customerId, invoice: invoice.id, currency: "cad", amount: assessment.feeCents,
        ...(env.billing_automatic_tax ? { tax_behavior: "exclusive", tax_code: env.billing_tax_code } : {}),
        description: assessment.source === "legacy" ? "Previously outstanding Artrelo service fees" : `Artrelo fee — job ${String(assessment.appointmentId).slice(-6).toUpperCase()}, verified ${assessment.closedAt.toISOString().slice(0, 10)}`,
        metadata: { artreloAssessment: String(assessment._id) } }, { idempotencyKey: `billing_item:${assessment._id}` });
      await Assessment.updateOne({ _id: assessment._id }, { $set: { stripeInvoiceItemId: item.id } });
    }
    // Refuse an operator-edited or incomplete draft rather than collecting it.
    invoice = await stripe.invoices.retrieve(invoice.id);
    if (invoice.subtotal !== row.subtotalCents) throw fail("invoice_total_mismatch", "Invoice subtotal does not match the assessments");
    invoice = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: true }, { idempotencyKey: `billing_finalize:${row._id}` });
  }
  await syncInvoice(invoice.id);
}

async function retryOpenInvoices(landlordId, paymentMethodId) {
  if (!env.service_billing_collection_enabled) return;
  const stripe = config.getStripe();
  const rows = await Invoice.find({ landlordId, status: "open", firstFailedAt: { $ne: null } }).lean();
  for (const row of rows) {
    try {
      await stripe.invoices.update(row.stripeInvoiceId, { default_payment_method: paymentMethodId });
      await stripe.invoices.pay(row.stripeInvoiceId, { payment_method: paymentMethodId, off_session: true },
        { idempotencyKey: `billing_recover:${row._id}:${paymentMethodId}` });
      await syncInvoice(row.stripeInvoiceId);
    } catch (error) { console.error("[billing] invoice recovery needs attention", String(row._id), error.code || "recovery_failed"); }
  }
}
async function handleEvent(event) {
  const object = event.data?.object;
  if (!object) return false;
  if (event.type === "setup_intent.succeeded") {
    if (object.metadata?.artreloPurpose !== "service_billing_setup") return false;
    await require("./billingAccount.service").syncSetup(object.id); return true;
  }
  if (event.type === "checkout.session.completed" && object.mode === "setup") {
    const setup = await Setup.findOne({ checkoutSessionId: object.id }); if (!setup) return false;
    const session = await config.getStripe().checkout.sessions.retrieve(object.id);
    if (session.setup_intent) await require("./billingAccount.service").syncSetup(idOf(session.setup_intent));
    return true;
  }
  if (event.type.startsWith("invoice.")) {
    await syncInvoice(object.id, { failedAt: ["invoice.payment_failed", "invoice.payment_action_required", "invoice.marked_uncollectible"].includes(event.type) ? new Date(event.created * 1000) : null });
    return true;
  }
  if (event.type.startsWith("credit_note.")) { await syncInvoice(idOf(object.invoice)); return true; }
  if (event.type.startsWith("charge.dispute.")) return !(await syncDispute(object.id)).ignored;
  if (["charge.updated", "charge.refunded", "refund.updated", "refund.created", "refund.failed"].includes(event.type)) {
    let piId = idOf(object.payment_intent);
    if (!piId && object.charge) piId = idOf((await config.getStripe().charges.retrieve(idOf(object.charge))).payment_intent);
    const match = await invoiceForIntent(piId); if (!match) return false;
    await syncInvoice(match.row.stripeInvoiceId); return true;
  }
  if (event.type === "payment_method.detached") {
    await Account.updateOne({ "card.paymentMethodId": object.id }, { $unset: { card: "" } }); return true;
  }
  return false;
}

function reportRecoveryFailure(kind, id, error) {
  const code = error.code || "billing_recovery_failed";
  console.error("[billing] recovery needs attention", kind, String(id), code);
  try { require("@sentry/node").captureException(new Error(`Billing ${kind} recovery failed: ${code}`), { tags: { operation: "service_billing" } }); } catch (_) { /* monitoring is non-fatal */ }
}
async function reconcileBilling({ now = new Date(), limit = 25 } = {}) {
  if (!config.getStripe()) return;
  const setups = await Setup.find({ completedAt: null, checkoutSessionId: { $ne: null } }).sort({ checkedAt: 1 }).limit(limit).lean();
  for (const setup of setups) {
    try {
      const session = await config.getStripe().checkout.sessions.retrieve(setup.checkoutSessionId);
      if (session.setup_intent) await require("./billingAccount.service").syncSetup(idOf(session.setup_intent));
    } catch (error) { reportRecoveryFailure("setup", setup._id, error); }
    finally { await Setup.updateOne({ _id: setup._id }, { $set: { checkedAt: now } }); }
  }
  const disputes = await Dispute.find({ $or: [{ outstandingCents: { $gt: 0 } }, { status: { $nin: ["won", "warning_closed"] } }] }).sort({ checkedAt: 1 }).limit(limit).lean();
  for (const dispute of disputes) {
    try { await syncDispute(dispute.disputeId); }
    catch (error) { reportRecoveryFailure("dispute", dispute._id, error); await Dispute.updateOne({ _id: dispute._id }, { $set: { checkedAt: now } }); }
  }
  const invoices = await Invoice.find({ $or: [{ status: { $in: ["creating", "draft", "open"] } }, { status: "paid", processingFeeCents: null }] }).sort({ checkedAt: 1 }).limit(limit).lean();
  for (const row of invoices) {
    try {
      if (["creating", "draft"].includes(row.status)) await finishInvoice(row._id);
      else await syncInvoice(row.stripeInvoiceId);
    } catch (error) { reportRecoveryFailure("invoice", row._id, error); }
    finally { await Invoice.updateOne({ _id: row._id }, { $set: { checkedAt: now } }); }
  }
  if (env.service_billing_collection_enabled && env.billing_tax_reviewed) {
    const owners = await Assessment.distinct("landlordId", { invoiceId: null, feeCents: { $gt: 0 }, closedAt: { $lt: periodStart(now) } });
    const eligible = await Account.find({ landlordId: { $in: owners }, "agreement.acceptedAt": { $type: "date" },
      "card.paymentMethodId": { $type: "string" }, "offer.effectiveAt": { $lte: now } })
      .sort({ lastCollectionAttemptAt: 1, _id: 1 }).limit(limit).select("landlordId").lean();
    for (const owner of eligible) {
      try { await createMonthlyInvoice(owner.landlordId, now); }
      catch (error) { reportRecoveryFailure("collection", owner._id, error); }
      finally { await Account.updateOne({ _id: owner._id }, { $set: { lastCollectionAttemptAt: now } }); }
    }
  }
}
async function refreshLandlord(landlordId) {
  if (!config.getStripe()) return;
  const setups = await Setup.find({ landlordId, completedAt: null, checkoutSessionId: { $ne: null } }).sort({ createdAt: -1 }).limit(3).lean();
  for (const setup of setups) {
    const session = await config.getStripe().checkout.sessions.retrieve(setup.checkoutSessionId);
    if (session.setup_intent) await require("./billingAccount.service").syncSetup(idOf(session.setup_intent));
  }
  const invoices = await Invoice.find({ landlordId, stripeInvoiceId: { $ne: null }, status: { $in: ["open", "disputed"] } }).limit(10).lean();
  for (const invoice of invoices) await syncInvoice(invoice.stripeInvoiceId);
}
module.exports = { syncInvoice, syncDispute, createMonthlyInvoice, finishInvoice, retryOpenInvoices, handleEvent, reconcileBilling, refreshLandlord };
