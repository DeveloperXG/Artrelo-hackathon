// Moving one message across the masked channel, in either direction.
//
// LOGISTICS ONLY. This carries "I'm 20 minutes out", "the gate code isn't
// working", "is the dog inside" — and nothing else. It is structurally
// incapable of changing job state, and that is deliberate rather than
// incidental: a vendor texting "done" must NOT close a job.
//
// Why that matters enough to design around: closing a job starts the 48h
// auto-confirm clock and, 24h later, moves money. Those transitions are gated
// on evidence — photos, an actual cost, an overage check against the landlord's
// ceiling — and every one of those gates lives behind the token portal, where
// we know WHO acted because they held a credential. An SMS proves only that
// somebody controls a phone number. So the inbound path has exactly one effect:
// it appends a comment. There is no command parsing here and there must never
// be one.
//
// The same reasoning applies to the tenant side. A tenant's comment is fanned
// out as a text; it is not an instruction to anything.

const MaintenanceRequest = require("../../models/MaintenanceRequest");
const ProxySession = require("../../models/ProxySession");
const Tenant = require("../../models/Tenant");
const { notifyUser } = require("../notification/notify.service");
const { publish } = require("../realtime/liveEvents.service");
const { sendSms } = require("../notification/sms.service");
const { getOpenSessionForRequest } = require("./proxySession.service");

// An inbound SMS is stored verbatim but bounded. Concatenated messages have no
// practical ceiling and this lands in a document nothing else caps.
const MAX_INBOUND_CHARS = 2000;

// Outbound is capped harder, because every 153 characters is another billed
// segment and a tenant pasting an essay into a comment box should not silently
// cost real money or arrive as fifteen buzzes on a contractor's phone.
const MAX_OUTBOUND_BODY_CHARS = 700;

const TRUNCATION_NOTE = " […message truncated]";

function clamp(text, limit) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return value.slice(0, limit - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
}

/**
 * How a tenant is named in a text landing on a vendor's personal phone.
 *
 * First name plus last initial — byte-for-byte what buildTenantDisplayName in
 * vendorBrief.service already gave this vendor in their post-acceptance brief,
 * so the relay reveals nothing new. Never the full surname, and never the email
 * or an id as a fallback.
 *
 * Resolved here rather than in postComment because this is the only path that
 * needs it, so a tenant commenting on a request with no open channel does not
 * pay for the lookup.
 */
async function resolveTenantDisplayName(tenantId) {
  if (!tenantId) return "The tenant";
  const tenant = await Tenant.findById(tenantId).select("firstName lastName").lean();
  const first = String(tenant?.firstName || "").trim();
  const lastInitial = String(tenant?.lastName || "").trim().charAt(0);
  if (!first) return "The tenant";
  return lastInitial ? `${first} ${lastInitial}.` : first;
}

/** The same JOB-XXXXXX the vendor sees in the portal and the hub. */
function buildJobReference(session) {
  const source = session?.outreachId || session?.appointmentId;
  if (!source) return null;
  return `JOB-${String(source).slice(-6).toUpperCase()}`;
}

/**
 * VENDOR -> TENANT. Called by the inbound webhook once it has verified the
 * signature and resolved (From, To) to exactly one open session.
 *
 * Writes `authorRole: "vendor"` — an enum value that has existed on
 * MaintenanceRequest.comments since before there was anything to write it.
 * `authorId` is the VendorIdentity, not a User: a vendor has no user account
 * and never will, which is the same reason hubAuth sets req.vendorIdentity and
 * never req.user.
 */
async function deliverInboundVendorMessage({ session, body }) {
  const text = clamp(body, MAX_INBOUND_CHARS);
  if (!text) return { delivered: false, reason: "empty_body" };

  const request = await MaintenanceRequest.findById(session.requestId);
  if (!request) return { delivered: false, reason: "request_missing" };

  request.comments.push({
    // The identity is the author. Falls back to the request's landlord only if
    // an identity is somehow absent, because authorId is a required ObjectId
    // and losing the message entirely would be worse than an imprecise author.
    authorId: session.identityId || request.landlordId,
    authorRole: "vendor",
    body: text,
  });
  await request.save();

  await ProxySession.updateOne(
    { _id: session._id },
    { $inc: { inboundCount: 1 }, $set: { lastMessageAt: new Date() } }
  );

  // Refresh the thread live for whoever has it open.
  publish([request.tenantId, request.landlordId], `request:${String(request._id)}`);

  // The tenant is not watching the request detail page. Without this the
  // message sits unread and the vendor concludes nobody is home.
  await notifyUser({
    userId: session.tenantId,
    type: "vendor_message_received",
    title: `${session.vendorNameSnapshot || "Your vendor"} sent a message`,
    // Notification.message is capped at 1000 in the schema and notifyUser
    // swallows a ValidationError, so an over-long preview would silently drop
    // the whole notification.
    message: clamp(text, 300),
    metadata: { workOrderId: String(request._id) },
  });

  return { delivered: true, request };
}

/**
 * TENANT -> VENDOR. Called from postComment after the comment is saved.
 *
 * Only TENANT-authored comments fan out. A landlord's comment does not: the
 * landlord already holds the vendor's real number (buildRevealedDetails gives
 * the vendor the manager's, and the roster holds the vendor's), so relaying it
 * through a channel built to hide numbers that are not hidden from each other
 * would just bill us to duplicate a conversation they can already have. The
 * masked channel exists for the one pair that must stay anonymous.
 *
 * Non-fatal by contract: the comment is already saved and visible in-app before
 * this runs, so a Twilio outage costs the vendor a buzz, not the tenant's
 * message.
 */
async function fanOutTenantMessage({ requestId, body }) {
  const session = await getOpenSessionForRequest(requestId);
  if (!session) return { sent: false, reason: "no_open_session" };

  const reference = buildJobReference(session);
  const who = await resolveTenantDisplayName(session.tenantId);
  const prefix = reference ? `[${reference}] ` : "";
  const text = `${prefix}${who}: ${clamp(body, MAX_OUTBOUND_BODY_CHARS)}`;

  const result = await sendSms({
    to: session.vendorPhoneE164,
    from: session.proxyNumber,
    body: text,
  });

  if (result.delivered) {
    await ProxySession.updateOne(
      { _id: session._id },
      { $inc: { outboundCount: 1 }, $set: { lastMessageAt: new Date() } }
    );
  }
  return { sent: Boolean(result.delivered), result, session };
}

module.exports = {
  deliverInboundVendorMessage,
  fanOutTenantMessage,
  buildJobReference,
  resolveTenantDisplayName,
  clamp,
  MAX_INBOUND_CHARS,
  MAX_OUTBOUND_BODY_CHARS,
};
