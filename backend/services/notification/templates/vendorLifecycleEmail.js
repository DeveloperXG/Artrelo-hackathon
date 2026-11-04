// The vendor emails around the booking.
//
// A vendor hears from us five times per job, each with one job and at most
// one link:
//
//   offer        vendorOutreachEmail   -> the response page
//   accepted     buildVendorAcceptedEmail          (this file) -> NO links
//   booked       vendorJobLinkEmail    -> the job page (sent when the tenant confirms)
//   ~1h before   buildVendorArrivalReminderEmail   (this file) -> NO links
//   complete     buildVendorJobCompleteEmail       (this file) -> "See your jobs"
//
// plus, only when the payout had to wait for Stripe to clear the money:
//
//   sent         buildVendorPayoutSentEmail    (this file) -> "See your jobs"
//
// The reminder carries no link on purpose: a new job link would rotate the
// token and kill the one in the "You're booked" email, which the vendor may
// already have open. It points them back to that email instead.
//
// Acceptance used to send the hub introduction ("See all your jobs") instead:
// a link to a list holding one job they couldn't open yet. Past jobs and
// payouts mean something once a job is DONE, so the hub is introduced there.
//
// Privacy, as every vendor email: no street address, unit or tenant name --
// email is forwardable and shows on lock screens. City only.

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

const paragraph = (text, color = MUTED) =>
  `<p style="margin:0 0 10px 0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;color:${color};">${escapeHtml(
    text
  )}</p>`;

function formatWhen(value, timeZone) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

// en-CA writes "9:30 a.m.", so a sentence ending on a time has its period.
const endSentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

const jobLabel = (category) => `${String(category || "maintenance").toLowerCase()} job`;

/**
 * Sent once the vendor accepts. Says what happens next and asks for nothing,
 * so it carries no link: the job page doesn't open until the tenant confirms,
 * and that's when the "You're booked" email brings the link.
 */
function buildVendorAcceptedEmail({
  vendorName,
  category,
  city,
  scheduledArrivalAt,
  timeZone = "America/Regina",
  managerLabel = "The property manager",
}) {
  const job = jobLabel(category);
  const where = city ? ` in ${city}` : "";
  const arrival = formatWhen(scheduledArrivalAt, timeZone);
  const subject = `Accepted — waiting on the tenant to confirm your time`;

  const lines = [
    `Thanks for taking the ${job}${where}.`,
    arrival
      ? endSentence(`We've asked the tenant to confirm your arrival on ${arrival}`)
      : "We've asked the tenant to confirm your arrival time.",
    "As soon as they do, we'll email your job link with the address and access details. There's nothing you need to do until then.",
  ];

  const bodyHtml = [
    row("12px 32px 0 32px", heading("You accepted the job")),
    row("4px 32px 24px 32px", lines.map((line) => paragraph(line)).join("")),
  ].join("\n");

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: "We'll email your job link once the tenant confirms.",
      bodyHtml,
      footerHtml: `Sent by Artrelo on behalf of ${escapeHtml(managerLabel)}.`,
    }),
    text: [`Hi ${vendorName || "there"},`, "", ...lines, "", `Sent by Artrelo on behalf of ${managerLabel}.`].join("\n"),
  };
}

/**
 * About an hour before arrival. A nudge, not a new link: the job page link is
 * in the "You're booked" email, and issuing another would invalidate it.
 */
function buildVendorArrivalReminderEmail({
  vendorName,
  category,
  city,
  scheduledArrivalAt,
  timeZone = "America/Regina",
  managerLabel = "The property manager",
}) {
  const job = jobLabel(category);
  const where = city ? ` in ${city}` : "";
  const time = scheduledArrivalAt
    ? new Intl.DateTimeFormat("en-CA", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(scheduledArrivalAt))
    : null;
  const subject = time ? `Starting soon — ${job}${where}, ${time}` : `Starting soon — ${job}${where}`;

  const lines = [
    time ? `Your ${job}${where} starts at ${time}, about an hour from now.` : `Your ${job}${where} starts in about an hour.`,
    `Your job page link is in the "You're booked" email we sent when the tenant confirmed. Open it when you arrive to check in, add your photos and submit your work.`,
    "Running late or can't make it? Let the property manager know as soon as you can.",
  ];

  const bodyHtml = [
    row("12px 32px 0 32px", heading("Your job is coming up")),
    row("4px 32px 24px 32px", lines.map((line) => paragraph(line)).join("")),
  ].join("\n");

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: `Your job link is in your "You're booked" email.`,
      bodyHtml,
      footerHtml: `Sent by Artrelo on behalf of ${escapeHtml(managerLabel)}.`,
    }),
    text: [`Hi ${vendorName || "there"},`, "", ...lines, "", `Sent by Artrelo on behalf of ${managerLabel}.`].join("\n"),
  };
}

