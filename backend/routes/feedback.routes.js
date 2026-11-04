const express = require("express");
const rateLimit = require("express-rate-limit");
const { submitFeedback } = require("../controllers/feedback.controller");

const router = express.Router();

// Per signed-in user, not per IP: tenants in one building can share an address.
// Generous for real use, and it stops a stuck button from filling the inbox.
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `feedback:${req.user?.id || "anon"}`,
  message: { success: false, code: "rate_limited", message: "That's a lot of feedback for one hour — thank you! Please try again later." },
});

// Mounted behind userAuth in app.js.
router.post("/", feedbackLimiter, submitFeedback);

module.exports = router;
