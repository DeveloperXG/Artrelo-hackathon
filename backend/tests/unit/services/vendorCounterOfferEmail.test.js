// The counter-offer email.
//
// Mirrors vendorOutreachEmail.test.js. Two things are pinned: the amount must be
// unmissable (it is the entire ask), and the privacy rule still holds even
// though this vendor has already accepted and been shown the address — email is
// forwardable and shows up in lock-screen previews.

const assert = require("assert");
const {
  buildVendorCounterOfferEmail,
} = require("../../../services/notification/templates/vendorCounterOfferEmail");

// Decoys. If any of these reach the rendered email, the privacy rule broke.
const STREET = "8842 Zephyrhill Crescent";
const UNIT_NUMBER = "3071B";
const TENANT_NAME = "Marisol Vandergriff";

const email = buildVendorCounterOfferEmail({
  vendorName: "Prairie Plumbing Partners",
  amount: 250,
  currency: "CAD",
  quotedLow: 180,
  quotedHigh: 320,
  responseUrl: "https://app.example.com/vendor-response/raw-token-abc",
  deadlineAt: new Date("2026-03-03T21:00:00Z"),
  timeZone: "America/Regina",
  note: "We can stretch to this but not past it.",
  managerName: "Excel Ojeifo",
  managerCompany: "Northline Properties",
  category: "Plumbing",
  city: "Regina",
});

/* ---- The amount is the ask ---- */

assert.ok(email.subject.includes("250"), "the subject carries the amount");
assert.ok(email.text.includes("250"), "the plain-text part carries the amount");
assert.ok(email.html.includes("250"), "the HTML part carries the amount");

// Context for the decision: what they originally asked for.
assert.ok(email.text.includes("180") && email.text.includes("320"), "shows the original range");

/* ---- Plain text is mandatory, never HTML-only ---- */

assert.ok(email.text.trim().length > 0, "plain-text alternative must not be empty");
assert.ok(
  email.text.includes("https://app.example.com/vendor-response/raw-token-abc"),
  "the link must be reachable without rendering HTML"
);
assert.ok(email.html.includes("raw-token-abc"), "the HTML CTA carries the link");

/* ---- Privacy: still no address, unit, or tenant name ---- */

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

/* ---- Nothing is booked yet, and the vendor is told so ---- */

assert.ok(
  /nothing is booked/i.test(email.text),
  "the vendor must know declining is a real option, not a broken promise"
);

/* ---- The rotated link is flagged, so the old one going dead is not a surprise ---- */

assert.ok(
  /no longer works/i.test(email.text),
  "warns that any earlier link for this job is now dead"
);

/* ---- Degrades safely without optional context ---- */

const minimal = buildVendorCounterOfferEmail({
  vendorName: "Someone",
  amount: 400,
  responseUrl: "https://app.example.com/vendor-response/t",
  deadlineAt: new Date("2026-03-03T21:00:00Z"),
});
assert.ok(minimal.subject.includes("400"));
assert.ok(minimal.text.trim().length > 0);
assert.ok(!minimal.text.includes("undefined"), "no undefined leaks into the body");
assert.ok(!minimal.html.includes("undefined"), "no undefined leaks into the html");

console.log("vendorCounterOfferEmail template tests passed");