/**
 * A Stripe clearing date, as a day. Stripe dates card money to 00:00 UTC
 * (pinned off sandbox balance transactions, 2026-10-12), so it is formatted IN
 * UTC: in any Canadian zone that instant is the evening before, and the email
 * would name a day earlier than the one Stripe shows.
 */
function formatClearingDate(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
    new Date(value)
  );
}

// What happened to the money, in words a contractor would use.
const PAYOUT_LINES = {
  paid: (amount) => `${amount} has been sent to your payout account.`,
  pending: (amount) => `${amount} is being processed and will reach your payout account shortly.`,
  pending_onboarding: (amount) =>
    `${amount} is waiting for you. Set up payouts from your jobs page to receive it — it's held safely until you do.`,
  pending_manual: (amount) => `Your property manager will pay you ${amount} directly.`,
  // The manager has been told (payoutNotices.service), and a failed payout
  // does NOT retry by itself -- the manager retries it or pays directly.
  failed: (amount) =>
    `We couldn't send ${amount} yet. Your property manager has been told and will resend it or pay you directly. You're still owed the full amount.`,
  awaiting_funds: (amount) =>
    `${amount} is owed to you and will be sent as soon as your property manager adds funds. You don't need to do anything.`,
  // Paid for, and sent by itself once Stripe clears the money. Say the date
  // when there is one: "processing" with no end is what makes people chase.
  awaiting_clearance: (amount, { clearsOn } = {}) => {
    const day = formatClearingDate(clearsOn);
    return day
      ? `${amount} is paid for and on its way. Your property manager's payment is still clearing with Stripe, our payment processor, so it will be sent to your payout account on or around ${day}. You don't need to do anything.`
      : `${amount} is paid for and on its way. Your property manager's payment is still clearing with Stripe, our payment processor, which usually takes a few business days. It's sent to your payout account automatically. You don't need to do anything.`;
  },
};

const formatMoney = (amount) => (typeof amount === "number" && amount > 0 ? `$${amount.toLocaleString("en-CA")}` : null);

/**
 * Sent when the job closes. The first email with the jobs link: past work and
 * payouts are worth looking at now, not when they had one unopened job.
 */
function buildVendorJobCompleteEmail({
  vendorName,
  category,
  city,
  amount,
  payoutStatus,
  hubUrl,
  managerLabel = "The property manager",
  // The part the property manager's balance did not cover. It is still owed;
  // it is sent once they add funds. `amount` stays the job total.
  awaitingAmount = 0,
  // On an awaiting_clearance payout: Stripe's expected clearing date, if known.
  clearsOn = null,
}) {
  const job = jobLabel(category);
  const where = city ? ` in ${city}` : "";
  const awaiting = formatMoney(awaitingAmount);
  const sentNow = awaiting ? formatMoney(Math.round((amount - awaitingAmount) * 100) / 100) : formatMoney(amount);

  // Split payment: say what went now and what is coming, separately. A single
  // "$400 is being processed" would be untrue for the part still waiting.
  const payoutLine = sentNow ? (PAYOUT_LINES[payoutStatus] || PAYOUT_LINES.pending)(sentNow, { clearsOn }) : null;
  const awaitingLine = awaiting
    ? sentNow
      ? `The remaining ${awaiting} will be sent as soon as your property manager adds funds. You don't need to do anything.`
      : PAYOUT_LINES.awaiting_funds(awaiting)
    : null;
  const subject = `Job complete — ${job}${where}`;

  const lines = [
    `The tenant confirmed the ${job}${where} is done. Thanks for your work.`,
    payoutLine,
    awaitingLine,
    "Your jobs page shows this job, your upcoming visits and what you've been paid.",
  ].filter(Boolean);

  const bodyHtml = [
    row("12px 32px 0 32px", heading("Job complete")),
    row("4px 32px 0 32px", lines.map((line) => paragraph(line)).join("")),
    row("16px 32px 8px 32px", renderButton({ href: hubUrl, label: "See your jobs" })),
    row(
      "8px 32px 16px 32px",
      `<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:19px;color:${MUTED};text-align:center;">No password needed — we email you a sign-in link.</p>`
    ),
  ].join("\n");

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: payoutLine || awaitingLine || "Thanks for your work.",
      bodyHtml,
      footerHtml: `Sent by Artrelo on behalf of ${escapeHtml(managerLabel)}.`,
    }),
    text: [`Hi ${vendorName || "there"},`, "", ...lines, "", `See your jobs: ${hubUrl}`, "", `Sent by Artrelo on behalf of ${managerLabel}.`].join("\n"),
  };
}

