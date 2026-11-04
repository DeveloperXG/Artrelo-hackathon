// What counts as "signed in".
//
// THE RULE THIS FILE EXISTS TO PROTECT: only an access token authenticates.
//
// It did not used to. The tenant invite `signupToken` was signed with the same
// JWT_SECRET and carried no marker saying what it was, so userAuth verified it
// happily and set req.user = {id: undefined, role: undefined}. authorize()
// rejects that, but every route guarded by isAuth ALONE did not: ai, payments,
// uploads, requests/:id, profile, notifications. Anyone who could verify an
// invite code — an unauthenticated call — held a key to them.
//
// Case 1 is that bug, driven end to end: mint a real sign-up token through the
// controller, then present it as a Bearer token.

const assert = require("assert");
const jwt = require("jsonwebtoken");

const env = require("../../../config/env");
env.jwt_secret = env.jwt_secret || "test-secret";
env.refresh_token_secret = env.refresh_token_secret || "test-refresh-secret";

const { userAuth } = require("../../../middleware/auth.middleware");
const {
  signAccessToken,
  signRefreshToken,
  signTenantSignupToken,
} = require("../../../services/auth/tokens.service");

function run(token) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
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
  // userAuth is async but resolves synchronously on every path here.
  return Promise.resolve(userAuth(req, res, () => (nextCalled = true))).then(() => ({
    req,
    nextCalled,
    status: nextCalled ? 200 : res.statusCode,
  }));
}

const ACCOUNT = { _id: "acc-1", tokenVersion: 3 };
const PROFILE = { _id: "prof-1", role: "landlord" };

async function main() {
  const realError = console.error;
  console.error = () => {};

  try {
    /* -------------- 1) A sign-up token is not a login -------------------- */

    const signupToken = signTenantSignupToken({ code: "9JKMNPQRST", landlordId: "l1", unitId: "u1" });
    let r = await run(signupToken);
    assert.strictEqual(r.nextCalled, false, "an invite sign-up token must never authenticate");
    assert.strictEqual(r.status, 401);

    /* -------------- 2) Nor is a refresh token ---------------------------- */

    r = await run(signRefreshToken({ profile: PROFILE, account: ACCOUNT, kind: "landlord" }));
    assert.strictEqual(r.nextCalled, false, "a refresh token is not an access token");

    /* -------------- 3) Nor is an unmarked token signed with the secret --- */
    //
    // Exactly the shape tokens had before `typ` existed, so a token minted by
    // the old code cannot be replayed against the new middleware either.

    const legacy = jwt.sign({ userId: "prof-1", role: "landlord" }, env.jwt_secret, { expiresIn: "15m" });
    r = await run(legacy);
    assert.strictEqual(r.nextCalled, false, "a token with no typ must be refused");

    /* -------------- 4) A real access token works ------------------------- */

    r = await run(signAccessToken({ profile: PROFILE, account: ACCOUNT }));
    assert.strictEqual(r.nextCalled, true);
    assert.deepStrictEqual(
      r.req.user,
      { id: "prof-1", role: "landlord", accountId: "acc-1" },
      "req.user.id stays the PROFILE id — ~137 handlers read it that way"
    );

    /* -------------- 5) The sign-up token uses a different key ------------ */
    //
    // Belt and braces behind case 1: the typ check is what refuses it, and
    // this is why a mistake in that check still could not turn a sign-up token
    // into a login. Asserted directly because it is invisible in behaviour —
    // remove the derived key and every test above still passes.

    assert.throws(
      () => jwt.verify(signupToken, env.jwt_secret, { algorithms: ["HS256"] }),
      /signature/i,
      "a sign-up token must not even verify under the access-token secret"
    );

    /* -------------- 6) Junk and absence ---------------------------------- */

    assert.strictEqual((await run(null)).status, 401, "no header");
    assert.strictEqual((await run("not-a-jwt")).status, 401);
    assert.strictEqual(
      (await run(jwt.sign({ typ: "access", userId: "x" }, "the-wrong-secret"))).status,
      401,
      "a token signed with another key is not ours"
    );
  } finally {
    console.error = realError;
  }

  console.log("auth.middleware tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
