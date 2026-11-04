// Forgetting and resetting a password.
//
// This is also the only way to take an address back. A tenant invite code is
// bound to a UNIT, not to an email, so during the beta somebody could sign up
// claiming an address they do not own. Completing a reset proves control of the
// address, sets emailVerifiedAt, and bumps tokenVersion — which signs the
// squatter out everywhere. Their tenant profile stays on the account, so that
// still needs removing by hand if it ever happens.
//
// TWO RULES SHAPE THIS FILE.
//
// 1. /forgot must not reveal whether an address has an account. Not through the
//    body, not the status, and not the TIME TAKEN. So it answers first and works
//    afterwards: the account lookup, the token write and the email all happen
//    after the response has been written, where nothing about them is
//    measurable. An error in that work is ours to see and must not change the
//    answer either.
//
// 2. /reset validates the new password BEFORE consuming the token. A password
//    the policy rejects must not cost somebody their one-shot link.

const bcrypt = require("bcryptjs");

const env = require("../config/env");
const Account = require("../models/Account");
const { PASSWORD_RESET_TTL_MS } = require("../models/AccountToken");
const {
  AuthError,
  BCRYPT_ROUNDS,
  findProfile,
  normalizeEmail,
  validatePassword,
} = require("../services/auth/account.service");
const accountTokens = require("../services/auth/accountToken.service");
const { clearAuthCookies } = require("../services/auth/tokens.service");
const { sendEmail } = require("../services/notification/email.service");
const { buildPasswordResetEmail } = require("../services/notification/templates/passwordResetEmail");

const KIND = "password_reset";

// At most three reset emails to one address per hour, counted in the database
// rather than in memory.
//
// The in-memory limiters cover a burst from one client; this covers the case
// they cannot see — somebody cycling addresses or IPs to use us as a mailer
// against one person's inbox. It survives a deploy, which the others do not.
const MAX_PER_EMAIL_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;

// One answer, always, whatever happened. Built once so no code path can
// accidentally construct a subtly different one.
const ACCEPTED = Object.freeze({
  success: true,
  message: "If that address has an Artrelo account, a reset link is on its way.",
});

const resetUrl = (rawToken) => {
  const base = String(env.app_public_url || "http://localhost:3000").replace(/\/+$/, "");
  // A fragment, so the token is never sent to a server: it cannot appear in an
  // access log, a Referer header or an analytics payload.
  return `${base}/login/reset#t=${rawToken}`;
};

/**
 * Everything /forgot does after it has already answered.
 *
 * Exported for the tests, which is the only way to observe it: by design the
 * endpoint's response says nothing about what happened in here.
 */
async function processForgot({ email, ip = null }) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { sent: false, reason: "no_email" };

  const account = await Account.findOne({ email: normalized }).select("_id status");
  // No account, or a disabled one. Nothing is sent and nothing is written — and
  // because the response has already gone, the caller cannot tell.
  if (!account) return { sent: false, reason: "no_account" };
  if (account.status !== "active") return { sent: false, reason: "disabled" };

  const recent = await accountTokens.countRecent({
    kind: KIND,
    email: normalized,
    since: new Date(Date.now() - HOUR_MS),
  });
  if (recent >= MAX_PER_EMAIL_PER_HOUR) return { sent: false, reason: "capped" };

  // issue() revokes this address's earlier live reset tokens, so a person who
  // clicks "email me a link" three times ends up with one that works — the one
  // they are looking at — rather than three standing keys.
  const { rawToken } = await accountTokens.issue({
    kind: KIND,
    email: normalized,
    accountId: account._id,
    ip,
  });

  // Only to greet them by name. Either profile will do; an account with neither
  // gets the nameless copy.
  const profile =
    (await findProfile("landlord", account._id)) || (await findProfile("tenant", account._id));

  const url = resetUrl(rawToken);
  const { subject, html, text } = buildPasswordResetEmail({
    firstName: profile?.firstName,
    url,
    expiresInMinutes: Math.round(PASSWORD_RESET_TTL_MS / 60000),
  });

  if (env.resend_api_key) {
    await sendEmail({ to: normalized, subject, html, text, categories: ["password_reset"] });
  } else {
    // Stub mode, same as the vendor hub's magic link: logged so the flow stays
    // exercisable with no mail provider.
    console.log(`[passwordForgot] ${url}`);
  }

  return { sent: true, url };
}

