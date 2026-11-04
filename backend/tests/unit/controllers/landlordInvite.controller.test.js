// Redeeming a beta landlord invite.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * the INVITE decides which address gets the landlord profile. An email in
//     the request body is ignored, or anyone holding a link could claim any
//     address — including one that already has an account;
//   * nothing that can be rejected may spend the invite. A wrong password, a
//     short password, an address that is already a landlord: the link must
//     still work afterwards, because getting another one means asking a human;
//   * one invite is worth exactly one landlord;
//   * it works while public registration is CLOSED. That is the entire point,
//     and the route is deliberately not behind requireRegistrationOpen;
//   * accepting proves control of the address, so emailVerifiedAt is set.

const assert = require("assert");
const bcrypt = require("bcryptjs");

const Account = require("../../../models/Account");
const Landlord = require("../../../models/Landlord");
const Tenant = require("../../../models/Tenant");

/* ---------------- Stubs -------------------------------------------------- */

let accounts = [];
let landlords = [];
let tenants = [];
let nextId = 1;
let failLandlordCreate = null;

const findAccount = (email) => accounts.find((a) => a.email === email) || null;

Account.findOne = (filter) => {
  const row = findAccount(filter?.email);
  return { select: async () => row };
};
Account.findById = async (id) => accounts.find((a) => String(a._id) === String(id)) || null;
Account.create = async (doc) => {
  const row = { _id: `acc${nextId++}`, tokenVersion: 0, status: "active", ...doc };
  accounts.push(row);
  return row;
};
Account.updateOne = async (filter, update) => {
  const row = accounts.find((a) => String(a._id) === String(filter._id));
  if (row) Object.assign(row, update.$set || {});
  return { modifiedCount: row ? 1 : 0 };
};
Account.deleteOne = async (filter) => {
  accounts = accounts.filter((a) => String(a._id) !== String(filter._id));
  return { deletedCount: 1 };
};

Landlord.findOne = async (filter) =>
  landlords.find((l) => String(l.accountId) === String(filter?.accountId)) || null;
Landlord.create = async (doc) => {
  if (failLandlordCreate) {
    const err = failLandlordCreate;
    failLandlordCreate = null;
    throw err;
  }
  const row = { _id: `lord${nextId++}`, ...doc };
  landlords.push(row);
  return row;
};
Landlord.updateOne = async () => ({ modifiedCount: 1 });

Tenant.findOne = async (filter) =>
  tenants.find((t) => String(t.accountId) === String(filter?.accountId)) || null;
Tenant.create = async (doc) => {
  const row = { _id: `ten${nextId++}`, ...doc };
  tenants.push(row);
  return row;
};
Tenant.updateOne = async () => ({ modifiedCount: 1 });

const env = require("../../../config/env");
env.jwt_secret = env.jwt_secret || "test-secret";
env.refresh_token_secret = env.refresh_token_secret || "test-refresh-secret";

// Registration CLOSED for every case below. An invite must not care.
env.registration_enabled = false;

const AccountToken = require("../../../models/AccountToken");

let tokenRows = [];
const sha = require("crypto");
const hash = (raw) => sha.createHash("sha256").update(String(raw)).digest("hex");

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
  return true;
};

AccountToken.create = async (doc) => {
  const row = { _id: `tok${nextId++}`, consumedAt: null, revokedAt: null, createdAt: new Date(), ...doc };
  tokenRows.push(row);
  return row;
};
AccountToken.findOne = async (filter) => tokenRows.find((r) => tokenMatches(r, filter)) || null;
// consume() is the only caller, so this doubles as the spend counter. The rule
// is that a rejectable request never SPENDS the invite -- not merely that the
// invite works afterwards, which a consume-then-rollback also satisfies.
let consumeAttempts = 0;
AccountToken.findOneAndUpdate = async (filter, update) => {
  consumeAttempts += 1;
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
AccountToken.countDocuments = async () => 0;

const accountTokens = require("../../../services/auth/accountToken.service");
const { postInvitePeek, postInviteAccept } = require("../../../controllers/landlordInvite.controller");
const { verifyAccessToken } = require("../../../services/auth/tokens.service");

const INVITED = "dana@example.com";
const GOOD_PASSWORD = "correct-horse-battery";
// Required since the emergency call needs a number to ring.
const TEST_PHONE = "(306) 555-0100";

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    cookies: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    cookie(name, value, opts) {
      this.cookies[name] = { value, opts };
      return this;
    },
  };
}

