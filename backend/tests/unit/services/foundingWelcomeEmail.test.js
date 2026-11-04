// The founding-landlord welcome email.
//
// It is a RECORD of what was agreed, so these tests pin facts, not styling:
//   * every interpolated string is escaped (a name reaches it from a form);
//   * the terms are exactly the SNAPSHOT passed in -- fee, discount, notice --
//     and a rate that was not set yet is said to be "to be confirmed", never
//     invented and never blank;
//   * nothing leaks that is internal (the agreement version hash) or broken
//     (undefined / null / NaN) however much is missing;
//   * dates are the portal's own (America/Regina), not the server's;
//   * the plain-text part says everything the HTML does -- some clients show
//     only it;
//   * it makes no promise the agreement text does not already make.

const assert = require("assert");
const { buildFoundingWelcomeEmail, lockedInFacts, formatDate } = require("../../../services/notification/templates/foundingWelcomeEmail");

const ACCEPTED = new Date("2026-10-11T15:00:00.000Z");
const BETA_END = new Date("2026-12-10T15:00:00.000Z");
const base = {
  firstName: "Dana",
  terms: { serviceFee: { flatCents: 400, percent: 1.5 }, planDiscountPercent: 30 },
  acceptedAt: ACCEPTED,
  betaEndsAt: BETA_END,
  chargeNoticeDays: 30,
  appUrl: "https://app.artrelo.com/",
};

// Strip tags and entities back to what a person reads, to compare against text.
const visible = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;|&zwnj;|&#847;/g, " ")
    .replace(/\s+/g, " ");

