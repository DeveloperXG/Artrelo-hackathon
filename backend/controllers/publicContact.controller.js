// Public, unauthenticated contact form for the marketing site.
//
// The marketing app is a static export (output:'export') — it has no server of
// its own, so this endpoint is where its forms submit. Everything in the body
// arrives attacker-controlled.
//
// Two effects, in this order: a Lead row is written, then one email goes to the
// sales alias. The order is the point — see models/Lead.js. Persisting first
// means a delivery failure downgrades to "we have the lead but it did not
// arrive" instead of "the lead is gone". Neither step is allowed to break the
// other: a DB fault still sends the email, and a send fault still keeps the row.
//
// Two rules this file exists to enforce:
//   * `from` stays the verified Resend identity. Putting the visitor's
//     address there would fail SPF/DKIM alignment for artrelo.com and land the
//     mail in spam. Their address goes in Reply-To instead.
//   * Header injection is impossible: control characters are stripped from
//     every field, and Reply-To is rejected unless it matches a strict
//     single-address pattern.

const env = require("../config/env");
const Lead = require("../models/Lead");
const { sendEmail } = require("../services/notification/email.service");
const { buildContactInquiryEmail } = require("../services/notification/templates/contactInquiryEmail");

const LIMITS = { name: 120, email: 254, company: 160, size: 60, message: 4000, sourcePage: 200 };

// Deliberately stricter than RFC 5322: a single address, no display name, no
// quoting, no commas, no whitespace. Anything else never reaches a header.
const EMAIL_RE = /^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\]+\.[a-zA-Z]{2,}$/;

// Mirrors the select on the form. An unrecognised value is coerced rather than
// rejected — the field is informational and not worth failing a lead over.
const PORTFOLIO_SIZES = [
  "1–10 units",
  "11–50 units",
  "51–250 units",
  "251–1,000 units",
  "1,000+ units",
];

// Every control char except newline becomes a space; CR is folded into LF
// first. A bare CR or LF in a header value is what makes header injection
// possible, so nothing reaches Reply-To or the subject with one intact.
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, " ")
    .trim()
    .slice(0, max);
}

// Single-line fields must not keep newlines either — only the message body may.
function cleanLine(value, max) {
  return clean(value, max).replace(/\n/g, " ");
}

// Per-address ceiling. Two, not one: the same person sending /contact and then
// /demo on the same day is a normal path, and should not be refused.
//
// Counted from Lead rows rather than an in-memory limiter, because this window
// is a day long and the in-memory stores reset on every deploy. The IP limiters
// in the router handle the short windows; this is what stops one address from
// generating a stream of duplicate leads across IP changes and restarts.
const EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_LEADS_PER_EMAIL = 2;

// Rows whose delivery failed are excluded. The visitor saw a 502 asking them to
// try again, so counting that attempt against them would refuse the retry the
// error message just invited.
//
// Fails OPEN. A database fault already must not cost us the email (see the
// persist step below); refusing every visitor because a count query failed
// would be the same mistake from the other side.
async function recentLeadCount(email) {
  try {
    return await Lead.countDocuments({
      email: email.toLowerCase(),
      deliveryStatus: { $ne: "failed" },
      createdAt: { $gte: new Date(Date.now() - EMAIL_WINDOW_MS) },
    });
  } catch (err) {
    console.error("[contact] recent-lead count failed; allowing submission", err?.message || err);
    return 0;
  }
}

async function submitContactInquiry(req, res) {
  const body = req.body || {};

  // Honeypot: a field hidden from humans via CSS. Bots that fill every input
  // get a 200 with the same shape as success, so the form looks like it worked
  // and nothing is sent.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return res.status(200).json({ success: true, message: "Thanks — we'll be in touch shortly." });
  }

  const name = cleanLine(body.name, LIMITS.name);
  const email = cleanLine(body.email, LIMITS.email);
  const company = cleanLine(body.company, LIMITS.company);
  const message = clean(body.message, LIMITS.message);
  const rawSize = cleanLine(body.size, LIMITS.size);
  const size = PORTFOLIO_SIZES.includes(rawSize) ? rawSize : "Not specified";
  // Which marketing page submitted. Informational only, so it is never a
  // validation failure — an absent or junk value just falls back to /contact.
  const sourcePage = cleanLine(body.sourcePage, LIMITS.sourcePage) || "/contact";

  const errors = {};
  if (!name) errors.name = "Please enter your name.";
  if (!EMAIL_RE.test(email)) errors.email = "Please enter a valid work email.";
  if (!company) errors.company = "Please enter your company.";
  if (!message) errors.message = "Please tell us a little about your needs.";

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({
      success: false,
      code: "invalid_input",
      message: "Please check the highlighted fields.",
      errors,
    });
  }

  // After validation, so a malformed address never reaches a query, and before
  // persistence, so a refused submission leaves no row and sends nothing.
  if ((await recentLeadCount(email)) >= MAX_LEADS_PER_EMAIL) {
    return res.status(429).json({
      success: false,
      code: "duplicate",
      message: "We've already received your recent messages and will reply within one business day.",
    });
  }

  // Claim the lead before attempting delivery. Email was the only channel
  // before this row existed, so a DB fault must not cost us that too: log it
  // and carry on with `lead` null, which simply skips the patch below.
  let lead = null;
  try {
    lead = await Lead.create({
      name,
      email,
      company,
      portfolioSize: size,
      message,
      sourcePage,
    });
  } catch (err) {
    console.error("[contact] lead persist failed", err?.message || err);
  }

  const submittedAt = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.outreach_timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());

  const { subject, html, text } = buildContactInquiryEmail({
    name,
    email,
    company,
    size,
    message,
    submittedAt,
  });

  const result = await sendEmail({
    to: env.sales_email,
    replyTo: email,
    subject,
    text,
    html,
    categories: ["contact-form"],
  });

  // Stub mode is the normal local-dev path, but in production it means no
  // Resend key is configured — so every visitor is being shown a success screen
  // while nothing is delivered. That is a misconfiguration, not a code path,
  // and it is silent by construction: shout about it. The Lead row above is the
  // only reason this situation is recoverable rather than lost.
  if (result.stub === true && env.node_env === "production") {
    console.error(
      "[contact] MISCONFIGURED: the email provider is stubbed in production — " +
        "no inquiry is reaching the sales inbox. Set RESEND_API_KEY. " +
        `Lead ${lead?._id ?? "(not persisted)"} is stored and recoverable.`
    );
  }

  // Record the outcome on the row regardless of what we return to the visitor,
  // so a 502 below still leaves an accurate lead rather than a stale "pending".
  if (lead) {
    try {
      await Lead.updateOne(
        { _id: lead._id },
        {
          deliveryStatus: result.delivered ? "delivered" : result.stub ? "stubbed" : "failed",
          providerMessageId: result.messageId ?? null,
          deliveryError: result.error ? String(result.error).slice(0, 500) : null,
        }
      );
    } catch (err) {
      console.error("[contact] lead delivery-status patch failed", err?.message || err);
    }
  }

  // A stub must not read as a failure to the visitor — locally, the console log
  // is the delivery record.
  if (!result.delivered && !result.stub) {
    console.error("[contact] delivery failed", result.error);
    return res.status(502).json({
      success: false,
      code: "delivery_failed",
      message: "We couldn't send your message. Please email us directly and we'll pick it up.",
    });
  }

  return res.status(200).json({ success: true, message: "Thanks — we'll be in touch shortly." });
}

module.exports = { submitContactInquiry };
