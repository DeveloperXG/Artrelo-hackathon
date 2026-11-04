const AgentActionLog = require("../../models/AgentActionLog");
const { touchLandlordActivity } = require("../metrics/activity.service");

// Audit logging must never break the action it is recording. Every failure is
// swallowed and reported to the console, matching the existing behaviour of the
// logAgentAction helper inside request.controller.js.
async function logAgentAction({
  requestId,
  landlordId,
  actor,
  actionType,
  summary,
  input,
  output,
  metadata,
}) {
  try {
    await AgentActionLog.create({
      requestId,
      landlordId,
      actor,
      actionType,
      summary,
      input,
      output,
      metadata,
    });
    // A decision the landlord made is the strongest evidence they are using the
    // product. Cheap after the first call of the day (see activity.service).
    if (actor === "landlord") void touchLandlordActivity(landlordId);
  } catch (err) {
    console.error("[logAgentAction] failed", err.message);
  }
}

module.exports = { logAgentAction };
