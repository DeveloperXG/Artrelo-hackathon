// Who may create an account during a closed beta.
//
// THE RULE THIS FILE EXISTS TO PROTECT: the two sign-ups answer to two
// switches. A landlord arriving from nowhere is public sign-up; a tenant
// holding an invite code was invited by a landlord who already has an account.
// Collapsing them back into one flag either locks a beta landlord's tenants out
// of the product or throws the doors open — and login must stay reachable
// either way, since it is not a sign-up at all.

const assert = require("assert");

const env = require("../../../config/env");
const {
  requireRegistrationOpen,
  requireTenantSignupOpen,
} = require("../../../middleware/registration.middleware");

function run(middleware) {
  let nextCalled = false;
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  middleware({}, res, () => (nextCalled = true));
  return { nextCalled, status: nextCalled ? 200 : res.statusCode, payload: res.payload };
}

function main() {
  const original = {
    registration: env.registration_enabled,
    tenant: env.tenant_signup_enabled,
  };

  try {
    /* -------------- 1) The beta shape: tenants in, landlords out -------- */

    env.registration_enabled = false;
    env.tenant_signup_enabled = true;

    let r = run(requireRegistrationOpen);
    assert.strictEqual(r.nextCalled, false, "public landlord sign-up stays shut");
    assert.strictEqual(r.status, 503);
    assert.match(r.payload.message, /not open/i);

    r = run(requireTenantSignupOpen);
    assert.strictEqual(r.nextCalled, true, "a beta landlord's tenants must be able to join");

    /* -------------- 2) Fully closed ------------------------------------- */

    env.registration_enabled = false;
    env.tenant_signup_enabled = false;

    assert.strictEqual(run(requireRegistrationOpen).nextCalled, false);
    assert.strictEqual(run(requireTenantSignupOpen).nextCalled, false, "tenant sign-up is off unless set");

    /* -------------- 3) Fully open --------------------------------------- */

    env.registration_enabled = true;
    env.tenant_signup_enabled = true;

    assert.strictEqual(run(requireRegistrationOpen).nextCalled, true);
    assert.strictEqual(run(requireTenantSignupOpen).nextCalled, true);

    /* -------------- 4) The gates are independent ------------------------ */
    //
    // Landlord sign-up open while tenant sign-up is not is a strange state to
    // configure, but it must be the state you get — one flag must never be
    // quietly reading the other.

    env.registration_enabled = true;
    env.tenant_signup_enabled = false;

    assert.strictEqual(run(requireRegistrationOpen).nextCalled, true);
    assert.strictEqual(run(requireTenantSignupOpen).nextCalled, false);
  } finally {
    env.registration_enabled = original.registration;
    env.tenant_signup_enabled = original.tenant;
  }

  console.log("registration.middleware tests passed");
}

main();
