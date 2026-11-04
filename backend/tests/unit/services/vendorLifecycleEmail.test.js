// The vendor emails either side of the booking.
//
//   accepted -> says "waiting on the tenant", carries NO link (the job page
//               doesn't open until the tenant confirms)
//   complete -> carries exactly one link: the jobs page, introduced here
// Neither ever carries a street address (forwardable, lock-screen previews).

const assert = require("assert");
const {
  buildVendorAcceptedEmail,
  buildVendorArrivalReminderEmail,
  buildVendorJobCompleteEmail,
  buildVendorPayoutSentEmail,
  formatClearingDate,
} = require("../../../services/notification/templates/vendorLifecycleEmail");

const links = (html) => [...html.matchAll(/<a\s+href="([^"]*)"/g)].map((match) => match[1]);

const accepted = buildVendorAcceptedEmail({
  vendorName: "Pat's Plumbing",
  category: "Plumbing",
  city: "Regina",
  scheduledArrivalAt: new Date("2026-08-03T15:30:00.000Z"),
  timeZone: "America/Regina",
  managerLabel: "Northline Properties",
});
assert.deepStrictEqual(links(accepted.html), [], "no link at all on acceptance");
assert.ok(!/https?:\/\//.test(accepted.text), "no link in the text part either");
assert.match(accepted.subject, /waiting on the tenant/i);
assert.match(accepted.text, /Mon, Aug 3/, "names the arrival time they proposed");
assert.match(accepted.text, /email your job link/);
assert.ok(!accepted.text.includes("a.m.."), "en-CA's trailing period is not doubled");

// ~1h before -> a nudge that points back to the "You're booked" email. No link:
// issuing one would rotate the token and kill the link the vendor holds.
const reminder = buildVendorArrivalReminderEmail({
  vendorName: "Pat's Plumbing",
  category: "Plumbing",
  city: "Regina",
  scheduledArrivalAt: new Date("2026-08-03T15:30:00.000Z"),
  timeZone: "America/Regina",
  managerLabel: "Northline Properties",
});
assert.deepStrictEqual(links(reminder.html), [], "no link in the reminder");
assert.ok(!/https?:\/\//.test(reminder.text));
assert.match(reminder.subject, /^Starting soon — plumbing job in Regina, 9:30 a\.m\./);
assert.match(reminder.text, /"You're booked" email/);
assert.ok(!/Broad|unit/i.test(reminder.text + reminder.html), "city only");

const HUB = "https://app.example/vendor-hub";
const complete = (payoutStatus, amount = 280, extra = {}) =>
  buildVendorJobCompleteEmail({
    vendorName: "Pat's Plumbing",
    category: "Plumbing",
    city: "Regina",
    amount,
    payoutStatus,
    hubUrl: HUB,
    ...extra,
  });

const paid = complete("paid");
assert.deepStrictEqual(links(paid.html), [HUB], "exactly one link: the jobs page");
assert.match(paid.text, /\$280 has been sent/);
assert.match(complete("pending_onboarding").text, /Set up payouts/);
assert.match(complete("pending_manual").text, /pay you \$280 directly/);
// A failed payout does not retry by itself, so the email must not say it will.
assert.match(complete("failed").text, /will resend it or pay you directly/);
assert.ok(!/retried/.test(complete("failed").text), "no promise the system cannot keep");

// Paid for, waiting on Stripe to clear: a date, and nothing to do.
// Stripe dates clearing to 00:00 UTC; in Regina that instant is Oct 15, 6pm.
const OCT_16_UTC = new Date("2026-10-16T00:00:00.000Z");
assert.strictEqual(formatClearingDate(OCT_16_UTC), "Fri, Oct 16", "Stripe's day, not the evening before");
const clearing = complete("awaiting_clearance", 20, { clearsOn: OCT_16_UTC }).text;
assert.match(clearing, /\$20 is paid for and on its way/);
assert.match(clearing, /clearing with Stripe/);
assert.match(clearing, /on or around Fri, Oct 16/);
assert.match(clearing, /You don't need to do anything/);
assert.match(complete("awaiting_clearance", 20).text, /a few business days/, "no date rather than a wrong one");

const paidLater = buildVendorPayoutSentEmail({
  vendorName: "Pat's Plumbing",
  category: "Plumbing",
  amount: 20,
  hubUrl: HUB,
  managerLabel: "Northline Properties",
});
assert.match(paidLater.subject, /Payment sent — \$20 for your plumbing job/);
assert.deepStrictEqual(links(paidLater.html), [HUB], "one link: the jobs page");
assert.match(paidLater.text, /Northline Properties/);
assert.ok(!/\$/.test(complete("paid", 0).text.split("Sent by")[0]), "no payment line for a $0 close");

for (const email of [accepted, paid, paidLater]) {
  assert.ok(!/Main St|Maple/.test(email.html + email.text), "no address, ever");
}

console.log("vendorLifecycleEmail tests passed");
