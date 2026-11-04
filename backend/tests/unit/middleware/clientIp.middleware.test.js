// resolveClientIp — req.ip from Railway's X-Real-IP.
//
// THE RULE THIS FILE EXISTS TO PROTECT: one visitor is one rate-limit key, even
// when Railway's network adds a varying hop to X-Forwarded-For. In production,
// `trust proxy 1` alone took that varying hop as the client, so a single IPv4
// visitor landed in two buckets and slipped past the contact-form cooldown.
// Case 4 reproduces exactly that shape.

const assert = require("assert");
const http = require("http");
const express = require("express");

const { resolveClientIp, normalise } = require("../../../middleware/clientIp.middleware");
const { cooldownLimiter } = require("../../../middleware/publicContactRateLimit.middleware");

function runMiddleware(headers, fallbackIp = "10.0.0.1") {
  // A plain object standing in for Express's request, with req.ip as a
  // prototype getter the way Express defines it.
  const proto = { get ip() { return fallbackIp; } };
  const req = Object.create(proto);
  req.headers = headers;
  let called = false;
  resolveClientIp(req, {}, () => (called = true));
  assert.ok(called, "must always continue the chain");
  return req.ip;
}

function post(port, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/contact",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function main() {
  /* -------------- 1) A valid X-Real-IP becomes req.ip ------------------ */

  assert.strictEqual(runMiddleware({ "x-real-ip": "24.66.244.189" }), "24.66.244.189");
  assert.strictEqual(runMiddleware({ "x-real-ip": " 24.66.244.189 " }), "24.66.244.189", "whitespace is tolerated");
  assert.strictEqual(runMiddleware({ "x-real-ip": "2604:3d09:497b:d620::1" }), "2604:3d09:497b:d620::1");

  /* -------------- 2) IPv4-mapped IPv6 is unwrapped --------------------- */
  //
  // Left wrapped, the limiter's IPv6 /56 grouping would put every IPv4 client
  // on the internet into one bucket.

  assert.strictEqual(normalise("::ffff:24.66.244.189"), "24.66.244.189");
  assert.strictEqual(normalise("::FFFF:24.66.244.189"), "24.66.244.189");

  /* -------------- 3) Anything but one literal address is ignored -------- */

  for (const bad of ["", "   ", "unknown", "24.66.244.189, 10.0.0.2", "24.66.244.189:443", "example.com", "999.1.1.1"]) {
    assert.strictEqual(runMiddleware({ "x-real-ip": bad }), "10.0.0.1", `"${bad}" must fall back to Express's req.ip`);
  }
  assert.strictEqual(runMiddleware({}), "10.0.0.1", "no header: Express's req.ip stands");
  assert.strictEqual(runMiddleware({ "x-real-ip": ["1.2.3.4", "5.6.7.8"] }), "10.0.0.1", "a repeated header is not trusted");

  /* -------------- 4) Through a limiter: the production failure ---------- */

  const app = express();
  app.set("trust proxy", "loopback");
  app.use(resolveClientIp);
  app.use(express.json());
  app.post("/contact", cooldownLimiter, (req, res) => res.status(200).json({ ip: req.ip }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address();

  try {
    // Same visitor, but the last X-Forwarded-For hop differs between requests
    // — which is what Express alone would have used as the client address.
    let r = await post(port, { "X-Real-IP": "24.66.244.189", "X-Forwarded-For": "24.66.244.189, 100.64.0.11" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ip, "24.66.244.189", "the handler sees the visitor, not the hop");

    r = await post(port, { "X-Real-IP": "24.66.244.189", "X-Forwarded-For": "24.66.244.189, 100.64.0.27" });
    assert.strictEqual(r.status, 429, "a varying internal hop must not give the same visitor a second bucket");
    assert.strictEqual(r.body.code, "cooldown");

    /* ------------ 5) Different visitors stay independent --------------- */

    r = await post(port, { "X-Real-IP": "198.51.100.40", "X-Forwarded-For": "198.51.100.40, 100.64.0.11" });
    assert.strictEqual(r.status, 200, "sharing an internal hop must not make strangers share a bucket");

    /* ------------ 6) Without X-Real-IP, Express's own answer is used ---- */

    r = await post(port, { "X-Forwarded-For": "203.0.113.9" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ip, "203.0.113.9");
  } finally {
    server.close();
  }

  console.log("clientIp.middleware tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
