const rateLimit = require("express-rate-limit");

// Limits for the invite-code surface.
//
// WHY THIS EXISTS. /codes/verify is an oracle: it answers "is this a real code"
// to anyone, unauthenticated, and a hit yields a signup token for a real unit.
// While tenant sign-up was closed the gate hid that; opening it for the beta
// does not. Code length raises the cost of a guess, and these raise the cost of
// making guesses at all — neither is sufficient alone.
//
// Deliberately tighter than the contact form's: a tenant types their code once,
// maybe twice after a typo. Nobody legitimately needs ten attempts an hour, and
// the numbers below still leave a guesser needing longer than the universe has
// been around against a 32^10 code space.

const HOUR_MS = 60 * 60 * 1000;

// Per IP. Ten is generous for "type the code from your landlord's email".
const verifyLimiter = rateLimit({
  windowMs: HOUR_MS,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "rate_limited",
    message: "Too many attempts. Please wait a while and try again, or ask your landlord for a new code.",
  },
});

// A guesser with a botnet has many IPs, so the per-IP cap alone is not a
// ceiling. Keyed to a constant, this one is: it caps guesses site-wide.
// Sized well above any plausible real hour of beta traffic.
const verifyGlobalLimiter = rateLimit({
  windowMs: HOUR_MS,
  limit: 200,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: () => "invite-code-verify",
  message: {
    success: false,
    code: "rate_limited",
    message: "We're unable to check invite codes right now. Please try again shortly.",
  },
});

// Sign-up itself. A verified code already gates this, but a leaked signup token
// should not be a way to hammer account creation either.
const signupLimiter = rateLimit({
  windowMs: HOUR_MS,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "rate_limited",
    message: "Too many sign-up attempts. Please wait a while and try again.",
  },
});

module.exports = { verifyLimiter, verifyGlobalLimiter, signupLimiter };
