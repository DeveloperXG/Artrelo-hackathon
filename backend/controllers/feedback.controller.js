// "Send feedback" from inside the app, for landlords and tenants.
//
// Same shape as the public contact form (publicContact.controller): save first,
// then email, and neither step may undo the other. The difference is that the
// sender is signed in, so who they are comes from the session -- never from the
// body -- and their address goes in Reply-To so a reply reaches them directly.
// `from` stays the verified sending identity for the same SPF/DKIM reason.

const env = require("../config/env");
const Feedback = require("../models/Feedback");
const Landlord = require("../models/Landlord");
const Tenant = require("../models/Tenant");
const { sendEmail } = require("../services/notification/email.service");

const MAX_MESSAGE = 4000;
const MAX_PAGE = 300;
const MIN_MESSAGE = 3;
// A single address, nothing that could break out of a header.
const EMAIL_RE = /^[^\s@,;:<>"'\\]+@[^\s@,;:<>"'\\]+\.[a-zA-Z]{2,}$/;
// Every control character except newline becomes a space.
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, " ").trim().slice(0, max);
}

async function findSender({ id, role }) {
  const fields = "firstName lastName email companyName";
  const person =
    role === "tenant"
      ? await Tenant.findById(id).select(fields).lean()
      : await Landlord.findById(id).select(fields).lean();
  return person || null;
}

exports.submitFeedback = async (req, res) => {
  const message = clean(req.body?.message, MAX_MESSAGE);
  // Only a path inside the app: anything else is dropped rather than stored.
  const rawPage = clean(req.body?.page, MAX_PAGE);
  const page = rawPage.startsWith("/") ? rawPage.split(/[?#]/)[0] : "";

  if (message.length < MIN_MESSAGE) {
    return res.status(400).json({ success: false, field: "message", message: "Tell us a little more first." });
  }

  const { id, role } = req.user;
  let saved = null;
  try {
    saved = await Feedback.create({ userId: id, role, message, page: page || undefined });
  } catch (err) {
    // Not fatal: the email below is still worth sending.
    console.error("[submitFeedback] save failed", err.message);
  }

  try {
    const sender = await findSender({ id, role });
    const name = [sender?.firstName, sender?.lastName].filter(Boolean).join(" ") || "Someone";
    const who = role === "tenant" ? "tenant" : "landlord";
    const replyTo = sender?.email && EMAIL_RE.test(sender.email) ? sender.email : undefined;
    const result = await sendEmail({
      to: env.support_email,
      subject: `Feedback from ${name} (${who})`,
      text:
        `${name} (${who}${sender?.companyName ? `, ${sender.companyName}` : ""}) sent feedback` +
        `${page ? ` from ${page}` : ""}:\n\n${message}\n\n` +
        `${replyTo ? `Reply to this email to answer them.` : "No reply address on file."}\n` +
        `${saved ? `Feedback id: ${saved._id}` : ""}`,
      replyTo,
      categories: ["app_feedback"],
    });
    if (saved && result && result.delivered !== false) {
      await Feedback.updateOne({ _id: saved._id }, { $set: { emailedAt: new Date() } });
    }
  } catch (err) {
    console.error("[submitFeedback] email failed", err.message);
  }

  if (!saved) {
    return res.status(502).json({ success: false, message: "We couldn't save that just now. Please try again." });
  }
  return res.status(201).json({ success: true, message: "Thanks — we read every message." });
};

exports.MAX_MESSAGE = MAX_MESSAGE;
