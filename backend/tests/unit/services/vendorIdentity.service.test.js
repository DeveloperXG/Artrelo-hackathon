// Global vendor identity resolution.
//
// Two things here are load-bearing beyond ordinary correctness:
//
//  1. The unique (phoneE164, emailNormalized) indexes mean a losing race must
//     degrade to "read the winner". If it throws instead, a concurrent
//     approve-contact turns into a 500 on the outreach path.
//  2. Every seeded demo vendor shares one DEMO_VENDOR_EMAIL and one
//     DEMO_VENDOR_PHONE (see scripts/backfill_demo_vendor_emails.js), so a
//     contact-keyed identity WILL collapse the whole demo roster onto one
//     contractor. That is why the backfill skips them, and the collapse is
//     pinned here so nobody "fixes" the skip later.

const assert = require("assert");

/* ---------------- Stub the model BEFORE the service requires it ----------- */

const VendorIdentity = require("../../../models/VendorIdentity");
const calendar = require("../../../services/vendor/vendorCalendar.service");
calendar.ensureCalendar = async () => {};
calendar.lockCalendar = async () => {};
calendar.occupied = async () => [];
require("mongoose").connection.transaction = async work => work({});

let rows = [];
let nextId = 1;
const clone = (value) => (value ? JSON.parse(JSON.stringify(value)) : value);

const matches = (row, query) =>
  Object.entries(query).every(([key, value]) => {
    if (key === "_id") return String(row._id) === String(value);
    return row[key] === value;
  });

// A tiny in-memory collection that enforces the same unique constraints the
// real indexes do — the E11000 path is the whole point of the test.
function insert(doc) {
  const uniqueHit = rows.find(
    (row) =>
      row.identityKey === doc.identityKey ||
      (doc.phoneE164 && row.phoneE164 === doc.phoneE164) ||
      (doc.emailNormalized && row.emailNormalized === doc.emailNormalized)
  );
  if (uniqueHit) {
    const err = new Error("E11000 duplicate key");
    err.code = 11000;
    throw err;
  }
  const row = {
    _id: `id-${nextId++}`,
    providerRefs: [],
    aggregate: { completedJobs: 0, disputedJobs: 0, ratingSum: 0, ratingCount: 0 },
    mergedInto: null,
    ...doc,
  };
  rows.push(row);
  return clone(row);
}

VendorIdentity.findOne = async (query) => clone(rows.find((row) => matches(row, query)) || null);
VendorIdentity.findById = async (id) => clone(rows.find((row) => String(row._id) === String(id)) || null);
VendorIdentity.create = async (doc) => insert(doc);
VendorIdentity.findOneAndUpdate = async (query, update) => {
  const row = rows.find((r) => matches(r, query));
  if (!row) return null;
  const set = update.$set || {};
  const collision = rows.find(
    (other) =>
      other !== row &&
      ((set.phoneE164 && other.phoneE164 === set.phoneE164) ||
        (set.emailNormalized && other.emailNormalized === set.emailNormalized))
  );
  if (collision) {
    const err = new Error("E11000 duplicate key");
    err.code = 11000;
    throw err;
  }
  Object.assign(row, set);
  for (const [key, delta] of Object.entries(update.$inc || {})) {
    const [outer, inner] = key.split(".");
    if (inner) row[outer][inner] = (row[outer][inner] || 0) + delta;
    else row[key] = (row[key] || 0) + delta;
  }
  if (update.$addToSet?.providerRefs) {
    const value = update.$addToSet.providerRefs;
    const list = value.$each || [value];
    for (const ref of list) {
      if (!row.providerRefs.some((r) => r.providerVendorId === ref.providerVendorId)) {
        row.providerRefs.push(ref);
      }
    }
  }
  return clone(row);
};
VendorIdentity.updateOne = async (query, update) => {
  const row = rows.find((r) => matches(r, query));
  if (!row) return { modifiedCount: 0 };
  Object.assign(row, update.$set || {});
  for (const key of Object.keys(update.$unset || {})) delete row[key];
  return { modifiedCount: 1 };
};

