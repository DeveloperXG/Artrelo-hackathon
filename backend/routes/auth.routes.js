const express = require("express");
const router = express.Router();
const authController = require("../controllers/auth.controller");
const landlordAuth = require("../controllers/landlordAuth.controller");
const {
  requireRegistrationOpen,
  requireTenantSignupOpen,
} = require("../middleware/registration.middleware");
const { signupLimiter } = require("../middleware/inviteCodeRateLimit.middleware");
const {
  credentialLimiter,
  credentialIpLimiter,
  inviteLimiter,
} = require("../middleware/authRateLimit.middleware");
const landlordInvite = require("../controllers/landlordInvite.controller");
const passwordReset = require("../controllers/passwordReset.controller");
const {
  forgotIpLimiter,
  forgotCooldown,
  resetLimiter,
} = require("../middleware/passwordResetRateLimit.middleware");

// Every route below that checks a password gets the credential limiters. That
// includes sign-up: when the email already has an account, signing up attaches
// a role to it and takes that account's password, so it is a second way to
// guess one.
const checksPassword = [credentialIpLimiter, credentialLimiter];

// Landlord
router.post("/landlord/sign-up", ...checksPassword, requireRegistrationOpen, landlordAuth.landlordPostSignUp);
router.post("/landlord/login", ...checksPassword, landlordAuth.landlordPostLogin);

// Beta landlord invites. Deliberately NOT behind requireRegistrationOpen: an
// invite is not public sign-up, and the whole point is that it works while
// public sign-up is shut. The token is the authorisation.
//
// The token travels in the POST body, never a URL — morgan logs URLs — and the
// emailed link carries it after a `#`, so it does not reach a server until the
// page posts it here.
router.post("/landlord/invite/peek", inviteLimiter, landlordInvite.postInvitePeek);
router.post(
  "/landlord/invite/accept",
  inviteLimiter,
  credentialIpLimiter,
  landlordInvite.postInviteAccept
);

// Tenant. A different gate from the landlord one: this route needs a signup
// token minted from a landlord's invite code, so it can open for a beta while
// public landlord sign-up stays shut.
router.post(
  "/tenant/sign-up",
  ...checksPassword,
  signupLimiter,
  requireTenantSignupOpen,
  authController.tenantPostSignUp
);
router.post("/tenant/login", ...checksPassword, landlordAuth.tenantPostLogin);

// Password reset. Ungated like login: an account that exists must always be
// recoverable, whatever the registration flags say.
//
// /forgot deliberately has NO credentialLimiter — that one keys on the email in
// the body, and a 429 whose shape depended on the address would leak whether it
// exists. These limiters answer only "you asked recently".
router.post("/password/forgot", forgotIpLimiter, forgotCooldown, passwordReset.postForgotPassword);
router.post("/password/reset", resetLimiter, passwordReset.postResetPassword);

// Common
router.post("/logout", authController.postLogout);
router.post("/refresh-token", authController.postRefreshToken);

module.exports = router;
