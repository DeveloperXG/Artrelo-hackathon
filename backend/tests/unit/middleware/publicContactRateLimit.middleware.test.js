// The public contact limiters, exercised through a real Express app.
//
// THE RULE THIS FILE EXISTS TO PROTECT: a visitor cannot land a second lead
// within the cooldown of their last ACCEPTED one — but a visitor whose attempt
// was REJECTED (bad input) is not made to wait, and a rejected attempt can
// never shorten the next cooldown. Case 5 is the production failure that last
// clause is about: a typo, then two real leads twelve seconds apart, both sent.
//
// Real HTTP rather than hand-built req/res because the cooldown settles on the
// response lifecycle ("finish"/"close"), which a fake res would not emit.

const assert = require("assert");
const http = require("http");
const express = require("express");

const {
  cooldownLimiter,
  perIpLimiter,
  globalLimiter,
  createCooldown,
  COOLDOWN_MS,
} = require("../../../middleware/publicContactRateLimit.middleware");

// Stands in for the controller: status and latency are chosen per request, so
// a test can produce an accepted lead (200), a validation failure (400), or a
// slow send, on demand.
function handler(req, res) {
  const { status = 200, delayMs = 0 } = req.body;
  setTimeout(() => res.status(status).json({ success: status < 400 }), delayMs);
}

function buildApp(cooldown) {
  const app = express();
  // Trust only the loopback socket, then read the client from X-Forwarded-For.
  // That lets each case use its own "visitor", mirroring production's req.ip.
  app.set("trust proxy", "loopback");
  app.use(express.json());
  app.post("/contact", globalLimiter, cooldown, perIpLimiter, handler);
  return app;
}

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return server;
}

// fetch is disabled for unit tests (see _unit_setup.js), so use http directly.
function post(port, ip, status = 200, delayMs = 0, extra = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ status, delayMs, ...extra });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/contact",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Forwarded-For": ip,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null })
        );
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

// The cooldown settles on "finish", which can land a tick after the client has
// read the response. Yield before the next request so each assertion is about
// behaviour, not scheduling.
const settle = () => new Promise((r) => setTimeout(r, 25));