/**
 * The money the "Job complete" email said was on its way has now gone. Sent
 * only for a payout that WAITED (on Stripe clearing the funds): one that went
 * at the close was already reported as sent there, and saying it twice is
 * noise. Same single link as the complete email.
 */
function buildVendorPayoutSentEmail({ vendorName, category, amount, hubUrl, managerLabel = "The property manager" }) {
  const job = jobLabel(category);
  const sent = formatMoney(amount) || "Your payment";
  const subject = `Payment sent — ${sent} for your ${job}`;
  const lines = [
    `${sent} for your ${job} has been sent to your payout account. Your property manager's payment has cleared.`,
    "Your bank usually shows it within a few business days, on your payout account's normal schedule.",
  ];

  const bodyHtml = [
    row("12px 32px 0 32px", heading("Payment sent")),
    row("4px 32px 0 32px", lines.map((line) => paragraph(line)).join("")),
    row("16px 32px 16px 32px", renderButton({ href: hubUrl, label: "See your jobs" })),
  ].join("\n");

  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: lines[0],
      bodyHtml,
      footerHtml: `Sent by Artrelo on behalf of ${escapeHtml(managerLabel)}.`,
    }),
    text: [`Hi ${vendorName || "there"},`, "", ...lines, "", `See your jobs: ${hubUrl}`, "", `Sent by Artrelo on behalf of ${managerLabel}.`].join("\n"),
  };
}

/**
 * A booking that fell through and is being given to someone else. The vendor
 * must know not to turn up, and why. No link: there's nothing left for them
 * to do on this job.
 */
function buildVendorBookingCancelledEmail({ vendorName, category, city, reason, managerLabel = "The property manager" }) {
  const job = jobLabel(category);
  const where = city ? ` in ${city}` : "";
  const subject = `Booking cancelled — ${job}${where}`;
  const why =
    reason === "no_show"
      ? `${managerLabel} recorded that nobody arrived for the booked time, so the job has been passed to another vendor.`
      : `The tenant didn't confirm your arrival time, so ${managerLabel} has passed the job to another vendor. This isn't counted against you.`;
  const lines = [`Your booking for the ${job}${where} has been cancelled.`, why, "Please don't go to the property for this job."];
  const bodyHtml = [
    row("12px 32px 0 32px", heading("Booking cancelled")),
    row("4px 32px 24px 32px", lines.map((line) => paragraph(line)).join("")),
  ].join("\n");
  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: "Please don't go to the property for this job.",
      bodyHtml,
      footerHtml: `Sent by Artrelo on behalf of ${escapeHtml(managerLabel)}.`,
    }),
    text: [`Hi ${vendorName || "there"},`, "", ...lines, "", `Sent by Artrelo on behalf of ${managerLabel}.`].join("\n"),
  };
}

/**
 * The manager turned down a quote the vendor had already accepted with. They
 * said yes and are waiting to hear; silence would leave them holding a time
 * window for a job that is gone. Carries the manager's reason only when the
 * manager wrote one to share -- never the landlord's quota or limit. No link:
 * there's nothing left for them to do on this job.
 */
function buildVendorQuoteNotAcceptedEmail({ vendorName, category, city, reason, managerLabel = "The property manager" }) {
  const job = jobLabel(category);
  const where = city ? ` in ${city}` : "";
  const subject = `Quote not accepted — ${job}${where}`;
  const lines = [
    `${managerLabel} has decided not to go ahead with your quote for the ${job}${where}, so this job is no longer available to you.`,
    ...(reason ? [`Their reason: ${reason}`] : []),
    "You don't need to do anything, and you won't hear about this job again. Thanks for quoting.",
  ];
  const bodyHtml = [
    row("12px 32px 0 32px", heading("Quote not accepted")),
    row("4px 32px 24px 32px", lines.map((line) => paragraph(line)).join("")),
  ].join("\n");
  return {
    subject,
    html: renderLayout({
      title: subject,
      preheader: "This job is no longer available to you.",
      bodyHtml,
      footerHtml: `Sent by Artrelo on behalf of ${escapeHtml(managerLabel)}.`,
    }),
    text: [`Hi ${vendorName || "there"},`, "", ...lines, "", `Sent by Artrelo on behalf of ${managerLabel}.`].join("\n"),
  };
}

module.exports = {
  buildVendorAcceptedEmail,
  buildVendorArrivalReminderEmail,
  buildVendorJobCompleteEmail,
  buildVendorPayoutSentEmail,
  buildVendorBookingCancelledEmail,
  buildVendorQuoteNotAcceptedEmail,
  formatClearingDate,
  PAYOUT_LINES,
};
