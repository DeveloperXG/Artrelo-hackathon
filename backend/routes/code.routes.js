const express = require("express");
const router = express.Router();
const codeController = require("../controllers/code.controller");
const { requireTenantSignupOpen } = require("../middleware/registration.middleware");
const { verifyLimiter, verifyGlobalLimiter } = require("../middleware/inviteCodeRateLimit.middleware");

// Public route to verify a code. Gated on TENANT_SIGNUP_ENABLED rather than the
// landlord switch: a tenant holding a code was invited by a landlord who
// already has an account, so this can be open during a closed beta.
//
// Unauthenticated and it tells the caller whether a code is real, so the
// limiters run first — see inviteCodeRateLimit.middleware.js.
router.post(
  "/verify",
  verifyGlobalLimiter,
  verifyLimiter,
  requireTenantSignupOpen,
  codeController.verifyInviteCode
);

// Landlords generate codes through POST /api/v1/landlords/invite-codes
// (authenticated, landlord-only). There is deliberately no public generate
// route here.

module.exports = router;