const {
  normalizePhoneE164,
  resolveIdentityKey,
  ensureVendorIdentity,
  mergeIdentities,
  resolveIdentity,
} = require("../../../services/vendor/vendorIdentity.service");

const reset = () => {
  rows = [];
  nextId = 1;
};

/* ---------------- 1) E.164 normalization ---------------------------------- */

assert.strictEqual(normalizePhoneE164("(306) 555-8842"), "+13065558842");
assert.strictEqual(normalizePhoneE164("306-555-8842"), "+13065558842");
assert.strictEqual(normalizePhoneE164("3065558842"), "+13065558842");
assert.strictEqual(normalizePhoneE164("13065558842"), "+13065558842");
assert.strictEqual(normalizePhoneE164("+1 306 555 8842"), "+13065558842");
assert.strictEqual(normalizePhoneE164("+44 20 7946 0958"), "+442079460958");

// Every formatting of the same number must collapse to one key, or the unique
// index silently stops deduplicating.
const variants = ["(306) 555-8842", "306.555.8842", " 3065558842 ", "1-306-555-8842"];
assert.strictEqual(new Set(variants.map(normalizePhoneE164)).size, 1, "variants must collapse");

// Refused rather than guessed: a wrong key is worse than no key.
assert.strictEqual(normalizePhoneE164("5558842"), null, "7-digit local has no area code");
assert.strictEqual(normalizePhoneE164(""), null);
assert.strictEqual(normalizePhoneE164(null), null);
assert.strictEqual(normalizePhoneE164("not a phone"), null);

/* ---------------- 2) Key preference --------------------------------------- */

assert.strictEqual(
  resolveIdentityKey({ phone: "306-555-8842", email: "A@Example.com" }).identityKey,
  "+13065558842",
  "phone outranks email"
);
assert.strictEqual(
  resolveIdentityKey({ email: "A@Example.com" }).identityKey,
  "a@example.com",
  "email is the fallback key, lowercased"
);
assert.strictEqual(resolveIdentityKey({}).identityKey, null);

/* -------------------------------------------------------------------------
 * The remaining cases are async. This file is CommonJS (no top-level await),
 * so they run inside main() and a rejection has to set the exit code
 * explicitly — an unhandled rejection would otherwise exit 0 and report a pass.
 * ---------------------------------------------------------------------- */

