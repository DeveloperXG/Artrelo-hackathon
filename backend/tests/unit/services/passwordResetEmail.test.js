// The password reset email.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * the name is escaped. It is a stored value rendered into HTML sent to an
//     inbox;
//   * the link survives into the plain-text part;
//   * it states the short window, so somebody returning to it after lunch knows
//     why it failed;
//   * it does NOT read as an alarm. This is the one email we send to people who
//     did not ask for it — that is the cost of never revealing whether an
//     address has an account — so it must say plainly that nothing has changed.

const assert = require("assert");

const {
  buildPasswordResetEmail,
  describeMinutes,
} = require("../../../services/notification/templates/passwordResetEmail");

const URL = "https://artrelo.com/login/reset#t=abc123";

function main() {
  /* -------------- 1) The name is escaped ------------------------------- */

  const evil = buildPasswordResetEmail({ firstName: '<script>alert("x")</script>', url: URL });
  assert.ok(!evil.html.includes("<script>"), "a raw <script> must never reach the HTML");
  assert.ok(evil.html.includes("&lt;script&gt;"), "it appears escaped instead");

  const quoted = buildPasswordResetEmail({ firstName: 'Dana" onload="x', url: URL });
  assert.ok(!quoted.html.includes('onload="x"'), "an attribute must not be injectable");

  assert.ok(
    buildPasswordResetEmail({ firstName: "Ben & Co", url: URL }).html.includes("Ben &amp; Co"),
    "ampersands are escaped"
  );

  /* -------------- 2) The link reaches both parts intact ---------------- */

  const mail = buildPasswordResetEmail({ firstName: "Dana", url: URL, expiresInMinutes: 30 });
  assert.ok(mail.html.includes(URL), "the HTML button points at it");
  assert.ok(mail.text.includes(URL), "and the text part carries it");
  assert.ok(mail.html.includes("#t=abc123"), "the fragment is not mangled — it IS the token");
  assert.ok(mail.subject && mail.subject.length < 80);

  /* -------------- 3) The window is stated ------------------------------ */

  assert.match(mail.html, /expires in 30 minutes\./, "stated where the reader sees it");
  assert.match(mail.text, /expires in 30 minutes\./);

  assert.strictEqual(describeMinutes(1), "in 1 minute", "singular, not '1 minutes'");
  assert.strictEqual(describeMinutes(30), "in 30 minutes");
  assert.strictEqual(describeMinutes(60), "in 1 hour");
  assert.strictEqual(describeMinutes(120), "in 2 hours");
  for (const bad of [0, -5, undefined, null, "abc", NaN]) {
    assert.strictEqual(describeMinutes(bad), "shortly", `describeMinutes(${JSON.stringify(bad)})`);
  }

  /* -------------- 4) It reassures rather than alarms ------------------- */
  //
  // Sent to people who did not ask for it, by design. If it reads as a breach
  // notice it costs support time and teaches people to distrust our mail.

  assert.match(
    mail.html,
    /your password has not changed/i,
    "it must say plainly that nothing has happened yet"
  );
  assert.match(mail.text, /password has not changed/i);
  assert.match(mail.text, /didn't ask for this/i, "and how to react: ignore it");

  // It must not instruct a panic action, because the recipient may well be a
  // stranger who received someone else's reset request.
  assert.ok(!/immediately|urgent|compromised|breach/i.test(mail.html), "no alarm language");

  /* -------------- 5) Signing out elsewhere is warned about ------------- */
  //
  // Completing a reset bumps tokenVersion and kills every session. Saying so
  // turns a surprise into an expectation.

  assert.match(mail.text, /sign in again/i, "the consequence is stated");

  /* -------------- 6) No name still yields a valid email --------------- */

  for (const missing of [undefined, null, ""]) {
    const anon = buildPasswordResetEmail({ firstName: missing, url: URL });
    assert.ok(!/undefined|null/.test(anon.html), `no placeholder leaks for ${JSON.stringify(missing)}`);
    assert.ok(!/undefined|null/.test(anon.text));
    assert.ok(anon.text.startsWith("Hi,"));
    assert.ok(anon.html.includes(URL));
  }

  console.log("passwordResetEmail tests passed");
}

main();
