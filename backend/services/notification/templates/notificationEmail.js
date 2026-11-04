// The email copy of an in-app notification that needs a person to act.
//
// One template for all of them on purpose: the in-app title and message are
// already written for the reader, so the email says the same thing and links
// to the page where it is dealt with. An emergency gets a red banner and an
// EMERGENCY subject, because it is the one email that must not read like the
// others in an inbox at 2am.
//
// Same layout rules as the other templates: bodyHtml is a run of <tr> rows,
// each with its own bgcolor (see passwordResetEmail.js).

const { INK, MUTED, SURFACE, escapeHtml, renderLayout, renderButton } = require("./emailLayout");

const ALERT = "#b91c1c";
const ALERT_SURFACE = "#fee2e2";

const row = (padding, innerHtml, bg = SURFACE) =>
  `<tr>
  <td class="pad" bgcolor="${bg}" style="background-color:${bg};padding:${padding};font-family:Helvetica,Arial,sans-serif;">
    ${innerHtml}
  </td>
</tr>`;

const heading = (text) =>
  `<h1 style="margin:0 0 10px 0;font-family:Helvetica,Arial,sans-serif;font-size:22px;line-height:28px;font-weight:700;color:${INK};">${escapeHtml(
    text
  )}</h1>`;

const paragraph = (text) =>
  `<p style="margin:0 0 12px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;color:${MUTED};">${escapeHtml(
    text
  )}</p>`;

const greet = (firstName) => (firstName ? `Hi ${firstName},` : "Hi,");

/**
 * @param {object}  p
 * @param {string}  p.title        the notification's title
 * @param {string}  p.message      the notification's message
 * @param {string}  p.url          where it is dealt with
 * @param {string}  p.buttonLabel
 * @param {boolean} [p.emergency]  red banner and an EMERGENCY subject
 * @param {string}  [p.firstName]
 * @param {"landlord"|"tenant"} p.audience  only changes the footer
 */
function buildNotificationEmail({ title, message, url, buttonLabel, emergency = false, firstName, audience }) {
  // The bell title may already say "Emergency: ..."; the subject says it once.
  const subject = emergency ? `EMERGENCY: ${String(title).replace(/^emergency:\s*/i, "")}` : title;
  const banner = emergency
    ? row(
        "14px 32px",
        `<div style="font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:18px;font-weight:700;letter-spacing:0.06em;color:${ALERT};">EMERGENCY</div>`,
        ALERT_SURFACE
      )
    : null;
  const bodyHtml = [
    banner,
    row("12px 32px 0 32px", `${heading(title)}${paragraph(greet(firstName))}${paragraph(message)}`),
    row("14px 32px 8px 32px", renderButton({ href: url, label: buttonLabel })),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: message,
      bodyHtml,
      footerHtml:
        audience === "tenant"
          ? "You're receiving this because you sent a maintenance request through Artrelo."
          : "You're receiving this because you manage this property on Artrelo.",
    }),
    text: `${emergency ? "EMERGENCY\n\n" : ""}${greet(firstName)}\n\n${title}\n\n${message}\n\n${buttonLabel}: ${url}\n`,
  };
}

module.exports = { buildNotificationEmail };
