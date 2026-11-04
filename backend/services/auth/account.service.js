// Signing in, and creating or attaching a role profile. The rules live here so
// the four controllers that need them cannot disagree.
//
// The shape to keep in mind: an Account is a person (an email and a password),
// and a Landlord or Tenant document is one ROLE that person holds. Somebody can
// hold both — a landlord who rents their own home is an ordinary person — so
// nothing here treats a second role as an error.
const bcrypt = require("bcryptjs");

const Account = require("../../models/Account");
const Landlord = require("../../models/Landlord");
const Tenant = require("../../models/Tenant");
const { touchLandlordActivity } = require("../metrics/activity.service");
const { buildBetaStamp, resolveBetaDays } = require("../beta/beta.service");
const { TERMS_VERSION } = require("../../config/beta");

const BCRYPT_ROUNDS = 12;

// bcrypt silently truncates at 72 BYTES, so a longer passphrase would have a
// prefix accepted as the whole thing. Reject rather than truncate.
const MIN_PASSWORD_BYTES = 8;
const MAX_PASSWORD_BYTES = 72;

const PROFILE_MODELS = { landlord: Landlord, tenant: Tenant };

// Timing. Without an account, the old code skipped bcrypt entirely and answered
// ~250ms sooner than a wrong password did — which told an attacker, precisely,
// which addresses exist. Every failed sign-in now burns one comparison against
// this hash instead. Computed once at load, so it costs nothing per request.
const DUMMY_HASH = bcrypt.hashSync("artrelo::timing::placeholder", BCRYPT_ROUNDS);

class AuthError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const normalizeEmail = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

function validatePassword(password) {
  if (typeof password !== "string") throw new AuthError("weak_password", 400, "Password is required");
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes < MIN_PASSWORD_BYTES) {
    throw new AuthError("weak_password", 400, "Password must be at least 8 characters");
  }
  if (bytes > MAX_PASSWORD_BYTES) {
    throw new AuthError("weak_password", 400, "Password is too long (72 bytes maximum)");
  }
  return password;
}

const profileModel = (kind) => {
  const model = PROFILE_MODELS[kind];
  if (!model) throw new Error(`unknown profile kind: ${kind}`);
  return model;
};

const findProfile = (kind, accountId) => profileModel(kind).findOne({ accountId });

// The public view of a signed-in user. Unchanged from what the SPA already
// stores, plus accountId.
const toSessionUser = (profile, account) => ({
  id: profile._id,
  accountId: account._id,
  email: account.email,
  firstName: profile.firstName,
  lastName: profile.lastName,
  role: profile.role,
  ...(profile.companyName ? { companyName: profile.companyName } : {}),
});

// Sign-in. `kind` comes from which endpoint was called, which is the toggle the
// visitor already chose on the form — so there is no "which role?" screen.
async function authenticate({ email, password, kind }) {
  const normalized = normalizeEmail(email);
  const account = normalized
    ? await Account.findOne({ email: normalized }).select("+hashedPassword")
    : null;

  const ok = await bcrypt.compare(
    typeof password === "string" ? password : "",
    account?.hashedPassword || DUMMY_HASH
  );
  // Same answer for "no such account" and "wrong password", and the same 400
  // the endpoint returned before accounts existed.
  if (!account || !ok) throw new AuthError("invalid_credentials", 400, "Invalid credentials");
  if (account.status !== "active") {
    throw new AuthError("account_disabled", 403, "This account has been disabled");
  }

  const profile = await findProfile(kind, account._id);
  if (!profile) {
    // Only reachable AFTER a correct password, so it reveals nothing to anyone
    // who is not already the account holder — and it saves them guessing why
    // the right password "does not work" on the wrong toggle.
    const other = kind === "landlord" ? "tenant" : "landlord";
    const otherProfile = await findProfile(other, account._id);
    if (otherProfile) {
      throw new AuthError("wrong_role", 409, `This account signs in as a ${other}.`, { role: other });
    }
    throw new AuthError("invalid_credentials", 400, "Invalid credentials");
  }

  return { account, profile };
}

// What a new landlord profile carries that a tenant's does not.
function landlordSignupFields({ betaDays, termsAccepted }) {
  const now = new Date();
  return {
    beta: buildBetaStamp(betaDays, now),
    ...(termsAccepted ? { termsAcceptedAt: now, termsVersion: TERMS_VERSION } : {}),
  };
}

