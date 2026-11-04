// Who hears about a payout, and when.
//
// The ledger records every provider status. This decides which CHANGES a
// person has to be told about, so that nobody is left reading "processing"
// with no end in sight. Called from settlePayout on every attempt, and acts
// only on a transition:
//
//   -> awaiting_clearance   the landlord: paid for, sends itself around <date>,
//                           nothing to do. The vendor is told in the "Job
//                           complete" email, which reads the same status.
//   awaiting_clearance -> paid
//                           both: the vendor gets "Payment sent" (they were
//                           told it was coming), the landlord a note that it went.
//   -> failed               the landlord, who has to act: Stripe refused, and a
//                           failed payout does NOT retry by itself. This is
//                           also what makes the vendor email's "your property
//                           manager has been told" true.
//
// Every message is best-effort. settlePayout wraps the call, and nothing here
// may be the reason money did or did not move.
//
// Privacy, as every vendor email: no address or tenant name. Job category only.

const env = require("../../config/env");
const Landlord = require("../../models/Landlord");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const VendorIdentity = require("../../models/VendorIdentity");
const VendorOutreach = require("../../models/VendorOutreach");
const { notifyUser } = require("../notification/notify.service");
const { sendEmail } = require("../notification/email.service");
const { logAgentAction } = require("../audit/agentAction.service");
const {
  buildVendorPayoutSentEmail,
  formatClearingDate,
} = require("../notification/templates/vendorLifecycleEmail");

const money = (cents, currency = "CAD") =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency }).format((cents || 0) / 100);

// Stripe's own messages can run long; a notification is not a log.
const brief = (text, max = 180) => {
  const clean = String(text || "").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** The names a message needs. Every lookup is optional: a missing one shortens the sentence. */
async function loadContext(entry) {
  const [request, identity, outreach, landlord] = await Promise.all([
    entry.requestId ? MaintenanceRequest.findById(entry.requestId).select("issueTitle ai.shortTitle category").lean() : null,
    entry.identityId ? VendorIdentity.findById(entry.identityId).select("displayName emailNormalized").lean() : null,
    entry.appointmentId
      ? VendorOutreach.findOne({ appointmentId: entry.appointmentId }).select("toEmail vendorNameSnapshot").lean()
      : null,
    Landlord.findById(entry.landlordId).select("firstName lastName companyName").lean(),
  ]);
  return {
    jobTitle: request?.ai?.shortTitle || request?.issueTitle || null,
    category: request?.category || null,
    vendorName: outreach?.vendorNameSnapshot || identity?.displayName || null,
    vendorEmail: outreach?.toEmail || identity?.emailNormalized || null,
    managerLabel:
      landlord?.companyName ||
      [landlord?.firstName, landlord?.lastName].filter(Boolean).join(" ") ||
      "The property manager",
  };
}

/** "$20.00 to Dana for "Leaking tap"", with whatever names exist. */
function describePayout(entry, ctx) {
  return [
    money(entry.amountCents, entry.currency),
    ctx.vendorName ? `to ${ctx.vendorName}` : "to your vendor",
    ctx.jobTitle ? `for "${ctx.jobTitle}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

async function announceClearing(entry, result) {
  const ctx = await loadContext(entry);
  const day = formatClearingDate(result.clearsOn);
  const when = day ? `around ${day}` : "in a few business days";

  await notifyUser({
    userId: entry.landlordId,
    type: "vendor_payout_clearing",
    title: "Vendor payment waiting on Stripe",
    message:
      `${describePayout(entry, ctx)} is paid from your wallet, but your card top-up is still clearing at Stripe. ` +
      `It sends to them automatically ${when}. Nothing to do.`,
    metadata: {
      workOrderId: entry.requestId ? String(entry.requestId) : undefined,
      entryId: String(entry._id),
      clearsOn: result.clearsOn || null,
    },
  });
  await logAgentAction({
    requestId: entry.requestId,
    landlordId: entry.landlordId,
    actor: "system",
    actionType: "payout_awaiting_clearance",
    summary: `Vendor payout of ${money(entry.amountCents, entry.currency)} parked until Stripe clears the funds`,
    input: { entryId: String(entry._id) },
    output: { status: "awaiting_clearance", clearsOn: result.clearsOn || null, detail: result.error || null },
  });
}

async function announceSentAfterClearing(entry, result) {
  const ctx = await loadContext(entry);

  if (ctx.vendorEmail) {
    const hubUrl = `${String(env.app_public_url || "http://localhost:3000").replace(/\/+$/, "")}/vendor-hub`;
    const email = buildVendorPayoutSentEmail({
      vendorName: ctx.vendorName,
      category: ctx.category,
      amount: entry.amountCents / 100,
      hubUrl,
      managerLabel: ctx.managerLabel,
    });
    await sendEmail({ to: ctx.vendorEmail, ...email, categories: ["vendor_payout_sent"] });
  }

  await notifyUser({
    userId: entry.landlordId,
    type: "vendor_payout_sent",
    title: "Vendor paid",
    message: `${describePayout(entry, ctx)} was sent now that your top-up has cleared.`,
    metadata: { workOrderId: entry.requestId ? String(entry.requestId) : undefined, entryId: String(entry._id) },
  });
  await logAgentAction({
    requestId: entry.requestId,
    landlordId: entry.landlordId,
    actor: "system",
    actionType: "payout_sent",
    summary: `Vendor payout of ${money(entry.amountCents, entry.currency)} sent after Stripe cleared the funds`,
    input: { entryId: String(entry._id) },
    output: { status: "paid", transferId: result.reference || null },
  });
}

async function announceFailed(entry, result) {
  const ctx = await loadContext(entry);
  await notifyUser({
    userId: entry.landlordId,
    type: "payment_failed",
    title: "A vendor payment didn't go through",
    message:
      `${describePayout(entry, ctx)} couldn't be sent${result.error ? `: ${brief(result.error)}` : "."} ` +
      "Retry it from your wallet, or pay them directly and mark it paid. They're still owed the full amount.",
    metadata: { workOrderId: entry.requestId ? String(entry.requestId) : undefined, entryId: String(entry._id) },
  });
  await logAgentAction({
    requestId: entry.requestId,
    landlordId: entry.landlordId,
    actor: "system",
    actionType: "payout_failed",
    summary: `Vendor payout of ${money(entry.amountCents, entry.currency)} was refused by the payment provider`,
    input: { entryId: String(entry._id) },
    output: { status: "failed", error: result.error || null },
  });
}

/**
 * React to one settle attempt. `from` is the status before it, `result` what
 * sendPayout returned. A repeat of the same status (a sweep re-parking a payout
 * every hour) says nothing.
 */
async function announcePayoutTransition({ entry, from, result }) {
  const to = result?.status;
  if (!entry || !to || to === from) return;

  if (to === "awaiting_clearance") return announceClearing(entry, result);
  if (to === "paid" && from === "awaiting_clearance") return announceSentAfterClearing(entry, result);
  if (to === "failed") return announceFailed(entry, result);
}

module.exports = { announcePayoutTransition, describePayout };
