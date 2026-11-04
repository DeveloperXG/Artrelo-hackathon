// The marketing contact-form notification: HTML part + plain-text alternative.
//
// This is the one template whose every field is attacker-controlled — anyone on
// the internet can POST the form. Escaping is not optional here, and the
// visitor's text is never allowed into the subject line unescaped or into any
// href. The reply path is a Reply-To header set by the caller, not a link.

const {
  BRAND,
  INK,
  MUTED,
  BORDER,
  SURFACE,
  escapeHtml,
  renderLayout,
} = require("./emailLayout");

function renderRow(label, value) {
  return `<tr>
  <td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:${MUTED};width:130px;vertical-align:top;">${escapeHtml(
    label
  )}</td>
  <td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;color:${INK};font-weight:600;vertical-align:top;">${escapeHtml(
    value
  )}</td>
</tr>`;
}

function buildContactInquiryEmail({ name, email, company, size, message, submittedAt }) {
  const subject = `Sales inquiry — ${name} (${company})`;
  const preheader = `${company} · ${size} · replies go straight to ${email}`;

  // Preserve the visitor's paragraph breaks without letting markup through.
  const messageHtml = escapeHtml(message).replace(/\r?\n/g, "<br>");

  const bodyHtml = `
<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:4px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;">
    <h1 style="margin:12px 0 4px 0;font-family:Helvetica,Arial,sans-serif;font-size:22px;line-height:30px;font-weight:700;color:${INK};letter-spacing:-0.02em;">New sales inquiry</h1>
    <p style="margin:0 0 20px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:${MUTED};">Submitted from the contact page. Hit reply to respond directly to ${escapeHtml(
      name
    )}.</p>
  </td>
</tr>
<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:0 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid ${BORDER};border-bottom:1px solid ${BORDER};padding:8px 0;">
      ${renderRow("Name", name)}
      ${renderRow("Email", email)}
      ${renderRow("Company", company)}
      ${renderRow("Portfolio size", size)}
      ${renderRow("Received", submittedAt)}
    </table>
  </td>
</tr>
<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:20px 32px 8px 32px;font-family:Helvetica,Arial,sans-serif;">
    <p style="margin:0 0 8px 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;font-weight:600;color:${BRAND};text-transform:uppercase;letter-spacing:0.06em;">How can we help?</p>
    <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:${INK};">${messageHtml}</p>
  </td>
</tr>`;

  const footerHtml = `Sent by the Artrelo marketing site contact form. The sender's address is set as Reply-To, so replying reaches them directly.`;

  const html = renderLayout({ title: subject, preheader, bodyHtml, footerHtml });

  const text = [
    "New sales inquiry",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
    `Company: ${company}`,
    `Portfolio size: ${size}`,
    `Received: ${submittedAt}`,
    "",
    "How can we help?",
    message,
    "",
    "Reply to this email to respond directly to the sender.",
  ].join("\n");

  return { subject, html, text, preheader };
}

module.exports = { buildContactInquiryEmail };
