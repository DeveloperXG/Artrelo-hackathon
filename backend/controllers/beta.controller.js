// A landlord's view of their own free beta, and the founding agreement.
//
//   GET  /landlords/beta[?highlights=1]   status for the banner (cheap), or with
//                                         highlights=1 the proof numbers for the
//                                         agreement dialog (a few bulk queries)
//   POST /landlords/beta/agreement        accept the CURRENT founding agreement
//   POST /landlords/beta/decline          say no to the founding offer (reversible:
//                                         accepting later replaces the decline)
//
// Everything is scoped to req.user.id: a landlord sees only themselves. The
// cohort-wide numbers stay in scripts/beta_metrics.js on purpose -- see the
// header there for why there is no admin screen.

const Landlord = require("../models/Landlord");
const env = require("../config/env");
const { currentAgreement } = require("../config/beta");
const { sendEmail } = require("../services/notification/email.service");
const { buildFoundingWelcomeEmail } = require("../services/notification/templates/foundingWelcomeEmail");
const { buildBetaView } = require("../services/beta/beta.service");
const { buildBetaReport } = require("../services/metrics/betaMetrics.service");
const { logAgentAction } = require("../services/audit/agentAction.service");
const { hashOpaque } = require("../services/vendor/hubSession.service");

const LANDLORD_FIELDS = "email firstName createdAt beta foundingAgreement";

/** The proof numbers, shaped for the dialog and the reminder email. */
async function loadHighlights(landlord, now = new Date()) {
  const report = await buildBetaReport([landlord], { now });
  const s = report.perLandlord[0].summary;
  return {
    requests: s.requests.total,
    completed: s.requests.completed,
    bookedRequests: s.decisions.bookedRequests,
    medianMinutesToBook: s.timeToBook.medianMinutes,
    autopilotRequests: s.decisions.autopilotRequests,
    autopilotPercent: s.decisions.autopilotPercent,
  };
}

