// The login identity. One row per email address, for the whole app.
//
// WHY THIS EXISTS. Landlord and Tenant each used to hold their own `email` and
// `hashedPassword`, unique only within their own collection. So one address
// could be two unrelated accounts with two different passwords, and nothing
// could answer "who is this email?" — which makes a password reset ambiguous
// and makes contacting a person by address meaningless.
//
// Rejecting the duplicate was not the fix: a landlord who also rents their own
// home is an ordinary person, not an error. The problem was never that an
// address has two roles, it was that the two accounts did not know they were
// the same person. So identity lives here, and Landlord and Tenant became
// profiles hanging off it, each holding what is true of that ROLE.
//
// Vendors deliberately stay out. VendorIdentity has no password, signs in by
// magic link, and sits behind the masked-contact privacy boundary; folding it
// in here would weaken that for no gain.
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const AccountSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },

    // select:false so the hash never rides along on an incidental read. The
    // two places that need it ask for it explicitly with .select("+hashedPassword").
    hashedPassword: { type: String, required: true, select: false },

    // Bumped by a password reset. Refresh tokens carry the value they were
    // minted with, so raising it invalidates every outstanding session — the
    // only way to log a stranger out of an account they should not have.
    tokenVersion: { type: Number, default: 0 },
    passwordChangedAt: { type: Date },

    // Set ONLY where control of the address was actually proven: accepting an
    // emailed invite, or completing a password reset. Tenant sign-up does not
    // prove it — the invite code is bound to a unit, not to an address — so a
    // tenant account stays unverified until its owner resets the password.
    emailVerifiedAt: { type: Date },

    lastLoginAt: { type: Date },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Account", AccountSchema);
