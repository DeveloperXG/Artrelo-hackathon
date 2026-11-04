// Emailed one-shot credentials: landlord invites, and password resets next.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * the raw token is NEVER stored. A database dump must not be a set of
//     working invites;
//   * issuing revokes the earlier live tokens for that address, so re-inviting
//     someone leaves one working link and not a drawer of standing keys;
//   * peek does not spend. An email scanner that fetches the page, or a person
//     who opens the link twice, must not destroy the invite;
//   * consume is single-use and settled by the database, so two tabs racing one
//     link produce exactly one winner;
//   * unconsume reverts ONLY the consume it was given. A stale rollback must
//     never reopen a later, successful acceptance.

const assert = require("assert");
const crypto = require("crypto");

const AccountToken = require("../../../models/AccountToken");

/* ---------------- Stubs -------------------------------------------------- */
//
// A small in-memory table, so the races can be driven deliberately. Statics are
// replaced before the service is required, the way the rest of the suite does
// it.

let rows = [];
let nextId = 1;

const matches = (row, filter) =>
  Object.entries(filter).every(([key, want]) => {
    const have = row[key];
    if (want && typeof want === "object" && !(want instanceof Date)) {
      if ("$gt" in want) return have instanceof Date && have > want.$gt;
      if ("$gte" in want) return have instanceof Date && have >= want.$gte;
      return false;
    }
    if (want === null) return have === null || have === undefined;
    if (want instanceof Date) return String(have) === String(want);
    return String(have) === String(want);
  });

const applyUpdate = (row, update) => {
  Object.assign(row, update.$set || {});
  for (const key of Object.keys(update.$unset || {})) delete row[key];
  return row;
};

AccountToken.create = async (doc) => {
  const row = { _id: `tok${nextId++}`, consumedAt: null, revokedAt: null, createdAt: new Date(), ...doc };
  rows.push(row);
  return row;
};
AccountToken.findOne = async (filter) => rows.find((r) => matches(r, filter)) || null;
AccountToken.findOneAndUpdate = async (filter, update) => {
  const row = rows.find((r) => matches(r, filter));
  if (!row) return null;
  return applyUpdate(row, update);
};
AccountToken.updateOne = async (filter, update) => {
  const row = rows.find((r) => matches(r, filter));
  if (!row) return { modifiedCount: 0 };
  applyUpdate(row, update);
  return { modifiedCount: 1 };
};
AccountToken.updateMany = async (filter, update) => {
  const hits = rows.filter((r) => matches(r, filter));
  hits.forEach((r) => applyUpdate(r, update));
  return { modifiedCount: hits.length };
};
AccountToken.countDocuments = async (filter) => rows.filter((r) => matches(r, filter)).length;

const accountTokens = require("../../../services/auth/accountToken.service");

const KIND = "landlord_invite";
const EMAIL = "dana@example.com";
const sha256 = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

const reset = () => {
  rows = [];
  nextId = 1;
};

