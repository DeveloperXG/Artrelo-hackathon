// The email that tells a beta landlord their free period is ending.
//
// WHAT IT MUST GET RIGHT, because it is the moment a free product turns into a
// conversation about money:
//   * say plainly what changes and what does not. Access does NOT switch off;
//     only the service-fee waiver ends. A landlord who reads "beta ending"
//     and assumes they are about to be locked out will either panic or leave;
//   * lead with what Artrelo did for them, not with the deadline -- the
//     highlights are the argument for staying;
//   * never state a price that does not exist yet. The founding terms arrive
//     from config/beta.js, and when no rate is chosen the copy says "we'll tell
//     you in advance" rather than inventing one.
//
// Same layout rules as landlordInviteEmail.js: bodyHtml is a run of <tr> rows,
// each with its own bgcolor AND inline background-color.

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

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describeDaysLeft(daysLeft) {
  const n = Math.max(0, Math.round(Number(daysLeft) || 0));
  if (n <= 1) return "tomorrow";
  return `in ${n} days`;
}

/**
 * The lines that make the case for staying. Each is included only when the
 * number behind it is real and worth saying: "0 requests handled" is not an
 * argument for anything.
 */
function highlightLines(highlights) {
  if (!highlights) return [];
  const lines = [];
  if (highlights.requests > 0) lines.push(`${plural(highlights.requests, "maintenance request")} handled`);
  if (highlights.medianMinutesToBook != null && highlights.bookedRequests > 0) {
    const m = highlights.medianMinutesToBook;
    lines.push(
      m < 90
        ? `a vendor booked in a median of ${Math.round(m)} minutes`
        : `a vendor booked in a median of ${Math.round((m / 60) * 10) / 10} hours`
    );
  }
  if (highlights.autopilotRequests > 0) {
    lines.push(`${plural(highlights.autopilotRequests, "job")} that needed nothing from you`);
  }
  return lines;
}

/**
 * @param {object} p
 * @param {string} [p.firstName]
 * @param {number} p.daysLeft
 * @param {string} p.url              where the button goes
 * @param {boolean} p.accepted        has accepted the CURRENT founding agreement
 * @param {object} [p.highlights]     { requests, bookedRequests, medianMinutesToBook, autopilotRequests }
 * @param {number} [p.chargeNoticeDays]
 */
function buildBetaReminderEmail({
  firstName,
  daysLeft,
  url,
  accepted = false,
  declined = false,
  highlights = null,
  chargeNoticeDays = 30,
}) {
  const when = describeDaysLeft(daysLeft);
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const lines = highlightLines(highlights);

  const proof = lines.length
    ? `So far in your beta: ${lines.join("; ")}.`
    : "Thanks for trying Artrelo during the beta.";

  const whatChanges =
    "Your access does not switch off when the beta ends. The one thing that changes is that the " +
    "service fee on completed jobs stops being waived.";

  // Someone who said no is not nagged. They still get this email -- it is also
  // the notice that the service fee is about to start -- but the offer is
  // mentioned once, plainly, with no button pointing at it.
  const offer = accepted
    ? "You've accepted the founding-landlord offer, so your founding terms are locked in."
    : declined
      ? "You chose not to take the founding-landlord offer. If you change your mind, you can still review it from your Wallet page."
      : "As a founding landlord you can lock in founding terms before the beta ends. Reviewing the " +
        "offer takes a minute and does not start any billing.";

  const noCharge = `We'll give you at least ${chargeNoticeDays} days' notice before any charge begins, and you choose a plan before anything is billed.`;

  const subject = `Your Artrelo beta ends ${when}`;
  const label = accepted || declined ? "Open Artrelo" : "Review the founding offer";

  const bodyHtml = [
    row(
      "12px 32px 0 32px",
      `${heading(`Your beta ends ${when}`)}${paragraph(
        `${escapeHtml(greeting)}<br><br>${escapeHtml(proof)}<br><br>${escapeHtml(whatChanges)}<br><br>${escapeHtml(offer)}`
      )}`
    ),
    row("26px 32px 6px 32px", renderButton({ href: url, label })),
    row("12px 32px 8px 32px", note(noCharge)),
  ].join("\n");

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: `Access doesn't switch off — only the service-fee waiver ends. ${accepted ? "Your founding terms are locked in." : declined ? "Open Artrelo." : "Review the founding offer."}`,
      bodyHtml,
      footerHtml:
        "You're receiving this because you're part of the Artrelo beta.<br>" +
        "Reply to this email with any questions.",
    }),
    text:
      `${greeting}\n\n` +
      `Your Artrelo beta ends ${when}.\n\n` +
      `${proof}\n\n` +
      `${whatChanges}\n\n` +
      `${offer}\n\n` +
      `${url}\n\n` +
      `${noCharge}\n`,
  };
}

module.exports = { buildBetaReminderEmail, highlightLines, describeDaysLeft };
