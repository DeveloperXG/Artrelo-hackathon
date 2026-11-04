const net = require("net");

// Makes req.ip the visitor's address on Railway.
//
// `trust proxy 1` tells Express to take the LAST X-Forwarded-For entry, which
// assumes exactly one proxy in front of the app. Railway does not guarantee
// that: requests can pick up another hop inside Railway's network, so the last
// entry is sometimes an internal proxy address rather than the visitor. In
// production that was observed directly: one client, on one IPv4 address, was
// counted under two different rate-limit keys within a minute.
//
// Everything downstream keys on req.ip — every express-rate-limit instance
// (contact form, vendor portal, vendor hub) and the submitter IP hashes stored
// on vendor submissions — so it is fixed here, once, rather than per limiter.
//
// X-Real-IP is what Railway's edge sets as the single connecting address, and
// it overwrites any client-supplied value. That is ONLY true behind Railway's
// edge, which is why app.js mounts this in production alone: anywhere a client
// can reach the app directly, this header is attacker-controlled and must not
// be believed. Railway documents one exception — with its CDN enabled the
// header holds the CDN edge address instead — and the CDN is off for this
// service. If that changes, this needs revisiting.

// An IPv4 client can arrive as an IPv4-mapped IPv6 address. Left as-is, the
// rate limiter would apply its IPv6 subnet grouping to it, and the /56 around
// ::ffff:0:0 contains every IPv4 address — one bucket for the whole internet.
const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function normalise(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const mapped = MAPPED_V4.exec(trimmed);
  const candidate = mapped ? mapped[1] : trimmed;
  // A single literal address only: net.isIP rejects lists, ports, hostnames
  // and empty strings, all of which fall back to Express's own req.ip.
  return net.isIP(candidate) ? candidate : null;
}

function resolveClientIp(req, res, next) {
  const ip = normalise(req.headers["x-real-ip"]);
  if (ip) {
    // req.ip is a getter on Express's request prototype; an own property on
    // this request shadows it for everything later in the chain.
    Object.defineProperty(req, "ip", { value: ip, configurable: true, enumerable: true });
  }
  next();
}

module.exports = { resolveClientIp, normalise };
