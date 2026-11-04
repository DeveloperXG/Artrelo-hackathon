// Every JWT this API mints or verifies, in one place.
//
// WHY THIS EXISTS. Tokens used to be signed inline in three controllers, and
// one of those — the tenant invite `signupToken` — was signed with the SAME
// secret as an access token and carried no marker saying what it was. userAuth
// happily accepted it as a login: `req.user` came out as
// {id: undefined, role: undefined}, which authorize() rejects but a route
// guarded only by isAuth does not. That covered ai, payments, uploads,
// requests/:id, profile and notifications.
//
// Two rules follow, and both live here so no caller can forget them:
//
//   * every token says what it is (`typ`), and every verify demands the `typ`
//     it expects;
//   * the sign-up token is signed with a DERIVED key, so even a bug in the typ
//     check cannot make it verify as an access token.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../../config/env");

// HS256 pinned on every verify. Without it, `alg` is attacker-controlled.
const ALGS = ["HS256"];

// A separate key for sign-up tokens, derived rather than configured: another
// env var is another thing to set correctly in production, and this cannot be
// left unset.
const signupKey = () => crypto.createHmac("sha256", String(env.jwt_secret)).update("tenant-signup").digest();

const REFRESH_COOKIE = "refreshToken";
const REFRESH_COOKIE_PATH = "/api/v1/auth/refresh-token";
const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// `userId` stays the PROFILE id: ~137 handlers read req.user.id and mean the
// landlord or tenant document, and accounts do not change that.
function signAccessToken({ profile, account }) {
  return jwt.sign(
    {
      typ: "access",
      userId: profile._id.toString(),
      role: profile.role,
      accountId: account._id.toString(),
    },
    env.jwt_secret,
    { expiresIn: env.jwt_expires_in }
  );
}

// Carries the profile KIND, not the role. Role is a mutable property of the
// profile (property_manager, co-tenant), so it is re-read on every refresh;
// the kind is what decides which collection to look in. `tv` is the account's
// tokenVersion — a password reset bumps it and every outstanding refresh token
// dies with it.
function signRefreshToken({ profile, account, kind }) {
  return jwt.sign(
    {
      typ: "refresh",
      sub: account._id.toString(),
      pk: kind,
      pid: profile._id.toString(),
      tv: account.tokenVersion || 0,
    },
    env.refresh_token_secret,
    { expiresIn: env.refresh_token_expires_in }
  );
}

function verifyAccessToken(token) {
  const decoded = jwt.verify(token, env.jwt_secret, { algorithms: ALGS });
  if (decoded?.typ !== "access") throw new jwt.JsonWebTokenError("not an access token");
  return decoded;
}

function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, env.refresh_token_secret, { algorithms: ALGS });
  if (decoded?.typ !== "refresh") throw new jwt.JsonWebTokenError("not a refresh token");
  return decoded;
}

// Proof that an invite code was verified, handed to the sign-up call that
// follows. Not a login, and now unable to masquerade as one.
function signTenantSignupToken({ code, landlordId, unitId }) {
  return jwt.sign({ typ: "tenant_signup", code, landlordId, unitId }, signupKey(), { expiresIn: "15m" });
}

function verifyTenantSignupToken(token) {
  const decoded = jwt.verify(token, signupKey(), { algorithms: ALGS });
  if (decoded?.typ !== "tenant_signup") throw new jwt.JsonWebTokenError("not a sign-up token");
  return decoded;
}

// Only the refresh token is a cookie. The access token used to be set as one
// too, but userAuth reads the Authorization header and never looked at it.
//
// maxAge matches the token's own 7-day lifetime; it used to be 7 HOURS, so a
// browser dropped a still-valid refresh token overnight and logged the user
// out for no reason.
function setAuthCookies(res, refreshToken) {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    path: REFRESH_COOKIE_PATH,
    secure: env.node_env === "production",
    sameSite: "strict",
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

function clearAuthCookies(res) {
  const base = { httpOnly: true, secure: env.node_env === "production", sameSite: "strict" };
  res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
  // The access-token cookie is no longer set, but browsers from before this
  // change still hold one. Clear it so it expires now rather than in 15
  // minutes of confusion.
  res.clearCookie("token", base);
}

module.exports = {
  ALGS,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_MAX_AGE_MS,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  signTenantSignupToken,
  verifyTenantSignupToken,
  setAuthCookies,
  clearAuthCookies,
};
