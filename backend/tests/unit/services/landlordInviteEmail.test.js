// The invite email.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * the invited name is escaped. It comes from a CLI argument today and a
//     landlord-facing form tomorrow, and it lands in HTML sent to a third
//     party's inbox;
//   * the link appears in the text part too. Plenty of people read mail as
//     plain text, and an invite whose only route in is an HTML button is
//     unusable to them;
//   * the copy states the expiry, so someone reading it late knows why it
//     failed rather than concluding we are broken.

const assert = require("assert");

const { buildLandlordInviteEmail, describeWindow } = require("../../../services/notification/templates/landlordInviteEmail");

const URL = "https://artrelo.com/login/invite#t=abc123";

function main() {
  /* -------------- 1) The name is escaped ------------------------------- */

  const nasty = '<script>alert("xss")</script>';
  const evil = buildLandlordInviteEmail({ firstName: nasty, url: URL });

  assert.ok(!evil.html.includes("<script>"), "a raw <script> must never reach the HTML body");
  assert.ok(evil.html.includes("&lt;script&gt;"), "it must appear escaped instead");

  // Quotes and ampersands matter as much as angle brackets: the name is
  // interpolated near inline style attributes.
  const quoted = buildLandlordInviteEmail({ firstName: 'Dana" onload="x', url: URL });
  assert.ok(!quoted.html.includes('onload="x"'), "an attribute must not be injectable");
  assert.ok(quoted.html.includes("&quot;") || quoted.html.includes("&#34;"), "quotes are escaped");

  const amp = buildLandlordInviteEmail({ firstName: "Ben & Co", url: URL });
  assert.ok(amp.html.includes("Ben &amp; Co"), "ampersands are escaped");

  /* -------------- 2) The link survives into both parts ----------------- */

  const normal = buildLandlordInviteEmail({ firstName: "Dana", url: URL, expiresInDays: 7 });
  assert.ok(normal.html.includes(URL), "the HTML button points at the link");
  assert.ok(normal.text.includes(URL), "and the plain-text part carries it too");
  assert.ok(normal.subject && normal.subject.length < 80, "a subject that is not truncated by clients");

  // The fragment must survive intact — it IS the token, and an escaped or
  // mangled `#t=` is a link that cannot work.
  assert.ok(normal.html.includes("#t=abc123"), "the fragment is not mangled");

  /* -------------- 3) The expiry is stated ------------------------------ */

  // The VISIBLE note, not just the preheader -- "7 days" alone passes on the
  // preheader text while the line the reader actually sees has gone.
  assert.match(
    normal.html,
    /This invite is for you alone and expires in 7 days\./,
    "the body states the expiry where the reader will see it"
  );
  assert.match(normal.text, /expires in 7 days\./, "so does the text");

  assert.strictEqual(describeWindow(1), "in 1 day", "singular, not '1 days'");
  assert.strictEqual(describeWindow(7), "in 7 days");
  assert.strictEqual(describeWindow(14), "in 14 days");
  // Never renders "in NaN days" or "in 0 days" at somebody.
  for (const bad of [0, -3, undefined, null, "abc"]) {
    assert.strictEqual(describeWindow(bad), "shortly", `describeWindow(${JSON.stringify(bad)})`);
  }

  /* -------------- 4) The copy changes for an existing account ---------- */
  //
  // Someone who already has a tenant account is adding a role with the password
  // they already have. Saying so up front avoids the "why is it asking for a
  // password I never set" pause.

  const fresh = buildLandlordInviteEmail({ firstName: "Dana", url: URL });
  const existing = buildLandlordInviteEmail({ firstName: "Dana", url: URL, accountExists: true });

  assert.ok(/existing password/i.test(existing.html), "it mentions their existing password");
  assert.ok(/existing password/i.test(existing.text));
  assert.ok(!/existing password/i.test(fresh.html), "and does not say that to a new person");
  assert.notStrictEqual(fresh.html, existing.html, "the two are genuinely different emails");

  /* -------------- 5) A missing name still produces a valid email ------- */
  //
  // The name is advisory, so a blank one must degrade rather than render
  // "Hi undefined,".

  for (const missing of [undefined, null, ""]) {
    const anon = buildLandlordInviteEmail({ firstName: missing, url: URL });
    assert.ok(!/undefined|null/.test(anon.html), `no placeholder leaks for ${JSON.stringify(missing)}`);
    assert.ok(!/undefined|null/.test(anon.text));
    assert.ok(anon.text.startsWith("Hi,"), "it just greets them plainly");
    assert.ok(anon.html.includes(URL), "and still carries the link");
  }

  console.log("landlordInviteEmail tests passed");
}

main();
