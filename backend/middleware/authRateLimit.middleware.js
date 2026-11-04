const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const { normalizeEmail } = require("../services/auth/account.service");

// Limits on every endpoint that checks a password.
//
// There were none: login, landlord sign-up and tenant sign-up would all check
// passwords as fast as they were asked. Sign-up matters as much as login,
// because attaching a second role to an existing account also takes that
// account's password — a second door onto the same guess.
//
// In memory, so a deploy resets the counters and the service must stay at one
// replica for these to mean anything (see backend/railway.json).

const WINDOW_MS = 15 * 60 * 1000;

// Keyed on address AND email, so one person guessing many passwords for one
// account is stopped without locking out everyone behind a shared IP — an
// office, a phone network — who is merely signing in.
//
// skipSuccessfulRequests: correct sign-ins never count, so an active user is
// never throttled; only failures accumulate.
const credentialLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  // ipKeyGenerator is required rather than req.ip directly: it normalises IPv6
  // to a /56 subnet, and express-rate-limit v8 rejects custom key generators
  // that use the raw address.
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${normalizeEmail(req.body?.email)}`,
  message: {
    success: false,
    code: "rate_limited",
    message: "Too many attempts for this account. Please wait a few minutes and try again.",
  },
});

// A backstop for someone spraying one password across many addresses, which
// the per-email key alone would never see. Loose enough not to trouble a busy
// office; failures again do the counting.
const credentialIpLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 50,
  skipSuccessfulRequests: true,
  standardHeaders: false,
  legacyHeaders: false,
  message: {
    success: false,
    code: "rate_limited",
    message: "Too many attempts from this network. Please wait a few minutes and try again.",
  },
});

// Invite peek and accept.
//
// Keyed on address alone, because neither request carries an email the limiter
// could use: the INVITE decides which address is involved, and the body's email
// is ignored precisely so a link cannot be pointed at someone else's account.
//
// Guessing the token itself is not the threat — it is 256 bits. This caps the
// hammering, and on accept it caps password attempts against an address the
// caller already holds a link for, which credentialLimiter cannot see.
//
// Failures are NOT skipped here. A person opening their own invite twice and
// mistyping a password once is nowhere near 20; anything that is needs slowing
// down whether it succeeds or not.
const inviteLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: {
    success: false,
    code: "rate_limited",
    message: "Too many attempts. Please wait a few minutes and try again.",
  },
});

module.exports = { credentialLimiter, credentialIpLimiter, inviteLimiter };