async function main() {

/* ---------------- 3) Find-or-create is idempotent ------------------------- */

reset();
const first = await ensureVendorIdentity({
  phone: "(306) 555-1000",
  email: "pat@fixit.example",
  name: "Pat Okonkwo",
  providerName: "taskrabbit",
  providerVendorId: "tr-1",
});
assert.strictEqual(first.created, true);
assert.strictEqual(first.identity.phoneE164, "+13065551000");

// Same vendor, different formatting, reached through a second landlord.
const second = await ensureVendorIdentity({ phone: "306.555.1000", name: "Pat O." });
assert.strictEqual(second.created, false, "must not create a duplicate identity");
assert.strictEqual(String(second.identity._id), String(first.identity._id));
assert.strictEqual(rows.length, 1, "one contractor, one identity across landlords");

/* ---------------- 4) Email-keyed identity gains a phone later ------------- */
// Outreach is email-only, so this is the common path, not an edge case.

reset();
const emailOnly = await ensureVendorIdentity({ email: "sam@drains.example", name: "Sam" });
assert.strictEqual(emailOnly.identity.identityKey, "sam@drains.example");
assert.strictEqual(emailOnly.identity.phoneE164, undefined);

const enriched = await ensureVendorIdentity({
  email: "sam@drains.example",
  phone: "306-555-2000",
});
assert.strictEqual(String(enriched.identity._id), String(emailOnly.identity._id), "same identity");
assert.strictEqual(enriched.identity.phoneE164, "+13065552000", "phone is backfilled");
assert.strictEqual(
  enriched.identity.identityKey,
  "sam@drains.example",
  "the key is never mutated in place"
);

/* ---------------- 5) Losing the create race reads the winner -------------- */

reset();
const realCreate = VendorIdentity.create;
let raced = false;
VendorIdentity.create = async (doc) => {
  if (!raced) {
    raced = true;
    // Simulate a concurrent writer landing between our findOne and our create.
    insert({ identityKey: doc.identityKey, phoneE164: doc.phoneE164, displayName: "Winner" });
  }
  return realCreate(doc);
};

const loser = await ensureVendorIdentity({ phone: "306-555-3000", name: "Loser" });
VendorIdentity.create = realCreate;

assert.ok(loser.identity, "a lost race must resolve to the winner, not throw");
assert.strictEqual(loser.identity.displayName, "Winner");
assert.strictEqual(loser.created, false);
assert.strictEqual(rows.length, 1, "the race must not leave two identities behind");

/* ---------------- 6) Split identity is reported, never auto-merged -------- */

reset();
const byEmail = await ensureVendorIdentity({ email: "dispatch@acme.example" });
const byPhone = await ensureVendorIdentity({ phone: "306-555-4000" });
assert.strictEqual(rows.length, 2);

const conflicted = await ensureVendorIdentity({
  phone: "306-555-4000",
  email: "dispatch@acme.example",
});
assert.strictEqual(
  String(conflicted.identity._id),
  String(byPhone.identity._id),
  "phone wins the tie"
);
assert.strictEqual(
  String(conflicted.mergeCandidateId),
  String(byEmail.identity._id),
  "the email-keyed row is reported as a merge candidate"
);
assert.strictEqual(rows.length, 2, "merging is explicit and audited — never a side effect");

/* ---------------- 7) mergeIdentities folds without deleting --------------- */

reset();
const keep = await ensureVendorIdentity({ phone: "306-555-5000", name: "Jo" });
const drop = await ensureVendorIdentity({ email: "jo@pipes.example", name: "Jo Alt" });
rows.find((r) => String(r._id) === String(drop.identity._id)).aggregate = {
  completedJobs: 3,
  disputedJobs: 1,
  ratingSum: 14,
  ratingCount: 3,
};

const merged = await mergeIdentities({ fromId: drop.identity._id, intoId: keep.identity._id });
assert.strictEqual(merged.emailNormalized, "jo@pipes.example", "survivor claims the free contact");
assert.strictEqual(merged.aggregate.completedJobs, 3, "history is carried over");
assert.strictEqual(merged.aggregate.ratingCount, 3);

const tombstone = rows.find((r) => String(r._id) === String(drop.identity._id));
assert.ok(tombstone, "the loser is tombstoned, never deleted");
assert.strictEqual(String(tombstone.mergedInto), String(keep.identity._id));
assert.strictEqual(tombstone.emailNormalized, undefined, "contact released from the unique index");

// A stale pointer still resolves to the survivor.
const followed = await resolveIdentity(drop.identity._id);
assert.strictEqual(String(followed._id), String(keep.identity._id));

// Idempotent.
const again = await mergeIdentities({ fromId: drop.identity._id, intoId: keep.identity._id });
assert.strictEqual(String(again._id), String(keep.identity._id));

// Payout routing never transfers on a merge — a Stripe account is bound to a
// verified legal identity and silently repointing it is the one truly dangerous
// thing this function could do.
assert.strictEqual(merged.stripeConnectAccountId, undefined);

/* ---------------- 8) The demo-vendor collapse, pinned --------------------- */
// This is why backfill_vendor_identities.js skips isDemoVendor rows.

reset();
const DEMO_EMAIL = "demo-vendor@example.com";
const DEMO_PHONE = "+1-306-555-0100";
for (const name of ["Demo Plumber", "Demo Electrician", "Demo Roofer"]) {
  await ensureVendorIdentity({ phone: DEMO_PHONE, email: DEMO_EMAIL, name });
}
assert.strictEqual(
  rows.length,
  1,
  "three distinct demo vendors sharing one phone/email collapse to ONE identity — " +
    "running the backfill over them would hand a single contractor every demo payout"
);

console.log("vendorIdentity.service tests passed");

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
