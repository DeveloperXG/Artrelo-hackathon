// A vendor's login to the hub — the one place they see every job they hold,
// across every landlord who has hired them.
//
// This is the FIRST browser session in the system that does not belong to a
// Landlord or a Tenant, and it is deliberately not a JWT and deliberately not
// part of userAuth. See middleware/hubAuth.middleware.js for why.
//
// TWO TOKENS, TWO LIFETIMES:
//
//   magic  — emailed, single-use, ~15 minutes. Proves the person controls the
//            address. Consumed on first exchange and never usable again.
//   session — the cookie, ~14 days. Issued only in exchange for a magic token.
//
// Keeping them in one collection with a `kind` discriminator means one expiry
// sweep and one revocation path, rather than two things to remember to retire.
//
// Only sha256 is stored, never the raw value — same rule as VendorOutreach and
// JobToken. A database dump must not be a set of working logins.

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const SESSION_KINDS = ["magic", "session"];

// Long enough that a contractor checking in weekly is not re-authenticating
// every visit; short enough that a stolen laptop stops working.
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// Long enough to survive a slow mail relay, short enough that a forwarded email
// is not a standing key.
const MAGIC_TTL_MS = 15 * 60 * 1000;

const HubSessionSchema = new Schema(
  {
    identityId: {
      type: Schema.Types.ObjectId,
      ref: "VendorIdentity",
      required: true,
      index: true,
    },

    kind: { type: String, enum: SESSION_KINDS, required: true },

    // sha256 of the raw token. Unset on consume/revoke so the partial unique
    // index stops covering the row and the credential stops resolving.
    tokenHash: { type: String, default: undefined },

    issuedAt: { type: Date, default: Date.now },
    // No `index: true` here — the TTL index below already covers this field,
    // and declaring both makes Mongoose warn about a duplicate.
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, default: null },
    usedCount: { type: Number, default: 0, min: 0 },

    // Set when a magic token is exchanged, so the same link cannot mint a
    // second session if it is forwarded or replayed.
    consumedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },

    // Opaque, for abuse investigation only. Never returned by any API, and
    // never used to make an auth decision — a vendor legitimately moves between
    // a phone on cellular and a laptop on wifi mid-job.
    ipHash: { type: String, default: null },
    uaHash: { type: String, default: null },
  },
  { timestamps: true }
);

// partialFilterExpression rather than sparse: a sparse unique index still
// treats an explicit null as a value, so two consumed magic links that both
// stored `tokenHash: null` would collide. Consuming $unsets the field.
HubSessionSchema.index(
  { tokenHash: 1 },
  { unique: true, partialFilterExpression: { tokenHash: { $type: "string" } } }
);

// Lets Mongo retire expired rows on its own. The application already refuses
// an expired token, so this is hygiene rather than a security control —
// which matters, because TTL deletion can lag by a minute or more.
HubSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

HubSessionSchema.index({ identityId: 1, kind: 1, createdAt: -1 });

module.exports = mongoose.model("HubSession", HubSessionSchema);
module.exports.SESSION_KINDS = SESSION_KINDS;
module.exports.SESSION_TTL_MS = SESSION_TTL_MS;
module.exports.MAGIC_TTL_MS = MAGIC_TTL_MS;
