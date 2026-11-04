// The vendor hub: one login, every job, across every landlord.
//
// Passwordless by design. A vendor sourced from TaskRabbit or Thumbtack never
// signed up for anything here, and asking them to invent a password for a
// portal they visit twice a month would simply not happen. Control of the email
// address is the same proof the offer links have always relied on.

const VendorIdentity = require("../models/VendorIdentity");
const { sendEmail } = require("../services/notification/email.service");
const { buildVendorHubLoginEmail } = require("../services/notification/templates/vendorHubEmail");
const {
  issueMagicToken,
  exchangeMagicToken,
  revokeSession,
  hashOpaque,
  SESSION_TTL_MS,
} = require("../services/vendor/hubSession.service");
const { buildHubView } = require("../services/vendor/hubProjection.service");
const { rotateJobToken, buildJobUrl } = require("../services/vendor/jobToken.service");
const { ensureConnectAccount, createPayoutUpdateLink } = require("../services/ledger/payoutProvider.service");
const VendorOutreach = require("../models/VendorOutreach");
const Appointment = require("../models/Appointment");
const { hubCookieOptions, HUB_COOKIE } = require("../middleware/hubAuth.middleware");
const { normalizeEmail } = require("../services/vendor/vendorIdentity.service");
const env = require("../config/env");

// ALWAYS the same body, whether or not that vendor exists.
//
// Anything else turns this endpoint into a directory: type an address, learn
// from the response whether that contractor works through Artrelo. That is
// worth protecting on its own, and doubly so because the answer would also
// reveal which of a competitor's tradespeople are on the platform.
const LOGIN_ACCEPTED = {
  success: true,
  message: "If that address is on file, a sign-in link is on its way.",
};

exports.requestLoginLink = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      // Shape validation only. A malformed address is a client bug, not a
      // signal about who exists.
      return res.status(400).json({ success: false, message: "Enter a valid email address." });
    }

    const identity = await VendorIdentity.findOne({ emailNormalized: email, mergedInto: null });

    // The whole branch below is invisible to the caller: same status, same
    // body, and the timing difference between "sent an email" and "did
    // nothing" is dominated by the response itself.
    if (identity) {
      const { url } = await issueMagicToken({
        identityId: identity._id,
        ipHash: hashOpaque(req.ip),
        uaHash: hashOpaque(req.get("user-agent")),
      });

      const { subject, html, text } = buildVendorHubLoginEmail({
        vendorName: identity.displayName,
        url,
      });

      await sendEmail({ to: email, subject, html, text, categories: ["vendor_hub_login"] });
      // Stub mode logs rather than sends, which is what keeps the flow
      // exercisable with no mail provider — same as the offer links.
      if (!env.resend_api_key) console.log(`[vendorHubLogin] ${url}`);
    }

    return res.json(LOGIN_ACCEPTED);
  } catch (err) {
    console.error("[requestLoginLink] error", err);
    // Even a failure must not distinguish itself, so the caller still gets the
    // accepted body. The error is ours to see, not theirs.
    return res.json(LOGIN_ACCEPTED);
  }
};

