// The counter-offer email: "we authorized $X — can you do it for that?".
//
// Sent only when the manager authorizes an amount between the vendor's quoteLow
// and quoteHigh. When they authorize at or above quoteHigh the job simply books
// and this email is never sent — the vendor has nothing to decide, and telling
// them the manager would have paid more only anchors their next quote upward.
//
// Privacy rule, inherited from vendorOutreachEmail.js and still binding even
// though this vendor has already accepted and been shown the address: NO street
// address, NO unit number, NO tenant name. That rule is justified by
// forwardability and lock-screen previews, not by the acceptance gate. The
// address lives on the portal page, behind the token.
//
// The amount IS disclosed here. That is the entire point of the message, and it
// is the one sanctioned disclosure of the manager's authorization — see the
// authorizedCeiling comment in models/VendorOutreach.js.

const {
  BRAND,
  INK,
  MUTED,
  SURFACE,
  escapeHtml,
  renderLayout,
  renderButton,
} = require("./emailLayout");

function formatDeadline(deadline, timeZone) {
  if (!deadline) return "soon";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(deadline));
}

function formatMoney(amount, currency = "CAD") {
  const value = Number(amount || 0);
  return `$${value.toLocaleString("en-CA")} ${currency}`;
}

function buildVendorCounterOfferEmail({
  vendorName,
  amount,
  currency = "CAD",
  quotedLow,
  quotedHigh,
  responseUrl,
  deadlineAt,
  timeZone = "America/Regina",
  note = "",
  managerName,
  managerCompany,
  category = "Maintenance",
  city = "your service area",
}) {
  const deadlineLabel = formatDeadline(deadlineAt, timeZone);
  const amountLabel = formatMoney(amount, currency);
  const manager = managerCompany || managerName || "the property manager";
  const hasRange = quotedLow != null && quotedHigh != null;
  const rangeLabel = hasRange
    ? `$${Number(quotedLow).toLocaleString("en-CA")}–$${Number(quotedHigh).toLocaleString("en-CA")}`
    : null;

  const subject = `Can you do this job for ${amountLabel}?`;
  const preheader = `${manager} approved ${amountLabel} for the ${category.toLowerCase()} job in ${city}. Confirm by ${deadlineLabel}.`;

  const bodyHtml = `
<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:12px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;">
    <span style="display:inline-block;padding:4px 10px;border-radius:999px;background-color:#ffedd5;color:#c2410c;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">Price confirmation</span>
    <h1 style="margin:14px 0 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:24px;line-height:30px;font-weight:700;color:${INK};">Can you do it for ${escapeHtml(
      amountLabel
    )}?</h1>
    <p style="margin:0 0 4px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:${MUTED};">Hello ${escapeHtml(
      vendorName
    )} — thanks for accepting the ${escapeHtml(
    category.toLowerCase()
  )} job in ${escapeHtml(city)}. ${escapeHtml(
    manager
  )} has approved a specific amount for it.</p>
  </td>
</tr>

<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:20px 32px 0 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr>
        <td bgcolor="#f8fafc" style="background-color:#f8fafc;border-left:3px solid ${BRAND};border-radius:0 8px 8px 0;padding:16px;font-family:Helvetica,Arial,sans-serif;">
          <div style="font-size:13px;line-height:18px;color:${MUTED};">Approved amount</div>
          <div style="margin-top:2px;font-size:26px;line-height:32px;font-weight:700;color:${INK};">${escapeHtml(
            amountLabel
          )}</div>
          ${
            rangeLabel
              ? `<div style="margin-top:8px;font-size:13px;line-height:19px;color:${MUTED};">You quoted ${escapeHtml(
                  rangeLabel
                )}.</div>`
              : ""
          }
        </td>
      </tr>
    </table>
  </td>
</tr>
${
  note
    ? `
<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:16px 32px 0 32px;">
    <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:${INK};white-space:pre-line;">${escapeHtml(
      note
    )}</p>
  </td>
</tr>`
    : ""
}

<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:26px 32px 6px 32px;">
    ${renderButton({ href: responseUrl, label: "Confirm or decline" })}
  </td>
</tr>

<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:12px 32px 8px 32px;">
    <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:${MUTED};text-align:center;">Please answer by <strong style="color:${INK};">${escapeHtml(
    deadlineLabel
  )}</strong>. Nothing is booked until you confirm — if this doesn't work for you, decline and the job goes to another provider.</p>
  </td>
</tr>`;

  const footerHtml = `This is a new link, unique to you — please don't forward it. Any earlier link for this job no longer works.<br>Sent by Artrelo on behalf of ${escapeHtml(
    manager
  )}.`;

  const html = renderLayout({ title: subject, preheader, bodyHtml, footerHtml });

  // Plain-text alternative is mandatory — never ship HTML-only.
  const text = [
    `Hello ${vendorName},`,
    "",
    `Thanks for accepting the ${category.toLowerCase()} job in ${city}.`,
    `${manager} has approved ${amountLabel} for it.`,
    rangeLabel ? `You quoted ${rangeLabel}.` : null,
    "",
    `Approved amount: ${amountLabel}`,
    "",
    note || null,
    note ? "" : null,
    "Confirm or decline here:",
    responseUrl,
    "",
    `Please answer by ${deadlineLabel}.`,
    "Nothing is booked until you confirm — if this doesn't work for you, decline and the job goes to another provider.",
    "",
    "This is a new link, unique to you — please don't forward it. Any earlier link for this job no longer works.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  return { subject, html, text, preheader };
}

module.exports = { buildVendorCounterOfferEmail };
