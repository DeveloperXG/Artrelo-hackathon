const crypto = require("crypto");
const Request = require("../../models/MaintenanceRequest");
const Outreach = require("../../models/VendorOutreach");
const Appointment = require("../../models/Appointment");
const Preparation = require("../../models/BookingPreparation");
const Policy = require("../../models/LandlordPolicy");
const Approval = require("../../models/ApprovalRequest");
const { resolveMaxVendors } = require("./routingSetup.service");
const { loadPresetCandidates, buildRequestContext } = require("./vendorRecommendation.service");
const { evaluateHardConstraints } = require("./vendorScoring.service");
const calendar = require("./vendorCalendar.service");
const { closePreparation } = require("./bookingCoordination.service");
const { publish } = require("../realtime/liveEvents.service");
const { logAgentAction } = require("../audit/agentAction.service");
function refused(code, message) { const error = new Error(message); error.code = code; error.status = 409; return error; }
const CLOSED = ["completed", "cancelled", "rejected"];
async function history(requestId) {
  const rows = await Outreach.find({ requestId, vendorId: { $ne: null },
    status: { $in: ["declined", "expired", "superseded", "revoked"] } })
    .sort({ createdAt: -1 }).limit(40).select("_id vendorNameSnapshot response.quoteHigh createdAt").lean();
  return rows.map(row => ({ ref: String(row._id), vendorName: row.vendorNameSnapshot,
    previousQuote: row.response?.quoteHigh ?? null, closedAt: row.createdAt }));
}
async function returnToVendor({ requestId, landlordId, outreachRef, amount, start, durationMinutes, note = "" }) {
  const amountCents = Math.round(Number(amount) * 100);
  const arrival = new Date(start);
  if (amount === null || amount === "" || !Number.isSafeInteger(amountCents) || Math.abs(Number(amount) * 100 - amountCents) > 0.000001 || amountCents < 0 || amountCents > 100_000_000 ||
      !Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 720 || durationMinutes % 15 ||
      !Number.isFinite(arrival.getTime()) || arrival <= new Date() || arrival > new Date(Date.now() + 60 * 86400_000)) {
    const error = new Error("Provide an agreed price, future arrival within 60 days, and duration in 15-minute steps.");
    error.status = 400; throw error;
  }
  const old = await Outreach.findOne({ _id: outreachRef, requestId, landlordId,
    status: { $in: ["declined", "expired", "superseded", "revoked"] } });
  if (!old?.vendorId) throw refused("offer_not_closed", "Choose a closed offer from this request.");
  const token = crypto.randomUUID(), now = new Date();
  const request = await Request.findOneAndUpdate({ _id: requestId, landlordId, status: { $nin: CLOSED }, archivedAt: null,
    $or: [{ bookingActionUntil: null }, { bookingActionUntil: { $lte: now } }] },
  { $set: { bookingActionToken: token, bookingActionUntil: new Date(now.getTime() + 120_000), bookingVersion: 2,
    "initialRouting.status": "done" } }, { new: true });
  if (!request) throw refused("booking_changed", "Another action is in progress, or this request is closed. Refresh before retrying.");
  try {
    if (await Appointment.exists({ requestId, status: { $nin: ["cancelled", "failed", "completed"] } })) {
      throw refused("cancel_booked_visit_first", "Explicitly cancel the current visit before contacting another vendor.");
    }
    const policy = await Policy.findOne({ landlordId }).lean();
    if (resolveMaxVendors(policy) < 1) throw refused("vendor_cap_zero", "Increase the vendor contact cap before sending another offer.");
    const candidate = (await loadPresetCandidates({ request })).find(row => String(row.vendorId) === String(old.vendorId));
    const property = request.propertyId ? await require("../../models/Property").findById(request.propertyId).lean() : null;
    if (!candidate || !evaluateHardConstraints(buildRequestContext(request, property, null, policy), candidate).eligible) {
      throw refused("vendor_ineligible", "This vendor is no longer eligible. Review your vendor network.");
    }
    const vendor = await require("../../models/Vendor").findById(old.vendorId).lean();
    if (!vendor?.email || vendor.verificationStatus === "blocked" || !vendor.active) throw refused("vendor_ineligible", "This vendor cannot currently receive an offer.");
    const identityId = await calendar.canonicalId(vendor.identityId || old.identityId);
    await calendar.assertAvailable(identityId, arrival, new Date(arrival.getTime() + durationMinutes * 60_000));
    const preparations = await Preparation.find({ requestId, active: true });
    for (const row of preparations) await closePreparation({ preparationId: row._id, revision: row.revision,
      reason: "manager_replaced_proposal", onlyUnbooked: true });
    const competing = await Outreach.find({ requestId, status: { $in: ["scheduled", "queued", "sent", "viewed", "accepted"] } });
    await Outreach.updateMany({ requestId, status: { $in: ["scheduled", "queued", "sent", "viewed", "accepted"] } },
      { $set: { status: "superseded" }, $unset: { tokenHash: 1 } });
    await Approval.updateMany({ requestId, status: "pending" }, { $set: { status: "expired", decidedAt: new Date() } });
    for (const row of competing) if (["sent", "viewed", "accepted"].includes(row.status)) {
      await require("../notification/email.service").sendEmail({ to: row.toEmail, subject: "Visit proposal withdrawn",
        text: "The property manager has withdrawn this unbooked proposal. Please do not attend under the old offer.", categories: ["vendor_proposal_closed"] });
    }
    const { cloneSnapshot, rebuildSnapshotSections } = require("./vendorSnapshot.service");
    const latest = await Request.findById(requestId);
    const snapshot = cloneSnapshot(latest.vendorRecommendationSnapshot) || { candidateLedger: [] };
    let entry = snapshot.candidateLedger.find(row => row.candidateKey === old.candidateKey);
    if (!entry) { entry = { ...candidate, candidateKey: old.candidateKey }; snapshot.candidateLedger.push(entry); }
    Object.assign(entry, { state: "approved_for_contact", displayGroup: "active", contactApproved: true,
      eligibility: { eligible: true, reasonCodes: [] }, contact: { email: vendor.email, hasEmail: true },
      contactApproval: { status: "approved", approvedAt: new Date().toISOString(), approvedBy: String(landlordId) } });
    snapshot.activeCandidateKey = old.candidateKey; snapshot.approvalRequest = null;
    request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
    await Request.updateOne({ _id: requestId, bookingActionToken: token },
      { $set: { selectedVendorId: null, vendorId: null, status: "approved", routingStatus: "pending",
        vendorRecommendationSnapshot: request.vendorRecommendationSnapshot } });
    request.selectedVendorId = null; request.vendorId = null; request.status = "approved";
    const previous = await Outreach.findOne({ requestId, candidateKey: old.candidateKey }).sort({ attempt: -1 });
    const proposal = { amountCents, start: arrival, durationMinutes, note: String(note).trim().slice(0, 500) };
    const result = await require("./vendorOutreach.service").sendVendorOutreach({ request,
      candidate: { ...candidate, candidateKey: old.candidateKey, email: vendor.email, contact: { email: vendor.email } }, actorUserId: landlordId,
      attempt: (previous?.attempt || 0) + 1, bookingActionToken: token, negotiatedProposal: proposal,
      draftMessage: `Please reconfirm the agreed $${(amountCents / 100).toFixed(2)} CAD price and exact arrival time. ${proposal.note}` });
    await logAgentAction({ requestId, landlordId, actor: "landlord", actionType: "vendor_contact_approved",
      summary: `Fresh negotiated offer sent to ${vendor.name}`, input: { outreachId: String(result.outreach._id) },
      output: { amountCents, start: arrival, durationMinutes } });
    publish(landlordId, `request:${requestId}`); publish(request.tenantId, `request:${requestId}`);
    publish([landlordId, request.tenantId], "requests");
    return { scheduled: !!result.scheduled, outreachRef: String(result.outreach._id) };
  } finally {
    await Request.updateOne({ _id: requestId, bookingActionToken: token }, { $unset: { bookingActionToken: 1, bookingActionUntil: 1 } });
  }
}
module.exports = { history, returnToVendor };