async function main() {
  /* ===================== The production instance ===================== */

  let server = await listen(buildApp(cooldownLimiter));
  let { port } = server.address();

  try {
    /* -------------- 1) Immediate resubmit is refused -------------------- */

    let r = await post(port, "203.0.113.1");
    assert.strictEqual(r.status, 200, "the first submission goes through");
    await settle();

    r = await post(port, "203.0.113.1");
    assert.strictEqual(r.status, 429, "a reload-and-resubmit seconds later must be refused");
    assert.strictEqual(r.body.code, "cooldown", "the client can tell a cooldown apart from a flood");
    const retryAfter = Number(r.headers["retry-after"]);
    assert.ok(
      retryAfter > 0 && retryAfter <= COOLDOWN_MS / 1000,
      `Retry-After must say how long is left, got ${r.headers["retry-after"]}`
    );

    /* -------------- 2) The cooldown is per visitor ---------------------- */

    r = await post(port, "203.0.113.2");
    assert.strictEqual(r.status, 200, "one visitor's cooldown must not block another");

    /* -------------- 3) A rejected submission does not start the clock ---- */

    r = await post(port, "203.0.113.3", 400);
    assert.strictEqual(r.status, 400);
    await settle();

    r = await post(port, "203.0.113.3");
    assert.strictEqual(r.status, 200, "fixing a typo must not be punished with a wait");
    await settle();

    r = await post(port, "203.0.113.3");
    assert.strictEqual(r.status, 429, "but once a lead is accepted, the cooldown applies");

    /* -------------- 4) Refused resubmits don't spend hourly slots --------- */
    //
    // Hammering during the cooldown is stopped before perIpLimiter, so it must
    // not exhaust the visitor's five-per-hour allowance. Eight refused attempts
    // is past that allowance: if they were reaching the hourly limiter, the
    // later ones would come back as "rate_limited" instead.

    for (let i = 0; i < 8; i++) {
      r = await post(port, "203.0.113.1");
      assert.strictEqual(r.body.code, "cooldown", `attempt ${i + 1} is refused by the cooldown, not the hourly cap`);
    }
  } finally {
    server.close();
  }

  /* ================= A cooldown on a controllable clock ================= */

  let clock = 1_000_000;
  const now = () => clock;
  const advance = (ms) => (clock += ms);
  server = await listen(buildApp(createCooldown({ now })));
  ({ port } = server.address());

  try {
    /* -------------- 5) A failure cannot shorten the next cooldown -------- */
    //
    // The production sequence, with the gaps that mattered: a typo, a real lead
    // just short of two minutes later, and another real lead just after two
    // minutes from the typo. A fixed window opened by the typo expires between
    // the two leads and lets both through.

    let r = await post(port, "198.51.100.1", 400);
    assert.strictEqual(r.status, 400);
    await settle();

    advance(COOLDOWN_MS - 2_000);
    r = await post(port, "198.51.100.1");
    assert.strictEqual(r.status, 200, "the lead after the typo goes through");
    await settle();

    advance(12_000);
    r = await post(port, "198.51.100.1");
    assert.strictEqual(r.status, 429, "twelve seconds after an accepted lead is inside its cooldown, whatever came before");

    /* -------------- 6) The cooldown runs from the accepted lead ---------- */

    advance(COOLDOWN_MS - 12_000 - 1);
    r = await post(port, "198.51.100.1");
    assert.strictEqual(r.status, 429, "one millisecond short of the cooldown is still refused");

    advance(1);
    r = await post(port, "198.51.100.1");
    assert.strictEqual(r.status, 200, "and it lapses exactly one cooldown after the accepted lead");
    await settle();

    /* -------------- 7) Simultaneous submissions: exactly one wins -------- */
    //
    // Both arrive before either is accepted. Without the in-flight guard both
    // pass the "last accepted" check and both leads are sent.

    const both = await Promise.all([
      post(port, "198.51.100.2", 200, 80),
      post(port, "198.51.100.2", 200, 80),
    ]);
    const statuses = both.map((x) => x.status).sort();
    assert.deepStrictEqual(statuses, [200, 429], `one accepted, one refused; got ${statuses}`);
    await settle();

    /* -------------- 8) A failure in flight releases the key -------------- */

    const [slowFail, whileFailing] = await Promise.all([
      post(port, "198.51.100.3", 400, 80),
      (async () => {
        await new Promise((res) => setTimeout(res, 20));
        return post(port, "198.51.100.3");
      })(),
    ]);
    assert.strictEqual(slowFail.status, 400);
    assert.strictEqual(whileFailing.status, 429, "a second post during the first is refused, even if the first later fails");
    await settle();

    r = await post(port, "198.51.100.3");
    assert.strictEqual(r.status, 200, "once the failure is done, nothing is left blocking the visitor");
  } finally {
    server.close();
  }

  /* ============= The refusal body is the caller's to choose ============= */
  //
  // createCooldown is reused by /auth/password/forgot, where the default copy --
  // "You just sent us a message" -- is nonsense: nobody sent a message, they
  // asked for a reset link. It shipped that way for one run before this test
  // existed. The default must stay put for /contact and /demo.

  server = await listen(buildApp(createCooldown({ windowMs: 60_000 })));
  ({ port } = server.address());
  try {
    await post(port, "203.0.113.90");
    await settle();
    let r = await post(port, "203.0.113.90");
    assert.strictEqual(r.status, 429);
    assert.match(r.body.message, /just sent us a message/i, "the default copy is unchanged for the public forms");
    assert.strictEqual(r.body.code, "cooldown");
  } finally {
    server.close();
  }

  const CUSTOM = {
    success: false,
    code: "cooldown",
    message: "A reset link was just requested for that address. Please wait a minute before asking again.",
  };
  server = await listen(buildApp(createCooldown({ windowMs: 60_000, message: CUSTOM })));
  ({ port } = server.address());
  try {
    await post(port, "203.0.113.91");
    await settle();
    const r = await post(port, "203.0.113.91");
    assert.strictEqual(r.status, 429);
    assert.deepStrictEqual(r.body, CUSTOM, "a caller's message is used verbatim");
    assert.ok(!/sent us a message/i.test(r.body.message), "and the contact copy does not leak through");
  } finally {
    server.close();
  }

  /* ============= keyFor decides what shares a cooldown ============= */
  //
  // The reset endpoint keys on the EMAIL, not the address, so a shared office IP
  // cannot let two people race one inbox — and one person's wait is not everyone
  // behind that IP.

  server = await listen(buildApp(createCooldown({ windowMs: 60_000, keyFor: (req) => `k:${req.body.who}` })));
  ({ port } = server.address());
  try {
    const postAs = (who) => post(port, "203.0.113.92", 200, 0, { who });
    await postAs("alice");
    await settle();
    assert.strictEqual((await postAs("alice")).status, 429, "the same key is refused");
    assert.strictEqual((await postAs("bob")).status, 200, "a different key, from the SAME ip, is not");
  } finally {
    server.close();
  }

  console.log("publicContactRateLimit.middleware tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