async function main() {
  /* -------------- 1) The raw token is never stored --------------------- */
  //
  // The single most important line in this file. Everything else is about
  // lifecycle; this is about what a stolen backup is worth.

  reset();
  const { rawToken, token } = await accountTokens.issue({ kind: KIND, email: EMAIL });

  assert.ok(rawToken && rawToken.length >= 40, "the raw token must be long");
  assert.strictEqual(token.tokenHash, sha256(rawToken), "only the sha256 is persisted");

  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(rawToken), "the raw token must appear nowhere in the stored row");

  // Normalised on the way in, so an invite typed as "Dana@Example.COM" is found
  // by the lowercase address the rest of the system uses.
  const { token: cased } = await accountTokens.issue({ kind: KIND, email: "  DANA@Example.COM " });
  assert.strictEqual(cased.email, EMAIL, "the address is normalised");

  /* -------------- 2) Issuing retires the earlier live tokens ----------- */

  reset();
  const first = await accountTokens.issue({ kind: KIND, email: EMAIL });
  const second = await accountTokens.issue({ kind: KIND, email: EMAIL });

  assert.strictEqual(await accountTokens.peek({ rawToken: second.rawToken, kind: KIND }) !== null, true, "the newest link works");
  assert.strictEqual(
    await accountTokens.peek({ rawToken: first.rawToken, kind: KIND }),
    null,
    "the superseded link must stop working"
  );

  // Revoking $unsets the hash rather than nulling it, so the row leaves the
  // partial unique index and the credential cannot resolve at all.
  const revoked = rows.find((r) => String(r._id) === String(first.token._id));
  assert.ok(revoked.revokedAt instanceof Date, "it is marked revoked");
  assert.ok(!("tokenHash" in revoked), "and the hash is removed, not set to null");

  // A different address is untouched — revokeAll is scoped, not a sweep.
  reset();
  const dana = await accountTokens.issue({ kind: KIND, email: EMAIL });
  await accountTokens.issue({ kind: KIND, email: "someone-else@example.com" });
  assert.ok(await accountTokens.peek({ rawToken: dana.rawToken, kind: KIND }), "another address must not revoke this one");

  /* -------------- 3) peek does not spend ------------------------------- */
  //
  // The bug this prevents: an invite destroyed by the corporate mail scanner
  // that fetches every link before the human sees it.

  reset();
  const live = await accountTokens.issue({ kind: KIND, email: EMAIL });
  for (let i = 0; i < 5; i += 1) {
    assert.ok(await accountTokens.peek({ rawToken: live.rawToken, kind: KIND }), `peek ${i + 1} still works`);
  }
  assert.strictEqual(rows[0].consumedAt, null, "peeking must never set consumedAt");

  /* -------------- 4) Every unusable state answers the same ------------- */

  reset();
  const expired = await accountTokens.issue({ kind: KIND, email: EMAIL, ttlMs: 1000 });
  assert.strictEqual(
    await accountTokens.peek({ rawToken: expired.rawToken, kind: KIND, now: new Date(Date.now() + 5000) }),
    null,
    "expired"
  );

  reset();
  const gone = await accountTokens.issue({ kind: KIND, email: EMAIL });
  await accountTokens.revokeAll({ kind: KIND, email: EMAIL });
  assert.strictEqual(await accountTokens.peek({ rawToken: gone.rawToken, kind: KIND }), null, "revoked");

  reset();
  const used = await accountTokens.issue({ kind: KIND, email: EMAIL });
  await accountTokens.consume({ rawToken: used.rawToken, kind: KIND });
  assert.strictEqual(await accountTokens.peek({ rawToken: used.rawToken, kind: KIND }), null, "already consumed");

  assert.strictEqual(await accountTokens.peek({ rawToken: "not-a-token", kind: KIND }), null, "unknown");
  assert.strictEqual(await accountTokens.peek({ rawToken: null, kind: KIND }), null, "absent");

  // A token of one kind must not resolve as the other, or a password reset link
  // would be redeemable as a landlord invite.
  reset();
  const reset1 = await accountTokens.issue({ kind: "password_reset", email: EMAIL });
  assert.strictEqual(
    await accountTokens.peek({ rawToken: reset1.rawToken, kind: KIND }),
    null,
    "a reset token is not an invite"
  );

  /* -------------- 5) consume is single-use ----------------------------- */

  reset();
  const once = await accountTokens.issue({ kind: KIND, email: EMAIL });
  const winner = await accountTokens.consume({ rawToken: once.rawToken, kind: KIND });
  const loser = await accountTokens.consume({ rawToken: once.rawToken, kind: KIND });

  assert.ok(winner, "the first consume wins");
  assert.ok(winner.consumedAt instanceof Date);
  assert.strictEqual(loser, null, "the second gets nothing — exactly one tab creates a landlord");

  // The hash survives being spent: the row is the audit trail of an accepted
  // invite, and keeping it is what makes unconsume possible.
  assert.strictEqual(winner.tokenHash, sha256(once.rawToken), "consume keeps the hash; only revoke removes it");

  // An expired token cannot be consumed even though peek is a separate call —
  // the guard is in the update filter, not only in peek.
  reset();
  const stale = await accountTokens.issue({ kind: KIND, email: EMAIL, ttlMs: 1000 });
  assert.strictEqual(
    await accountTokens.consume({ rawToken: stale.rawToken, kind: KIND, now: new Date(Date.now() + 5000) }),
    null,
    "consume re-checks expiry itself"
  );

  /* -------------- 6) unconsume reverts ONLY its own consume ------------ */
  //
  // The scenario: request A consumes and stalls. Request B consumes — no, it
  // cannot, A holds it. So: A consumes, A fails, A's rollback runs LATE, and by
  // then the person has retried and B has consumed and succeeded. If unconsume
  // matched on _id alone it would reopen a token that has already produced a
  // landlord, handing out a second one.

  reset();
  const shared = await accountTokens.issue({ kind: KIND, email: EMAIL });
  const consumeA = await accountTokens.consume({ rawToken: shared.rawToken, kind: KIND });
  const stampA = consumeA.consumedAt;

  // A rolls back correctly.
  await accountTokens.unconsume({ _id: consumeA._id, consumedAt: stampA });
  assert.strictEqual(rows[0].consumedAt, null, "its own consume is reverted");

  // The person retries; B consumes and succeeds.
  const consumeB = await accountTokens.consume({ rawToken: shared.rawToken, kind: KIND, now: new Date(Date.now() + 1000) });
  assert.ok(consumeB, "the retry can consume again");
  assert.notStrictEqual(String(consumeB.consumedAt), String(stampA), "a different consume");

  // A's stale rollback arrives. It must do nothing.
  const stale2 = await accountTokens.unconsume({ _id: consumeA._id, consumedAt: stampA });
  assert.strictEqual(stale2.modifiedCount, 0, "a stale rollback matches nothing");
  assert.ok(rows[0].consumedAt, "and B's acceptance stays spent");

  assert.strictEqual((await accountTokens.unconsume({ _id: null, consumedAt: null })).modifiedCount, 0, "no-op args");

  /* -------------- 7) purgeAt outlives expiry --------------------------- */
  //
  // "Was this person invited, and did they accept?" is worth answering a month
  // later, so the row is not deleted the moment it stops working.

  reset();
  const audited = await accountTokens.issue({ kind: KIND, email: EMAIL });
  assert.ok(
    audited.token.purgeAt - audited.token.expiresAt >= 29 * 24 * 60 * 60 * 1000,
    "purgeAt must be well after expiresAt, so a spent invite is still auditable"
  );

  /* -------------- 8) countRecent, for PR3's cap ------------------------ */

  reset();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  await accountTokens.issue({ kind: "password_reset", email: EMAIL });
  await accountTokens.issue({ kind: "password_reset", email: EMAIL });
  assert.strictEqual(await accountTokens.countRecent({ kind: "password_reset", email: EMAIL, since }), 2);
  assert.strictEqual(await accountTokens.countRecent({ kind: KIND, email: EMAIL, since }), 0, "counted per kind");
  assert.strictEqual(await accountTokens.countRecent({ kind: KIND, email: "", since }), 0, "no address, no count");

  /* -------------- 9) An unknown kind is a programming error ------------ */

  await assert.rejects(
    () => accountTokens.issue({ kind: "not_a_kind", email: EMAIL }),
    /unknown token kind/,
    "a typo'd kind must throw rather than mint something with no expiry"
  );
  await assert.rejects(() => accountTokens.issue({ kind: KIND, email: "" }), /requires an email/);

  console.log("accountToken.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
