// A one-shot, emailed credential that acts on an Account: an invite to become a
// landlord, or a password reset.
//
// Both are the same object — a random secret, sent to an address, good once,
// for a short while — so they share one collection with a `kind`
// discriminator. One expiry sweep, one revocation path, one place to audit,
// rather than two of each to keep in step. HubSession.js makes the same call
// for the vendor hub's two token types.
//
// Only sha256 is stored, never the raw value, and the raw value is never
// logged. Same rule as HubSession, VendorOutreach and JobToken: a database
// dump must not be a set of working credentials.
//
// WHY A ROW SURVIVES BEING USED: `consumedAt` is set and the hash is KEPT, so
// there is a record that this invite was accepted, by whom, and when. Revoking
// is what unsets the hash and stops the credential resolving. That also makes
// the consume reversible — see accountToken.service.unconsume, which the accept
// endpoint needs when profile creation fails after the token is spent.

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const TOKEN_KINDS = ["landlord_invite", "password_reset"];

// A week. An invite is sent to someone a human has spoken to, so it does not
// need to be short-lived to be safe, and a beta landlord who reads it on Monday
// and acts on Friday should not have to ask for another.
const LANDLORD_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Thirty minutes. Nobody requests a reset and then waits, and the address may
// be one the requester does not control.
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

// How long a spent or expired row is kept before Mongo removes it. The audit
// trail is the point: "was this person invited, and did they accept?" is a
// question worth being able to answer a month later.
const PURGE_AFTER_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

const AccountTokenSchema = new Schema(
  {
    kind: { type: String, enum: TOKEN_KINDS, required: true },

    // sha256 of the raw token. Unset on REVOKE (not on consume), so the partial
    // unique index below stops covering the row and the credential stops
    // resolving.
    tokenHash: { type: String, default: undefined },

    // The address this token was sent to, normalised. For an invite this is the
    // authority on which email the landlord profile gets — never the request
    // body, which the recipient controls.
    email: { type: String, required: true, lowercase: true, trim: true, index: true },

    // Set when the address already had an Account at issue time. Null for an
    // invite to a brand-new person; the accept path resolves it by email.
    accountId: { type: Schema.Types.ObjectId, ref: "Account", default: null },

    // What the inviter typed, so the accept form can be pre-filled and the
    // email can greet them by name. Advisory only: the person can correct these
    // when they accept.
    invitedFirstName: { type: String, trim: true, default: null },
    invitedLastName: { type: String, trim: true, default: null },

    // Length of the free beta this invite offers, in days. Null = use the
    // default (config/beta.js). Copied onto the landlord at acceptance, not
    // before: the beta clock starts when they JOIN, not when we sent the email.
    betaDays: { type: Number, min: 1, default: null },

    // Who issued it. Null for the CLI script, which runs as an operator rather
    // than as a landlord.
    invitedBy: { type: Schema.Types.ObjectId, ref: "Landlord", default: null },

    issuedAt: { type: Date, default: Date.now },
    // No `index: true` — the TTL index on purgeAt covers retirement, and this
    // field is only ever read on a row already found by its hash.
    expiresAt: { type: Date, required: true },

    consumedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },

    // Opaque, for abuse investigation only. Never returned by any API and never
    // used to make a decision.
    ipHash: { type: String, default: null },

    // When Mongo may delete the row. Set by the service to expiresAt + 30 days.
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// partialFilterExpression rather than sparse: a sparse unique index still
// treats an explicit null as a value, so two revoked tokens that both stored
// `tokenHash: null` would collide. Revoking $unsets the field instead.
AccountTokenSchema.index(
  { tokenHash: 1 },
  { unique: true, partialFilterExpression: { tokenHash: { $type: "string" } } }
);

// Retires spent rows on Mongo's own schedule. The application already refuses
// an expired token, so this is hygiene rather than a security control — which
// matters, because TTL deletion can lag by a minute or more.
AccountTokenSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

// Serves both "revoke the earlier live tokens for this address" on issue and
// the per-email rate cap PR3 needs.
AccountTokenSchema.index({ email: 1, kind: 1, createdAt: -1 });

module.exports = mongoose.model("AccountToken", AccountTokenSchema);
module.exports.TOKEN_KINDS = TOKEN_KINDS;
module.exports.LANDLORD_INVITE_TTL_MS = LANDLORD_INVITE_TTL_MS;
module.exports.PASSWORD_RESET_TTL_MS = PASSWORD_RESET_TTL_MS;
module.exports.PURGE_AFTER_EXPIRY_MS = PURGE_AFTER_EXPIRY_MS;
