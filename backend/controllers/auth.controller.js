const Account = require("../models/Account");
const InviteCode = require("../models/Code");
const {
  AuthError,
  createOrAttachProfile,
  findProfile,
  toSessionUser,
} = require("../services/auth/account.service");
const {
  signAccessToken,
  verifyRefreshToken,
  verifyTenantSignupToken,
  clearAuthCookies,
} = require("../services/auth/tokens.service");
const { startSession, fail } = require("./landlordAuth.controller");
const { touchLandlordActivity } = require("../services/metrics/activity.service");

exports.tenantPostSignUp = async (req, res) => {
  const { firstName, lastName, email, password, confirmPassword, signupToken, phone } = req.body;

  // The code was already redeemed at this point, so put it back if anything
  // below fails. Declared out here so the catch can see it.
  let consumedCode = null;

  try {
    if (!signupToken) {
      return res.status(401).json({
        success: false,
        message: "Missing verification token. Please verify your invite code first.",
      });
    }

    let decoded;
    try {
      // Checks `typ` as well as the signature, and uses a key derived from
      // JWT_SECRET — so an access token cannot be passed off as one of these,
      // and one of these cannot be passed off as an access token.
      decoded = verifyTenantSignupToken(signupToken);
    } catch {
      return res.status(401).json({ success: false, message: "Invalid or expired verification session." });
    }

    const { code, landlordId, unitId } = decoded;

    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ success: false, message: "Passwords do not match" });
    }

    // Redeem the code BEFORE creating anything. It used to be deleted after the
    // tenant was saved, which let two sign-ups holding the same code both
    // succeed — the second arriving while the first was still hashing.
    // findOneAndDelete is atomic, so exactly one caller can win.
    consumedCode = await InviteCode.findOneAndDelete({ code, expiresAt: { $gt: new Date() } });
    if (!consumedCode) {
      return res.status(400).json({ success: false, message: "Invalid or expired invite code." });
    }

    const { account, profile } = await createOrAttachProfile({
      email,
      password,
      kind: "tenant",
      profileFields: {
        firstName,
        lastName,
        phone,
        role: "tenant",
        landlord: landlordId,
        unit: unitId,
        inviteCode: code,
        // The code proves the landlord invited this unit's tenant. It does NOT
        // prove control of the email address, so Account.emailVerifiedAt stays
        // unset — see models/Account.js.
        isVerified: true,
        status: "active",
      },
    });

    return startSession(res, {
      account,
      profile,
      kind: "tenant",
      status: 201,
      message: "New tenant has been successfully registered!",
    });
  } catch (err) {
    // Hand the code back: the invitation is the landlord's, and a failed
    // attempt must not cost them one.
    if (consumedCode) {
      await InviteCode.create({
        code: consumedCode.code,
        landlordId: consumedCode.landlordId,
        propertyId: consumedCode.propertyId,
        unitId: consumedCode.unitId,
        expiresAt: consumedCode.expiresAt,
      }).catch((restoreError) =>
        console.error("[tenantPostSignUp] invite code restore failed", restoreError?.message || restoreError)
      );
    }
    if (err?.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: Object.values(err.errors || {}).map((e) => e.message).join(", ") || "Validation error",
      });
    }
    return fail(res, err, "tenantPostSignUp");
  }
};

exports.postLogout = async (req, res) => {
  try {
    clearAuthCookies(res);
    return res.json({ success: true, message: "User has been logged out successfully!" });
  } catch (err) {
    console.error("[postLogout]", err);
    return res.status(500).json({ success: false, message: "Server Error: Failed to log user out" });
  }
};

// The SPA calls this whenever an access token expires.
//
// It used to re-mint from the old payload alone: no database read, so a
// deleted or disabled account, or a stale role, kept working for as long as
// the refresh token lived — and nothing could end a session. Now the account
// and profile are re-read every time.
exports.postRefreshToken = async (req, res) => {
  // Cookie only. It also accepted the token from the body and the QUERY
  // STRING, which puts a 7-day credential into server logs and Referer headers.
  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken) {
    return res.status(401).json({ success: false, message: "No refresh token found" });
  }

  const reject = () =>
    res.status(401).json({ success: false, message: "Invalid or expired refresh token" });

  try {
    const decoded = verifyRefreshToken(refreshToken);

    const account = await Account.findById(decoded.sub);
    if (!account || account.status !== "active") return reject();
    // Bumped by a password reset, so every session minted before it stops here.
    if ((account.tokenVersion || 0) !== (decoded.tv || 0)) return reject();

    const profile = await findProfile(decoded.pk, account._id);
    if (!profile) return reject();

    // A landlord who stays signed in never hits touchLogin again, so a refresh
    // is the only sign of life. Not awaited: bookkeeping must not slow the
    // token the SPA is waiting on, and touchLandlordActivity never throws.
    if (decoded.pk === "landlord") void touchLandlordActivity(profile._id);

    return res.json({
      success: true,
      token: signAccessToken({ profile, account }),
      // The SPA compares this against the session it has. One browser holds one
      // refresh cookie, so signing in as the other role in a second tab would
      // otherwise silently hand tab one the wrong role's token.
      user: toSessionUser(profile, account),
      message: "Access token refreshed",
    });
  } catch (err) {
    if (!(err instanceof AuthError)) console.error("[postRefreshToken]", err?.message || err);
    return reject();
  }
};
