// The vendor outreach email: HTML part + mandatory plain-text alternative.
//
// Privacy rule for this file: the subject line, preheader, and body carry NO
// street address, NO unit number, and NO tenant name. A vendor learns those
// only after accepting, on the response form. Email is forwardable and lands in
// inbox previews on lock screens; treat it as public.

const {
  BRAND,
  INK,
  MUTED,
  BORDER,
  SURFACE,
  escapeHtml,
  renderLayout,
  renderButton,
} = require("./emailLayout");

const TIER_ACCENTS = {
  emergency: { bg: "#fee2e2", fg: "#b91c1c", label: "Emergency" },
  urgent: { bg: "#ffedd5", fg: "#c2410c", label: "Urgent" },
  normal: { bg: "#e0f2fe", fg: "#0369a1", label: "Standard" },
  low: { bg: "#f1f5f9", fg: "#475569", label: "Low priority" },
};

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

function renderRow(label, value) {
  return `<tr>
  <td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;color:${MUTED};width:38%;vertical-align:top;">${escapeHtml(
    label
  )}</td>
  <td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;color:${INK};font-weight:600;vertical-align:top;">${escapeHtml(
    value
  )}</td>
</tr>`;
}

// The manager's message as paragraphs: split on blank lines, leading whitespace
// dropped, single newlines kept as <br>. Replaces `white-space:pre-line`, which
// rendered a landlord's edit with indented lines and stray gaps. Mirrored by
// frontend/src/app/components/MessageParagraphs.tsx so the landlord's preview,
// this email and the vendor's page agree.
function splitParagraphs(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    )
    .filter((lines) => lines.length > 0);
}

function renderParagraphs(text) {
  const paragraphs = splitParagraphs(text);
  return paragraphs
    .map(
      (lines, index) =>
        `<p style="margin:0 0 ${index === paragraphs.length - 1 ? 0 : 10}px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:${INK};">${lines
          .map(escapeHtml)
          .join("<br>")}</p>`
    )
    .join("\n");
}

