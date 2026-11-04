// Forgetting and resetting a password.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * /forgot must not reveal whether an address has an account — not in the
//     body, not the status, and not by TIMING. It answers BEFORE it looks
//     anything up, which is asserted by ordering rather than by a clock;
//   * a password the policy rejects must not cost somebody their one-shot link;
//   * a completed reset bumps tokenVersion, which is the only thing that signs a
//     stranger out of an account they should not have;
//   * a reset link works once;
//   * completing a reset proves control of the address, so emailVerifiedAt is
//     set — for a tenant who signed up with a code, for the first time.

const assert = require("assert");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const Account = require("../../../models/Account");
const Landlord = require("../../../models/Landlord");
const Tenant = require("../../../models/Tenant");
const AccountToken = require("../../../models/AccountToken");

/* ---------------- Stubs -------------------------------------------------- */

let accounts = [];
let landlords = [];
let tenants = [];
let tokenRows = [];
let nextId = 1;
let sentEmails = [];

// Every touch of the Account collection, in order. This is how the timing rule
// is asserted: the response must be written before any of it happens.
let accountReads = [];

const selectable = (row) => ({ select: async () => row });

Account.findOne = (filter) => {
  accountReads.push("findOne");
  return selectable(accounts.find((a) => a.email === filter?.email) || null);
};
Account.findById = async (id) => {
  accountReads.push("findById");
  return accounts.find((a) => String(a._id) === String(id)) || null;
};
Account.updateOne = async (filter, update) => {
  const row = accounts.find((a) => String(a._id) === String(filter._id));
  if (!row) return { modifiedCount: 0 };
  Object.assign(row, update.$set || {});
  for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
  return { modifiedCount: 1 };
};

Landlord.findOne = async (filter) =>
  landlords.find((l) => String(l.accountId) === String(filter?.accountId)) || null;
Tenant.findOne = async (filter) =>
  tenants.find((t) => String(t.accountId) === String(filter?.accountId)) || null;

const hash = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

const tokenMatches = (row, filter) => {
  if (filter.tokenHash !== undefined && row.tokenHash !== filter.tokenHash) return false;
  if (filter.kind !== undefined && row.kind !== filter.kind) return false;
  if (filter._id !== undefined && String(row._id) !== String(filter._id)) return false;
  if (filter.email !== undefined && row.email !== filter.email) return false;
  if ("consumedAt" in filter) {
    if (filter.consumedAt === null) {
      if (row.consumedAt) return false;
    } else if (String(row.consumedAt) !== String(filter.consumedAt)) return false;
  }
  if ("revokedAt" in filter && filter.revokedAt === null && row.revokedAt) return false;
  if (filter.expiresAt?.$gt && !(row.expiresAt > filter.expiresAt.$gt)) return false;
  if (filter.createdAt?.$gte && !(row.createdAt >= filter.createdAt.$gte)) return false;
  return true;
};

AccountToken.create = async (doc) => {
  const row = { _id: `tok${nextId++}`, consumedAt: null, revokedAt: null, createdAt: new Date(), ...doc };
  tokenRows.push(row);
  return row;
};
AccountToken.findOne = async (filter) => tokenRows.find((r) => tokenMatches(r, filter)) || null;
AccountToken.findOneAndUpdate = async (filter, update) => {
  const row = tokenRows.find((r) => tokenMatches(r, filter));
  if (!row) return null;
  Object.assign(row, update.$set || {});
  return row;
};
AccountToken.updateOne = async (filter, update) => {
  const row = tokenRows.find((r) => tokenMatches(r, filter));
  if (!row) return { modifiedCount: 0 };
  Object.assign(row, update.$set || {});
  for (const k of Object.keys(update.$unset || {})) delete row[k];
  return { modifiedCount: 1 };
};
AccountToken.updateMany = async (filter, update) => {
  const hits = tokenRows.filter((r) => tokenMatches(r, filter));
  hits.forEach((r) => {
    Object.assign(r, update.$set || {});
    for (const k of Object.keys(update.$unset || {})) delete r[k];
  });
  return { modifiedCount: hits.length };
};
AccountToken.countDocuments = async (filter) => tokenRows.filter((r) => tokenMatches(r, filter)).length;

