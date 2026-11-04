const InviteCode = require("../models/Code");
const { signTenantSignupToken } = require("../services/auth/tokens.service");
// Generation lives in the shared service, and only there. This file used to
// hold a second generator plus a generateInviteCode handler whose route was
// commented out; hardening that copy never reached a real landlord's codes.
const { normalizeCode } = require("../services/inviteCode/inviteCode.service");

exports.verifyInviteCode = async (req, res) => {
  try {
    const code = normalizeCode(req.body.code);

    if (!code) {
      return res.status(400).json({ success: false, message: "Invite code is required" });
    }

    // expiresAt is filtered here rather than left to the TTL index: MongoDB
    // sweeps expired documents on a background pass that can lag a minute or
    // more, and an expired code must not verify in that window.
    const inviteCode = await InviteCode.findOne({ code, expiresAt: { $gt: new Date() } });

    if (!inviteCode) {
      return res.status(404).json({ success: false, message: "Invalid or expired invite code" });
    }

    // Proof for the sign-up call that follows. Signed with a key derived from
    // JWT_SECRET, not JWT_SECRET itself: this used to share the access-token
    // secret and carried no type marker, so userAuth accepted it as a login on
    // every route guarded by isAuth alone.
    const signupToken = signTenantSignupToken({
      code: inviteCode.code,
      landlordId: inviteCode.landlordId,
      unitId: inviteCode.unitId,
    });

    res.json({
      success: true,
      valid: true,
      signupToken, // Frontend must send this to /sign-up
      message: "Code verified. Please proceed to signup.",
    });
  } catch (err) {
    console.error("Error verifying invite code:", err);
    res.status(500).json({ success: false, message: "Server Error: Failed to verify invite code" });
  }
};

