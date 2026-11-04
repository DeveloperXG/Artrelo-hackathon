// The email a landlord gets the moment they accept the founding offer.
//
// IT IS A RECORD AS MUCH AS A WELCOME. It is the one place, outside the app,
// that says what was agreed and when, so everything in it is a fact from the
// agreement the landlord actually accepted:
//   * the terms come from the SNAPSHOT stored on their account at acceptance,
//     never from today's configuration -- if the offer changes next month,
//     this email still describes what THEY accepted;
//   * nothing is promised that the agreement text does not already promise;
//   * a rate that was not set yet is said to be "to be confirmed, with notice",
//     never invented or left blank;
//   * the agreement's version hash is internal and never appears.
//
// Same layout rules as landlordInviteEmail.js / betaReminderEmail.js: the body
// is a run of <tr> rows (renderLayout splices it between two siblings), and
// every row carries its own bgcolor AND inline background-color, because
// Gmail's dark-mode inverter blacks out transparent cells.
//
// The plain-text part says everything the HTML does. Some clients show only it.

const { INK, MUTED, BORDER, SURFACE, BRAND, escapeHtml, renderLayout, renderButton } = require("./emailLayout");
const { describeFee } = require("../../../config/beta");

// A soft brand tint for the "locked in" card. A mid-tone survives Gmail's
// dark-mode inversion where pure white-on-black pairs do not.
const TINT = "#eff6ff";
const TINT_BORDER = "#bfdbfe";

const row = (padding, innerHtml) =>
  `<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:${padding};font-family:Helvetica,Arial,sans-serif;">
    ${innerHtml}
  </td>
</tr>`;

const heading = (text) =>
  `<h1 style="margin:0 0 10px 0;font-family:Helvetica,Arial,sans-serif;font-size:24px;line-height:30px;font-weight:700;color:${INK};">${escapeHtml(
    text
  )}</h1>`;

const sectionTitle = (text) =>
  `<h2 style="margin:0 0 10px 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:22px;font-weight:700;color:${INK};">${escapeHtml(
    text
  )}</h2>`;

const paragraph = (text) =>
  `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;color:${MUTED};">${escapeHtml(
    text
  )}</p>`;

const note = (text) =>
  `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:${MUTED};text-align:center;">${escapeHtml(
    text
  )}</p>`;

/** A labelled fact inside the tinted card. */
const fact = (label, value, isLast) =>
  `<tr>
      <td bgcolor="${TINT}" style="background-color:${TINT};padding:0 18px ${isLast ? "16px" : "12px"} 18px;font-family:Helvetica,Arial,sans-serif;">
        <div style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND};">${escapeHtml(label)}</div>
        <div style="font-size:15px;line-height:22px;color:${INK};">${escapeHtml(value)}</div>
      </td>
    </tr>`;

/** One step in "what happens next": a bold lead-in, then the detail. */
const step = (label, text) =>
  `<tr>
      <td bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:0 0 14px 0;font-family:Helvetica,Arial,sans-serif;border-left:3px solid ${BORDER};">
        <div style="padding-left:14px;">
          <div style="font-size:14px;line-height:20px;font-weight:700;color:${INK};">${escapeHtml(label)}</div>
          <div style="font-size:14px;line-height:21px;color:${MUTED};">${escapeHtml(text)}</div>
        </div>
      </td>
    </tr>`;

/** "October 11, 2026" in the portal's own timezone, or "" for anything unusable. */
function formatDate(value, timeZone) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: timeZone || "America/Regina" }).format(date);
  } catch {
    // An unknown IANA name must not take the email down.
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(date);
  }
}

const wholeNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * The three things they locked in, as plain sentences. Each is only as specific
 * as the snapshot allows -- a snapshot taken before any rate existed says so.
 */
function lockedInFacts(terms, noticeDays) {
  const flatCents = wholeNumber(terms?.serviceFee?.flatCents, 0);
  const percent = wholeNumber(terms?.serviceFee?.percent, 0);
  const discount = wholeNumber(terms?.planDiscountPercent, 0);
  const fee = describeFee({ flatCents, percent });

  return {
    hasFee: Boolean(fee),
    serviceFee: fee
      ? `${fee}. As a founding landlord, this rate is locked in for you.`
      : `To be confirmed. We'll tell you the exact amount at least ${noticeDays} days before any fee applies, and it will be locked in for you.`,
    planDiscount:
      discount > 0
        ? `${discount}% off any Artrelo plan, locked in at the price shown when plans launch.`
        : "A founding rate on any Artrelo plan, confirmed in writing before plans launch.",
    notice: `At least ${noticeDays} days' notice before any charge begins.`,
  };
}