function sectionLabel(label) {
  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${MUTED};padding-bottom:8px;">${escapeHtml(
    label
  )}</div>`;
}

function buildVendorOutreachEmail({
  vendorName,
  brief,
  offeredWindows = [],
  responseUrl,
  responseDeadlineAt,
  tier = "normal",
  timeZone = "America/Regina",
  messageBody = "",
  managerName,
  managerCompany,
  expiresAt,
  photoCount = 0,
}) {
  const accent = TIER_ACCENTS[tier] || TIER_ACCENTS.normal;
  const deadlineLabel = formatDeadline(responseDeadlineAt, timeZone);
  const expiryLabel = formatDeadline(expiresAt, timeZone);
  const city = brief?.city || "your service area";
  const category = brief?.category || "Maintenance";

  // en-CA times end in "p.m.", so a sentence ending on one already has its
  // period -- appending another printed "2:56 p.m..".
  const stop = (label) => (/\.$/.test(label) ? "" : ".");

  const subject = `Job request — ${category} in ${city} · ${accent.label} response needed`;
  const preheader = `${accent.label} ${category.toLowerCase()} job in ${city}. Respond by ${deadlineLabel}${stop(
    deadlineLabel
  )}`;

  // Each fact appears once, in reading order: who wants you, their note, the
  // job, when, then the button. The urgency is the chip (no Urgency row), the
  // manager is the message label and the footer (no Property manager row),
  // and the greeting is here rather than repeated inside the note.
  const sender = managerCompany || managerName || "A property manager";
  // The tenant's timing, from the public brief (AI-normalised phrases only).
  const preference = (brief?.preferredTimes || []).join(", ") || null;
  const messageFrom = managerName || managerCompany || "your property manager";
  const paragraphs = splitParagraphs(messageBody);

  // Flush rows with a left rule -- no bullets, no indent.
  const windowsHtml = offeredWindows.length
    ? offeredWindows
        .map(
          (slot) =>
            `<tr><td style="padding:0 0 6px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td bgcolor="#f8fafc" style="background-color:#f8fafc;border-left:3px solid ${BRAND};padding:9px 12px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;font-weight:600;color:${INK};">${escapeHtml(
              slot.label
            )}</td></tr></table></td></tr>`
        )
        .join("\n")
    : `<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;color:${MUTED};">Times to be coordinated on the response page.</td></tr>`;

  const bodyHtml = `
<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:12px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;">
    <span style="display:inline-block;padding:4px 10px;border-radius:999px;background-color:${accent.bg};color:${accent.fg};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(
      accent.label
    )}</span>
    <h1 style="margin:14px 0 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:24px;line-height:30px;font-weight:700;color:${INK};">New job request</h1>
    <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:${MUTED};">${escapeHtml(
      sender
    )} would like to book you, ${escapeHtml(vendorName)}.</p>
  </td>
</tr>

${
  paragraphs.length
    ? `<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:22px 32px 0 32px;">
    ${sectionLabel(`Message from ${messageFrom}`)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr>
        <td bgcolor="#f8fafc" style="background-color:#f8fafc;border-left:3px solid ${BRAND};border-radius:0 8px 8px 0;padding:14px 16px;">
          ${renderParagraphs(messageBody)}
        </td>
      </tr>
    </table>
  </td>
</tr>`
    : ""
}

<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:22px 32px 0 32px;">
    ${sectionLabel("The job")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      ${renderRow("Trade", category)}
      ${renderRow("Location", city)}
      ${renderRow("Issue", brief?.shortTitle || brief?.summary || "See details on the response page")}
      ${preference ? renderRow("Tenant prefers", preference) : ""}
      ${photoCount > 0 ? renderRow("Photos", `${photoCount} on the response page`) : ""}
    </table>
  </td>
</tr>

<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:22px 32px 0 32px;">
    ${sectionLabel("Choose a time window")}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      ${windowsHtml}
    </table>
  </td>
</tr>

<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:24px 32px 6px 32px;">
    ${renderButton({ href: responseUrl, label: "Review job & respond" })}
  </td>
</tr>

<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:12px 32px 8px 32px;">
    <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:${MUTED};text-align:center;">Respond by <strong style="color:${INK};">${escapeHtml(
      deadlineLabel
    )}</strong>${stop(deadlineLabel)} The address and access details unlock once you accept.</p>
  </td>
</tr>`;

  const footerHtml = `This link is unique to you — please don't forward it. It expires ${escapeHtml(
    expiryLabel
  )}${stop(expiryLabel)}<br>Sent by Artrelo on behalf of ${escapeHtml(managerCompany || managerName || "the property manager")}.`;

  const html = renderLayout({ title: subject, preheader, bodyHtml, footerHtml });

  // Plain-text alternative is mandatory — never ship HTML-only. Same order as
  // the HTML, nothing indented.
  const text = [
    `New job request — ${accent.label}`,
    `${sender} would like to book you, ${vendorName}.`,
    "",
    ...(paragraphs.length
      ? [`Message from ${messageFrom}:`, "", paragraphs.map((lines) => lines.join("\n")).join("\n\n"), ""]
      : []),
    `Trade: ${category}`,
    `Location: ${city}`,
    `Issue: ${brief?.shortTitle || brief?.summary || "See the response page"}`,
    preference ? `Tenant prefers: ${preference}` : null,
    photoCount > 0 ? `Photos: ${photoCount} on the response page` : null,
    "",
    "Choose a time window:",
    ...(offeredWindows.length
      ? offeredWindows.map((slot) => `- ${slot.label}`)
      : ["Times to be coordinated on the response page."]),
    "",
    "Review the job and respond here:",
    responseUrl,
    "",
    `Respond by ${deadlineLabel}${stop(deadlineLabel)} The address and access details unlock once you accept.`,
    "",
    `This link is unique to you — please don't forward it. It expires ${expiryLabel}${stop(expiryLabel)}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return { subject, html, text, preheader };
}

module.exports = { buildVendorOutreachEmail, TIER_ACCENTS };