/**
 * POST /auth/password/forgot
 *
 * Answers 202 before doing anything. See rule 1 above — an existing address and
 * a missing one must be indistinguishable, and the cheapest way to guarantee
 * that is for the response not to depend on the work.
 */
exports.postForgotPassword = (req, res) => {
  const { email } = req.body || {};

  // Written first, deliberately.
  res.status(202).json(ACCEPTED);

  // Fire and forget. Nothing below can change what the caller was told, so
  // every failure is logged and swallowed.
  processForgot({ email, ip: req.ip }).catch((err) =>
    console.error("[postForgotPassword] background work failed", err?.message || err)
  );
};

/**
 * POST /auth/password/reset
 *
 * Order matters: validate, then consume, then write. A rejected password must
 * leave the link usable.
 */
exports.postResetPassword = async (req, res) => {
  try {
    const { token: rawToken, password } = req.body || {};

    // Before the token is touched.
    validatePassword(password);

    const peeked = await accountTokens.peek({ rawToken, kind: KIND });
    if (!peeked) {
      return res.status(400).json({
        success: false,
        code: "reset_invalid",
        message: "This reset link is no longer valid. Request a new one.",
      });
    }

    const account = await Account.findById(peeked.accountId || undefined);
    if (!account || account.status !== "active") {
      // The account went away or was disabled after the link was sent. Retire
      // the token rather than leaving it live against a dead account.
      await accountTokens.revokeAll({ kind: KIND, email: peeked.email }).catch(() => {});
      return res.status(400).json({
        success: false,
        code: "reset_invalid",
        message: "This reset link is no longer valid. Request a new one.",
      });
    }

    // Now spend it. Conditional, so two tabs submitting the same link set the
    // password once.
    const consumed = await accountTokens.consume({ rawToken, kind: KIND });
    if (!consumed) {
      return res.status(400).json({
        success: false,
        code: "reset_invalid",
        message: "This reset link is no longer valid. Request a new one.",
      });
    }

    const now = new Date();
    // One update, so there is no window in which the password is new but
    // tokenVersion is not — which would leave a stranger's session alive.
    await Account.updateOne(
      { _id: account._id },
      {
        $set: {
          hashedPassword: await bcrypt.hash(password, BCRYPT_ROUNDS),
          passwordChangedAt: now,
          // Completing this proves control of the address. For a tenant who
          // signed up with a code, this is the first time that is true.
          emailVerifiedAt: account.emailVerifiedAt || now,
        },
        // Kills every outstanding refresh token: they carry the value they were
        // minted with, and postRefreshToken compares it. This is the only way to
        // sign a stranger out of an account they should not have.
        $inc: { tokenVersion: 1 },
      }
    );

    // Any other live reset token for this address is now a spare key.
    await accountTokens.revokeAll({ kind: KIND, email: peeked.email }).catch((err) =>
      console.error("[postResetPassword] revoking spare tokens failed", err?.message || err)
    );

    // This browser's own session is gone too — it was minted with the old
    // tokenVersion — so clear the cookie rather than leaving one that 401s.
    clearAuthCookies(res);

    // Which toggle the sign-in page should preselect. Not sensitive: whoever is
    // reading this just proved they control the address.
    const [landlord, tenant] = await Promise.all([
      findProfile("landlord", account._id),
      findProfile("tenant", account._id),
    ]);
    const roles = [landlord && "landlord", tenant && "tenant"].filter(Boolean);

    return res.status(200).json({
      success: true,
      message: "Password updated. Please sign in.",
      email: account.email,
      roles,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    console.error("[postResetPassword]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.processForgot = processForgot;
exports.ACCEPTED = ACCEPTED;
exports.MAX_PER_EMAIL_PER_HOUR = MAX_PER_EMAIL_PER_HOUR;
exports.resetUrl = resetUrl;
