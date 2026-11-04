// Outbound SMS. Shaped exactly like notification/email.service.js: `provider`
// names the rail, a stub rail is the default so the surrounding flow stays
// exercisable, and a rejected send is a normal return with `delivered: false`
// rather than a throw. Callers of this module are all non-fatal paths — a
// vendor not receiving a text must never unwind a job.
//
// TWO INDEPENDENT GATES, and they are not the same question:
//
//   1. Credentials  — is there a Twilio account to send through? (technical)
//   2. relay_sms_enabled — has A2P 10DLC brand + campaign registration cleared?
//                          (carrier approval; see config/env.js)
//
// Only (1) is detectable from the environment, which is why (2) is an explicit
// switch. Sending unregistered A2P traffic is not a degraded experience, it is
// how the sending brand gets filtered and fined — so the default is off and a
// stray credential cannot start real traffic.
//
// The `twilio` package is an OPTIONAL dependency, absent today. Its absence
// degrades to the stub, exactly as a missing `resend` does.

const env = require("../../config/env");

let twilioClient = null;
try {
  // Optional dependency
  // eslint-disable-next-line global-require
  const twilio = require("twilio");
  if (env.twilio_account_sid && env.twilio_auth_token) {
    twilioClient = twilio(env.twilio_account_sid, env.twilio_auth_token);
  }
} catch (_) {
  twilioClient = null;
}

/**
 * Is the real rail live? Exported because the relay layer has to answer
 * "is messaging available for this job" BEFORE it has anything to send, and
 * must not claim a channel it cannot deliver on.
 */
function isSmsLive() {
  return Boolean(env.relay_sms_enabled && twilioClient);
}

/**
 * @param {string} to   E.164 destination (the vendor's real phone)
 * @param {string} from E.164 sender — the allocated PROXY number, never a
 *                      tenant's number and never a shared default. Required:
 *                      the whole masking guarantee is that `from` is the proxy,
 *                      so a caller that forgets it must fail loudly rather than
 *                      fall back to some account-wide number and break routing.
 */
async function sendSms({ to, from, body }) {
  if (!to || !from) {
    console.error(`[sms] refusing to send without both to and from (to=${Boolean(to)} from=${Boolean(from)})`);
    return { delivered: false, provider: "none", error: "missing_address" };
  }

  if (!isSmsLive()) {
    // Normal local-dev path. Log enough to follow a relay conversation without
    // Twilio, the way [email-stub] keeps the magic-link flow testable.
    const why = !twilioClient ? "no-credentials" : "relay-disabled";
    console.log(`[sms-stub:${why}] from=${from} to=${to} body=${String(body || "").slice(0, 120)}`);
    return { stub: true, delivered: false, provider: "stub", messageId: null };
  }

  try {
    const message = await twilioClient.messages.create({ to, from, body });

    // Twilio resolves with a queued message and reports terminal failures
    // asynchronously via status callbacks, so `delivered` here means ACCEPTED,
    // not received. Anything stronger would be a claim we cannot support.
    if (message?.errorCode) {
      console.error("[sms] send rejected", message.errorCode, message.errorMessage);
      return {
        delivered: false,
        provider: "twilio",
        messageId: message.sid || null,
        error: String(message.errorMessage || message.errorCode),
      };
    }
    return { delivered: true, provider: "twilio", messageId: message?.sid || null };
  } catch (err) {
    console.error("[sms] send failed", err.message);
    return { delivered: false, provider: "twilio", error: err.message };
  }
}

module.exports = { sendSms, isSmsLive };
