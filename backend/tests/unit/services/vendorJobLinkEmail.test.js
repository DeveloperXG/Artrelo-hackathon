// The job-link email sent when a booking is confirmed.
//
// Mirrors vendorOutreachEmail.test.js. What is pinned: the link is a real CTA
// (not a bare URL dumped in the body), the privacy rule survives even though
// this vendor has already been shown the address, and no cost figure appears.

const assert = require("assert");
const {
  buildVendorJobLinkEmail,
} = require("../../../services/notification/templates/vendorJobLinkEmail");

// Decoys. Any of these in the rendered email means the privacy rule broke.
const STREET = "8842 Zephyrhill Crescent";
const UNIT_NUMBER = "3071B";
const TENANT_NAME = "Marisol Vandergriff";

const JOB_URL = "https://app.example.com/vendor-job/raw-token-abc";
const JOB_CODE = "7KQ3MPXZ";

const email = buildVendorJobLinkEmail({
  vendorName: "Prairie Plumbing Partners",
  jobUrl: JOB_URL,
  jobCode: JOB_CODE,
  issueTitle: "Kitchen sink leaking under cabinet",
  category: "Plumbing",
  city: "Regina",
  scheduledArrivalAt: new Date("2026-03-04T15:30:00Z"),
  durationMinutes: 120,
  timeZone: "America/Regina",
  managerName: "Excel Ojeifo",
  managerCompany: "Northline Properties",
});

/* ---- The link is a button, not a raw URL in the prose ---- */

assert.ok(
  email.html.includes(`href="${JOB_URL}"`),
  "the HTML must link the job URL from an anchor"
);
assert.ok(
  /Open your job page/.test(email.html),
  "the anchor carries a label rather than exposing the URL as the link text"
);
assert.ok(
  !email.html.includes(`>${JOB_URL}<`),
  "the raw URL must not be the visible link text in the HTML part"
);
// The plain-text part is the one place a bare URL belongs — it has no anchors.
assert.ok(email.text.includes(JOB_URL), "plain text still carries the reachable URL");

/* ---- Structure matches the outreach email ---- */

assert.ok(email.html.includes("Artrelo"), "uses the shared branded layout");
assert.ok(/Trade/.test(email.html) && /Plumbing/.test(email.html), "detail rows are rendered");
assert.ok(/Regina/.test(email.html), "shows the city");
assert.ok(/Kitchen sink leaking under cabinet/.test(email.html), "shows the job");
assert.ok(email.preheader.trim().length > 0, "has a preheader like the outreach email");
assert.ok(email.subject.includes("Plumbing") && email.subject.includes("Regina"));

/* ---- The arrival commitment is echoed back ---- */

assert.ok(/arrival/i.test(email.html), "restates the time they committed to");
assert.ok(/2h on site/.test(email.html) || /2h on site/.test(email.text), "includes the duration");

/* ---- The job code is presented, not buried ---- */

assert.ok(email.html.includes(JOB_CODE), "the job code is rendered for another-device access");
assert.ok(email.text.includes(JOB_CODE));

/* ---- Plain text is mandatory ---- */

assert.ok(email.text.trim().length > 0, "never ship HTML-only");
assert.ok(!email.text.includes("undefined"));
assert.ok(!email.html.includes("undefined"));

/* ---- Privacy: address, unit and tenant name stay on the portal ---- */

for (const [label, decoy] of [
  ["street address", STREET],
  ["unit number", UNIT_NUMBER],
  ["tenant name", TENANT_NAME],
]) {
  assert.ok(!email.subject.includes(decoy), `subject must not carry the ${label}`);
  assert.ok(!email.preheader.includes(decoy), `preheader must not carry the ${label}`);
  assert.ok(!email.html.includes(decoy), `html must not carry the ${label}`);
  assert.ok(!email.text.includes(decoy), `text must not carry the ${label}`);
}
assert.ok(
  /address/i.test(email.text),
  "but it should TELL them the address is on the job page, so the omission is not confusing"
);

/* ---- No money. They are about to enter a final cost; do not anchor it. ---- */

const withMoney = buildVendorJobLinkEmail({
  vendorName: "Someone",
  jobUrl: JOB_URL,
  jobCode: JOB_CODE,
  category: "Plumbing",
  city: "Regina",
  // Even if a caller passes these through, nothing should render them.
  agreedAmount: 320,
  approvedCeiling: 987654,
});
assert.ok(!withMoney.html.includes("987654"), "the manager's ceiling must never render");
assert.ok(!withMoney.text.includes("987654"));
assert.ok(!withMoney.html.includes("320"), "no cost figure is restated before they invoice");
assert.ok(!/\$\d/.test(withMoney.text), "no dollar amount in the plain-text part either");

/* ---- Degrades safely with the minimum a caller can supply ---- */

const minimal = buildVendorJobLinkEmail({ vendorName: "Someone", jobUrl: JOB_URL });
assert.ok(minimal.text.trim().length > 0);
assert.ok(minimal.html.includes(JOB_URL));
assert.ok(!minimal.text.includes("undefined"));
assert.ok(!minimal.html.includes("undefined"));
assert.ok(!minimal.html.includes("null"), "a missing arrival must not render as null");

const direct = buildVendorJobLinkEmail({ vendorName: "Someone", jobUrl: JOB_URL, paymentMode: "direct" });
assert.ok(direct.text.includes("property manager pays you directly"));
assert.ok(!direct.text.includes("Payment is released"));
assert.ok(minimal.text.includes("funds are available for transfer"));

console.log("vendorJobLinkEmail template tests passed");
