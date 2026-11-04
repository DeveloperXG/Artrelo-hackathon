// Tenant invite codes: the one place they are minted and canonicalised.
//
// WHY THIS IS A SERVICE. There used to be two generators — one in
// code.controller.js and one in landlord.controller.js. Hardening the first
// (six hex characters -> ten base32) changed nothing real: its route had been
// commented out, and every code a landlord actually issued came from the
// second, still six hex characters. Anything that mints a code must come
// through here, so that cannot happen again.
//
// The stakes: a code is the whole gate on tenant sign-up, and /codes/verify
// answers "is this real" to anyone. Six hex characters is 16.7 million
// possibilities, which an unthrottled guesser works through in hours.

const crypto = require("crypto");
const InviteCode = require("../../models/Code");

// Crockford-style base32: the digits and A-Z without I, L, O and U, which are
// the characters people misread when copying a code off a screen (and U keeps
// it clear of accidental words). 32^10 ≈ 1.1e15 possibilities.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;

function generateCode() {
  let out = "";
  // randomInt is rejection-sampled, so every symbol is equally likely.
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

// What a tenant types is not what was stored: they lowercase it, keep a hyphen
// it was displayed with, or paste a trailing space. Canonicalise before the
// lookup rather than answering "invalid code" to someone holding a good one.
function normalizeCode(value) {
  return typeof value === "string" ? value.replace(/[\s-]/g, "").toUpperCase() : "";
}

// Mints and saves one code. `code` is uniquely indexed, so a collision
// surfaces as a duplicate-key error rather than overwriting; at 32^10 that is
// vanishingly rare, but a landlord seeing a 500 mid-invite is worth two more
// attempts to avoid.
async function createInviteCode({ landlordId, propertyId, unitId, expiresAt }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await InviteCode.create({ code: generateCode(), landlordId, propertyId, unitId, expiresAt });
    } catch (err) {
      if (err?.code !== 11000 || attempt === 2) throw err;
    }
  }
}

module.exports = { CODE_ALPHABET, CODE_LENGTH, generateCode, normalizeCode, createInviteCode };