exports.enterWithMagicToken = async (req, res) => {
  try {
    const result = await exchangeMagicToken({
      rawToken: req.params.token,
      ipHash: hashOpaque(req.ip),
      uaHash: hashOpaque(req.get("user-agent")),
    });

    if (!result) {
      return res.status(401).json({
        success: false,
        code: "link_expired",
        message: "That sign-in link has expired or was already used. Request a new one.",
      });
    }

    res.cookie(HUB_COOKIE, result.rawToken, hubCookieOptions({ maxAge: SESSION_TTL_MS }));
    return res.json({ success: true, data: { signedIn: true } });
  } catch (err) {
    console.error("[enterWithMagicToken] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getHub = async (req, res) => {
  try {
    const data = await buildHubView(req.vendorIdentity);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("[getHub] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * Re-issue the link to one of this vendor's own jobs.
 *
 * The recovery path. A vendor who lost the email, or whose link was retired,
 * previously had nowhere to go — and because payout setup lives behind that
 * same link, they could be owed money with no way to enter bank details.
 *
 * Rotating retires the old link deliberately. The hub session is a stronger
 * credential than the emailed link it replaces (it proved control of the
 * address just now), so minting from it is legitimate; and a forwarded copy of
 * the old link stops working, which is the safer default.
 *
 * Scoped by identity: the ref is resolved only among THIS vendor's own
 * appointments, so an opaque ref from someone else's job matches nothing.
 */
exports.issueJobLink = async (req, res) => {
  try {
    const ref = String(req.params.ref || "").trim().toUpperCase();
    if (!ref) return res.status(400).json({ success: false, message: "Missing job reference." });

    const outreaches = await VendorOutreach.find({
      identityId: req.vendorIdentity._id,
      appointmentId: { $ne: null },
    })
      .select("_id appointmentId")
      .lean();

    // Refs are the last six characters of the outreach id, so matching is
    // scoped to this vendor's handful of jobs rather than the whole database.
    const match = outreaches.find(
      (o) => `JOB-${String(o._id).slice(-6).toUpperCase()}` === ref
    );
    if (!match) {
      return res.status(404).json({ success: false, message: "That job isn't on your account." });
    }

    const appointment = await Appointment.findById(match.appointmentId).select("status").lean();
    // Not open yet is not the same as closed.
    if (appointment?.status === "awaiting_tenant") {
      return res.status(409).json({
        success: false,
        code: "awaiting_tenant",
        message:
          "This job isn't open yet — the tenant is still confirming your arrival time. We'll email your job link as soon as they do.",
      });
    }
    if (!appointment || !["scheduled", "work_verifying", "in_review", "disputed"].includes(appointment.status)) {
      return res.status(409).json({
        success: false,
        message: "That job is closed. There's nothing left to submit.",
      });
    }

    const { rawToken } = await rotateJobToken({ appointmentId: match.appointmentId });
    if (!rawToken) {
      return res.status(409).json({
        success: false,
        message: "That job's link can't be reissued. Contact your property manager.",
      });
    }

    return res.json({ success: true, data: { jobUrl: buildJobUrl(rawToken) } });
  } catch (err) {
    console.error("[issueJobLink] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * Start (or resume) payout onboarding from the hub.
 *
 * Bank details belong to the VENDOR, not to a job. Putting them only behind a
 * job link was wrong: job links die when the job closes, so a vendor whose
 * payout was parked at pending_onboarding — exactly the vendor who most needs
 * to add bank details — lost the only route to doing so the moment the work was
 * signed off. The hub is identity-scoped and outlives every job.
 */
exports.startPayouts = async (req, res) => {
  try {
    const identity = req.vendorIdentity;
    if (req.body?.businessWebsite !== undefined) {
      let website;
      try { website = require("../services/ledger/connectRequirements").normalizeBusinessWebsite(req.body.businessWebsite); }
      catch (error) { return res.status(400).json({ success: false, message: error.message }); }
      await VendorIdentity.updateOne({ _id: identity._id }, { $set: { businessWebsite: website } });
      identity.businessWebsite = website;
    }

    if (identity.connectStatus === "enabled") {
      return res.json({ success: true, data: { alreadyEnabled: true, onboardingUrl: null } });
    }

    const base = String(env.app_public_url || "http://localhost:3000").replace(/\/+$/, "");
    const result = await ensureConnectAccount({
      identity,
      returnUrl: `${base}/vendor-hub?payouts=done`,
      refreshUrl: `${base}/vendor-hub?payouts=retry`,
    });

    if (!result.onboardingUrl) {
      return res.json({
        success: true,
        data: {
          alreadyEnabled: false,
          onboardingUrl: null,
          message: "Payouts aren't set up on this platform yet — your property manager will pay you directly.",
        },
      });
    }

    return res.json({
      success: true,
      data: { alreadyEnabled: false, onboardingUrl: result.onboardingUrl },
    });
  } catch (err) {
    console.error("[startPayouts] error", err?.message || err);
    return res.status(502).json({
      success: false,
      message: "Couldn't start payout setup. Please try again shortly.",
    });
  }
};

/** Change payout details after setup. Identity-scoped like onboarding. */
exports.payoutUpdateLink = async (req, res) => {
  try {
    const identity = req.vendorIdentity;
    if (identity.connectStatus !== "enabled") {
      return res.status(409).json({ success: false, message: "Set up payouts first." });
    }
    const base = String(env.app_public_url || "http://localhost:3000").replace(/\/+$/, "");
    const result = await createPayoutUpdateLink({
      identity,
      returnUrl: `${base}/vendor-hub?payouts=updated`,
      refreshUrl: `${base}/vendor-hub?payouts=retry`,
    });
    if (!result.url) {
      return res.status(502).json({ success: false, message: "Couldn't open payout settings. Please try again shortly." });
    }
    return res.json({ success: true, data: { url: result.url } });
  } catch (err) {
    console.error("[payoutUpdateLink] error", err?.message || err);
    return res.status(502).json({ success: false, message: "Couldn't open payout settings. Please try again shortly." });
  }
};

exports.signOut = async (req, res) => {
  try {
    await revokeSession(req.cookies?.[HUB_COOKIE]);
    res.clearCookie(HUB_COOKIE, hubCookieOptions());
    return res.json({ success: true });
  } catch (err) {
    console.error("[signOut] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.LOGIN_ACCEPTED = LOGIN_ACCEPTED;
