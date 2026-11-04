// Accepting a beta landlord invite.
//
// Public landlord sign-up is shut, so this is the only way a landlord account
// comes into existence. Neither endpoint is behind requireRegistrationOpen, on
// purpose: an invite is not public sign-up. Somebody already decided to let
// this person in, which is the thing the registration gate is there to control.
//
// THE ORDERING RULE, and the reason this file is not thinner: every check that
// can fail happens BEFORE the token is spent. A wrong password, an address that
// is already a landlord, a password that is too short — none of them may burn a
// one-shot invite, because the person then has to ask a human for another one.
// Only once nothing is left to reject do we consume, and if creation still
// fails after that, we put the token back.

const {
  AuthError,
  createOrAttachProfile,
  findAccountForAuth,
  findProfile,
  normalizeEmail,
  validatePassword,
  verifyPassword,
} = require("../services/auth/account.service");
const { toE164 } = require("../utils/phone");
const accountTokens = require("../services/auth/accountToken.service");
const { defaultBetaDays, TERMS_VERSION } = require("../config/beta");
const { startSession, fail } = require("./landlordAuth.controller");

const KIND = "landlord_invite";

// One answer for every way a token can be unusable — unknown, expired, already
// accepted, revoked. The person cannot act on the difference (they need a new
// invite either way), and distinguishing them would turn this endpoint into an
// oracle for which tokens once existed.
const invalid = (res) =>
  res.status(404).json({
    success: false,
    code: "invite_invalid",
    message: "This invite link is no longer valid. Ask for a new one.",
  });

/**
 * What the invite page needs before the visitor types anything, without
 * spending the invite. See accountToken.service.peek for why peeking must not
 * consume.
 *
 * The token arrives in the POST body rather than the URL because morgan logs
 * URLs, and the link puts it after a `#` so it never reaches a server at all
 * until the page sends it here.
 */
exports.postInvitePeek = async (req, res) => {
  try {
    const token = await accountTokens.peek({ rawToken: req.body?.token, kind: KIND });
    if (!token) return invalid(res);

    // The invite's address is the authority, never the request body.
    const account = await findAccountForAuth(token.email);
    const alreadyLandlord = account ? Boolean(await findProfile("landlord", account._id)) : false;

    return res.status(200).json({
      success: true,
      email: token.email,
      firstName: token.invitedFirstName || null,
      lastName: token.invitedLastName || null,
      // Tells the page whether to ask for an existing password or a new one.
      accountExists: Boolean(account),
      // Already done. The page says so and points at sign-in rather than
      // showing a form that cannot succeed.
      alreadyLandlord,
      // The free beta this invite offers. The clock starts when they JOIN, so
      // the page says "N days from the day you join", not a calendar date.
      betaDays: token.betaDays || defaultBetaDays(),
      termsVersion: TERMS_VERSION,
    });
  } catch (err) {
    console.error("[postInvitePeek]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * Redeem the invite and sign the new landlord in.
 *
 * `email` in the body is IGNORED. The invite decides which address gets the
 * profile, or else anyone holding a link could claim any address — including
 * one that already has an account.
 */
exports.postInviteAccept = async (req, res) => {
  let consumed = null;
  try {
    const { token: rawToken, password, firstName, lastName, companyName, phone, termsAccepted } = req.body || {};

    /* ---- 1. Is the invite usable at all? ---- */
    const token = await accountTokens.peek({ rawToken, kind: KIND });
    if (!token) return invalid(res);

    const email = normalizeEmail(token.email);
    if (!firstName || !lastName) {
      return res.status(400).json({ success: false, message: "First and last name are required" });
    }
    // Required, and dialable: an emergency request phones the landlord
    // (services/notification/emergencyCall.service), and there is no later
    // settings page to add one. Stored as typed; normalized when dialled.
    if (!toE164(phone)) {
      return res.status(400).json({
        success: false,
        code: "phone_required",
        field: "phone",
        message: "Enter a phone number we can call you on for emergencies, with its area code.",
      });
    }
    // Checked here, before the token is spent, like every other rejectable
    // thing: forgetting a checkbox must not burn a one-shot invite. Strictly
    // `true` -- a truthy string from a hand-built request is not consent.
    if (termsAccepted !== true) {
      return res.status(400).json({
        success: false,
        code: "terms_required",
        message: "Please accept the Terms to create your account.",
      });
    }

    /* ---- 2. Is the password acceptable, or theirs? ---- */
    const account = await findAccountForAuth(email);
    if (account) {
      if (!(await verifyPassword(account, password))) {
        // Not "invalid credentials": they are holding a valid invite, so the
        // useful thing to say is which password we mean.
        throw new AuthError(
          "account_exists",
          409,
          "An Artrelo account already uses this email. Enter that account's password to add landlord access, or reset it first."
        );
      }
      if (account.status !== "active") {
        throw new AuthError("account_disabled", 403, "This account has been disabled");
      }

      /* ---- 3. Already a landlord? ---- */
      if (await findProfile("landlord", account._id)) {
        throw new AuthError("profile_exists", 409, "This account is already a landlord. Sign in instead.");
      }
    } else {
      // Throws weak_password before anything is spent.
      validatePassword(password);
    }

    /* ---- 4. Spend it. Nothing above can fail any more. ---- */
    consumed = await accountTokens.consume({ rawToken, kind: KIND });
    // Lost a race with another tab holding the same link. Exactly one wins.
    if (!consumed) return invalid(res);

    /* ---- 5. Create or attach ---- */
    let created;
    try {
      created = await createOrAttachProfile({
        email,
        password,
        kind: "landlord",
        profileFields: { firstName, lastName, phone: String(phone).trim(), companyName, role: "landlord" },
        // Clicking a link sent to this address is proof of control over it —
        // the one place in the system where that is currently established.
        verifiedEmail: true,
        // Copied from the invite, so "free for 90 days" means 90 days from the
        // moment they joined. Null falls back to the default.
        betaDays: token.betaDays || undefined,
        termsAccepted: true,
      });
    } catch (err) {
      /* ---- 6. Put the invite back ---- */
      // Only this consume, matched on its timestamp, so a stale rollback cannot
      // reopen a later successful acceptance. See unconsume.
      await accountTokens
        .unconsume({ _id: consumed._id, consumedAt: consumed.consumedAt })
        .catch((e) => console.error("[postInviteAccept] unconsume failed", e?.message || e));
      throw err;
    }

    /* ---- 7. Sign them in ---- */
    return startSession(res, {
      account: created.account,
      profile: created.profile,
      kind: "landlord",
      status: 201,
      message: "Welcome to Artrelo",
    });
  } catch (err) {
    return fail(res, err, "postInviteAccept");
  }
};