const env = require("../../../config/env");
env.jwt_secret = env.jwt_secret || "test-secret";
env.refresh_token_secret = env.refresh_token_secret || "test-refresh-secret";
// A key, so the controller takes its SEND path rather than the stub-log one --
// that branch is what production runs and is the one worth testing.
//
// Nothing can actually leave: sendEmail is replaced below BEFORE the controller
// is required, so the controller's destructured reference is this stub, and
// tests/_unit_setup.js blocks the network regardless.
env.resend_api_key = "test-key-never-used";

const emailService = require("../../../services/notification/email.service");
emailService.sendEmail = async (msg) => {
  sentEmails.push(msg);
  return { id: "stub" };
};

const accountTokens = require("../../../services/auth/accountToken.service");
const {
  postForgotPassword,
  postResetPassword,
  processForgot,
  ACCEPTED,
  MAX_PER_EMAIL_PER_HOUR,
} = require("../../../controllers/passwordReset.controller");

const EMAIL = "dana@example.com";
const NEW_PASSWORD = "a-brand-new-password";

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    cleared: [],
    // What the account collection had been asked at the moment json() ran.
    readsWhenAnswered: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      this.readsWhenAnswered = [...accountReads];
      return this;
    },
    clearCookie(name) {
      this.cleared.push(name);
      return this;
    },
    cookie() {
      return this;
    },
  };
}

const call = async (handler, body) => {
  const res = makeRes();
  await handler({ body, ip: "203.0.113.9", cookies: {} }, res);
  return res;
};

const reset = () => {
  accounts = [];
  landlords = [];
  tenants = [];
  tokenRows = [];
  sentEmails = [];
  accountReads = [];
  nextId = 1;
};

const seedAccount = async (email, password, extra = {}) => {
  const row = {
    _id: `acc${nextId++}`,
    email,
    hashedPassword: await bcrypt.hash(password, 4),
    tokenVersion: 0,
    status: "active",
    ...extra,
  };
  accounts.push(row);
  return row;
};

const issueReset = (email, accountId, extra = {}) =>
  accountTokens.issue({ kind: "password_reset", email, accountId, ...extra });

// Let the fire-and-forget work in postForgotPassword settle.
const drain = () => new Promise((r) => setImmediate(() => setImmediate(r)));

