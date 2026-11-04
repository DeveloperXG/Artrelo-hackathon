// One account per email; Landlord and Tenant are roles hanging off it.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * a failed sign-in gives away nothing — not whether the address exists,
//     and not by how long it took;
//   * a second role can be added to an address only by someone who can prove
//     that account's password, and doing so never changes the password;
//   * a half-made account (created, profile then failed) never survives.

const assert = require("assert");
const bcrypt = require("bcryptjs");

const Account = require("../../../models/Account");
const Landlord = require("../../../models/Landlord");
const Tenant = require("../../../models/Tenant");

/* ---------------- Stubs -------------------------------------------------- */
//
// Model statics are replaced before the service is required, the way the rest
// of the suite does it. Accounts are held in a small in-memory table so the
// duplicate-key races can be driven deliberately.

let accounts = [];
let profiles = { landlord: [], tenant: [] };
let deletedAccountIds = [];
let nextId = 1;
let failNextProfileCreate = null; // Error to throw from the next create
let createRace = false; // make Account.create throw E11000 once

const selectable = (row) => ({ select: async () => row });

Account.findOne = (filter) => {
  const email = filter?.email;
  return selectable(accounts.find((a) => a.email === email) || null);
};
Account.findById = async (id) => accounts.find((a) => String(a._id) === String(id)) || null;
Account.create = async (doc) => {
  if (createRace) {
    createRace = false;
    // Someone else inserted this email between our lookup and our insert.
    throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  }
  if (accounts.some((a) => a.email === doc.email)) {
    throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  }
  const row = { _id: `acc${nextId++}`, tokenVersion: 0, status: "active", ...doc };
  accounts.push(row);
  return row;
};
Account.updateOne = async (filter, update) => {
  const row = accounts.find((a) => String(a._id) === String(filter._id));
  if (row && update?.$set) Object.assign(row, update.$set);
  return { modifiedCount: row ? 1 : 0 };
};
Account.deleteOne = async (filter) => {
  deletedAccountIds.push(String(filter._id));
  accounts = accounts.filter((a) => String(a._id) !== String(filter._id));
  return { deletedCount: 1 };
};

for (const [kind, Model] of [
  ["landlord", Landlord],
  ["tenant", Tenant],
]) {
  Model.findOne = async (filter) =>
    profiles[kind].find((p) => String(p.accountId) === String(filter.accountId)) || null;
  Model.create = async (doc) => {
    if (failNextProfileCreate) {
      const err = failNextProfileCreate;
      failNextProfileCreate = null;
      throw err;
    }
    if (profiles[kind].some((p) => String(p.accountId) === String(doc.accountId))) {
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    }
    const row = { _id: `${kind}${nextId++}`, ...doc };
    profiles[kind].push(row);
    return row;
  };
  Model.updateOne = async () => ({ modifiedCount: 1 });
}

const {
  AuthError,
  authenticate,
  createOrAttachProfile,
  normalizeEmail,
  validatePassword,
} = require("../../../services/auth/account.service");

const PASSWORD = "correct-horse-battery";
let PASSWORD_HASH;

function reset() {
  accounts = [];
  profiles = { landlord: [], tenant: [] };
  deletedAccountIds = [];
  failNextProfileCreate = null;
  createRace = false;
}

function seedAccount({ email = "dana@example.com", hash = PASSWORD_HASH, status = "active" } = {}) {
  const row = { _id: `acc${nextId++}`, email, hashedPassword: hash, tokenVersion: 0, status };
  accounts.push(row);
  return row;
}

const seedProfile = (kind, account, extra = {}) => {
  const row = { _id: `${kind}${nextId++}`, accountId: account._id, email: account.email, role: kind, ...extra };
  profiles[kind].push(row);
  return row;
};

