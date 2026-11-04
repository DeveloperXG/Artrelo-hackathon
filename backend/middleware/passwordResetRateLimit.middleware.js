// Limits on the password-reset endpoints.
//
// /forgot is an endpoint that makes US send email to an address a stranger
// chooses, so it is a mailer somebody else can aim. Three layers, because each
// sees something the others cannot:
//
//   forgotIpLimiter   — one client hammering it.
//   forgotCooldown    — one ADDRESS, from any client. A shared office IP must
//                       not let two people race the same inbox.
//   (in the controller) a database-backed cap of 3 per address per hour, which
//                       is the only one that survives a deploy and the only one
//                       that sees an attacker cycling IPs.
//
// The first two are in memory, so the service must stay at a single replica for
// them to mean anything — see backend/railway.json.
//
// NOTHING HERE MAY DEPEND ON WHETHER THE ADDRESS EXISTS. These run before the
// controller, which has not looked anything up yet, so that holds by
// construction: a 429 says "you asked recently", never "this account is real".

const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

const { normalizeEmail } = require("../services/auth/account.service");
const { createCooldown } = require("./publicContactRateLimit.middleware");

const WINDOW_MS = 15 * 60 * 1000;
const EMAIL_COOLDOWN_MS = 60 * 1000;

const forgotIpLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: {
    success: false,
    code: "rate_limited",
    message: "Too many reset requests from this network. Please wait a few minutes.",
  },
});

// createCooldown rather than express-rate-limit, for the reason spelled out in
// publicContactRateLimit: a fixed-window limiter's "cooldown" lasts only as long
// as whatever is left of a window some earlier request opened, which in
// production let two submissions through twelve seconds apart. This remembers
// when an address was last accepted and refuses anything inside the window.
//
// /forgot always answers 202, so every request counts — which is exactly right
// here. The alternative, counting only "real" ones, would make the timing depend
// on whether the account exists.
const forgotCooldown = createCooldown({
  windowMs: EMAIL_COOLDOWN_MS,
  keyFor: (req) => `forgot:${normalizeEmail(req.body?.email) || ipKeyGenerator(req.ip)}`,
  // Says only "you asked recently", never whether the address exists.
  message: {
    success: false,
    code: "cooldown",
    message: "A reset link was just requested for that address. Please wait a minute before asking again.",
  },
});

// The reset itself. Loose: somebody following a link they were sent is not the
// threat, and guessing the token is not feasible. This is a backstop against
// scripted noise.
const resetLimiter = rateLimit({
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

module.exports = {
  forgotIpLimiter,
  forgotCooldown,
  resetLimiter,
  EMAIL_COOLDOWN_MS,
};
