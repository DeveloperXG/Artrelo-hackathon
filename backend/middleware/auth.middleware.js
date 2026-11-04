const SYSTEM_API_KEY = require("../config/env").sys_api_key;
const { verifyAccessToken } = require("../services/auth/tokens.service");

const userAuth = async (req, res, next) => {
  //-- NO COOKIE W/ MANUAL AUTHORIZATION HEADER MANUALLY SET
  const authHeader = req.headers.authorization; // "Bearer TOKEN"
  if (!authHeader)
    return res
      .status(401)
      .json({ success: false, message: "No auth header provided" });

  const token = authHeader.split(" ")[1]; // remove "Bearer "

  //--COOKIE FOR AUTOMATIC USER AUTH WITH NO MANUAL AUTH HEADER NEEDED FOR BROWSER REQUEST
  //   const token = req.cookies.token;
  //   if (!token)
  //     return res.status(401).json({ message: "No token provided" });

  try {
    // verifyAccessToken demands typ === "access", pins HS256, and is the only
    // thing that accepts the access-token secret. A tenant sign-up token used
    // to verify here — same secret, no type marker — and let its holder
    // through every route guarded by isAuth alone.
    const decoded = verifyAccessToken(token);
    req.user = { id: decoded.userId, role: decoded.role, accountId: decoded.accountId };
    // Beside req.user, not on it: authorize() and others key off that shape.
    // The live stream reads this to end itself when the token lapses.
    req.authExpiresAt = decoded.exp ? decoded.exp * 1000 : null;
    next();
  } catch (err) {
    console.error("JWT auth error", err);
    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "No token provided" });
    }
    return res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
};

const apiKeyAuth = (req, res, next) => {
  const apiKey = req.header("X-API-key");
  if (!apiKey || apiKey !== SYSTEM_API_KEY) {
    return res
      .status(401)
      .json({ success: false, message: "Invalid or missing API key" });
  }
  
  // Mark request as system generated
  req.isSystemRequest = true;
  next();
};

module.exports = {
  userAuth,
  apiKeyAuth,
};