async function expectError(promise, code) {
  try {
    await promise;
    assert.fail(`expected ${code}`);
  } catch (err) {
    assert.ok(err instanceof AuthError, `expected AuthError, got ${err?.name}: ${err?.message}`);
    assert.strictEqual(err.code, code);
    return err;
  }
}

async function main() {
  PASSWORD_HASH = await bcrypt.hash(PASSWORD, 12);

  /* -------------- 1) Email is canonicalised ---------------------------- */

  assert.strictEqual(normalizeEmail("  Dana@Example.COM "), "dana@example.com");
  assert.strictEqual(normalizeEmail(undefined), "");

  /* -------------- 2) Password length is in BYTES ----------------------- */
  //
  // bcrypt truncates at 72 bytes, so a longer passphrase would have its prefix
  // accepted as the whole thing.

  assert.throws(() => validatePassword("short"), /at least 8/);
  assert.throws(() => validatePassword("a".repeat(73)), /72 bytes/);
  assert.throws(() => validatePassword("é".repeat(37)), /72 bytes/, "multi-byte characters count as bytes");
  validatePassword("just-long-enough");

  /* -------------- 3) Failed sign-ins are indistinguishable ------------- */

  reset();
  const known = seedAccount();
  seedProfile("landlord", known);

  const unknown = await expectError(
    authenticate({ email: "nobody@example.com", password: PASSWORD, kind: "landlord" }),
    "invalid_credentials"
  );
  const wrongPassword = await expectError(
    authenticate({ email: known.email, password: "not-the-password", kind: "landlord" }),
    "invalid_credentials"
  );
  assert.strictEqual(unknown.message, wrongPassword.message, "same message either way");
  assert.strictEqual(unknown.status, wrongPassword.status, "same status either way");

  // Timing: the unknown-email path must still spend a bcrypt comparison,
  // otherwise its speed alone answers "does this address exist?".
  //
  // Asserted by COUNTING the comparison, not by timing it. This was a wall
  // clock check -- `unknownMs > wrongMs * 0.5` -- and it failed in a suite run
  // while the machine was busy with a parallel build: two bcrypt calls of
  // ~250ms each are only comparable when nothing else competes for the CPU, so
  // the ratio measured the load, not the code. The invariant is that a
  // comparison HAPPENS against a real bcrypt hash; that is exact, and it fails
  // for the right reason if the `|| DUMMY_HASH` fallback is ever removed.
  const realCompare = bcrypt.compare;
  const comparedAgainst = [];
  bcrypt.compare = (password, hash) => {
    comparedAgainst.push(hash);
    return realCompare.call(bcrypt, password, hash);
  };
  try {
    await expectError(
      authenticate({ email: "nobody@example.com", password: PASSWORD, kind: "landlord" }),
      "invalid_credentials"
    );
  } finally {
    bcrypt.compare = realCompare;
  }

  assert.strictEqual(comparedAgainst.length, 1, "an unknown address must still cost one bcrypt comparison");
  assert.match(
    String(comparedAgainst[0]),
    /^\$2[aby]\$\d{2}\$.{53}$/,
    "it must compare against a real bcrypt hash (the dummy), not an empty string or undefined"
  );
  assert.notStrictEqual(
    comparedAgainst[0],
    PASSWORD_HASH,
    "and not against a seeded account's hash, which would defeat the point"
  );

  /* -------------- 4) The happy path ------------------------------------ */

  reset();
  const account = seedAccount();
  const landlord = seedProfile("landlord", account, { firstName: "Dana" });
  const signedIn = await authenticate({ email: " DANA@example.com ", password: PASSWORD, kind: "landlord" });
  assert.strictEqual(String(signedIn.profile._id), String(landlord._id), "email is normalised on the way in");

  /* -------------- 5) Right password, wrong toggle ---------------------- */
  //
  // Only reachable AFTER the password checks out, so it tells the account
  // holder something they already know and nobody else anything.

  const hint = await expectError(
    authenticate({ email: account.email, password: PASSWORD, kind: "tenant" }),
    "wrong_role"
  );
  assert.strictEqual(hint.status, 409);
  assert.strictEqual(hint.role, "landlord", "the client uses this to flip its toggle");

  /* -------------- 6) No profile at all is not a hint ------------------- */

  reset();
  const orphan = seedAccount();
  await expectError(
    authenticate({ email: orphan.email, password: PASSWORD, kind: "landlord" }),
    "invalid_credentials"
  );

  /* -------------- 7) Disabled accounts cannot sign in ------------------ */

  reset();
  const disabled = seedAccount({ status: "disabled" });
  seedProfile("landlord", disabled);
  await expectError(
    authenticate({ email: disabled.email, password: PASSWORD, kind: "landlord" }),
    "account_disabled"
  );

  /* -------------- 8) Sign-up with a new address ------------------------ */

  reset();
  const created = await createOrAttachProfile({
    email: " NEW@example.com ",
    password: PASSWORD,
    kind: "landlord",
    profileFields: { firstName: "New", lastName: "Person", role: "landlord" },
  });
  assert.strictEqual(created.account.email, "new@example.com");
  assert.strictEqual(created.createdAccount, true);
  assert.strictEqual(created.profile.email, "new@example.com", "the profile copies the ACCOUNT's address");
  assert.ok(!created.account.emailVerifiedAt, "a password alone does not prove the address");

  /* -------------- 9) Adding a role needs that account's password ------- */

  reset();
  const existing = seedAccount();
  seedProfile("landlord", existing);

  const refused = await expectError(
    createOrAttachProfile({
      email: existing.email,
      password: "guessing",
      kind: "tenant",
      profileFields: { firstName: "Mallory", role: "tenant" },
    }),
    "account_exists"
  );
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(accounts[0].hashedPassword, PASSWORD_HASH, "a failed attempt must never change the password");
  assert.strictEqual(profiles.tenant.length, 0, "and must not create the profile");

  const attached = await createOrAttachProfile({
    email: existing.email,
    password: PASSWORD,
    kind: "tenant",
    profileFields: { firstName: "Dana", role: "tenant" },
  });
  assert.strictEqual(attached.createdAccount, false, "the account is reused, not replaced");
  assert.strictEqual(String(attached.account._id), String(existing._id));
  assert.strictEqual(accounts[0].hashedPassword, PASSWORD_HASH, "attaching does not touch the password");
  assert.strictEqual(profiles.tenant.length, 1);

  /* -------------- 10) The same role twice ------------------------------ */

  await expectError(
    createOrAttachProfile({
      email: existing.email,
      password: PASSWORD,
      kind: "tenant",
      profileFields: { role: "tenant" },
    }),
    "profile_exists"
  );

  /* -------------- 11) An invite may mark the address as proven --------- */

  reset();
  const verified = await createOrAttachProfile({
    email: "invited@example.com",
    password: PASSWORD,
    kind: "landlord",
    profileFields: { firstName: "Invited", role: "landlord" },
    verifiedEmail: true,
  });
  assert.ok(verified.account.emailVerifiedAt, "accepting an emailed invite proves the address");

  /* -------------- 12) A failed profile create leaves no orphan --------- */

  reset();
  failNextProfileCreate = new Error("mongo unavailable");
  await assert.rejects(
    createOrAttachProfile({
      email: "doomed@example.com",
      password: PASSWORD,
      kind: "landlord",
      profileFields: { role: "landlord" },
    }),
    /mongo unavailable/
  );
  assert.strictEqual(accounts.length, 0, "the account this request created is cleaned up");
  assert.strictEqual(deletedAccountIds.length, 1);

  /* -------------- 13) ...but an existing account is never deleted ------ */

  reset();
  const keepMe = seedAccount();
  seedProfile("landlord", keepMe);
  failNextProfileCreate = new Error("mongo unavailable");
  await assert.rejects(
    createOrAttachProfile({
      email: keepMe.email,
      password: PASSWORD,
      kind: "tenant",
      profileFields: { role: "tenant" },
    }),
    /mongo unavailable/
  );
  assert.strictEqual(accounts.length, 1, "someone else's account must survive our failure");
  assert.strictEqual(deletedAccountIds.length, 0);

  /* -------------- 14) Losing the create race falls back to attach ------ */

  reset();
  const racer = seedAccount({ email: "race@example.com" });
  // Pretend the lookup missed it, then the insert collided: the address was
  // taken between the two. The attach path must take over.
  Account.findOne = (filter) =>
    selectable(filter.email === "race@example.com" && createRace ? null : accounts.find((a) => a.email === filter.email) || null);
  createRace = true;

  const afterRace = await createOrAttachProfile({
    email: "race@example.com",
    password: PASSWORD,
    kind: "tenant",
    profileFields: { role: "tenant" },
  });
  assert.strictEqual(String(afterRace.account._id), String(racer._id), "the winner's account is used");
  assert.strictEqual(afterRace.createdAccount, false);
  assert.strictEqual(accounts.length, 1, "no duplicate account is left behind");

  /* -------------- 14) A new landlord gets a beta clock ----------------- */

  const DAY = 24 * 60 * 60 * 1000;

  reset();
  const dflt = await createOrAttachProfile({
    email: "beta1@example.com",
    password: PASSWORD,
    kind: "landlord",
    profileFields: { firstName: "B", lastName: "One", role: "landlord" },
  });
  assert.strictEqual(dflt.profile.beta.status, "active");
  assert.strictEqual(
    Math.round((dflt.profile.beta.endsAt - dflt.profile.beta.startedAt) / DAY),
    require("../../../config/beta").defaultBetaDays(),
    "no betaDays -> the default beta length"
  );
  assert.deepStrictEqual(dflt.profile.beta.remindersSent, []);
  assert.strictEqual(dflt.profile.termsAcceptedAt, undefined, "terms are recorded only when accepted");

  reset();
  const ninety = await createOrAttachProfile({
    email: "beta2@example.com",
    password: PASSWORD,
    kind: "landlord",
    profileFields: { firstName: "B", lastName: "Two", role: "landlord" },
    betaDays: 90,
    termsAccepted: true,
  });
  assert.strictEqual(Math.round((ninety.profile.beta.endsAt - ninety.profile.beta.startedAt) / DAY), 90);
  assert.ok(ninety.profile.termsAcceptedAt instanceof Date);
  assert.ok(ninety.profile.termsVersion, "the Terms version accepted is stored");

  // A tenant is not in the program.
  reset();
  const tenant = await createOrAttachProfile({
    email: "t@example.com",
    password: PASSWORD,
    kind: "tenant",
    profileFields: { firstName: "T", role: "tenant" },
    betaDays: 90,
  });
  assert.strictEqual(tenant.profile.beta, undefined);

  // Attaching the landlord role to an existing account stamps it too.
  reset();
  const person = seedAccount();
  seedProfile("tenant", person);
  const dual = await createOrAttachProfile({
    email: person.email,
    password: PASSWORD,
    kind: "landlord",
    profileFields: { firstName: "D", role: "landlord" },
    betaDays: 30,
  });
  assert.strictEqual(Math.round((dual.profile.beta.endsAt - dual.profile.beta.startedAt) / DAY), 30);

  // A nonsense length is refused BEFORE an account is created for it.
  reset();
  // A plain Error, not an AuthError: betaDays comes from our own invite row, so
  // a bad value is a bug on our side (a 500), not something the visitor did.
  await assert.rejects(
    createOrAttachProfile({
      email: "bad@example.com",
      password: PASSWORD,
      kind: "landlord",
      profileFields: { role: "landlord" },
      betaDays: -5,
    }),
    /beta days/
  );
  assert.strictEqual(accounts.length, 0, "no account is left behind");

  console.log("account.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
