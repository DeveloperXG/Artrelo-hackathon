// Issuing and redeeming the emailed credentials that act on an Account:
// landlord invites now, password resets in the next change.
//
// Reuses generateRawToken/hashToken from the vendor hub rather than growing a
// second way to make a secret. 256 bits of randomness, sha256 at rest, the raw
// value returned once to the caller and never persisted or logged.
//
// The shape that matters here is CONSUME-THEN-UNCONSUME. The accept endpoint
// has to spend the token before it creates anything, or two tabs both create a
// landlord; but if creation then fails for a reason that is not the person's
// fault, an invite they were entitled to must not be burnt. So consume is
// reversible, and only by the exact consume that happened.

const AccountToken = require("../../models/AccountToken");
const {
  LANDLORD_INVITE_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  PURGE_AFTER_EXPIRY_MS,
} = require("../../models/AccountToken");
const { generateRawToken, hashToken, hashOpaque } = require("../vendor/hubSession.service");
const { normalizeEmail } = require("./account.service");

const TTL_BY_KIND = {
  landlord_invite: LANDLORD_INVITE_TTL_MS,
  password_reset: PASSWORD_RESET_TTL_MS,
};

const ttlFor = (kind) => {
  const ttl = TTL_BY_KIND[kind];
  if (!ttl) throw new Error(`unknown token kind: ${kind}`);
  return ttl;
};

/**
 * Mint a token of `kind` for `email`.
 *
 * Earlier live tokens of the same kind and address are revoked first. Somebody
 * re-invited because the first email went astray should end up with one working
 * link — the one they are looking at — not a drawer of them, each of which is a
 * standing key to the account.
 *
 * Returns the RAW token. This is the only time it exists; store the hash, mail
 * the raw value, keep neither.
 */
async function issue({
  kind,
  email,
  accountId = null,
  invitedFirstName = null,
  invitedLastName = null,
  invitedBy = null,
  betaDays = null,
  ttlMs,
  ip = null,
  now = new Date(),
}) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error("issue requires an email");

  await revokeAll({ kind, email: normalized, now });

  const expiresAt = new Date(now.getTime() + (ttlMs || ttlFor(kind)));
  const raw = generateRawToken();

  const token = await AccountToken.create({
    kind,
    tokenHash: hashToken(raw),
    email: normalized,
    accountId,
    invitedFirstName,
    invitedLastName,
    invitedBy,
    betaDays,
    issuedAt: now,
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + PURGE_AFTER_EXPIRY_MS),
    ipHash: hashOpaque(ip),
  });

  return { rawToken: raw, token };
}

/**
 * Look a token up WITHOUT spending it.
 *
 * The invite page needs this: it shows whose invite this is and whether the
 * address already has an account, before the visitor has typed anything. If
 * peek consumed, opening the link twice — or an email scanner prefetching it —
 * would destroy the invite before it was used. That is also why the token
 * travels in a POST body and after a `#`, never in a URL path.
 *
 * Returns null for every failure mode, so a caller cannot accidentally tell
 * "never existed" from "expired" from "already used".
 */
async function peek({ rawToken, kind, now = new Date() }) {
  if (!rawToken) return null;
  const token = await AccountToken.findOne({ tokenHash: hashToken(rawToken), kind });
  if (!token) return null;
  if (token.consumedAt || token.revokedAt) return null;
  if (token.expiresAt <= now) return null;
  return token;
}

/**
 * Spend the token. Single-use.
 *
 * A conditional findOneAndUpdate, so two tabs racing the same link produce
 * exactly one winner: the loser gets null and is told the link is spent, rather
 * than both proceeding to create a profile.
 *
 * The hash is KEPT. The row is the audit trail of an accepted invite, and
 * keeping it is what makes unconsume possible.
 */
async function consume({ rawToken, kind, now = new Date() }) {
  if (!rawToken) return null;
  return AccountToken.findOneAndUpdate(
    {
      tokenHash: hashToken(rawToken),
      kind,
      consumedAt: null,
      revokedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { consumedAt: now } },
    { new: true }
  );
}

/**
 * Put a consumed token back, but only the exact consume described.
 *
 * `consumedAt` is part of the filter deliberately. Without it this would also
 * un-spend a LATER, legitimate acceptance: request A consumes, stalls, request
 * B consumes and succeeds, then A's cleanup runs and reopens a token that has
 * already produced a landlord. Matching on the timestamp means a stale rollback
 * finds nothing and does nothing.
 */
async function unconsume({ _id, consumedAt }) {
  if (!_id || !consumedAt) return { modifiedCount: 0 };
  return AccountToken.updateOne({ _id, consumedAt }, { $set: { consumedAt: null } });
}

/**
 * Retire every live token of a kind for an address.
 *
 * $unset on the hash, not a null: it takes the row out of the partial unique
 * index and makes the credential unresolvable, which is the point — a revoked
 * token must not merely be flagged.
 */
async function revokeAll({ kind, email, now = new Date() }) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { modifiedCount: 0 };
  return AccountToken.updateMany(
    { kind, email: normalized, consumedAt: null, revokedAt: null },
    { $set: { revokedAt: now }, $unset: { tokenHash: 1 } }
  );
}

/** How many tokens of a kind went to this address since `since`. PR3's cap. */
async function countRecent({ kind, email, since }) {
  const normalized = normalizeEmail(email);
  if (!normalized) return 0;
  return AccountToken.countDocuments({ kind, email: normalized, createdAt: { $gte: since } });
}

module.exports = {
  issue,
  peek,
  consume,
  unconsume,
  revokeAll,
  countRecent,
  hashToken,
  generateRawToken,
  LANDLORD_INVITE_TTL_MS,
  PASSWORD_RESET_TTL_MS,
};
