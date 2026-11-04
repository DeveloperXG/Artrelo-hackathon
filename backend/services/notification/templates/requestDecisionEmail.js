// The tenant's emails about a rejected request: the rejection (with its appeal
// deadline), the reopen, and the final decision.
//
// These go by email as well as in-app because the appeal window is short and a
// tenant who doesn't open the portal for two days would otherwise miss it. The
// final one has to stand on its own: the request it is about is deleted, so
// there is no page to send them to for the details.
//
// Same layout rules as the other templates: bodyHtml is a run of <tr> rows,
// each with its own bgcolor (see passwordResetEmail.js).

const { INK, MUTED, BORDER, SURFACE, escapeHtml, renderLayout, renderButton } = require("./emailLayout");

const row = (padding, innerHtml) =>
  `<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:${padding};font-family:Helvetica,Arial,sans-serif;">
    ${innerHtml}
  </td>
</tr>`;

const heading = (text) =>
  `<h1 style="margin:0 0 10px 0;font-family:Helvetica,Arial,sans-serif;font-size:22px;line-height:28px;font-weight:700;color:${INK};">${escapeHtml(
    text
  )}</h1>`;

const paragraph = (html) =>
  `<p style="margin:0 0 12px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;color:${MUTED};">${html}</p>`;

const quote = (label, text) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr>
    <td bgcolor="${SURFACE}" style="background-color:${SURFACE};border-left:3px solid ${BORDER};padding:4px 0 4px 14px;font-family:Helvetica,Arial,sans-serif;">
      <div style="font-size:12px;line-height:18px;font-weight:600;color:${MUTED};text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(
        label
      )}</div>
      <div style="font-size:15px;line-height:23px;color:${INK};">${escapeHtml(text)}</div>
    </td>
  </tr>
</table>`;

const list = (items) =>
  `<ol style="margin:0;padding:0 0 0 20px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;color:${MUTED};">${items
    .map((item) => `<li style="margin:0 0 8px 0;">${escapeHtml(item)}</li>`)
    .join("")}</ol>`;

const greet = (firstName) => (firstName ? `Hi ${firstName},` : "Hi,");

function buildRequestRejectedEmail({ firstName, issueTitle, reason, appealWindowHours, url }) {
  const subject = `Your request "${issueTitle}" was rejected`;
  const bodyHtml = [
    row(
      "12px 32px 0 32px",
      `${heading("Your request was rejected")}${paragraph(
        `${escapeHtml(greet(firstName))} your property manager rejected <strong>${escapeHtml(issueTitle)}</strong>.`
      )}`
    ),
    row("4px 32px 12px 32px", quote("Their reason", reason)),
    row(
      "4px 32px 0 32px",
      paragraph(
        `If you think this is a mistake, you can appeal <strong>once</strong> within ${escapeHtml(
          appealWindowHours
        )} hours. Explain what they may have missed. If you don't appeal, the request is removed when the window closes.`
      )
    ),
    row("14px 32px 8px 32px", renderButton({ href: url, label: "Review and appeal" })),
  ].join("\n");
  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: `You have ${appealWindowHours} hours to appeal.`,
      bodyHtml,
      footerHtml: "You're receiving this because you sent this maintenance request through Artrelo.",
    }),
    text:
      `${greet(firstName)}\n\nYour property manager rejected "${issueTitle}".\n\nTheir reason: ${reason}\n\n` +
      `If you think this is a mistake, you can appeal once within ${appealWindowHours} hours:\n${url}\n\n` +
      "If you don't appeal, the request is removed when the window closes.\n",
  };
}

function buildRequestReopenedEmail({ firstName, issueTitle, wasAppeal, url }) {
  const subject = wasAppeal ? `Your appeal was accepted: "${issueTitle}"` : `Your request "${issueTitle}" is back on`;
  const lead = wasAppeal
    ? "your property manager accepted your appeal and reopened the request."
    : "your property manager withdrew their rejection and reopened the request.";
  const bodyHtml = [
    row(
      "12px 32px 0 32px",
      `${heading(wasAppeal ? "Your appeal was accepted" : "Your request was reopened")}${paragraph(
        `${escapeHtml(greet(firstName))} ${escapeHtml(lead)} <strong>${escapeHtml(
          issueTitle
        )}</strong> is back in the queue. It doesn't use another of your requests.`
      )}`
    ),
    row("14px 32px 8px 32px", renderButton({ href: url, label: "View the request" })),
  ].join("\n");
  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: "It's back in the queue.",
      bodyHtml,
      footerHtml: "You're receiving this because you sent this maintenance request through Artrelo.",
    }),
    text: `${greet(firstName)}\n\n${lead[0].toUpperCase()}${lead.slice(1)} "${issueTitle}" is back in the queue. It doesn't use another of your requests.\n\n${url}\n`,
  };
}

function buildRequestFinalRejectionEmail({ firstName, issueTitle, lead, reason, nextSteps, url }) {
  const subject = `Final decision on "${issueTitle}"`;
  const bodyHtml = [
    row(
      "12px 32px 0 32px",
      `${heading("Final decision on your request")}${paragraph(
        `${escapeHtml(greet(firstName))} ${escapeHtml(lead)}`
      )}`
    ),
    row("4px 32px 14px 32px", quote("Their reason", reason)),
    row("4px 32px 0 32px", `${paragraph(`<strong style="color:${INK};">What you can do next</strong>`)}${list(nextSteps)}`),
    row("14px 32px 8px 32px", renderButton({ href: url, label: "Open your requests" })),
  ].join("\n");
  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: "This request is closed. Here's what you can do next.",
      bodyHtml,
      footerHtml: "You're receiving this because you sent this maintenance request through Artrelo.",
    }),
    text:
      `${greet(firstName)}\n\n${lead}\n\nTheir reason: ${reason}\n\nWhat you can do next:\n` +
      nextSteps.map((step, i) => `${i + 1}. ${step}`).join("\n") +
      `\n\n${url}\n`,
  };
}

module.exports = {
  buildRequestRejectedEmail,
  buildRequestReopenedEmail,
  buildRequestFinalRejectionEmail,
};