const call = async (handler, body) => {
  const res = makeRes();
  await handler({ body, ip: "203.0.113.7", get: () => "test-agent" }, res);
  return res;
};

const reset = () => {
  consumeAttempts = 0;
  accounts = [];
  landlords = [];
  tenants = [];
  tokenRows = [];
  nextId = 1;
  failLandlordCreate = null;
};

const seedAccount = async (email, password, { status = "active" } = {}) => {
  const row = {
    _id: `acc${nextId++}`,
    email,
    hashedPassword: await bcrypt.hash(password, 4),
    tokenVersion: 0,
    status,
  };
  accounts.push(row);
  return row;
};

const issueInvite = async (email = INVITED, extra = {}) =>
  accountTokens.issue({ kind: "landlord_invite", email, invitedFirstName: "Dana", invitedLastName: "Okafor", ...extra });

const stillUsable = async (rawToken) =>
  Boolean(await accountTokens.peek({ rawToken, kind: "landlord_invite" }));

// The strong form of "a rejectable request must not cost an invite": the token
// was never spent at all, so there was no rollback to depend on. Without this,
// dropping a pre-consume check still passes -- createOrAttachProfile repeats
// both the disabled and already-a-landlord checks, so the status code is
// unchanged and the catch path hands the invite back.
const neverSpent = (label) =>
  assert.strictEqual(consumeAttempts, 0, `${label}: the invite must not be consumed at all`);

