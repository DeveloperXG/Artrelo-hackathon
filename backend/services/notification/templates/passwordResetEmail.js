// The password reset email.
//
// Two things this has to say that the invite does not:
//
//   * the window is SHORT. Thirty minutes, stated plainly, because somebody who
//     comes back to it after lunch needs to know why it failed;
//   * "if this wasn't you, nothing has changed". A reset email is the one we
//     send to people who did not ask for it — that is the whole point of not
//     revealing whether an address has an account — so it must not read as an
//     alarm. Nothing happens until the link is used.
//
// Uses renderLayout/renderButton from emailLayout, like the other two templates,
// so this renders in the clients that layout was tested against. bodyHtml MUST
// be a run of <tr> rows: bare <p>/<div> gets foster-parented out of the table
// and lands on the grey canvas above the card. Every row carries its own bgcolor
// AND inline background-color, because Gmail's dark-mode inverter blacks out
// transparent cells.

const { INK, MUTED, SURFACE, escapeHtml, renderLayout, renderButton } = require("./emailLayout");

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

const paragraph = (html) =>
  `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;color:${MUTED};">${html}</p>`;

const note = (text) =>
  `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:${MUTED};text-align:center;">${escapeHtml(
    text
  )}</p>`;

function describeMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return "shortly";
  if (n === 1) return "in 1 minute";
  if (n >= 120) return `in ${Math.round(n / 60)} hours`;
  if (n === 60) return "in 1 hour";
  return `in ${Math.round(n)} minutes`;
}

/**
 * The reset link.
 *
 * `firstName` is escaped like any other stored string. It is absent whenever the
 * account has no profile yet, so the copy degrades to a plain greeting rather
 * than "Hi undefined,".
 */
function buildPasswordResetEmail({ firstName, url, expiresInMinutes = 30 }) {
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const opener = firstName
    ? `Hi ${escapeHtml(firstName)} — someone asked to reset the password for your Artrelo account.`
    : "Someone asked to reset the password for your Artrelo account.";

  const window = describeMinutes(expiresInMinutes);

  const bodyHtml = [
    row(
      "12px 32px 0 32px",
      `${heading("Reset your password")}${paragraph(
        `${opener}<br><br>Choose a new one using the button below. ` +
          "Signing in again on your other devices will be necessary afterwards."
      )}`
    ),
    row("26px 32px 6px 32px", renderButton({ href: url, label: "Choose a new password" })),
    row("12px 32px 8px 32px", note(`This link works once and expires ${window}.`)),
  ].join("\n");

  return {
    subject: "Reset your Artrelo password",
    html: renderLayout({
      title: "Reset your Artrelo password",
      preheader: `Choose a new password — this link works once and expires ${window}.`,
      bodyHtml,
      footerHtml:
        "If you didn't ask for this, you can ignore this email — your password has not changed " +
        "and nobody can change it without this link.",
    }),
    text:
      `${greeting}\n\n` +
      "Someone asked to reset the password for your Artrelo account. " +
      "Choose a new one here:\n" +
      `${url}\n\n` +
      `This link works once and expires ${window}.\n` +
      "You'll need to sign in again on your other devices afterwards.\n\n" +
      "If you didn't ask for this, ignore this email — your password has not changed, " +
      "and nobody can change it without this link.\n",
  };
}

module.exports = { buildPasswordResetEmail, describeMinutes };
