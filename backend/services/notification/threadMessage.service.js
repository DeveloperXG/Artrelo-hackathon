// Tells the other party that a message landed in a request thread.
//
// In-app only, by decision: the bell row is cheap and coalesces per request,
// whereas an email per message would need throttling to be tolerable. The
// thread itself is unchanged -- this only makes it discoverable without the
// request already being open.

const Tenant = require("../../models/Tenant");
const Landlord = require("../../models/Landlord");
const { notifyUser } = require("./notify.service");
const { publish } = require("../realtime/liveEvents.service");

function clamp(text, limit) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
}

function personName(doc) {
  return [doc?.firstName, doc?.lastName].filter(Boolean).join(" ").trim();
}

async function senderLabel(authorRole, authorId) {
  try {
    if (authorRole === "tenant") {
      const tenant = await Tenant.findById(authorId).select("firstName lastName").lean();
      return personName(tenant) || "Your tenant";
    }
    const landlord = await Landlord.findById(authorId).select("firstName lastName companyName").lean();
    return landlord?.companyName || personName(landlord) || "Your property manager";
  } catch {
    return authorRole === "tenant" ? "Your tenant" : "Your property manager";
  }
}

/**
 * @param request  the MaintenanceRequest the comment was added to
 * @param authorRole  "tenant" | "landlord" (system comments notify nobody)
 */
async function notifyThreadMessage({ request, authorId, authorRole, body }) {
  if (!request || !["tenant", "landlord"].includes(authorRole)) return null;
  const recipientId = authorRole === "tenant" ? request.landlordId : request.tenantId;
  if (!recipientId) return null;

  const requestId = String(request._id);
  // Both sides of an open thread refresh it live, whoever wrote.
  publish([request.tenantId, request.landlordId], `request:${requestId}`);

  // One person can hold both a landlord and a tenant profile (they rent their
  // own unit). Their own message is not news to them.
  if (String(recipientId) === String(authorId)) return null;

  const sender = await senderLabel(authorRole, authorId);
  const subject = request.issueTitle ? `${clamp(request.issueTitle, 80)}: ` : "";
  return notifyUser({
    userId: recipientId,
    type: authorRole === "tenant" ? "tenant_message_received" : "landlord_message_received",
    title: `${sender} sent a message`,
    titleForCount: (count) => (count > 1 ? `${sender} sent ${count} new messages` : `${sender} sent a message`),
    // The message column caps at 1000 and an overflow drops the whole row
    // silently (notifyUser swallows the ValidationError).
    message: clamp(`${subject}${body}`, 300),
    metadata: { workOrderId: requestId },
    coalesce: true,
  });
}

module.exports = { notifyThreadMessage };
