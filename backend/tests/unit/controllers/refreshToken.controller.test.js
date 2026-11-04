// Refreshing an access token.
//
// THE RULE THIS FILE EXISTS TO PROTECT: refreshing re-reads the account and
// the profile every time. It used to re-mint straight from the old token's
// payload — no database read at all — which meant a deleted account, a
// disabled one, or a stale role kept working for the seven days the refresh
// token lived, and nothing could end a session. A password reset that cannot
// log the stranger out is not a password reset.
//
// The second rule: the refresh token comes from the cookie and nowhere else.
// It used to be accepted from the query string too, which writes a seven-day
// credential into server logs and Referer headers.

const assert = require("assert");

const Account = require("../../../models/Account");
const Landlord = require("../../../models/Landlord");
const Tenant = require("../../../models/Tenant");

let account = null;
let landlord = null;
let tenant = null;

Account.findById = async (id) => (account && String(account._id) === String(id) ? account : null);
Landlord.findOne = async (filter) =>
  landlord && String(landlord.accountId) === String(filter.accountId) ? landlord : null;
Tenant.findOne = async (filter) =>
  tenant && String(tenant.accountId) === String(filter.accountId) ? tenant : null;

const env = require("../../../config/env");
env.jwt_secret = env.jwt_secret || "test-secret";
env.refresh_token_secret = env.refresh_token_secret || "test-refresh-secret";

const { postRefreshToken } = require("../../../controllers/auth.controller");
const {
  signRefreshToken,
  signAccessToken,
  verifyAccessToken,
} = require("../../../services/auth/tokens.service");

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    cookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    cookie(name, value, opts) {
      this.cookies.push({ name, value, opts });
      return this;
    },
  };
}

const call = async (req) => {
  const res = makeRes();
  await postRefreshToken(req, res);
  return res;
};

function reset() {
  account = { _id: "acc-1", email: "dana@example.com", tokenVersion: 3, status: "active" };
  landlord = { _id: "prof-1", accountId: "acc-1", role: "landlord", firstName: "Dana", email: account.email };
  tenant = null;
}

async function main() {
  const realError = console.error;
  console.error = () => {};

  try {
    /* -------------- 1) The happy path ------------------------------------ */

    reset();
    const good = signRefreshToken({ profile: landlord, account, kind: "landlord" });
    let res = await call({ cookies: { refreshToken: good } });

    assert.strictEqual(res.statusCode, 200);
    const decoded = verifyAccessToken(res.payload.token);
    assert.strictEqual(decoded.userId, "prof-1");
    assert.strictEqual(decoded.role, "landlord");
    assert.ok(res.payload.user, "the client needs the session back to spot a role change");
    assert.strictEqual(res.payload.user.role, "landlord");

    /* -------------- 2) The role is re-read, not copied ------------------- */
    //
    // A promotion (or demotion) applies on the next refresh rather than
    // whenever the user happens to sign in again.

    landlord.role = "property_manager";
    res = await call({ cookies: { refreshToken: good } });
    assert.strictEqual(verifyAccessToken(res.payload.token).role, "property_manager");

    /* -------------- 3) A password reset ends the session ----------------- */

    reset();
    const beforeReset = signRefreshToken({ profile: landlord, account, kind: "landlord" });
    account.tokenVersion = 4; // what resetPassword does
    res = await call({ cookies: { refreshToken: beforeReset } });
    assert.strictEqual(res.statusCode, 401, "a token minted before the reset must stop working");

    /* -------------- 4) Disabled, deleted, profile gone ------------------- */

    reset();
    const token = signRefreshToken({ profile: landlord, account, kind: "landlord" });

    account.status = "disabled";
    assert.strictEqual((await call({ cookies: { refreshToken: token } })).statusCode, 401, "disabled");

    reset();
    account = null;
    assert.strictEqual((await call({ cookies: { refreshToken: token } })).statusCode, 401, "account deleted");

    reset();
    landlord = null;
    assert.strictEqual((await call({ cookies: { refreshToken: token } })).statusCode, 401, "profile deleted");

    /* -------------- 5) Cookie only --------------------------------------- */

    reset();
    const live = signRefreshToken({ profile: landlord, account, kind: "landlord" });
    assert.strictEqual((await call({ cookies: {}, query: { refreshToken: live } })).statusCode, 401, "query string");
    assert.strictEqual((await call({ cookies: {}, body: { refreshToken: live } })).statusCode, 401, "body");
    assert.strictEqual((await call({ cookies: {} })).statusCode, 401, "absent");

    /* -------------- 6) Only a refresh token refreshes -------------------- */

    reset();
    const access = signAccessToken({ profile: landlord, account });
    assert.strictEqual((await call({ cookies: { refreshToken: access } })).statusCode, 401);

    /* -------------- 7) The kind decides which collection ----------------- */

    reset();
    tenant = { _id: "ten-1", accountId: "acc-1", role: "tenant", email: account.email };
    const tenantToken = signRefreshToken({ profile: tenant, account, kind: "tenant" });
    res = await call({ cookies: { refreshToken: tenantToken } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      verifyAccessToken(res.payload.token).userId,
      "ten-1",
      "one account holding both roles refreshes the one it signed in as"
    );
  } finally {
    console.error = realError;
  }

  console.log("refreshToken.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
