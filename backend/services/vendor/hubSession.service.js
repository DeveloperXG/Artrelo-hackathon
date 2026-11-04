// Issuing and resolving vendor hub sessions.
//
// Reuses the same primitives the magic-link portal has always used: 256 bits of
// randomness, sha256 at rest, the raw value never persisted and never logged.
// What is new is that this credential is a SESSION rather than a one-shot
// action token, so it gets an explicit consume step and an explicit revoke.

const crypto = require("crypto");
const env = require("../../config/env");
const HubSession = require("../../models/HubSession");
const { SESSION_TTL_MS, MAGIC_TTL_MS } = require("../../models/HubSession");

const TOKEN_BYTES = 32; // 256 bits

const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");
const generateRawToken = () => crypto.randomBytes(TOKEN_BYTES).toString("base64url");

/** Opaque and one-way. For abuse investigation, never for an auth decision. */
function hashOpaque(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

/** The emailed link. */
function buildMagicUrl(rawToken) {
  const base = String(env.app_public_url || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/vendor-hub/enter/${rawToken}`;
}

/**
 * Mint a single-use magic token for an identity.
 *
 * Any outstanding magic tokens for the same vendor are revoked first: a person
 * who clicks "email me a link" twice should end up with one working link, not a
 * drawer of them, and the newest request is the one they are looking at.
 */
async function issueMagicToken({ identityId, ipHash = null, uaHash = null }) {
  await HubSession.updateMany(
    { identityId, kind: "magic", consumedAt: null, revokedAt: null },
    { $set: { revokedAt: new Date() }, $unset: { tokenHash: 1 } }
  );

  const raw = generateRawToken();
  await HubSession.create({
    identityId,
    kind: "magic",
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + MAGIC_TTL_MS),
    ipHash,
    uaHash,
  });

  return { rawToken: raw, url: buildMagicUrl(raw) };
}

/**
 * Exchange a magic token for a session. Single-use.
 *
 * The consume is a conditional update, so two tabs racing the same link produce
 * exactly one session — the loser gets null and is told the link is spent,
 * rather than both silently succeeding.
 */
async function exchangeMagicToken({ rawToken, ipHash = null, uaHash = null }) {
  const now = new Date();
  const consumed = await HubSession.findOneAndUpdate(
    {
      tokenHash: hashToken(rawToken || ""),
      kind: "magic",
      consumedAt: null,
      revokedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { consumedAt: now }, $unset: { tokenHash: 1 }, $inc: { usedCount: 1 } },
    { new: true }
  );

  if (!consumed) return null;

  const raw = generateRawToken();
  const session = await HubSession.create({
    identityId: consumed.identityId,
    kind: "session",
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipHash,
    uaHash,
  });

  return { rawToken: raw, session, identityId: consumed.identityId };
}

/**
 * Resolve a session cookie. Returns null for every failure mode so the caller
 * cannot accidentally distinguish "never existed" from "expired" from
 * "revoked" in its response.
 */
async function resolveSession(rawToken, { now = new Date() } = {}) {
  if (!rawToken) return null;

  const session = await HubSession.findOne({ tokenHash: hashToken(rawToken), kind: "session" });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt <= now) return null;

  // Best-effort liveness stamp; a failed write must not cost the vendor their
  // session.
  HubSession.updateOne(
    { _id: session._id },
    { $set: { lastSeenAt: now }, $inc: { usedCount: 1 } }
  ).catch(() => {});

  return session;
}

/** Sign out. $unset so the partial unique index stops covering the row. */
async function revokeSession(rawToken) {
  if (!rawToken) return { modifiedCount: 0 };
  return HubSession.updateOne(
    { tokenHash: hashToken(rawToken), kind: "session" },
    { $set: { revokedAt: new Date() }, $unset: { tokenHash: 1 } }
  );
}

/** Sign out everywhere — used when a vendor identity is merged or disabled. */
async function revokeAllForIdentity(identityId) {
  return HubSession.updateMany(
    { identityId, revokedAt: null },
    { $set: { revokedAt: new Date() }, $unset: { tokenHash: 1 } }
  );
}

module.exports = {
  hashToken,
  hashOpaque,
  generateRawToken,
  buildMagicUrl,
  issueMagicToken,
  exchangeMagicToken,
  resolveSession,
  revokeSession,
  revokeAllForIdentity,
  SESSION_TTL_MS,
  MAGIC_TTL_MS,
};
