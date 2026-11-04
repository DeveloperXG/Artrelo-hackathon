const assert = require("assert");
const {
  generateOutreachToken,
  hashToken,
  maskEmail,
  buildResponseUrl,
  hashOpaque,
  buildOutreachLedgerPatch,
} = require("../../../services/vendor/vendorOutreach.service");

/* ---------------- 1) Token entropy and hashing ---------------- */

const token = generateOutreachToken();

// 32 random bytes base64url-encoded = 43 chars, 256 bits.
assert.strictEqual(token.raw.length, 43, "token should carry 256 bits of entropy");
assert.ok(/^[A-Za-z0-9_-]+$/.test(token.raw), "token must be URL-safe (base64url, no padding)");
assert.strictEqual(token.hash.length, 64, "sha256 hex digest is 64 chars");
assert.ok(/^[0-9a-f]+$/.test(token.hash), "hash should be lowercase hex");
assert.strictEqual(token.last4, token.raw.slice(-4));

// Hashing is stable and one-way in the sense that the raw value never appears.
assert.strictEqual(hashToken(token.raw), token.hash, "hash must be deterministic");
assert.ok(!token.hash.includes(token.raw), "hash must not contain the raw token");

// Tokens are unique across generations.
const seen = new Set();
for (let i = 0; i < 500; i += 1) seen.add(generateOutreachToken().raw);
assert.strictEqual(seen.size, 500, "tokens must not collide");

// A single-character change produces a completely different hash.
const mutated = `${token.raw.slice(0, -1)}${token.raw.slice(-1) === "A" ? "B" : "A"}`;
assert.notStrictEqual(hashToken(mutated), token.hash);

/* ---------------- 2) Magic-link URL carries no PII ---------------- */

const url = buildResponseUrl(token.raw);
assert.ok(url.endsWith(`/vendor-response/${token.raw}`), "token goes in the path");
assert.ok(!url.includes("?"), "no query string — nothing to leak via Referer parsing");
assert.ok(!url.includes("@"), "no email in the URL");

/* ---------------- 3) Email masking ---------------- */

assert.strictEqual(maskEmail("excelojeifo3.0@gmail.com"), "exc***@gmail.com");
assert.strictEqual(maskEmail("ab@x.io"), "ab@x.io", "short locals are not padded with ***");
assert.strictEqual(maskEmail("abc@x.io"), "abc@x.io");
assert.strictEqual(maskEmail("abcd@x.io"), "abc***@x.io");
assert.strictEqual(maskEmail("not-an-email"), null);
assert.strictEqual(maskEmail(""), null);
assert.strictEqual(maskEmail(null), null);

// The masked form must never contain the full local part of a long address.
const masked = maskEmail("excelojeifo3.0@gmail.com");
assert.ok(!masked.includes("excelojeifo3.0"), "masked address must not reveal the full local part");

/* ---------------- 4) Opaque hashing of IP / UA ---------------- */

const ipHash = hashOpaque("203.0.113.42");
assert.strictEqual(ipHash.length, 32);
assert.ok(!ipHash.includes("203.0.113.42"), "raw IP must not be recoverable from the stored value");
assert.strictEqual(hashOpaque("203.0.113.42"), ipHash, "stable for the same input");
assert.notStrictEqual(hashOpaque("203.0.113.43"), ipHash);
assert.strictEqual(hashOpaque(null), null);
assert.strictEqual(hashOpaque(""), null);

/* ---------------- 5) Ledger patch is JSON-safe and masks the address ----- */
// The snapshot is round-tripped through JSON.parse(JSON.stringify(...)), so any
// Date or ObjectId in this patch would silently degrade.

const now = new Date("2026-07-28T15:00:00.000Z");
const patch = buildOutreachLedgerPatch({
  _id: { toString: () => "60a1b2c3d4e5f60718293a4b" },
  status: "sent",
  attempt: 1,
  channel: "email",
  toEmail: "excelojeifo3.0@gmail.com",
  tier: "normal",
  sentAt: now,
  responseDeadlineAt: now,
  createdAt: now,
  response: {
    outcome: "accepted",
    quoteLow: 120,
    quoteHigh: 260,
    quoteCurrency: "CAD",
    selectedWindow: { label: "Wed, Jul 29, 8:00 a.m. – 12:00 p.m." },
  },
  respondedAt: now,
  quotaCheck: { limit: 300, quoteHigh: 260, overQuota: false, evaluatedAt: now },
});

const serialized = JSON.stringify(patch);
assert.ok(
  !serialized.includes("excelojeifo3.0@gmail.com"),
  "the unmasked vendor address must never reach the snapshot"
);
assert.strictEqual(patch.toEmailMasked, "exc***@gmail.com");

// Every timestamp must already be an ISO string, not a Date.
["sentAt", "respondedAt", "responseDeadlineAt", "lastAttemptAt"].forEach((field) => {
  assert.strictEqual(typeof patch[field], "string", `${field} must be an ISO string`);
  assert.strictEqual(patch[field], now.toISOString());
});
assert.strictEqual(typeof patch.outreachId, "string", "outreachId must be a plain string");
assert.strictEqual(patch.decision.quoteHigh, 260);
assert.strictEqual(patch.quotaCheck.overQuota, false);

// Round-tripping through JSON must not change anything.
assert.deepStrictEqual(JSON.parse(JSON.stringify(patch)), patch);

// The empty case stays clean.
const empty = buildOutreachLedgerPatch(null);
assert.strictEqual(empty.status, "not_sent");
assert.strictEqual(empty.outreachId, null);

console.log("vendorOutreach token/masking tests passed");
