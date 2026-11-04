const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

// The marketing contact form is unauthenticated, uncaptcha'd, and triggers an
// outbound send — so it is the cheapest thing in the API to abuse. Three layers
// live here, all keyed off the request rather than the body:
//
//   * a short per-IP cooldown, so a reload-and-resubmit cannot land a second
//     lead seconds after the first;
//   * a per-IP hourly cap for scripted floods;
//   * a global cap so a distributed spray can't burn the Resend quota or bury a
//     real lead in noise.
//
// A fourth, per-email limit lives in the controller: it needs the validated
// address and a durable count, and these in-memory stores reset on every
// deploy. That is acceptable for windows measured in minutes, not for a day.

const HOUR_MS = 60 * 60 * 1000;
const COOLDOWN_MS = 2 * 60 * 1000;

const COOLDOWN_MESSAGE = {
  success: false,
  code: "cooldown",
  message: "You just sent us a message. Please wait a couple of minutes before sending another.",
};

// At most one ACCEPTED submission per IP per COOLDOWN_MS, shared by /contact
// and /demo, measured from the moment that submission was accepted.
//
// WHY NOT express-rate-limit. This was a limit:1, skipFailedRequests limiter,
// and in production it let the same browser land two leads twelve seconds
// apart. That limiter counts in fixed windows that open on a key's first
// request of ANY outcome. skipFailedRequests takes a failed request back out of
// the count but leaves its window running, so a typo at 0:00 followed by a real
// lead at 1:58 put that lead at the tail of a window closing at 2:00 — and the
// next submission, at 2:10, opened a fresh window and went through. The
// "cooldown" lasted as long as whatever was left of a window a failure started.
//
// So the rule is stated directly instead: remember when each key last had a
// submission accepted, refuse anything inside COOLDOWN_MS of that.
//
//   * Accepted means a response under 400 — a real lead, or a honeypot hit made
//     to look like one. A validation 400, the controller's per-address 429, or
//     the hourly cap's 429 records nothing, so fixing a mistyped email is never
//     punished and can never shift the timing of the next real send.
//   * While one submission is being processed, others from the same key are
//     refused. Without that, two near-simultaneous posts both pass the check
//     before either is accepted.
//   * If the client disconnects before a response is written, the submission
//     is treated as accepted: the controller carries on regardless, so a lead
//     has most likely been created.
//
// In memory, like the other limiters, so a deploy clears it. The service runs a
// single replica; with more, this would need a shared store.
function createCooldown({
  windowMs = COOLDOWN_MS,
  now = Date.now,
  keyFor = (req) => ipKeyGenerator(req.ip),
  // The refusal body. A parameter because this is reused by the password-reset
  // endpoint, where "you just sent us a message" is nonsense — the caller asked
  // for a reset link, not a contact form. Defaults to the contact copy so the
  // two public forms are unaffected.
  message = COOLDOWN_MESSAGE,
} = {}) {
  const acceptedAt = new Map(); // key -> when its last submission was accepted
  const inFlight = new Set(); // keys with a submission currently being handled

  // Expired entries are only ever read to be ignored, so drop them periodically
  // to keep the map bounded by recent traffic. unref() so tests can exit.
  const sweep = setInterval(() => {
    const cutoff = now() - windowMs;
    for (const [key, at] of acceptedAt) if (at <= cutoff) acceptedAt.delete(key);
  }, windowMs);
  sweep.unref();

  function cooldown(req, res, next) {
    const key = keyFor(req);
    const t = now();
    const last = acceptedAt.get(key);
    const cooling = last !== undefined && t - last < windowMs;

    if (cooling || inFlight.has(key)) {
      const waitMs = cooling ? windowMs - (t - last) : windowMs;
      res.set("Retry-After", String(Math.max(1, Math.ceil(waitMs / 1000))));
      return res.status(429).json(message);
    }

    inFlight.add(key);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      inFlight.delete(key);
      // statusCode is still its default 200 if the client left before the
      // handler responded — deliberately counted as accepted (see above).
      if (res.statusCode < 400) acceptedAt.set(key, now());
    };
    // "close" also fires after "finish"; `settled` makes the pair idempotent.
    res.on("finish", settle);
    res.on("close", settle);
    next();
  }

  return cooldown;
}

const cooldownLimiter = createCooldown();

const perIpLimiter = rateLimit({
  windowMs: HOUR_MS,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "rate_limited",
    message: "Too many messages from this address. Please try again later, or email us directly.",
  },
});

// Keyed to a constant so every request shares one bucket.
const globalLimiter = rateLimit({
  windowMs: HOUR_MS,
  limit: 100,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: () => "public-contact",
  message: {
    success: false,
    code: "rate_limited",
    message: "We're receiving an unusual volume of messages. Please try again later.",
  },
});

module.exports = { cooldownLimiter, perIpLimiter, globalLimiter, createCooldown, COOLDOWN_MS };
