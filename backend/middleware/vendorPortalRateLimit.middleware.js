const rateLimit = require("express-rate-limit");

// The vendor portal is the only unauthenticated, state-changing surface in the
// API, so it gets its own limits. Token entropy (256 bits) already makes
// guessing infeasible; these caps exist to blunt scripted abuse and to keep a
// leaked link from being hammered.

const WINDOW_MS = 15 * 60 * 1000;

const briefLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again shortly." },
});

const respondLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again shortly." },
});

// Reviewing availability is not a vendor response or consent. A manager trying
// wording must not consume a vendor's confirmation budget on the same network.
const availabilityPreviewLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many availability previews. Please try again shortly, or enter an exact time." },
});

// The counter-offer round gets its OWN instance rather than reusing
// respondLimiter. These are IP-keyed and each limiter holds one shared counter,
// so sharing would let a busy offer round exhaust the counter-offer budget for
// every vendor behind the same NAT.
const counterOfferLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again shortly." },
});

// Completion is a second unauthenticated surface, and the upload one carries
// file bodies, so it gets its own (tighter) caps rather than sharing the
// brief/respond ones.
const completionReadLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again shortly." },
});

const completionUploadLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many uploads. Please try again shortly." },
});

const completionSubmitLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again shortly." },
});

module.exports = {
  briefLimiter,
  respondLimiter,
  availabilityPreviewLimiter,
  counterOfferLimiter,
  completionReadLimiter,
  completionUploadLimiter,
  completionSubmitLimiter,
};