exports.getBeta = async (req, res) => {
  try {
    const landlord = await Landlord.findById(req.user.id).select(LANDLORD_FIELDS).lean();
    if (!landlord) return res.status(404).json({ success: false, message: "Landlord not found" });

    const view = buildBetaView(landlord, { agreement: currentAgreement() });

    // Opt-in: the banner loads on every page and must stay one cheap read; only
    // the dialog, which a person deliberately opens, pays for the aggregation.
    if (req.query.highlights === "1" && view.inBeta) {
      // Best effort. The dialog is still useful without the numbers, and a
      // failing metrics query must not make the agreement unreadable.
      view.highlights = await loadHighlights(landlord).catch((err) => {
        console.error("[getBeta] highlights failed", err?.message || err);
        return null;
      });
    }

    return res.json({ success: true, beta: view });
  } catch (err) {
    console.error("[getBeta]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * The confirmation email, sent once per acceptance. It never throws: a mail
 * failure must not turn a recorded acceptance into an error, and the landlord
 * has already seen it succeed on screen. (sendEmail itself reports provider
 * errors rather than raising them; this catches the rest, such as a template
 * fed an unexpected value.)
 *
 * Sent regardless of notificationPreferences.email on purpose: it is a record
 * of an agreement, not a notification, and no other landlord email in the
 * codebase consults that preference either.
 */
async function sendFoundingWelcome({ landlord, agreement, acceptedAt }) {
  try {
    if (!landlord?.email) return;
    const email = buildFoundingWelcomeEmail({
      firstName: landlord.firstName,
      // The terms just SNAPSHOTTED, not whatever the environment says later.
      terms: agreement.terms,
      acceptedAt,
      betaEndsAt: landlord.beta?.endsAt,
      chargeNoticeDays: agreement.chargeNoticeDays,
      appUrl: env.app_public_url,
      timeZone: env.outreach_timezone,
    });
    await sendEmail({
      to: landlord.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
      categories: ["founding_welcome"],
    });
  } catch (err) {
    console.error("[postAgreement] welcome email failed", err?.message || err);
  }
}

exports.postAgreement = async (req, res) => {
  try {
    const agreement = currentAgreement();
    const version = req.body?.version;

    // Accept only the offer the server is currently making. If the wording or
    // numbers changed while the dialog was open, the person must see the new
    // terms rather than agree to ones they never read.
    if (version !== agreement.version) {
      return res.status(409).json({
        success: false,
        code: "agreement_changed",
        message: "The offer was updated. Please review the latest version.",
        agreement: { version: agreement.version, sections: agreement.sections, terms: agreement.terms },
      });
    }

    const landlord = await Landlord.findById(req.user.id).select(LANDLORD_FIELDS).lean();
    if (!landlord) return res.status(404).json({ success: false, message: "Landlord not found" });

    // An account with no beta has no offer to accept.
    if (!landlord.beta?.endsAt) {
      return res.status(409).json({ success: false, code: "no_offer", message: "There is no founding offer on this account." });
    }

    // ALREADY FOUNDING, AT ANY VERSION: a no-op, never a rewrite. Founding is
    // permanent and the snapshot is what "locked in" means. Keying this on the
    // CURRENT version (as it once did) would let a stale client overwrite an
    // older landlord's locked terms with today's. It also keeps the ORIGINAL
    // timestamp, which is the evidence of when they agreed.
    if (landlord.foundingAgreement?.acceptedAt) {
      return res.json({ success: true, beta: buildBetaView(landlord, { agreement }) });
    }

    const now = new Date();
    const foundingAgreement = {
      version: agreement.version,
      acceptedAt: now,
      ipHash: hashOpaque(req.ip),
      // The numbers AS OFFERED, frozen. A later change to the environment
      // changes the next offer, never this one.
      terms: agreement.terms,
    };

    // Guarded on "not yet accepted", so two taps racing write once. $set of the
    // WHOLE subdocument is deliberate: it also clears a previous declinedAt, so
    // someone who declined and changed their mind ends up simply accepted.
    const result = await Landlord.updateOne(
      { _id: landlord._id, "foundingAgreement.acceptedAt": { $exists: false } },
      { $set: { foundingAgreement } }
    );

    if (result?.modifiedCount !== 1) {
      // Lost the race: another request accepted first and is sending the email
      // and writing the audit row. Report where things stand; do neither again.
      const fresh = await Landlord.findById(landlord._id).select(LANDLORD_FIELDS).lean();
      return res.json({ success: true, beta: buildBetaView(fresh || landlord, { agreement }) });
    }

    await logAgentAction({
      landlordId: landlord._id,
      actor: "landlord",
      actionType: "founding_agreement_accepted",
      summary: `Accepted the founding-landlord agreement (${agreement.version})`,
      metadata: { version: agreement.version, terms: agreement.terms },
    });

    await sendFoundingWelcome({ landlord, agreement, acceptedAt: now });

    return res.status(201).json({
      success: true,
      beta: buildBetaView({ ...landlord, foundingAgreement }, { agreement, now }),
    });
  } catch (err) {
    console.error("[postAgreement]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * Say no to the founding offer. Explicit, and reversible: accepting later (the
 * Wallet page keeps a quiet link to the offer) replaces this.
 *
 * Only an OPEN offer can be declined. A founding landlord cannot decline: that
 * would mean giving up locked terms, which nobody asked for and which is a very
 * different thing from "no thanks" -- it is refused rather than quietly done.
 *
 * What declining does NOT do is stop the beta-ending reminders: those double as
 * the notice that the service fee is about to start, which the agreement and
 * the Terms promise every landlord.
 */
exports.postDecline = async (req, res) => {
  try {
    const agreement = currentAgreement();
    const landlord = await Landlord.findById(req.user.id).select(LANDLORD_FIELDS).lean();
    if (!landlord) return res.status(404).json({ success: false, message: "Landlord not found" });

    if (!landlord.beta?.endsAt) {
      return res.status(409).json({ success: false, code: "no_offer", message: "There is no founding offer on this account." });
    }
    if (landlord.foundingAgreement?.acceptedAt) {
      return res.status(409).json({
        success: false,
        code: "already_accepted",
        message: "You've already accepted the founding offer.",
      });
    }
    // Idempotent, and it keeps the ORIGINAL decline time.
    if (landlord.foundingAgreement?.declinedAt) {
      return res.json({ success: true, beta: buildBetaView(landlord, { agreement }) });
    }

    const now = new Date();
    // Both guards matter: a decline must never land on an acceptance that won
    // the race, and two declines write once.
    const result = await Landlord.updateOne(
      {
        _id: landlord._id,
        "foundingAgreement.acceptedAt": { $exists: false },
        "foundingAgreement.declinedAt": { $exists: false },
      },
      { $set: { "foundingAgreement.declinedAt": now } }
    );

    if (result?.modifiedCount !== 1) {
      const fresh = await Landlord.findById(landlord._id).select(LANDLORD_FIELDS).lean();
      if (fresh?.foundingAgreement?.acceptedAt) {
        return res.status(409).json({
          success: false,
          code: "already_accepted",
          message: "You've already accepted the founding offer.",
        });
      }
      return res.json({ success: true, beta: buildBetaView(fresh || landlord, { agreement }) });
    }

    await logAgentAction({
      landlordId: landlord._id,
      actor: "landlord",
      actionType: "founding_agreement_declined",
      summary: "Declined the founding-landlord offer",
    });

    return res.json({
      success: true,
      beta: buildBetaView({ ...landlord, foundingAgreement: { ...(landlord.foundingAgreement || {}), declinedAt: now } }, { agreement, now }),
    });
  } catch (err) {
    console.error("[postDecline]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.loadHighlights = loadHighlights;