async function main() {
  const realError = console.error;
  const realLog = console.log;
  console.error = () => {};
  console.log = () => {};

  try {
    /* ========== /forgot ================================================= */

    /* -------------- 1) It answers BEFORE it looks anything up ---------- */
    //
    // The timing rule, asserted by ordering rather than by a clock. A wall-clock
    // comparison of two bcrypt-free paths would measure machine load, and a
    // flaky security test is worse than none.

    reset();
    const known = await seedAccount(EMAIL, "old-password");
    let res = await call(postForgotPassword, { email: EMAIL });

    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(
      res.readsWhenAnswered,
      [],
      "the response must be written before the account is looked up at all"
    );
    await drain();
    assert.ok(accountReads.length > 0, "and the work does then happen");

    /* -------------- 2) Existing and missing are indistinguishable ------ */

    const bodies = [];
    for (const address of [EMAIL, "no-such-person@example.com", "", "not-an-email", undefined]) {
      reset();
      await seedAccount(EMAIL, "old-password");
      const r = await call(postForgotPassword, { email: address });
      bodies.push({ status: r.statusCode, payload: r.payload, reads: r.readsWhenAnswered });
      await drain();
    }
    const first = JSON.stringify(bodies[0]);
    bodies.forEach((b, i) =>
      assert.strictEqual(JSON.stringify(b), first, `response ${i} must be byte-identical to the first`)
    );
    assert.deepStrictEqual(bodies[0].payload, ACCEPTED, "and it is the one frozen body");

    // Even when the work throws, the caller gets the same answer.
    reset();
    await seedAccount(EMAIL, "old-password");
    const boom = Account.findOne;
    Account.findOne = () => {
      throw new Error("mongo went away");
    };
    res = await call(postForgotPassword, { email: EMAIL });
    assert.strictEqual(res.statusCode, 202, "an internal failure must not change the answer");
    assert.deepStrictEqual(res.payload, ACCEPTED);
    await drain();
    Account.findOne = boom;

    /* -------------- 3) No token for a missing or disabled account ------ */

    reset();
    assert.strictEqual((await processForgot({ email: "nobody@example.com" })).reason, "no_account");
    assert.strictEqual(tokenRows.length, 0, "nothing is written for an address with no account");
    assert.strictEqual(sentEmails.length, 0, "and nothing is sent");

    reset();
    await seedAccount(EMAIL, "old-password", { status: "disabled" });
    assert.strictEqual((await processForgot({ email: EMAIL })).reason, "disabled");
    assert.strictEqual(tokenRows.length, 0, "a disabled account cannot be reset into");
    assert.strictEqual(sentEmails.length, 0);

    reset();
    assert.strictEqual((await processForgot({ email: "  " })).reason, "no_email");

    /* -------------- 4) The happy path issues exactly one live token ---- */

    reset();
    const acct = await seedAccount(EMAIL, "old-password");
    landlords.push({ _id: "lord1", accountId: acct._id, firstName: "Dana", role: "landlord" });

    let out = await processForgot({ email: EMAIL });
    assert.strictEqual(out.sent, true);
    assert.ok(out.url.includes("/login/reset#t="), "the link puts the token in the FRAGMENT");
    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].to, EMAIL);
    assert.ok(sentEmails[0].text.includes("Dana"), "greeted by name from whichever profile exists");
    assert.ok(!sentEmails[0].html.includes("undefined"));

    // Only the hash is stored.
    const raw = out.url.split("#t=")[1];
    assert.strictEqual(tokenRows[0].tokenHash, hash(raw), "only the sha256 is persisted");
    assert.ok(!JSON.stringify(tokenRows).includes(raw), "the raw token appears nowhere");

    // Asking twice leaves ONE working link — the newest.
    const second = await processForgot({ email: EMAIL });
    const rawOld = raw;
    const rawNew = second.url.split("#t=")[1];
    assert.strictEqual(await accountTokens.peek({ rawToken: rawOld, kind: "password_reset" }), null, "the old link dies");
    assert.ok(await accountTokens.peek({ rawToken: rawNew, kind: "password_reset" }), "the newest works");

    /* -------------- 5) The database-backed hourly cap ------------------ */
    //
    // The one limiter that survives a deploy and sees an attacker cycling IPs,
    // which is what makes this endpoint a mailer someone else can aim.

    reset();
    const capped = await seedAccount(EMAIL, "old-password");
    for (let i = 0; i < MAX_PER_EMAIL_PER_HOUR; i += 1) {
      assert.strictEqual((await processForgot({ email: EMAIL })).sent, true, `send ${i + 1}`);
    }
    out = await processForgot({ email: EMAIL });
    assert.strictEqual(out.sent, false, `the ${MAX_PER_EMAIL_PER_HOUR + 1}th is refused`);
    assert.strictEqual(out.reason, "capped");
    assert.strictEqual(sentEmails.length, MAX_PER_EMAIL_PER_HOUR, "and no extra mail goes out");

    // Counted per address, so one person's cap is not everyone's.
    await seedAccount("someone-else@example.com", "pw");
    assert.strictEqual((await processForgot({ email: "someone-else@example.com" })).sent, true);
    assert.ok(capped);

    /* ========== /reset ================================================== */

    /* -------------- 6) A rejected password keeps the link ------------- */

    reset();
    const target = await seedAccount(EMAIL, "old-password");
    let live = await issueReset(EMAIL, target._id);

    for (const bad of ["short", undefined, null, "x".repeat(73)]) {
      res = await call(postResetPassword, { token: live.rawToken, password: bad });
      assert.strictEqual(res.statusCode, 400, `password ${JSON.stringify(bad)?.slice(0, 20)}`);
      assert.strictEqual(res.payload.code, "weak_password");
      assert.ok(
        await accountTokens.peek({ rawToken: live.rawToken, kind: "password_reset" }),
        "THE LINK MUST SURVIVE a password the policy rejects"
      );
    }
    assert.strictEqual(target.tokenVersion, 0, "and nothing was written");
    assert.strictEqual(target.passwordChangedAt, undefined);

    /* -------------- 7) The happy path ---------------------------------- */

    const oldHash = target.hashedPassword;
    res = await call(postResetPassword, { token: live.rawToken, password: NEW_PASSWORD });

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.payload));
    assert.notStrictEqual(target.hashedPassword, oldHash, "the password changed");
    assert.strictEqual(await bcrypt.compare(NEW_PASSWORD, target.hashedPassword), true, "to the new one");
    assert.strictEqual(target.tokenVersion, 1, "TOKENVERSION IS BUMPED — every session dies");
    assert.ok(target.passwordChangedAt instanceof Date);
    assert.ok(target.emailVerifiedAt instanceof Date, "completing a reset proves the address");
    assert.ok(res.cleared.includes("refreshToken"), "this browser's own cookie is cleared too");

    // Worth exactly one use.
    res = await call(postResetPassword, { token: live.rawToken, password: "another-new-password" });
    assert.strictEqual(res.statusCode, 400, "a replay fails");
    assert.strictEqual(res.payload.code, "reset_invalid");
    assert.strictEqual(target.tokenVersion, 1, "and changes nothing");
    assert.strictEqual(await bcrypt.compare(NEW_PASSWORD, target.hashedPassword), true);

    /* -------------- 7b) Two tabs, one link ----------------------------- */
    //
    // The reason this consumes rather than peeks. A single-threaded replay is
    // also refused by the revokeAll that follows a success, so only a race
    // distinguishes the two: with a non-conditional check both requests get a
    // live token and both write, and the password ends up whichever landed last
    // with tokenVersion bumped twice.

    reset();
    const raced = await seedAccount(EMAIL, "old-password");
    live = await issueReset(EMAIL, raced._id);

    const outcomes = await Promise.all([
      call(postResetPassword, { token: live.rawToken, password: "first-tab-password" }),
      call(postResetPassword, { token: live.rawToken, password: "second-tab-password" }),
    ]);

    const wins = outcomes.filter((r) => r.statusCode === 200);
    assert.strictEqual(wins.length, 1, `exactly one tab may win, got ${outcomes.map((r) => r.statusCode)}`);
    assert.strictEqual(raced.tokenVersion, 1, "and the password is set exactly once");

    /* -------------- 8) roles, for the sign-in toggle ------------------- */

    reset();
    const dual = await seedAccount(EMAIL, "old-password");
    landlords.push({ _id: "lordD", accountId: dual._id, role: "landlord" });
    tenants.push({ _id: "tenD", accountId: dual._id, role: "tenant" });
    live = await issueReset(EMAIL, dual._id);
    res = await call(postResetPassword, { token: live.rawToken, password: NEW_PASSWORD });
    assert.deepStrictEqual(res.payload.roles.sort(), ["landlord", "tenant"]);
    assert.strictEqual(res.payload.email, EMAIL);

    reset();
    const lonely = await seedAccount(EMAIL, "old-password");
    live = await issueReset(EMAIL, lonely._id);
    res = await call(postResetPassword, { token: live.rawToken, password: NEW_PASSWORD });
    assert.deepStrictEqual(res.payload.roles, [], "an account with no profile yet reports none");

    /* -------------- 9) An unusable link, every way ---------------------- */

    reset();
    const owner = await seedAccount(EMAIL, "old-password");

    for (const bad of [undefined, null, "", "made-up"]) {
      res = await call(postResetPassword, { token: bad, password: NEW_PASSWORD });
      assert.strictEqual(res.statusCode, 400, `token ${JSON.stringify(bad)}`);
      assert.strictEqual(res.payload.code, "reset_invalid");
    }

    // Expired.
    live = await issueReset(EMAIL, owner._id, { ttlMs: -1000 });
    res = await call(postResetPassword, { token: live.rawToken, password: NEW_PASSWORD });
    assert.strictEqual(res.payload.code, "reset_invalid", "expired");
    assert.strictEqual(owner.tokenVersion, 0);

    // Revoked.
    live = await issueReset(EMAIL, owner._id);
    await accountTokens.revokeAll({ kind: "password_reset", email: EMAIL });
    res = await call(postResetPassword, { token: live.rawToken, password: NEW_PASSWORD });
    assert.strictEqual(res.payload.code, "reset_invalid", "revoked");

    // An INVITE token must not work here.
    reset();
    const victim = await seedAccount(EMAIL, "old-password");
    const inviteToken = await accountTokens.issue({
      kind: "landlord_invite",
      email: EMAIL,
      accountId: victim._id,
    });
    accountReads = [];
    res = await call(postResetPassword, { token: inviteToken.rawToken, password: NEW_PASSWORD });
    assert.strictEqual(res.statusCode, 400, "an invite is not a reset token");
    assert.strictEqual(victim.tokenVersion, 0, "and cannot change a password");
    // The FIRST peek must reject it, before the handler goes any further.
    // consume() also filters on kind and would refuse it a step later, so
    // without this the kind check on peek could be dropped unnoticed -- and peek
    // is the gate that decides whether we look an account up at all.
    assert.deepStrictEqual(
      accountReads,
      [],
      "a wrong-kind token must be refused before the account is even loaded"
    );
    assert.ok(
      await accountTokens.peek({ rawToken: inviteToken.rawToken, kind: "landlord_invite" }),
      "and the invite is left intact"
    );

    /* -------------- 10) The account was disabled after the link went out */

    reset();
    const later = await seedAccount(EMAIL, "old-password");
    live = await issueReset(EMAIL, later._id);
    later.status = "disabled";

    res = await call(postResetPassword, { token: live.rawToken, password: NEW_PASSWORD });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.payload.code, "reset_invalid");
    assert.strictEqual(later.tokenVersion, 0, "a disabled account's password is not resettable");
    // The token is retired rather than left live against a dead account.
    assert.strictEqual(
      await accountTokens.peek({ rawToken: live.rawToken, kind: "password_reset" }),
      null,
      "and the link is retired"
    );

    /* -------------- 11) Spare links are revoked on success ------------- */
    //
    // issue() already revokes on the way out, so this covers the other order:
    // two links minted before either was used (a re-issue racing a send).

    reset();
    const multi = await seedAccount(EMAIL, "old-password");
    const linkA = await issueReset(EMAIL, multi._id);
    // A second row created directly, bypassing issue()'s revoke-on-mint.
    const rawB = accountTokens.generateRawToken();
    await AccountToken.create({
      kind: "password_reset",
      tokenHash: hash(rawB),
      email: EMAIL,
      accountId: multi._id,
      expiresAt: new Date(Date.now() + 60000),
      purgeAt: new Date(Date.now() + 9e8),
    });
    assert.ok(await accountTokens.peek({ rawToken: rawB, kind: "password_reset" }), "both are live");

    res = await call(postResetPassword, { token: linkA.rawToken, password: NEW_PASSWORD });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(
      await accountTokens.peek({ rawToken: rawB, kind: "password_reset" }),
      null,
      "using one link revokes the spare — it would otherwise be a second key"
    );
  } finally {
    console.error = realError;
    console.log = realLog;
  }

  console.log("passwordReset.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