async function main() {
  const realError = console.error;
  console.error = () => {};

  try {
    /* -------------- 1) peek tells the page what it needs -------------- */

    reset();
    let invite = await issueInvite();
    let res = await call(postInvitePeek, { token: invite.rawToken });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.payload.email, INVITED);
    assert.strictEqual(res.payload.firstName, "Dana");
    assert.strictEqual(res.payload.accountExists, false);
    assert.strictEqual(res.payload.alreadyLandlord, false);
    assert.strictEqual(await stillUsable(invite.rawToken), true, "peeking must not spend the invite");

    // Every unusable state gets one answer, so this is not an oracle for which
    // tokens once existed.
    for (const bad of [undefined, null, "", "made-up-token"]) {
      res = await call(postInvitePeek, { token: bad });
      assert.strictEqual(res.statusCode, 404, `peek(${JSON.stringify(bad)})`);
      assert.strictEqual(res.payload.code, "invite_invalid");
    }

    /* -------------- 2) accountExists / alreadyLandlord ---------------- */

    reset();
    const existing = await seedAccount(INVITED, GOOD_PASSWORD);
    invite = await issueInvite();
    res = await call(postInvitePeek, { token: invite.rawToken });
    assert.strictEqual(res.payload.accountExists, true, "a tenant-only account is reported");
    assert.strictEqual(res.payload.alreadyLandlord, false);

    landlords.push({ _id: "lordX", accountId: existing._id, email: INVITED });
    res = await call(postInvitePeek, { token: invite.rawToken });
    assert.strictEqual(res.payload.alreadyLandlord, true, "so the page can point at sign-in instead");

    /* -------------- 3) A new landlord, with registration CLOSED ------- */

    reset();
    assert.strictEqual(env.registration_enabled, false, "the whole point of an invite");

    invite = await issueInvite();
    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: invite.rawToken,
      password: GOOD_PASSWORD,
      firstName: "Dana",
      lastName: "Okafor",
      companyName: "Okafor Property",
    });

    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.payload));
    assert.strictEqual(res.payload.user.email, INVITED);
    assert.strictEqual(res.payload.user.role, "landlord");
    assert.strictEqual(res.payload.user.companyName, "Okafor Property");

    // A real session, and the access token names the PROFILE id.
    const decoded = verifyAccessToken(res.payload.token);
    assert.strictEqual(String(decoded.userId), String(landlords[0]._id));
    assert.strictEqual(decoded.role, "landlord");
    assert.ok(res.cookies.refreshToken, "the refresh token is a cookie");
    assert.strictEqual(res.payload.refreshToken, undefined, "and never in the body");

    // Clicking a link sent to the address proves control of it.
    assert.ok(accounts[0].emailVerifiedAt, "accepting an invite verifies the email");

    assert.strictEqual(await stillUsable(invite.rawToken), false, "the invite is spent");

    // Worth exactly one landlord.
    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: invite.rawToken,
      password: GOOD_PASSWORD,
      firstName: "Dana",
      lastName: "Okafor",
    });
    assert.strictEqual(res.statusCode, 404, "a second accept fails");
    assert.strictEqual(landlords.length, 1, "and creates nothing");

    /* -------------- 3b) The beta clock and the Terms ------------------- */
    //
    // The landlord created above got the default beta and a recorded
    // acceptance of the Terms.
    const first = landlords[0];
    assert.strictEqual(first.beta.status, "active");
    assert.strictEqual(
      Math.round((first.beta.endsAt - first.beta.startedAt) / 86400000),
      require("../../../config/beta").defaultBetaDays()
    );
    assert.ok(first.termsAcceptedAt instanceof Date);
    assert.ok(first.termsVersion);

    // The invite can carry its own length, and the page is told it before the
    // visitor types anything.
    reset();
    invite = await issueInvite(INVITED, { betaDays: 45 });
    res = await call(postInvitePeek, { token: invite.rawToken });
    assert.strictEqual(res.payload.betaDays, 45);
    assert.ok(res.payload.termsVersion);

    // Forgetting the checkbox must not burn the one-shot invite: refused with a
    // code the page can act on, and the same link still works afterwards.
    for (const termsAccepted of [undefined, false, "true", 1]) {
      res = await call(postInviteAccept, { phone: TEST_PHONE,
        termsAccepted,
        token: invite.rawToken,
        password: GOOD_PASSWORD,
        firstName: "Dana",
        lastName: "Okafor",
      });
      assert.strictEqual(res.statusCode, 400, `termsAccepted=${JSON.stringify(termsAccepted)} is not consent`);
      assert.strictEqual(res.payload.code, "terms_required");
    }
    assert.strictEqual(await stillUsable(invite.rawToken), true, "refusing for the Terms spends nothing");
    assert.strictEqual(landlords.length, 0);

    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: invite.rawToken,
      password: GOOD_PASSWORD,
      firstName: "Dana",
      lastName: "Okafor",
    });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.payload));
    assert.strictEqual(
      Math.round((landlords[0].beta.endsAt - landlords[0].beta.startedAt) / 86400000),
      45,
      "the invite's own length is the beta length"
    );

    /* -------------- 4) The body's email is IGNORED -------------------- */
    //
    // The attack: hold a valid invite for your own address, post somebody
    // else's email, and get a landlord profile on their account.

    reset();
    const victim = await seedAccount("victim@example.com", "victims-own-password");
    invite = await issueInvite(INVITED);

    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: invite.rawToken,
      email: "victim@example.com",
      password: GOOD_PASSWORD,
      firstName: "Mal",
      lastName: "Ory",
    });

    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.payload));
    assert.strictEqual(res.payload.user.email, INVITED, "the INVITE decides the address");
    assert.strictEqual(landlords[0].email, INVITED);
    assert.strictEqual(
      landlords.filter((l) => String(l.accountId) === String(victim._id)).length,
      0,
      "the victim's account gains nothing"
    );

    /* -------------- 5) A wrong password does not burn the invite ------ */

    reset();
    await seedAccount(INVITED, "their-real-password");
    invite = await issueInvite();

    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: invite.rawToken,
      password: "not-their-password",
      firstName: "Dana",
      lastName: "Okafor",
    });

    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.payload.code, "account_exists");
    assert.strictEqual(landlords.length, 0, "nothing created");
    neverSpent("a wrong password");
    assert.strictEqual(await stillUsable(invite.rawToken), true, "THE INVITE MUST SURVIVE a wrong password");

    // And the right password then works on the same link, adding the role
    // without touching the existing password.
    const hashBefore = accounts[0].hashedPassword;
    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: invite.rawToken,
      password: "their-real-password",
      firstName: "Dana",
      lastName: "Okafor",
    });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.payload));
    assert.strictEqual(accounts[0].hashedPassword, hashBefore, "an existing password is never overwritten");
    assert.strictEqual(landlords.length, 1);

    /* -------------- 6) Nor does a weak one, or a missing name --------- */

    reset();
    invite = await issueInvite();
    res = await call(postInviteAccept, { phone: TEST_PHONE, termsAccepted: true, token: invite.rawToken, password: "short", firstName: "D", lastName: "O" });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.payload.code, "weak_password");
    neverSpent("a short password");
    assert.strictEqual(await stillUsable(invite.rawToken), true, "a short password must not burn it");

    res = await call(postInviteAccept, { phone: TEST_PHONE, termsAccepted: true, token: invite.rawToken, password: GOOD_PASSWORD, firstName: "", lastName: "" });
    assert.strictEqual(res.statusCode, 400);
    neverSpent("a missing name");
    assert.strictEqual(await stillUsable(invite.rawToken), true, "nor a missing name");

    // A phone is required: an emergency rings it. Refused before the invite is
    // spent, like everything else a landlord can fix and resubmit.
    for (const phone of [undefined, "", "555-0100", "call me"]) {
      res = await call(postInviteAccept, { termsAccepted: true, token: invite.rawToken, password: GOOD_PASSWORD, firstName: "Dana", lastName: "Okafor", phone });
      assert.strictEqual(res.statusCode, 400, `phone ${JSON.stringify(phone)} is refused`);
      assert.strictEqual(res.payload.code, "phone_required");
      assert.strictEqual(res.payload.field, "phone");
    }
    neverSpent("a missing phone");
    assert.strictEqual(await stillUsable(invite.rawToken), true, "nor a missing or undialable phone");

    /* -------------- 7) Nor an address that is already a landlord ------ */

    reset();
    const already = await seedAccount(INVITED, GOOD_PASSWORD);
    landlords.push({ _id: "lordY", accountId: already._id, email: INVITED });
    invite = await issueInvite();

    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: invite.rawToken,
      password: GOOD_PASSWORD,
      firstName: "Dana",
      lastName: "Okafor",
    });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.payload.code, "profile_exists");
    // Caught by the controller BEFORE the consume. createOrAttachProfile would
    // also reject this, with the same 409 -- but only after the token was spent
    // and rolled back, which is a write that can itself fail.
    neverSpent("an address that is already a landlord");
    assert.strictEqual(await stillUsable(invite.rawToken), true, "still unspent");

    /* -------------- 8) A disabled account cannot be revived ----------- */

    reset();
    await seedAccount(INVITED, GOOD_PASSWORD, { status: "disabled" });
    invite = await issueInvite();
    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: invite.rawToken,
      password: GOOD_PASSWORD,
      firstName: "Dana",
      lastName: "Okafor",
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.payload.code, "account_disabled");
    neverSpent("a disabled account");
    assert.strictEqual(await stillUsable(invite.rawToken), true);

    /* -------------- 9) If creation fails, the invite comes back ------- */
    //
    // The consume happens before the create, so a database error after it would
    // otherwise cost the person an invite for a fault that is entirely ours.

    reset();
    invite = await issueInvite();
    failLandlordCreate = new Error("mongo went away");

    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: invite.rawToken,
      password: GOOD_PASSWORD,
      firstName: "Dana",
      lastName: "Okafor",
    });

    assert.strictEqual(res.statusCode, 500, "our fault, reported as ours");
    assert.strictEqual(landlords.length, 0);
    assert.strictEqual(await stillUsable(invite.rawToken), true, "THE INVITE IS GIVEN BACK");
    assert.strictEqual(accounts.length, 0, "and the half-made account is cleaned up");

    // And it genuinely still works.
    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: invite.rawToken,
      password: GOOD_PASSWORD,
      firstName: "Dana",
      lastName: "Okafor",
    });
    assert.strictEqual(res.statusCode, 201, "the retry succeeds on the same link");

    /* -------------- 10) An expired invite is refused ------------------ */

    reset();
    invite = await issueInvite(INVITED, { ttlMs: -1000 });
    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: invite.rawToken,
      password: GOOD_PASSWORD,
      firstName: "Dana",
      lastName: "Okafor",
    });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.payload.code, "invite_invalid");
    assert.strictEqual(landlords.length, 0);

    /* -------------- 11) A reset token is not an invite ---------------- */

    reset();
    const resetToken = await accountTokens.issue({ kind: "password_reset", email: INVITED });

    // PEEK must refuse it too. accept happens to fail anyway because consume
    // filters on kind, but peek is also reached by its own endpoint, where a
    // missing kind filter would confirm a reset token and disclose its address.
    res = await call(postInvitePeek, { token: resetToken.rawToken });
    assert.strictEqual(res.statusCode, 404, "peek must not resolve a reset token as an invite");
    assert.strictEqual(res.payload.email, undefined, "and must not disclose its address");

    res = await call(postInviteAccept, { phone: TEST_PHONE,
      termsAccepted: true,
      token: resetToken.rawToken,
      password: GOOD_PASSWORD,
      firstName: "Mal",
      lastName: "Ory",
    });
    assert.strictEqual(res.statusCode, 404, "kinds must not be interchangeable");
    assert.strictEqual(landlords.length, 0);
  } finally {
    console.error = realError;
  }

  console.log("landlordInvite.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