/**
 * @param {object} p
 * @param {string} [p.firstName]
 * @param {{serviceFee?: {flatCents?: number, percent?: number}, planDiscountPercent?: number}} [p.terms]
 *        the snapshot stored at acceptance
 * @param {Date|string} [p.acceptedAt]
 * @param {Date|string} [p.betaEndsAt]
 * @param {number} [p.chargeNoticeDays]
 * @param {string} [p.appUrl]            where the button goes
 * @param {string} [p.timeZone]          IANA name; the portal's own
 */
function buildFoundingWelcomeEmail({
  firstName,
  terms,
  acceptedAt,
  betaEndsAt,
  chargeNoticeDays = 30,
  appUrl = "",
  timeZone,
} = {}) {
  const noticeDays = Math.max(1, Math.round(wholeNumber(chargeNoticeDays, 30)));
  const facts = lockedInFacts(terms, noticeDays);
  const accepted = formatDate(acceptedAt || new Date(), timeZone);
  const betaEnd = formatDate(betaEndsAt, timeZone);
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const url = `${String(appUrl || "").replace(/\/+$/, "")}/dashboard`;

  const subject = "You're a founding Artrelo landlord";
  const intro =
    `${greeting} thank you for being one of the first landlords on Artrelo. ` +
    `${accepted ? `As of ${accepted}, your` : "Your"} founding terms are locked in.`;

  // What happens next. Each entry is [lead-in, detail]; the beta-end date is
  // dropped (not guessed) when it is not known.
  const steps = [
    [
      betaEnd ? `Until ${betaEnd}` : "For the length of your beta",
      "Artrelo is free for you, and the service fee is waived on every job.",
    ],
    [
      "Before it ends",
      "We'll email you reminders, so the end of the beta is never a surprise.",
    ],
    [
      "When the beta ends",
      facts.hasFee
        ? "Your access continues. The service fee applies to each completed job, at your founding rate."
        : `Your access continues. A small service fee on completed jobs may apply, and we'll tell you the exact amount at least ${noticeDays} days beforehand.`,
    ],
    [
      "When subscription plans launch",
      "We'll email you the plans and your founding rate before anything is billed. You choose a plan; nothing is billed without your say.",
    ],
  ];

  const lockedCard = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${TINT}" style="background-color:${TINT};border:1px solid ${TINT_BORDER};border-radius:10px;border-collapse:separate;">
    <tr>
      <td bgcolor="${TINT}" style="background-color:${TINT};padding:16px 18px 12px 18px;border-radius:10px 10px 0 0;font-family:Helvetica,Arial,sans-serif;">
        <div style="font-size:16px;line-height:22px;font-weight:700;color:${INK};">What you've locked in</div>
      </td>
    </tr>
    ${fact("Service fee", facts.serviceFee, false)}
    ${fact("Plan discount", facts.planDiscount, false)}
    ${fact("Notice", facts.notice, true)}
  </table>`;

  const timeline = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
    ${steps.map(([label, text]) => step(label, text)).join("\n    ")}
  </table>`;

  const bodyHtml = [
    row("12px 32px 0 32px", `${heading("You're a founding landlord")}${paragraph(intro)}`),
    row("22px 32px 0 32px", lockedCard),
    row("26px 32px 0 32px", `${sectionTitle("What happens next")}${timeline}`),
    row(
      "8px 32px 6px 32px",
      `${paragraph("You don't need to do anything. Your founding terms are on your account, and we'll write to you before any charge begins.")}`
    ),
    row("18px 32px 6px 32px", renderButton({ href: url, label: "Open Artrelo" })),
    row(
      "12px 32px 8px 32px",
      note(
        `${accepted ? `Keep this email as your record: you accepted the founding offer on ${accepted}. ` : "Keep this email as your record. "}` +
          "Questions? Just reply to this email."
      )
    ),
  ].join("\n");

  const text =
    `${greeting}\n\n` +
    `Thank you for being one of the first landlords on Artrelo. ${accepted ? `As of ${accepted}, your` : "Your"} founding terms are locked in.\n\n` +
    "WHAT YOU'VE LOCKED IN\n" +
    `- Service fee: ${facts.serviceFee}\n` +
    `- Plan discount: ${facts.planDiscount}\n` +
    `- Notice: ${facts.notice}\n\n` +
    "WHAT HAPPENS NEXT\n" +
    steps.map(([label, detail]) => `- ${label}: ${detail}`).join("\n") +
    "\n\n" +
    "You don't need to do anything. Your founding terms are on your account, and we'll write to you before any charge begins.\n\n" +
    `Open Artrelo: ${url}\n\n` +
    `${accepted ? `Keep this email as your record: you accepted the founding offer on ${accepted}. ` : "Keep this email as your record. "}` +
    "Questions? Just reply to this email.\n";

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: "Your founding terms are locked in. Here's what that means and what happens next.",
      bodyHtml,
      footerHtml:
        "You're receiving this because you accepted the Artrelo founding-landlord offer.<br>" +
        "Replies reach our support team.",
    }),
    text,
  };
}

module.exports = { buildFoundingWelcomeEmail, lockedInFacts, formatDate };
