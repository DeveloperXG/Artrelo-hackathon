// Sign-in and landlord sign-up. Thin: the rules are in services/auth.
const {
  AuthError,
  authenticate,
  createOrAttachProfile,
  toSessionUser,
  touchLogin,
} = require("../services/auth/account.service");
const { signAccessToken, signRefreshToken, setAuthCookies } = require("../services/auth/tokens.service");

// One shape for every successful sign-in and sign-up.
//
// The refresh token is NOT in the body any more. The SPA never read it — it
// arrives as an httpOnly cookie — so returning it only handed a copy to any
// script on the page.
function startSession(res, { account, profile, kind, status = 200, message }) {
  const token = signAccessToken({ profile, account });
  setAuthCookies(res, signRefreshToken({ profile, account, kind }));
  return res.status(status).json({
    success: true,
    message,
    user: toSessionUser(profile, account),
    token,
  });
}

function fail(res, err, where) {
  if (err instanceof AuthError) {
    const body = { success: false, code: err.code, message: err.message };
    if (err.role) body.role = err.role;
    return res.status(err.status).json(body);
  }
  console.error(`[${where}]`, err);
  return res.status(500).json({ success: false, message: "Server error" });
}

exports.landlordPostSignUp = async (req, res) => {
  try {
    const { firstName, lastName, email, password, confirmPassword, phone, companyName } = req.body;
    if (!firstName || !lastName || !email || !password) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }
    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({ success: false, message: "Passwords do not match" });
    }

    const { account, profile } = await createOrAttachProfile({
      email,
      password,
      kind: "landlord",
      profileFields: { firstName, lastName, phone, companyName, role: "landlord" },
    });

    return startSession(res, {
      account,
      profile,
      kind: "landlord",
      status: 201,
      message: "Account created",
    });
  } catch (err) {
    return fail(res, err, "landlordPostSignUp");
  }
};

exports.landlordPostLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password required" });
    }
    const { account, profile } = await authenticate({ email, password, kind: "landlord" });
    await touchLogin({ account, profile, kind: "landlord" });
    return startSession(res, { account, profile, kind: "landlord", message: "Login successful" });
  } catch (err) {
    return fail(res, err, "landlordPostLogin");
  }
};

exports.tenantPostLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password required" });
    }
    const { account, profile } = await authenticate({ email, password, kind: "tenant" });
    await touchLogin({ account, profile, kind: "tenant" });
    return startSession(res, { account, profile, kind: "tenant", message: "Login successful" });
  } catch (err) {
    return fail(res, err, "tenantPostLogin");
  }
};

// Shared with auth.controller.js (tenant sign-up) so every entry point returns
// the same session shape.
exports.startSession = startSession;
exports.fail = fail;
