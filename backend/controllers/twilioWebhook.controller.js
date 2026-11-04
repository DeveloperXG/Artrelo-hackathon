// Inbound SMS from a vendor.
//
// SIGNATURE VERIFICATION IS MANDATORY AND REAL. It is NOT the pattern the (since
// removed) Vapi voice webhook used, whose verifier was a TODO that returned
// `true` unconditionally. Anyone who learns this URL can otherwise post a
// message that appears in a tenant's request thread attributed to the vendor
// working in their home. That is a worse failure than the forged-payout one the
// Stripe handler guards against, because it impersonates a person rather than
// a number.
//
// RAW BODY, like the Stripe route: Twilio's signature is an HMAC over bytes we
// have to reproduce exactly, so this is mounted with express.raw BEFORE the
// global express.json/urlencoded in app.js. Twilio posts
// application/x-www-form-urlencoded, so the raw type differs from Stripe's —
// mounting it for `application/json` would leave req.body a parsed object and
// every legitimate message would 403.
//
// The algorithm (Twilio's documented scheme, implemented with `crypto` rather
// than the twilio SDK so a security-critical path has no optional-dependency
// hole — the SDK is absent today and a missing dependency must not degrade to
// "skip the check"):
//
//   1. Start with the FULL public URL Twilio posted to.
//   2. Append each POST parameter, sorted by key, as key immediately followed
//      by value, with no separators.
//   3. HMAC-SHA1 with the account auth token, base64.
//   4. Constant-time compare against X-Twilio-Signature.
//
// Step 1 is the one that bites: behind a tunnel or a proxy, req.protocol and
// req.get("host") describe the INTERNAL address, and the signature then fails
// for reasons indistinguishable from a wrong token. TWILIO_WEBHOOK_URL pins it.

const crypto = require("crypto");
const env = require("../config/env");
const ProxySession = require("../models/ProxySession");
const { resolveInboundSession } = require("../services/comms/proxySession.service");
const { deliverInboundVendorMessage } = require("../services/comms/relayMessaging.service");
const { isPoolNumber } = require("../services/comms/numberPool.service");
const { sendSms } = require("../services/notification/sms.service");
const { logAgentAction } = require("../services/audit/agentAction.service");

// Twilio does nothing with an empty TwiML document, which is what we want: the
// reply travels through the app, not back down the SMS leg.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// How stale a closed channel may be and still earn a courtesy reply. Long
// enough to cover a vendor texting the morning after a job closed.
const CLOSED_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const CLOSED_REPLY =
  "This job is closed, so your message wasn't delivered. Contact the property manager directly if you still need something.";

/** Parse the raw form-encoded body into a flat string map. */
function parseFormBody(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  const params = {};
  for (const [key, value] of new URLSearchParams(text)) params[key] = value;
  return params;
}

function buildSignatureBase(url, params) {
  return Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
}

/**
 * The URL Twilio signed. Pinned config wins; the reconstruction is a fallback
 * that logs, because a silent wrong guess here looks exactly like an attack.
 */
function resolveWebhookUrl(req) {
  if (env.twilio_webhook_url) return env.twilio_webhook_url;
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host");
  console.warn("[twilioWebhook] TWILIO_WEBHOOK_URL is unset; reconstructing from headers");
  return `${proto}://${host}${req.originalUrl}`;
}

function verifyTwilioSignature({ req, params }) {
  const signature = req.get("x-twilio-signature");
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha1", env.twilio_auth_token)
    .update(Buffer.from(buildSignatureBase(resolveWebhookUrl(req), params), "utf8"))
    .digest("base64");

  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself be a signal.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleTwilioInboundSms(req, res) {
  // No token, no processing. An endpoint that accepts unverified payloads is
  // worse than one that is switched off — the same stance the Stripe handler
  // takes on a missing webhook secret.
  if (!env.twilio_auth_token) {
    console.error("[twilioWebhook] TWILIO_AUTH_TOKEN unset; refusing to process inbound SMS");
    return res.status(503).send("relay not configured");
  }

  const params = parseFormBody(req.body);

  if (!verifyTwilioSignature({ req, params })) {
    console.error("[twilioWebhook] signature verification failed");
    return res.status(403).send("invalid signature");
  }

  const from = params.From;
  const to = params.To;
  const body = params.Body;
  const messageSid = params.MessageSid || params.SmsSid || null;

  // Everything past this point answers 200 with empty TwiML. Twilio retries a
  // non-2xx, and none of these conditions improve on a retry — a message we
  // cannot route will not become routable in thirty seconds, and a retry would
  // re-run a delivery that may already have appended a comment.
  try {
    if (!isPoolNumber(to)) {
      console.warn(`[twilioWebhook] inbound to ${to}, which is not in the pool`);
      return res.status(200).type("text/xml").send(EMPTY_TWIML);
    }

    const session = await resolveInboundSession({ from, to });

    if (!session) {
      await replyToClosedChannel({ from, to });
      return res.status(200).type("text/xml").send(EMPTY_TWIML);
    }

    // Consecutive-retry dedupe. See models/ProxySession.js.
    if (messageSid && session.lastInboundSid === messageSid) {
      return res.status(200).type("text/xml").send(EMPTY_TWIML);
    }
    if (messageSid) {
      await ProxySession.updateOne({ _id: session._id }, { $set: { lastInboundSid: messageSid } });
    }

    const result = await deliverInboundVendorMessage({ session, body });

    if (result.delivered) {
      // The message body is NOT logged. An audit trail records that a vendor
      // made contact; the contents belong in the request thread, where the
      // people involved can see them, and nowhere else.
      await logAgentAction({
        requestId: session.requestId,
        landlordId: session.landlordId,
        actor: "vendor",
        actionType: "relay_message_received",
        summary: `${session.vendorNameSnapshot || "Vendor"} sent a message through the relay`,
        input: { proxySessionId: String(session._id), chars: String(body || "").length },
        output: { delivered: true },
      }).catch(() => {});
    }
  } catch (err) {
    // Swallowed on purpose. A 500 makes Twilio retry, and a retry of a handler
    // that already appended a comment double-posts it into a tenant's thread.
    console.error("[twilioWebhook] inbound handling failed", err.message);
  }

  return res.status(200).type("text/xml").send(EMPTY_TWIML);
}

/**
 * A vendor texting a channel that has closed gets silence otherwise, and reads
 * that as the tenant ignoring them.
 *
 * Guarded on there being a RECENTLY CLOSED session for this exact pair, so a
 * wrong number or a spam blast at a pool number gets nothing back — replying to
 * arbitrary inbound would make us a free SMS reflector.
 */
async function replyToClosedChannel({ from, to }) {
  try {
    const recent = await ProxySession.findOne({
      proxyNumber: to,
      vendorPhoneE164: from,
      status: "closed",
      closedAt: { $gte: new Date(Date.now() - CLOSED_REPLY_WINDOW_MS) },
    })
      .sort({ closedAt: -1 })
      .lean();
    if (!recent) {
      console.warn(`[twilioWebhook] unroutable inbound on ${to}; no open session, no recent close`);
      return;
    }
    await sendSms({ to: from, from: to, body: CLOSED_REPLY });
  } catch (err) {
    console.error("[twilioWebhook] closed-channel reply failed", err.message);
  }
}

module.exports = {
  handleTwilioInboundSms,
  // Exported for tests: the signature scheme is the part worth pinning against
  // a real payload.
  buildSignatureBase,
  parseFormBody,
  EMPTY_TWIML,
  CLOSED_REPLY,
};
