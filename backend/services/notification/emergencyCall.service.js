// Phone the landlord about an emergency.
//
// Email and the bell reach someone who is looking. A burst pipe at 2am needs a
// phone that rings, so an emergency request also places an automated voice
// call to the landlord's number, reading out what happened and where.
//
// A CALL, NOT A TEXT. Calls are not application-to-person messaging, so they
// need no A2P 10DLC registration (the reason the SMS relay is still dormant):
// a Twilio number with voice is enough. Off unless EMERGENCY_CALLS_ENABLED is
// set, for the same reason as the relay -- a stray credential must not start
// phoning people.
//
// Twilio's REST API is called directly rather than through the `twilio`
// package, which this project keeps optional: one POST does not justify a
// dependency. Never throws: the request, the email and the bell all stand on
// their own, and a failed call is logged and audited, not retried.

const env = require("../../config/env");
const { toE164 } = require("../../utils/phone");

const TWILIO_API = "https://api.twilio.com/2010-04-01";

const escapeXml = (value) =>
  String(value || "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

// Twilio caps inline TwiML at 4000 characters, and the text is said twice. The
// tenant's title is theirs to write, so it is cut well short of that.
const clip = (text, max) => {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
};

/** What the call says, read twice so a half-awake listener catches it. */
function buildEmergencyTwiml({ issueTitle, where }) {
  const title = clip(issueTitle, 160);
  const place = clip(where, 120);
  const said =
    `This is Artrelo with an emergency maintenance request. ` +
    `${title ? `${title}. ` : ""}${place ? `At ${place}. ` : ""}` +
    "Open Artrelo or check your email to respond.";
  const say = `<Say voice="alice" language="en-CA">${escapeXml(said)}</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Pause length="1"/>${say}</Response>`;
}

/** Whether calls can go out at all. */
function isCallingLive() {
  return Boolean(
    env.emergency_calls_enabled && env.twilio_account_sid && env.twilio_auth_token && toE164(env.twilio_voice_from)
  );
}

/**
 * @returns {Promise<{ placed: boolean, reason?: string, callSid?: string }>}
 *   reason: "disabled" | "no_phone" | "twilio_error"
 */
async function placeEmergencyCall({ phone, issueTitle, where, fetchImpl = fetch }) {
  if (!isCallingLive()) return { placed: false, reason: "disabled" };
  const to = toE164(phone);
  if (!to) return { placed: false, reason: "no_phone" };

  try {
    const auth = Buffer.from(`${env.twilio_account_sid}:${env.twilio_auth_token}`).toString("base64");
    const response = await fetchImpl(`${TWILIO_API}/Accounts/${env.twilio_account_sid}/Calls.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        To: to,
        From: toE164(env.twilio_voice_from),
        Twiml: buildEmergencyTwiml({ issueTitle, where }),
        // If voicemail answers, wait for the greeting to finish before speaking,
        // so the message lands on the recording. "Enable" would start talking
        // over the greeting and most of it would be lost (Twilio CreateCall).
        MachineDetection: "DetectMessageEnd",
      }).toString(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("[emergencyCall] Twilio refused the call", response.status, body?.message || "");
      return { placed: false, reason: "twilio_error" };
    }
    return { placed: true, callSid: body.sid || null };
  } catch (err) {
    console.error("[emergencyCall] call failed", err.message);
    return { placed: false, reason: "twilio_error" };
  }
}

module.exports = { toE164, buildEmergencyTwiml, isCallingLive, placeEmergencyCall };
