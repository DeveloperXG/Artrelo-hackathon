// Telling the landlord a tenant reported something.
//
// Every request is a bell entry and an email (work_order_created is emailed by
// notify.service). An EMERGENCY is that, worded and marked as one, plus a phone
// call -- the safety gate already told the tenant the manager is being alerted,
// and an email at 2am is not an alert.

const Landlord = require("../../models/Landlord");
const Property = require("../../models/Property");
const { notifyUser } = require("./notify.service");
const { placeEmergencyCall } = require("./emergencyCall.service");
const { logAgentAction } = require("../audit/agentAction.service");
const { resolveOutreachTier } = require("../vendor/vendorOutreachPolicy.service");
const Request = require('../../models/MaintenanceRequest');

/** "Maple Court, unit 4B", as far as it is known. */
async function describeWhere({ propertyId, unitNumber }) {
  const property = propertyId ? await Property.findById(propertyId).select("name").lean().catch(() => null) : null;
  return [property?.name, unitNumber ? `unit ${unitNumber}` : null].filter(Boolean).join(", ");
}

/**
 * @param {object} p
 * @param {object} p.request    the saved MaintenanceRequest
 * @param {object} p.tenant     the reporting tenant (firstName, lastName, phone)
 * @param {string} [p.unitNumber]
 * Never throws; call without awaiting so the tenant's response is not held up.
 */
async function alertLandlordOfNewRequest({ request, tenant, unitNumber = null }) {
  try {
    const landlordId = request.landlordId;
    if (!landlordId) return;
    const emergency = request.safetyAssessment?.state !== 'none' && !!request.safetyAssessment || resolveOutreachTier(request) === "emergency";
    const revision = request.safetyAssessment?.revision || 1;
    const uncertain = request.safetyAssessment?.state === 'needs_review';
    const reporter = [tenant?.firstName, tenant?.lastName].filter(Boolean).join(" ") || "Your tenant";
    const where = await describeWhere({ propertyId: request.propertyId, unitNumber });

    const notice = await notifyUser({
      userId: landlordId,
      type: "work_order_created",
      eventKey: `new_request:${request._id}:${revision}`,
      title: uncertain ? `Urgent safety concern: ${request.issueTitle}` : emergency ? `Emergency: ${request.issueTitle}` : "New maintenance request",
      message: emergency
        ? `${reporter}${where ? ` at ${where}` : ""} reported ${uncertain ? 'a safety concern requiring human review' : 'an emergency'}: ${request.issueTitle}.${
            tenant?.phone ? ` Their phone: ${tenant.phone}.` : ""
          } Artrelo is preparing vendor recommendations. Review the request or call a vendor directly now.`
        : `${reporter} reported: ${request.issueTitle}`,
      metadata: { workOrderId: String(request._id), priority: request.urgency },
    });

    if (!emergency) {
      // Delivery bookkeeping must not invalidate an in-flight routing snapshot.
      // Actual intake/safety/policy changes retain their normal version fences.
      if (notice) await Request.updateOne({_id:request._id},{$set:{workflowAlertPending:false}}, { timestamps: false });
      return;
    }
    // Claim before the external side effect. A lost provider response is never
    // retried blindly; its persisted outcome remains unknown for operator review.
    const claim = await Request.findOneAndUpdate({_id:request._id,'safetyAlert.revision':{$ne:revision}},
      {$set:{safetyAlert:{revision,status:'unconfirmed',claimedAt:new Date()}}});
    if (!claim) {
      if (notice) await Request.updateOne({_id:request._id},{$set:{workflowAlertPending:false}}, { timestamps: false });
      return;
    }
    const landlord = await Landlord.findById(landlordId).select("phone").lean();
    const call = await placeEmergencyCall({ phone: landlord?.phone, issueTitle: request.issueTitle, where });
    await Request.updateOne({_id:request._id,'safetyAlert.revision':revision},{$set:{
      workflowAlertPending:!notice,'safetyAlert.status':call.placed?'placed':call.reason==='twilio_error'?'unconfirmed':'skipped',
      'safetyAlert.callSid':call.callSid||null,'safetyAlert.reason':call.reason||null}});
    await logAgentAction({
      requestId: request._id,
      landlordId,
      actor: "system",
      actionType: call.placed ? "emergency_call_placed" : "emergency_call_skipped",
      summary: call.placed
        ? "Called the manager about an emergency request"
        : `Did not call the manager about an emergency (${call.reason})`,
      input: { reason: call.reason || null },
      output: { callSid: call.callSid || null },
    });
  } catch (err) {
    console.error("[alertLandlordOfNewRequest] failed", err.message);
  }
}

module.exports = { alertLandlordOfNewRequest };
