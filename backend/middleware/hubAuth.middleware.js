// Authentication for the vendor hub.
//
// WHY THIS IS NOT userAuth, AND WHY THERE IS NO `vendor` ROLE.
//
// userAuth sets req.user = { id, role }, and authorize(["landlord", ...])
// gates every landlord and tenant route off exactly that shape. Adding a
// "vendor" role to it would mean a vendor now carries a req.user, and every
// route that forgot an authorize() call — or that authorizes loosely — becomes
// reachable by them. The blast radius of one missing line would be a
// contractor reading a landlord's portfolio.
//
// So a vendor never gets a req.user at all. They get req.vendorIdentity, which
// nothing else in the codebase reads, and this middleware is mounted only on
// /api/v1/vendor-hub. A route that forgets to include it does not fall back to
// weaker auth — it simply has no vendor to act on and fails.
//
// The credential is an httpOnly cookie rather than a bearer token because the
// hub is a plain browser session with no SPA token store, and httpOnly keeps it
// out of reach of any script on the page.

const VendorIdentity = require("../models/VendorIdentity");
const { resolveSession } = require("../services/vendor/hubSession.service");

const HUB_COOKIE = "artrelo_hub";

// One body for every failure — expired, revoked, forged, never existed. A
// caller must not be able to tell which, or the endpoint becomes a way to probe
// whether a given session ever existed.
const GENERIC_UNAUTHORIZED = {
  success: false,
  code: "hub_session_invalid",
  message: "Your session has ended. Request a new sign-in link.",
};

async function hubAuth(req, res, next) {
  try {
    const raw = req.cookies?.[HUB_COOKIE];
    const session = await resolveSession(raw);
    if (!session) return res.status(401).json(GENERIC_UNAUTHORIZED);

    const identity = await VendorIdentity.findById(session.identityId);
    if (!identity) return res.status(401).json(GENERIC_UNAUTHORIZED);

    // A merged identity keeps working: mergeIdentities tombstones the loser
    // with `mergedInto` rather than deleting it, so a vendor holding a session
    // from before a merge follows the pointer instead of being logged out.
    if (identity.mergedInto) {
      const survivor = await VendorIdentity.findById(identity.mergedInto);
      if (!survivor) return res.status(401).json(GENERIC_UNAUTHORIZED);
      req.vendorIdentity = survivor;
    } else {
      req.vendorIdentity = identity;
    }

    req.hubSession = session;
    return next();
  } catch (err) {
    console.error("[hubAuth] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}

/** Cookie options, in one place so login and logout cannot drift apart. */
function hubCookieOptions({ maxAge } = {}) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // "lax", not "strict": the vendor arrives by clicking a link in an EMAIL,
    // which is a cross-site navigation. Under "strict" the cookie would not be
    // sent on that first request and they would land signed out on the page
    // that just signed them in.
    sameSite: "lax",
    path: "/",
    ...(maxAge ? { maxAge } : {}),
  };
}

module.exports = { hubAuth, hubCookieOptions, HUB_COOKIE, GENERIC_UNAUTHORIZED };
