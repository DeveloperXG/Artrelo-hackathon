// The manager turns down a quote a vendor had already accepted with.
//
// Two doors led here and each did half the job. "Dismiss this quote" on the
// request page marked the response declined and moved routing on, but left
// the quote's pending approval sitting in Decisions Needed. Rejecting that
// approval from Decisions moved routing on but left the response "accepted".
// Neither told the vendor, who had said yes and was holding a time window.
// Both now come through here.

const VendorOutreach = require("../../models/VendorOutreach");
const ApprovalRequest = require("../../models/ApprovalRequest");
const Property = require("../../models/Property");
const Landlord = require("../../models/Landlord");
const { sendEmail } = require("../notification/email.service");
const { buildVendorQuoteNotAcceptedEmail } = require("../notification/templates/vendorLifecycleEmail");
const { logAgentAction } = require("../audit/agentAction.service");
const { resolveRequestCity, formatCityLabel } = require("./vendorScoring.service");

const DEFAULT_REASON = "Dismissed by the property manager";
const MAX_REASON_LENGTH = 500;

const managerLabelFor = (landlord) =>
  landlord?.companyName || [landlord?.firstName, landlord?.lastName].filter(Boolean).join(" ") || "The property manager";

/**
 * Turn down an accepted quote. Idempotent: the response is claimed atomically
 * (still accepted, no appointment), so a double click or both doors at once
 * dismiss once and email once.
 *
 * @param reason  the manager's words, shared with the vendor. Optional.
 * @param source  "dismiss" (request page) or "approval" (Decisions); audit only.
 */
async function dismissVendorQuote({ request, outreach, reason = "", actorUserId = null, source = "dismiss" }) {
  const note = String(reason || "").trim().slice(0, MAX_REASON_LENGTH);

  const claimed = await VendorOutreach.findOneAndUpdate(
    { _id: outreach._id, status: "accepted", appointmentId: null },
    {
      $set: { status: "declined", "response.declineReason": note || DEFAULT_REASON },
      $unset: { tokenHash: 1 },
    },
    { new: true }
  );
  if (!claimed) return { dismissed: false, reason: "not_dismissable" };

  // The quote's own approval ("X quoted $480; your limit is $300") would
  // otherwise stay in Decisions Needed for a vendor who is gone. Pending only:
  // the approval being decided right now is already marked.
  await ApprovalRequest.updateMany(
    { requestId: request._id, status: "pending", "payload.outreachId": String(outreach._id) },
    { $set: { status: "rejected", decidedAt: new Date() } }
  );

  if (claimed.bookingVersion === 2) {
    const preparation = await require("../../models/BookingPreparation").findOne({ outreachId: claimed._id, active: true });
    if (preparation) await require("./bookingCoordination.service").closePreparation({ preparationId: preparation._id,
      revision: preparation.revision, reason: "manager_dismissed" });
  }
  if (claimed.toEmail && claimed.bookingVersion !== 2) {
    try {
      const [property, landlord] = await Promise.all([
        request.propertyId ? Property.findById(request.propertyId?._id || request.propertyId).select("address city").lean() : null,
        Landlord.findById(request.landlordId).select("firstName lastName companyName").lean(),
      ]);
      const email = buildVendorQuoteNotAcceptedEmail({
        vendorName: claimed.vendorNameSnapshot,
        category: request.category,
        city: formatCityLabel(resolveRequestCity({ property })) || null,
        reason: note || null,
        managerLabel: managerLabelFor(landlord),
      });
      await sendEmail({ to: claimed.toEmail, ...email, categories: ["vendor_quote_not_accepted"] });
    } catch (err) {
      // Non-fatal: the decision stands whether or not the email goes.
      console.error("[dismissVendorQuote] vendor email failed", err.message);
    }
  }

  await logAgentAction({
    requestId: request._id,
    landlordId: request.landlordId,
    actor: "landlord",
    actionType: "vendor_response_dismissed",
    summary: `Manager turned down the quote from ${claimed.vendorNameSnapshot}`,
    input: { outreachId: String(outreach._id), reason: note || null, source, actorUserId },
    output: { candidateKey: claimed.candidateKey, vendorEmailed: Boolean(claimed.toEmail) },
  });

  // Lazy: the sweeper requires the outreach service, which would cycle at load.
  // eslint-disable-next-line global-require
  const { advanceOutreach } = require("./vendorOutreachSweeper.service");
  await advanceOutreach({ outreach: claimed, reason: "manager_dismissed" });
  return { dismissed: true };
}

/**
 * Expire pending quote approvals whose vendor response is no longer open --
 * dismissed, declined, or already booked -- so Decisions Needed never asks the
 * manager to approve a price from a vendor who is gone. dismissVendorQuote
 * settles its own approval; this catches the rest (and rows left stale before
 * it did). Run before Decisions lists approvals and before the badge counts
 * them, so the two keep agreeing. Returns how many it expired.
 */
async function expireOrphanedQuoteApprovals(landlordId) {
  const pending = await ApprovalRequest.find({
    landlordId,
    status: "pending",
    "payload.source": "vendor_quote",
  })
    .select("_id payload.outreachId")
    .lean();
  if (!pending.length) return 0;

  const outreachIds = pending.map((row) => row.payload?.outreachId).filter(Boolean);
  const open = await VendorOutreach.find({ _id: { $in: outreachIds }, status: "accepted", appointmentId: null })
    .select("_id")
    .lean();
  const openIds = new Set(open.map((row) => String(row._id)));
  const orphaned = pending.filter((row) => !openIds.has(String(row.payload?.outreachId))).map((row) => row._id);
  if (!orphaned.length) return 0;

  await ApprovalRequest.updateMany(
    { _id: { $in: orphaned }, status: "pending" },
    { $set: { status: "expired", decidedAt: new Date() } }
  );
  return orphaned.length;
}

module.exports = { dismissVendorQuote, expireOrphanedQuoteApprovals, DEFAULT_REASON };
