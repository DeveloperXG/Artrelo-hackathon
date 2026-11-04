const Notice = require("../../models/CoordinationNotice");
const Preparation = require("../../models/BookingPreparation");
const VendorOutreach = require("../../models/VendorOutreach");
const Landlord = require("../../models/Landlord");
const Tenant = require("../../models/Tenant");
const { notifyUser } = require("../notification/notify.service");
const { sendEmail } = require("../notification/email.service");
const { issueSchedulingLink } = require("./schedulingToken.service");
const env = require("../../config/env");

function copy(preparation, audience, vendorName) {
  const phase = preparation.phase;
  if (audience === "landlord") return phase === "awaiting_funds" ? {
    title: "Funding required to confirm this visit",
    message: preparation.reasonCode === "insufficient_funds" ?
      `Add $${(preparation.shortfallCents / 100).toFixed(2)} to reserve the agreed vendor amount. The visit is not booked yet.` :
      "Your wallet needs reconciliation before a new platform-paid booking. Review Payments; the visit is not booked yet.",
  } : { title: "Visit coordination needs your attention", message: "The visit could not be confirmed. Review the request to arrange the next step." };
  const vendor = audience === "vendor";
  const text = {
    awaiting_approval: ["Response received — awaiting approval", vendor ? "Your response was received. The proposed visit is not booked; we will update you after the quote is reviewed." : `${vendorName} responded to your request. We are arranging the next step; no visit is confirmed yet.`],
    awaiting_funds: ["Visit awaiting confirmation", vendor ? "Your response was received. The booking is awaiting confirmation; please do not attend until you receive a confirmed visit." : `${vendorName} responded. We are preparing the visit and will ask you to confirm a time. No visit is booked yet.`],
    awaiting_vendor: ["Choose an alternative visit time", vendor ? "The proposed time is not confirmed. Review the tenant's alternatives or suggest another arrival time." : "We are arranging an alternative time with your vendor. The previous time is not booked."],
    awaiting_tenant: ["Please confirm the proposed visit", vendor ? "We have asked the tenant to confirm your proposed time. Do not attend until the visit is confirmed." : `${vendorName} proposed a visit. Confirm the exact time or suggest alternatives in your request.`],
    scheduled: ["Your visit is confirmed", vendor ? "The tenant confirmed the visit. Open your job link for the visit details." : `Your visit with ${vendorName} is confirmed. Your request shows the agreed arrival time.`],
    paused: ["Visit not confirmed", vendor ? "This visit has not been confirmed. Do not attend; we will contact you if a new proposal is made." : "We could not confirm the visit. Your property manager has been notified."],
    expired: ["Visit proposal closed", vendor ? "This proposal expired and the visit is not booked. Please do not attend." : "The visit proposal expired. We will update your request with the next step."],
    closed: ["Visit proposal closed", vendor ? "This proposal has been closed. Please do not attend under this proposal. A new proposal requires a new confirmation." : "This visit proposal has been closed. Your request shows the next step."],
  };
  const [title, message] = text[phase] || text.paused;
  return { title, message };
}
async function queueNotices(preparation, session = null) {
  if (preparation.phase === "preparing" || preparation.reasonCode === "job_completed") return;
  const audiences = preparation.phase === "scheduled" ? ["tenant"] : ["vendor", "tenant"];
  if (["awaiting_funds", "paused"].includes(preparation.phase)) audiences.push("landlord");
  for (const audience of audiences) {
    const key = `booking:${preparation._id}:${preparation.revision}:${audience}`;
    await Notice.updateOne({ key }, { $setOnInsert: { key, preparationId: preparation._id,
      revision: preparation.revision, audience, phase: preparation.phase, status: "pending", nextAttemptAt: new Date() } },
    { upsert: true, session });
  }
}
function rescheduleCopy(proposal) {
  const terminal = { committed: ['Visit time changed', 'The vendor and tenant confirmed the replacement time.'],
    declined: ['Visit change declined', 'The proposed change was declined or withdrawn. The original visit remains in place.'],
    expired: ['Visit change expired', 'The change was not confirmed before its deadline. The original visit remains in place.'],
    conflict: ['Proposed visit time unavailable', 'The new time could not be reserved. The original visit remains in place.'],
    invalidated: ['Visit change no longer applicable', 'This proposal did not replace the visit. Open the request for its current authoritative state.'] };
  const [title, lead] = terminal[proposal.status] || ['Visit change awaiting confirmation',
    'A visit change was requested. The original visit remains confirmed until the vendor and tenant both confirm the exact replacement.'];
  return { title, message: `${lead}\nReason: ${proposal.reason}\nOriginal: ${proposal.oldSlot.start} to ${proposal.oldSlot.end} (UTC).` +
    (proposal.proposedSlot ? `\nProposed: ${proposal.proposedSlot.start} to ${proposal.proposedSlot.end} (UTC).` : '\nNo replacement time has been agreed.') };
}
async function queueRescheduleNotices(proposal, session) {
  for (const audience of ['landlord', 'tenant', 'vendor']) {
    const key = `reschedule:${proposal.id}:${proposal.revision}:${audience}`;
    await Notice.updateOne({ key }, { $setOnInsert: { key, purpose: 'reschedule', rescheduleId: proposal.id,
      preparationId: proposal.preparationId, revision: proposal.revision, audience, phase: `reschedule:${proposal.status}`,
      status: 'pending', nextAttemptAt: new Date() } }, { upsert: true, session });
  }
}
async function deliverNotice(id) {
  const now = new Date();
  const notice = await Notice.findOneAndUpdate({ _id: id, status: "pending", nextAttemptAt: { $lte: now } },
    { $set: { status: "processing", leaseUntil: new Date(now.getTime() + 120_000) }, $inc: { attempts: 1 } }, { new: true });
  if (!notice) return;
  try {
    const preparation = await Preparation.findById(notice.preparationId);
    const reschedule = notice.purpose === 'reschedule' && preparation ? await require('../../models/BookingReschedule').findOne({
      _id: notice.rescheduleId, preparationId: preparation._id, landlordId: preparation.landlordId,
      revision: notice.revision }).lean() : null;
    if (!preparation || (notice.purpose === 'reschedule' ? !reschedule || !preparation.active || notice.phase !== `reschedule:${reschedule.status}` :
      preparation.revision !== notice.revision || preparation.phase !== notice.phase)) {
      await Notice.updateOne({ _id: id }, { $set: { status: "stale" } }); return;
    }
    const outreach = await VendorOutreach.findById(preparation.outreachId).select("toEmail vendorNameSnapshot").lean();
    const userId = notice.audience === "tenant" ? preparation.tenantId : preparation.landlordId;
    const person = notice.audience === "vendor" ? null : await (notice.audience === "tenant" ? Tenant : Landlord)
      .findById(userId).select("email notificationPreferences").lean();
    const message = reschedule ? rescheduleCopy(reschedule.proposal) : copy(preparation, notice.audience, outreach?.vendorNameSnapshot || "Your vendor");
    if (notice.audience !== "vendor" && !notice.notificationCreatedAt) {
      const notification = await notifyUser({ userId, type: "booking_coordination", eventKey: notice.key, ...message,
        metadata: { workOrderId: String(preparation.requestId) } });
      if (!notification) throw new Error("Notification could not be recorded");
      await Notice.updateOne({ _id: id }, { $set: { notificationCreatedAt: new Date() } });
    }
    const to = notice.audience === "vendor" ? outreach?.toEmail : person?.email;
    if (!to || person?.notificationPreferences?.email === false || env.outreach_email_enabled !== true) {
      await Notice.updateOne({ _id: id }, { $set: { status: "disabled", errorCode: "email_not_sent" } }); return;
    }
    let link = `${env.app_public_url}/${notice.audience === "tenant" ? "portal" : "dashboard"}/requests/${preparation.requestId}`;
    if (notice.audience === "vendor") link = reschedule || ["awaiting_vendor", "awaiting_tenant"].includes(preparation.phase) ?
      await issueSchedulingLink(reschedule ? { ...preparation.toObject(), deadlineAt: reschedule.expiresAt } : preparation) : null;
    const result = await sendEmail({ to, subject: message.title,
      text: `${message.message}${link ? `\n\nReview: ${link}` : ""}`,
      categories: ["booking_coordination"] });
    if (result.delivered === true) {
      await Notice.updateOne({ _id: id }, { $set: { status: "sent", errorCode: null } }); return;
    }
    if (result.stub) { await Notice.updateOne({ _id: id }, { $set: { status: 'disabled', errorCode: 'email_not_sent' } }); return; }
    // Unknown transport outcome is visible for manual resend. A fresh token on
    // an automatic retry could invalidate an email the provider already sent.
    const status = result.uncertain ? "uncertain" : notice.attempts >= 3 ? "failed" : "pending";
    await Notice.updateOne({ _id: id }, { $set: { status, errorCode: "email_delivery_failed",
      nextAttemptAt: new Date(Date.now() + (notice.attempts === 1 ? 60_000 : 300_000)) } });
  } catch (error) {
    await Notice.updateOne({ _id: id }, { $set: { status: "uncertain", errorCode: "notification_delivery_uncertain" } });
    console.error("[coordinationNotice] delivery uncertain", error.code || "delivery_error");
  }
}
async function sweepNotices() {
  await Notice.updateMany({ status: "processing", leaseUntil: { $lte: new Date() } },
    { $set: { status: "uncertain", errorCode: "notification_delivery_uncertain" } });
  const due = await Notice.find({ status: "pending", nextAttemptAt: { $lte: new Date() } }).sort({ createdAt: 1 }).limit(20).select("_id").lean();
  for (const row of due) await deliverNotice(row._id);
}
let scheduled = null;
let running = null;
function nudge() {
  if (scheduled || running) return;
  scheduled = setImmediate(() => {
    scheduled = null;
    running = sweepNotices().catch(error => console.error("[coordinationNotice] recovery failed", error.code || "notice_error"))
      .finally(() => { running = null; });
  });
}
async function flush() {
  if (scheduled) { clearImmediate(scheduled); scheduled = null; }
  if (running) await running;
  await sweepNotices();
}
module.exports = { copy, rescheduleCopy, queueNotices, queueRescheduleNotices, deliverNotice, sweepNotices, nudge, flush };