function main() {
  /* -------- 1) Subject and basics --------------------------------------- */
  const mail = buildFoundingWelcomeEmail(base);
  assert.strictEqual(mail.subject, "You're a founding Artrelo landlord");
  assert.ok(mail.subject.length < 80, "short enough to read in an inbox");
  assert.ok(!/[!\u{1F300}-\u{1FAFF}]/u.test(mail.subject), "no exclamation, no emoji");
  assert.ok(mail.html.includes("https://app.artrelo.com/dashboard"), "the button goes to the dashboard (trailing slash handled)");
  assert.ok(!mail.html.includes("//dashboard"));
  assert.ok(mail.text.includes("https://app.artrelo.com/dashboard"));

  /* -------- 2) The terms are the snapshot ------------------------------- */
  assert.ok(mail.text.includes("$4.00 per completed job plus 1.5% of the job payout"));
  assert.ok(mail.text.includes("30% off any Artrelo plan"));
  assert.ok(mail.text.includes("At least 30 days' notice before any charge begins"));
  assert.ok(mail.text.includes("this rate is locked in for you"));

  const flatOnly = buildFoundingWelcomeEmail({ ...base, terms: { serviceFee: { flatCents: 500, percent: 0 }, planDiscountPercent: 0 } });
  assert.ok(flatOnly.text.includes("$5.00 per completed job."), "a flat-only fee reads as one");
  assert.ok(!flatOnly.text.includes("%  of the job"), "no empty percent clause");
  const pctOnly = buildFoundingWelcomeEmail({ ...base, terms: { serviceFee: { flatCents: 0, percent: 2 }, planDiscountPercent: 0 } });
  assert.ok(pctOnly.text.includes("2% of the job payout."));
  assert.ok(!pctOnly.text.includes("$0.00"), "never '$0.00 per job'");

  /* -------- 3) A rate that was not set yet ------------------------------- */
  const unset = buildFoundingWelcomeEmail({ ...base, terms: { serviceFee: { flatCents: 0, percent: 0 }, planDiscountPercent: 0 } });
  assert.ok(unset.text.includes("To be confirmed. We'll tell you the exact amount at least 30 days before any fee applies"), unset.text);
  assert.ok(unset.text.includes("A founding rate on any Artrelo plan, confirmed in writing before plans launch"), "no discount number is invented");
  assert.ok(!/\$\d/.test(unset.text.split("WHAT HAPPENS NEXT")[0]), "no price appears in the terms block");
  assert.ok(unset.text.includes("A small service fee on completed jobs may apply"), "the 'when it ends' line is honest too");

  // Missing or nonsense terms degrade to the same honest wording.
  for (const terms of [undefined, null, {}, { serviceFee: {} }, { serviceFee: { flatCents: -5, percent: "abc" }, planDiscountPercent: "x" }]) {
    const m = buildFoundingWelcomeEmail({ ...base, terms });
    assert.ok(m.text.includes("To be confirmed"), JSON.stringify(terms));
    assert.ok(!/undefined|null|NaN/.test(m.text + visible(m.html)), `no leak for ${JSON.stringify(terms)}`);
  }

  /* -------- 4) Escaping -------------------------------------------------- */
  const evil = buildFoundingWelcomeEmail({ ...base, firstName: '<script>alert("x")</script>', appUrl: 'https://x.test"><img src=y>' });
  assert.ok(!evil.html.includes("<script>"), "a name cannot inject markup");
  assert.ok(evil.html.includes("&lt;script&gt;"));
  assert.ok(!evil.html.includes('"><img'), "nor can the URL break out of its attribute");

  /* -------- 5) Dates are the portal's own -------------------------------- */
  assert.strictEqual(formatDate(ACCEPTED, "America/Regina"), "October 11, 2026");
  // 03:00Z on the 12th is still the 11th in Regina (UTC-6, no DST).
  assert.strictEqual(formatDate("2026-10-12T03:00:00.000Z", "America/Regina"), "October 11, 2026", "Regina time, not the server's");
  assert.strictEqual(formatDate("2026-10-12T03:00:00.000Z", "UTC"), "October 12, 2026");
  assert.strictEqual(formatDate("not a date"), "", "garbage is dropped, not printed");
  assert.strictEqual(formatDate(undefined), "");
  assert.strictEqual(formatDate(ACCEPTED, "Not/AZone"), "October 11, 2026", "an unknown timezone must not take the email down");
  assert.ok(mail.text.includes("As of October 11, 2026, your founding terms are locked in"));
  assert.ok(mail.text.includes("Until December 10, 2026:"), "the beta end date");
  assert.ok(mail.text.includes("you accepted the founding offer on October 11, 2026"), "the record-keeping line");

  // No beta end date known: the line is generic, never a guessed date.
  const noEnd = buildFoundingWelcomeEmail({ ...base, betaEndsAt: undefined });
  assert.ok(noEnd.text.includes("For the length of your beta:"));
  assert.ok(!noEnd.text.includes("Until "), "no 'Until undefined'");

  /* -------- 6) Nothing internal, nothing broken -------------------------- */
  for (const m of [mail, unset, noEnd, buildFoundingWelcomeEmail({})]) {
    const all = m.text + visible(m.html);
    assert.ok(!/undefined|null|NaN/.test(all), "no leaked placeholders");
    assert.ok(!/founding-\d{4}/.test(all), "the agreement version hash is never shown");
  }
  const bare = buildFoundingWelcomeEmail({});
  assert.ok(bare.text.startsWith("Hi,"), "no name -> a plain greeting");
  // The email goes out AT acceptance, so an unspecified accepted date means today:
  // it still carries a real, formatted date rather than a blank or "undefined".
  assert.ok(/As of [A-Z][a-z]+ \d{1,2}, \d{4}, your founding terms are locked in\./.test(bare.text), bare.text);

  /* -------- 7) Notice days -------------------------------------------------- */
  assert.ok(buildFoundingWelcomeEmail({ ...base, chargeNoticeDays: 45 }).text.includes("At least 45 days' notice"));
  assert.ok(buildFoundingWelcomeEmail({ ...base, chargeNoticeDays: "junk" }).text.includes("At least 30 days' notice"), "junk falls back");

  /* -------- 8) The HTML says what the text says -------------------------------- */
  const page = visible(mail.html);
  // (The HTML's big heading is the plain text's subject line, so it is checked
  // against the HTML alone.)
  assert.ok(page.includes("You're a founding landlord"));
  for (const fragment of [
    "What you've locked in",
    "$4.00 per completed job plus 1.5% of the job payout",
    "30% off any Artrelo plan",
    "What happens next",
    "Until December 10, 2026",
    "When subscription plans launch",
    "nothing is billed without your say",
    "Open Artrelo",
    "you accepted the founding offer on October 11, 2026",
  ]) {
    assert.ok(page.includes(fragment), `the HTML is missing: ${fragment}`);
    assert.ok(mail.text.toLowerCase().includes(fragment.toLowerCase()), `the plain text is missing: ${fragment}`);
  }

  /* -------- 9) Structure: renderLayout needs a run of <tr> rows ----------- */
  assert.ok(mail.html.includes("<tr>"), "table layout");
  assert.ok(!/<(div|p|h1)[^>]*>\s*<\/?tr/.test(mail.html), "no block element wrapping a row");
  assert.ok(/bgcolor="#ffffff"/.test(mail.html), "cells carry bgcolor for Gmail's dark-mode inverter");

  /* -------- 10) No promise beyond the agreement ---------------------------------- */
  const promises = (mail.text + visible(mail.html)).toLowerCase();
  for (const forbidden of ["forever", "for life", "guarantee", "never increase", "as long as you use", "free forever", "lifetime"]) {
    assert.ok(!promises.includes(forbidden), `the email must not promise "${forbidden}"`);
  }

  /* -------- 11) lockedInFacts is what the email and tests share --------------- */
  const facts = lockedInFacts({ serviceFee: { flatCents: 250, percent: 0 }, planDiscountPercent: 10 }, 30);
  assert.strictEqual(facts.hasFee, true);
  assert.ok(facts.serviceFee.startsWith("$2.50 per completed job."));
  assert.strictEqual(lockedInFacts(undefined, 30).hasFee, false);

  console.log("foundingWelcomeEmail tests passed");
}

main();
