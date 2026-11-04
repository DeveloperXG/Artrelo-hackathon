// The job-link email: sent once the TENANT confirms access, which is the point
// a vendor's acceptance actually becomes a booked appointment. It carries the
// job-scoped portal link they use to check in, upload photos, and submit their
// final cost. About an hour before arrival a link-free reminder points back
// here (buildVendorArrivalReminderEmail).
//
// Not sent at vendor acceptance, deliberately. jobToken.middleware admits only
// `scheduled` and `work_verifying`, so a link issued while the appointment is
// still `awaiting_tenant` is dead — this used to go out then, hedged with "the
// tenant is confirming access now", which papered over a 404.
//
// Privacy rule, inherited from vendorOutreachEmail.js and still binding even
// though this vendor HAS been shown the address on the portal: NO street
// address, NO unit number, NO tenant name in the email. The rule is justified by
// forwardability and lock-screen previews, not by the acceptance gate. Those
// details live on the portal page, behind the token.
//
// Deliberately NO money. The vendor is about to enter their final cost, and
// restating the ceiling they'll be measured against invites them to bill up to
// it instead of billing what the job actually cost. They have their own quote.

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

function formatArrival(arrival, durationMinutes, timeZone) {
  if (!arrival) return null;
  const when = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(arrival));

  const minutes = Number(durationMinutes) || 0;
  if (!minutes) return when;
  const duration = minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10}h` : `${minutes} min`;
  return `${when} (about ${duration} on site)`;
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

function buildVendorJobLinkEmail({
  vendorName,
  jobUrl,
  jobCode,
  issueTitle,
  category = "Maintenance",
  city = "your service area",
  scheduledArrivalAt,
  durationMinutes,
  timeZone = "America/Regina",
  managerName,
  managerCompany,
  paymentMode = "platform",
}) {
  const manager = managerCompany || managerName || "the property manager";
  const arrivalLabel = formatArrival(scheduledArrivalAt, durationMinutes, timeZone);
  const subject = `You're booked — ${category} in ${city}`;
  const preheader = arrivalLabel
    ? `Arriving ${arrivalLabel}. Your job link is inside.`
    : "Your job link is inside — check in, add photos, submit your final cost.";
  const badge = "Booked";
  const headline = "You're booked for this job";
  const intro = `Thanks ${vendorName} — ${manager} has confirmed you, and the tenant has confirmed access.`;
  const paymentNote = paymentMode === "direct"
    ? "The property manager pays you directly after the work is submitted and confirmed. Artrelo records the payment status."
    : "Payment is released after the work is submitted and confirmed, once the funds are available for transfer.";

  const rows = [
    renderRow("Trade", category),
    renderRow("Location", city),
    issueTitle ? renderRow("Job", issueTitle) : "",
    arrivalLabel ? renderRow("Your arrival", arrivalLabel) : "",
    renderRow("Property manager", [managerName, managerCompany].filter(Boolean).join(" · ") || "Artrelo"),
  ]
    .filter(Boolean)
    .join("\n      ");

  const bodyHtml = `
<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:12px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;">
    <span style="display:inline-block;padding:4px 10px;border-radius:999px;background-color:#dcfce7;color:#15803d;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(badge)}</span>
    <h1 style="margin:14px 0 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:24px;line-height:30px;font-weight:700;color:${INK};">${escapeHtml(headline)}</h1>
    <p style="margin:0 0 4px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:${MUTED};">${escapeHtml(intro)}</p>
  </td>
</tr>

<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:20px 32px 0 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      ${rows}
    </table>
  </td>
</tr>

<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:22px 32px 0 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr>
        <td bgcolor="#f8fafc" style="background-color:#f8fafc;border-left:3px solid ${BRAND};border-radius:0 8px 8px 0;padding:14px 16px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:21px;color:${INK};">
          <strong style="color:${INK};">Use your job page to:</strong>
          <div style="margin-top:6px;color:${MUTED};">
            • See the full address, unit and access details<br>
            • Check in when you arrive<br>
            • Upload before / after photos and the tools you used<br>
            • Submit your final cost when the work is done
          </div>
        </td>
      </tr>
    </table>
  </td>
</tr>

<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:26px 32px 6px 32px;">
    ${renderButton({ href: jobUrl, label: "Open your job page" })}
  </td>
</tr>
${
  jobCode
    ? `
<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:16px 32px 0 32px;">
    <p style="margin:0 0 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:${MUTED};text-align:center;">Opening this on another device? Use your job code:</p>
    <p style="margin:0;text-align:center;">
      <span style="display:inline-block;padding:8px 16px;border:1px solid ${BORDER};border-radius:8px;background-color:#f8fafc;font-family:'Courier New',Courier,monospace;font-size:18px;font-weight:700;letter-spacing:0.18em;color:${INK};">${escapeHtml(
        jobCode
      )}</span>
    </p>
  </td>
</tr>`
    : ""
}

<tr>
  <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:18px 32px 8px 32px;">
    <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:${MUTED};text-align:center;">${escapeHtml(paymentNote)}</p>
  </td>
</tr>`;

  const footerHtml = `This link is unique to you and stays live for this job — please don't forward it.<br>Sent by Artrelo on behalf of ${escapeHtml(
    manager
  )}.`;

  const html = renderLayout({ title: subject, preheader, bodyHtml, footerHtml });

  // Plain-text alternative is mandatory — never ship HTML-only.
  const text = [
    `Hello ${vendorName},`,
    "",
    `${manager} has confirmed you for this job.`,
    "The tenant has confirmed access for this time.",
    "",
    `Trade: ${category}`,
    `Location: ${city}`,
    issueTitle ? `Job: ${issueTitle}` : null,
    arrivalLabel ? `Your arrival: ${arrivalLabel}` : null,
    `Property manager: ${[managerName, managerCompany].filter(Boolean).join(" · ") || "Artrelo"}`,
    "",
    "Use your job page to see the full address, unit and access details, check in",
    "when you arrive, upload before/after photos and the tools you used, and submit your final cost:",
    jobUrl,
    "",
    jobCode ? `Job code (if you open this on another device): ${jobCode}` : null,
    jobCode ? "" : null,
    paymentNote,
    "",
    "This link is unique to you and stays live for this job — please don't forward it.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  return { subject, html, text, preheader };
}

module.exports = { buildVendorJobLinkEmail };
