const env = require("../../config/env");

let resend = null;
try {
  // Optional dependency
  // eslint-disable-next-line global-require
  const { Resend } = require("resend");
  if (env.resend_api_key) resend = new Resend(env.resend_api_key);
} catch (_) {
  resend = null;
}

// One sending identity for every stream (RESEND_FROM_EMAIL, a no-reply
// address); the streams are told apart by `tags`, not by `from`. Two From
// addresses on the same domain would share reputation anyway.
//
// Reply-To is what varies. Since `from` is no-reply, a caller that omits it
// would be sending mail no human can answer — so the default is the support
// mailbox rather than nothing. Pass an address to override (the contact form
// points replies at the visitor), or `false` for a genuinely unanswerable send.
//
// Resend has no per-send tracking switch: click/open tracking is a
// per-domain setting in the Resend dashboard and is OFF by default. It must
// STAY off — link tracking rewrites every href through a Resend redirect
// domain, and vendor magic links have to stay same-origin.

// Tag names and values accept only ASCII letters, digits, `_` and `-`.
// Anything else is a 422 from the API, so the caller's category strings are
// coerced rather than trusted — a malformed tag must never cost us a send.
function toTagValue(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) || "unknown";
}

// `categories` is a list, a Resend tag is a name/value pair, and duplicate tag
// names collide. Every caller passes exactly one category today; index the
// rest so a second one is still recorded rather than silently overwriting.
function toTags(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return undefined;
  return categories.map((category, i) => ({
    name: i === 0 ? "category" : `category_${i + 1}`,
    value: toTagValue(category),
  }));
}

async function sendEmail({ to, subject, text, html, categories, previewUrl, replyTo }) {
  // The isolated judge runtime has no outbound channel, including dev-stub
  // logs containing bearer links. Ordinary local/production behavior is unchanged.
  if (require('../judgeSandbox/offlineGuard.service').inAppOnly()) return { delivered: false, provider: 'disabled', messageId: null, error: 'offline_in_app_only' };
  const finalReplyTo = replyTo === undefined ? env.support_email : replyTo;
  if (!env.resend_api_key || !env.resend_from_email || !resend) {
    // Stub mode is the normal local-dev path. Log enough that a flow which
    // depends on a link inside the email (vendor outreach) stays testable
    // without a Resend key.
    const fromLabel = env.resend_from_name
      ? `${env.resend_from_name} <${env.resend_from_email || "(unset)"}>`
      : env.resend_from_email || "(unset)";
    console.log(
      `[email-stub] from=${fromLabel} to=${to} replyTo=${finalReplyTo || "(none)"} subject=${subject} htmlChars=${(html || "").length}`
    );
    if (previewUrl) console.log(`[email-stub] link: ${previewUrl}`);
    return { stub: true, delivered: false, provider: "stub", messageId: null };
  }
  try {
    const tags = toTags(categories);
    const { data, error } = await resend.emails.send({
      to,
      // Resend takes one string, not an object: "Artrelo <no-reply@…>" so
      // recipients see the display name rather than the bare address. Falls
      // back to the bare address when no name is set.
      from: env.resend_from_name
        ? `${env.resend_from_name} <${env.resend_from_email}>`
        : env.resend_from_email,
      subject,
      text,
      html: html || `<p>${text}</p>`,
      ...(finalReplyTo ? { replyTo: finalReplyTo } : {}),
      ...(tags ? { tags } : {}),
    });
    // The SDK resolves rather than throws on an API-level rejection (bad
    // domain, unverified sender, rate limit), so a rejected send arrives here
    // as a normal return with `error` set. Only transport faults throw.
    if (error) {
      console.error("[email] send rejected", error.message || error.name);
      return {
        delivered: false,
        provider: "resend",
        error: error.message || String(error.name || "send_rejected"),
      };
    }
    return {
      delivered: true,
      provider: "resend",
      messageId: data?.id || null,
    };
  } catch (err) {
    console.error("[email] send failed", err.message);
    return { delivered: false, provider: "resend", error: err.message, uncertain: true };
  }
}

module.exports = { sendEmail };
