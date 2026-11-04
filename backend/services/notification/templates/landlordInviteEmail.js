// The email that brings a beta landlord in.
//
// Public sign-up is shut, so this link is the ONLY way to get a landlord
// account. It is therefore worth being plain about what it is and how long it
// lasts: someone who reads it a fortnight later should know why it failed
// before they conclude we are broken.
//
// Uses renderLayout/renderButton from emailLayout, like vendorHubEmail.js, so
// this renders in the clients that layout was already tested against —
// table-based, inline styles, nothing relying on a <style> block Outlook drops.
//
// renderLayout splices bodyHtml between two <tr> siblings, so bodyHtml MUST be
// a run of <tr> rows. Bare <p>/<div> does not merely look off: the parser
// foster-parents non-table content out of the table, dumping the copy onto the
// grey canvas above the white card. Every row carries its own bgcolor AND
// inline background-color, because Gmail's dark-mode inverter blacks out
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

// "in 7 days" reads better than a timestamp in a timezone the reader may not be
// in, and it cannot go stale in a forwarded copy the way "expires on the 4th"
// silently does.
function describeWindow(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return "shortly";
  if (n === 1) return "in 1 day";
  return `in ${Math.round(n)} days`;
}

/**
 * The invite.
 *
 * `firstName` is what the inviter typed and is escaped like any other
 * untrusted string — it reaches this template from a CLI argument and, later,
 * from a landlord-facing form.
 *
 * `accountExists` changes the copy rather than the link. Someone who already
 * has a tenant account is ADDING a landlord role to it with their existing
 * password, and telling them so up front avoids the "why is it asking for a
 * password I already have" pause on the page.
 */
function buildLandlordInviteEmail({ firstName, url, expiresInDays = 7, accountExists = false }) {
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const opener = firstName
    ? `Hi ${escapeHtml(firstName)} — you've been invited to set up your Artrelo landlord account.`
    : "You've been invited to set up your Artrelo landlord account.";

  const secondLine = accountExists
    ? "You already have an Artrelo account for this address, so you'll sign in with your existing " +
      "password and we'll add landlord access to it."
    : "Artrelo keeps your properties, tenants and maintenance requests in one place. " +
      "Setting up takes a minute.";

  const window = describeWindow(expiresInDays);

  const bodyHtml = [
    row(
      "12px 32px 0 32px",
      `${heading("You're invited to Artrelo")}${paragraph(`${opener}<br><br>${secondLine}`)}`
    ),
    row("26px 32px 6px 32px", renderButton({ href: url, label: accountExists ? "Add landlord access" : "Set up your account" })),
    row("12px 32px 8px 32px", note(`This invite is for you alone and expires ${window}.`)),
  ].join("\n");

  return {
    subject: "You're invited to Artrelo",
    html: renderLayout({
      title: "You're invited to Artrelo",
      preheader: `Set up your Artrelo landlord account — this invite expires ${window}.`,
      bodyHtml,
      footerHtml:
        "This invite is unique to you — please don't forward it.<br>" +
        "If you weren't expecting it, ignore this email; nothing will be created.",
    }),
    text:
      `${greeting}\n\n` +
      "You've been invited to set up your Artrelo landlord account.\n\n" +
      `${
        accountExists
          ? "You already have an Artrelo account for this address, so you'll sign in with your " +
            "existing password and we'll add landlord access to it."
          : "Artrelo keeps your properties, tenants and maintenance requests in one place."
      }\n\n` +
      `${url}\n\n` +
      `This invite is for you alone and expires ${window}.\n` +
      "If you weren't expecting it, ignore this email; nothing will be created.\n",
  };
}

module.exports = { buildLandlordInviteEmail, describeWindow };
