const express = require("express");
const router = express.Router();
const publicContactController = require("../controllers/publicContact.controller");
const {
  cooldownLimiter,
  perIpLimiter,
  globalLimiter,
} = require("../middleware/publicContactRateLimit.middleware");

// Unauthenticated by design — this is the marketing site's contact form, and
// the marketing app is a static export with no server of its own. The limiters
// run before the controller so a flood never reaches Resend. The cooldown sits
// ahead of the hourly cap so a rapid resubmit is refused without spending one
// of the visitor's five hourly slots.
router.post(
  "/",
  globalLimiter,
  cooldownLimiter,
  perIpLimiter,
  publicContactController.submitContactInquiry
);

module.exports = router;
