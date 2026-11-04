// The recovery path for a lost job link.
//
// This exists because a vendor could previously be locked out of their own
// open job with money held: the token expired on a 30-day clock, the hub could
// not re-issue one (the raw value is unrecoverable after minting, so mint
// returned null forever), and the jobCode fallback the model described was
// never built. Three separate dead ends stacked on the only route to payout
// setup.

const assert = require("assert");

const JobToken = require("../../../models/JobToken");

let rows = [];
let nextId = 1;

JobToken.findOne = async (filter) =>
  rows.find((r) =>
    Object.entries(filter).every(([k, v]) => (v === null ? r[k] == null : String(r[k]) === String(v)))
  ) || null;
JobToken.create = async (doc) => {
  const row = { _id: `t${nextId++}`, revokedAt: null, usedCount: 0, ...doc };
  rows.push(row);
  return row;
};
JobToken.findOneAndUpdate = async (filter, update) => {
  const row = rows.find((r) =>
    Object.entries(filter).every(([k, v]) => (v === null ? r[k] == null : String(r[k]) === String(v)))
  );
  if (!row) return null;
  Object.assign(row, update.$set || {});
  return row;
};
JobToken.updateOne = async () => ({ modifiedCount: 1 });

const {
  mintJobToken,
  rotateJobToken,
  resolveJobToken,
  hashToken,
  JOB_TOKEN_BACKSTOP_MS,
} = require("../../../services/vendor/jobToken.service");

const APPT = "appt-1";

async function main() {
  /* -------------- 1) A job token does not expire on a working timescale --- */
  // The old 30-day TTL locked vendors out of jobs that were still open. The
  // bound is the JOB's lifecycle (the appointment-state gate plus revocation at
  // close), not a clock.

  rows = [];
  const first = await mintJobToken({
    requestId: "req-1",
    appointmentId: APPT,
    landlordId: "l1",
    vendorNameSnapshot: "Northline Plumbing",
  });
  assert.ok(first.rawToken, "the first mint yields a usable link");

  const yearOut = Date.now() + 400 * 24 * 60 * 60 * 1000;
  assert.ok(
    first.jobToken.expiresAt.getTime() > yearOut,
    "a token must still be valid a year into an open job"
  );
  assert.ok(JOB_TOKEN_BACKSTOP_MS > 365 * 24 * 60 * 60 * 1000);

  /* -------------- 2) Re-minting cannot produce a link -------------------- */
  // This is WHY rotation had to exist: only sha256 is stored, so the raw value
  // is gone after the first mint. The hub called this per row and silently got
  // null every time.

  const second = await mintJobToken({
    requestId: "req-1",
    appointmentId: APPT,
    landlordId: "l1",
  });
  assert.strictEqual(second.created, false);
  assert.strictEqual(
    second.rawToken,
    null,
    "mint is idempotent and cannot recover the raw value — hence rotateJobToken"
  );

  /* -------------- 3) Rotation issues a working link ---------------------- */

  const rotated = await rotateJobToken({ appointmentId: APPT });
  assert.ok(rotated.rawToken, "rotation produces a usable link");
  assert.notStrictEqual(rotated.rawToken, first.rawToken, "and a different one");

  const resolved = await resolveJobToken(rotated.rawToken);
  assert.ok(resolved, "the new link resolves");
  assert.strictEqual(String(resolved.appointmentId), APPT);

  /* -------------- 4) Rotation RETIRES the old link ----------------------- */
  // Deliberate: the previous link is usually sitting in an inbox, so replacing
  // it means a forwarded or leaked copy stops working.

  const stale = await resolveJobToken(first.rawToken);
  assert.strictEqual(stale, null, "the superseded link must stop working");

  // Only one credential exists for the job at any time.
  assert.strictEqual(rows.filter((r) => r.scope === "job" && r.tokenHash).length, 1);

  /* -------------- 5) Rotation refuses a job with no live token ----------- */

  const none = await rotateJobToken({ appointmentId: "appt-does-not-exist" });
  assert.strictEqual(none.rawToken, null);
  assert.strictEqual(none.jobToken, null);

  // A revoked job (closed) cannot be rotated back into life.
  rows.find((r) => r.scope === "job").revokedAt = new Date();
  const afterClose = await rotateJobToken({ appointmentId: APPT });
  assert.strictEqual(
    afterClose.rawToken,
    null,
    "a closed job's link must not be reissuable"
  );

  /* -------------- 6) Only the hash is ever stored ------------------------ */

  rows = [];
  const fresh = await mintJobToken({ requestId: "r", appointmentId: "a2", landlordId: "l" });
  const stored = rows.find((r) => r.scope === "job");
  assert.strictEqual(stored.tokenHash, hashToken(fresh.rawToken));
  assert.ok(
    !JSON.stringify(rows).includes(fresh.rawToken),
    "the raw token must never be persisted — a database dump is not a set of working links"
  );

  console.log("jobToken recovery tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
