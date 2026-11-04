const env = require("../config/env");

//
// Sign-up gates. Two of them, because the two sign-ups are not the same event.
//
// A landlord arrives from nowhere, so opening that route opens the product to
// the public. A tenant arrives holding an invite code that only a landlord with
// an account could have generated, so opening that route opens the product to
// exactly the people a beta landlord invited. During a closed beta the second
// has to be open or a beta landlord has no tenants, and tenants are who file
// the maintenance requests.
//
// Login is deliberately NOT gated by either: locking out accounts that already
// exist is never what "registration is closed" should mean.
//

exports.requireRegistrationOpen = (req, res, next) => {
  if (!env.registration_enabled) {
    return res.status(503).json({
      success: false,
      message: "Registration is not open yet.",
    });
  }
  next();
};

exports.requireTenantSignupOpen = (req, res, next) => {
  if (!env.tenant_signup_enabled) {
    return res.status(503).json({
      success: false,
      message: "Registration is not open yet.",
    });
  }
  next();
};
