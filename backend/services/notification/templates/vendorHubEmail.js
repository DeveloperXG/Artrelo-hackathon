// Vendor hub emails: the sign-in link, and the one-time introduction.
//
// Both are plain and short on purpose. A contractor reads these on a phone,
// between jobs, and the only thing that matters is the button.
//
// Uses renderLayout/renderButton from emailLayout so these render in the same
// clients the outreach email was already tested against — table-based, inline
// styles, no reliance on a <style> block Outlook would drop.
//
// renderLayout splices bodyHtml between two <tr> siblings, so bodyHtml MUST be
// a run of <tr> rows. Bare <p>/<div> here does not merely look off: the HTML
// parser foster-parents non-table content out of the table entirely, which
// dumps the copy onto the grey canvas above the white card. Every row carries
// its own bgcolor + inline background-color for the reason in emailLayout's
// header — Gmail's dark-mode inverter blacks out transparent cells.

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

/**
 * The sign-in link.
 *
 * States the expiry out loud. A vendor who opens this an hour later should know
 * why it failed before they try, rather than concluding the system is broken.
 */
function buildVendorHubLoginEmail({ vendorName, url }) {
  const greeting = vendorName ? `Hi ${vendorName},` : "Hi,";
  const opener = vendorName
    ? `Hi ${escapeHtml(vendorName)} — here's your link to sign in and see the jobs you're working on.`
    : "Here's your link to sign in and see the jobs you're working on.";

  const bodyHtml = [
    row("12px 32px 0 32px", `${heading("Your sign-in link")}${paragraph(opener)}`),
    row("26px 32px 6px 32px", renderButton({ href: url, label: "Sign in" })),
    row("12px 32px 8px 32px", note("This link works once and expires in 15 minutes.")),
  ].join("\n");

  return {
    subject: "Your Artrelo sign-in link",
    html: renderLayout({
      title: "Sign in to Artrelo",
      preheader: "Your sign-in link — works once, expires in 15 minutes.",
      bodyHtml,
      footerHtml:
        "This link is unique to you — please don't forward it.<br>If you didn't ask for it, ignore this email; nothing will change.",
    }),
    text:
      `${greeting}\n\n` +
      `Sign in to Artrelo to see the jobs you're working on:\n${url}\n\n` +
      "This link works once and expires in 15 minutes.\n" +
      "If you didn't ask for it, ignore this email.\n",
  };
}

// The hub introduction moved to the job-complete email
// (templates/vendorLifecycleEmail.js): past jobs and payouts mean something
// once a job is done, not when a vendor has one job they cannot open yet.

module.exports = { buildVendorHubLoginEmail };
