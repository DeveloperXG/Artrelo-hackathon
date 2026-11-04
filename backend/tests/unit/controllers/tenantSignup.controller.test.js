// Redeeming an invite code to create a tenant.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * a code is worth exactly one tenant. It used to be deleted AFTER the
//     tenant was saved, so two sign-ups holding the same code — the second
//     arriving while the first was still hashing a password — both succeeded;
//   * a failed attempt gives the code back. The landlord issued it, and our
//     error must not cost them an invitation;
//   * only a sign-up token gets in here, and it proves a code, not an address.

const assert = require("assert");

const InviteCode = require("../../../models/Code");
const Account = require("../../../models/Account");
const Tenant = require("../../../models/Tenant");

let codeRow = null;
let deletedFilters = [];
let restored = [];
let failTenantCreate = null;

InviteCode.findOneAndDelete = async (filter) => {
  deletedFilters.push(filter);
  const row = codeRow;
  codeRow = null; // whoever gets here first takes it
  return row;
};
InviteCode.create = async (doc) => {
  restored.push(doc);
  return doc;
};

let accounts = [];
let tenants = [];
let nextId = 1;
Account.findOne = () => ({ select: async () => accounts.find((a) => a.email === "dana@example.com") || null });
Account.create = async (doc) => {
  const row = { _id: `acc${nextId++}`, tokenVersion: 0, status: "active", ...doc };
  accounts.push(row);
  return row;
};
Account.updateOne = async () => ({ modifiedCount: 1 });
Account.deleteOne = async (filter) => {
  accounts = accounts.filter((a) => String(a._id) !== String(filter._id));
  return { deletedCount: 1 };
};
Tenant.findOne = async () => null;
Tenant.create = async (doc) => {
  if (failTenantCreate) {
    const err = failTenantCreate;
    failTenantCreate = null;
    throw err;
  }
  const row = { _id: `ten${nextId++}`, ...doc };
  tenants.push(row);
  return row;
};
Tenant.updateOne = async () => ({ modifiedCount: 1 });

const env = require("../../../config/env");
env.jwt_secret = env.jwt_secret || "test-secret";
env.refresh_token_secret = env.refresh_token_secret || "test-refresh-secret";

const { tenantPostSignUp } = require("../../../controllers/auth.controller");
const {
  signTenantSignupToken,
  signAccessToken,
  verifyAccessToken,
} = require("../../../services/auth/tokens.service");

const CODE = { code: "9JKMNPQRST", landlordId: "l1", propertyId: "p1", unitId: "u1", expiresAt: new Date(Date.now() + 8.64e7) };

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    cookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    cookie(name, value, opts) {
      this.cookies.push({ name, value, opts });
      return this;
    },
  };
}

const body = (extra = {}) => ({
  firstName: "Dana",
  lastName: "Okafor",
  email: "dana@example.com",
  password: "correct-horse-battery",
  confirmPassword: "correct-horse-battery",
  signupToken: signTenantSignupToken({ code: CODE.code, landlordId: "l1", unitId: "u1" }),
  ...extra,
});

async function call(payload) {
  const res = makeRes();
  await tenantPostSignUp({ body: payload }, res);
  return res;
}

function reset() {
  codeRow = { ...CODE };
  deletedFilters = [];
  restored = [];
  failTenantCreate = null;
  accounts = [];
  tenants = [];
}

async function main() {
  const realError = console.error;
  const realLog = console.log;
  console.error = () => {};

  try {
    /* -------------- 1) The happy path ------------------------------------ */

    reset();
    let res = await call(body());
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.payload));
    assert.strictEqual(tenants.length, 1);
    assert.strictEqual(accounts.length, 1, "a tenant gets an account like anyone else");
    assert.ok(!accounts[0].emailVerifiedAt, "a unit-bound code does not prove the address");
    assert.strictEqual(verifyAccessToken(res.payload.token).userId, String(tenants[0]._id));
    assert.ok(
      res.payload.refreshToken === undefined,
      "the refresh token is an httpOnly cookie, never body JSON"
    );
    assert.ok(res.cookies.some((c) => c.name === "refreshToken" && c.opts.httpOnly));

    /* -------------- 2) The code is taken BEFORE anything is created ------ */

    assert.strictEqual(deletedFilters.length, 1, "redeemed atomically, once");
    assert.ok(deletedFilters[0].expiresAt?.$gt instanceof Date, "and only while unexpired");

    /* -------------- 3) A second sign-up with the same code fails --------- */
    //
    // codeRow is already null — the first call took it — which is what the
    // loser of the race sees.

    res = await call(body({ email: "someone-else@example.com" }));
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.payload.message, /Invalid or expired invite code/);
    assert.strictEqual(tenants.length, 1, "no second tenant from one code");

    /* -------------- 4) A failure hands the code back --------------------- */

    reset();
    failTenantCreate = new Error("mongo unavailable");
    res = await call(body());
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(restored.length, 1, "the landlord's invitation is returned");
    assert.strictEqual(restored[0].code, CODE.code);
    assert.strictEqual(restored[0].unitId, CODE.unitId, "restored with the unit it was bound to");
    assert.deepStrictEqual(
      restored[0].expiresAt,
      CODE.expiresAt,
      "and its original expiry, not a fresh one"
    );
    assert.strictEqual(accounts.length, 0, "and no half-made account is left behind");

    /* -------------- 5) Bad or missing sign-up tokens --------------------- */

    reset();
    assert.strictEqual((await call(body({ signupToken: undefined }))).statusCode, 401);
    assert.strictEqual(deletedFilters.length, 0, "a refusal must not touch the code");

    // An ACCESS token must not work here either: the two are signed with
    // different keys precisely so neither can stand in for the other.
    reset();
    const access = signAccessToken({
      profile: { _id: "p1", role: "tenant" },
      account: { _id: "a1", tokenVersion: 0 },
    });
    res = await call(body({ signupToken: access }));
    assert.strictEqual(res.statusCode, 401, "an access token is not proof of an invite code");
    assert.strictEqual(deletedFilters.length, 0);

    /* -------------- 6) Mismatched passwords never reach the code --------- */

    reset();
    res = await call(body({ confirmPassword: "something-else" }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(deletedFilters.length, 0, "checked before the code is redeemed");
  } finally {
    console.error = realError;
    console.log = realLog;
  }

  console.log("tenantSignup.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