// Sign-up, for both roles and for invites. Either creates the account, or —
// when the address already has one — attaches a second role to it, but only to
// someone who can prove that account's password.
//
// Races are settled by the unique indexes rather than a transaction: this
// codebase uses none, and every stubbed-model test would have to learn about
// sessions. A duplicate key is the arbiter, and the one unrecoverable case
// (account created, profile failed) is compensated below.
async function createOrAttachProfile({
  email,
  password,
  kind,
  profileFields,
  verifiedEmail = false,
  // Landlord only. Length of the free beta in days (undefined = the default),
  // and whether the person ticked the Terms.
  betaDays,
  termsAccepted = false,
}) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new AuthError("invalid_email", 400, "A valid email is required");

  const Model = profileModel(kind);
  // Refuse a nonsense beta length before an account is created for it, rather
  // than creating one and rolling it back.
  if (kind === "landlord") resolveBetaDays(betaDays);
  let account = await Account.findOne({ email: normalized }).select("+hashedPassword");
  let createdAccount = false;

  if (account) {
    const ok = await bcrypt.compare(typeof password === "string" ? password : "", account.hashedPassword);
    // Never overwrite an existing password. Whoever holds this address already
    // has an account, and adding a role to it has to be their decision.
    if (!ok) {
      throw new AuthError(
        "account_exists",
        409,
        "An Artrelo account already uses this email. Enter that account's password to add this role, or reset it first."
      );
    }
    if (account.status !== "active") {
      throw new AuthError("account_disabled", 403, "This account has been disabled");
    }
    if (await findProfile(kind, account._id)) {
      throw new AuthError("profile_exists", 409, `This account already has a ${kind} profile.`);
    }
  } else {
    validatePassword(password);
    try {
      account = await Account.create({
        email: normalized,
        hashedPassword: await bcrypt.hash(password, BCRYPT_ROUNDS),
        emailVerifiedAt: verifiedEmail ? new Date() : undefined,
      });
      createdAccount = true;
    } catch (err) {
      // Someone else created this account between the lookup and the insert.
      // The address is taken, so re-enter through the attach path.
      if (err?.code === 11000) {
        return createOrAttachProfile({ email, password, kind, profileFields, verifiedEmail, betaDays, termsAccepted });
      }
      throw err;
    }
  }

  if (verifiedEmail && !account.emailVerifiedAt) {
    await Account.updateOne({ _id: account._id }, { $set: { emailVerifiedAt: new Date() } });
  }

  try {
    const profile = await Model.create({
      ...profileFields,
      // The one place a landlord's beta clock starts. Stamped here, and nowhere
      // else, so every route into a landlord profile -- invite, public sign-up,
      // attaching a role to an existing account -- gets one, and none can
      // forget. Throws on a nonsense betaDays BEFORE anything is written.
      ...(kind === "landlord" ? landlordSignupFields({ betaDays, termsAccepted }) : {}),
      accountId: account._id,
      // Always the account's address, never one from a request body.
      email: account.email,
    });
    return { account, profile, createdAccount };
  } catch (err) {
    // A duplicate here means another request won the same race; the account is
    // fine and keeps its other roles, so leave it alone.
    if (err?.code === 11000) {
      throw new AuthError("profile_exists", 409, `This account already has a ${kind} profile.`);
    }
    // Any other failure leaves an account with no profile. Remove it only if
    // this request is what created it — otherwise it belongs to an existing
    // user who is merely adding a role.
    if (createdAccount) {
      await Account.deleteOne({ _id: account._id }).catch((cleanupError) =>
        console.error("[account.service] orphan account cleanup failed", cleanupError?.message || cleanupError)
      );
    }
    throw err;
  }
}

// Find an account by address, WITH the hash, for a caller that is about to
// check a password. Returns null rather than throwing: "no such address" is a
// normal answer and the caller decides what it reveals.
const findAccountForAuth = (email) => {
  const normalized = normalizeEmail(email);
  return normalized ? Account.findOne({ email: normalized }).select("+hashedPassword") : null;
};

// Does this password belong to this account?
//
// Exported so the invite and reset flows can check BEFORE they spend a
// single-use token, without a second copy of the bcrypt call. Note this does
// NOT burn a dummy comparison for a missing account: unlike sign-in, every
// caller here has already proven it holds a token naming the address, so there
// is no existence to leak.
async function verifyPassword(account, password) {
  if (!account?.hashedPassword) return false;
  return bcrypt.compare(typeof password === "string" ? password : "", account.hashedPassword);
}

// Best effort: a failed bookkeeping write must never fail a successful login.
async function touchLogin({ account, profile, kind }) {
  const now = new Date();
  try {
    await Promise.all([
      Account.updateOne({ _id: account._id }, { $set: { lastLoginAt: now } }),
      profileModel(kind).updateOne({ _id: profile._id }, { $set: { lastLogin: now } }),
    ]);
  } catch (err) {
    console.error("[account.service] lastLogin update failed", err?.message || err);
  }
  if (kind === "landlord") await touchLandlordActivity(profile._id, now);
}

module.exports = {
  AuthError,
  BCRYPT_ROUNDS,
  MIN_PASSWORD_BYTES,
  MAX_PASSWORD_BYTES,
  normalizeEmail,
  validatePassword,
  authenticate,
  createOrAttachProfile,
  findAccountForAuth,
  findProfile,
  profileModel,
  toSessionUser,
  touchLogin,
  verifyPassword,
};
