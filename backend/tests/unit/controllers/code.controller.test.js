// Invite codes are the whole gate on tenant sign-up.
//
// THE RULE THIS FILE EXISTS TO PROTECT: /codes/verify is an unauthenticated
// oracle — it tells any caller whether a code is real and hands back a signup
// token for a real unit. Closed registration used to hide that; the beta opens
// it. So a code must be expensive to guess, must stop working the moment it
// expires, and must still work when a tenant types it the way people type.

const assert = require("assert");

const InviteCode = require("../../../models/Code");

/* ---------------- Stubs -------------------------------------------------- */

let found = null;
let queries = [];
InviteCode.findOne = async (filter) => {
  queries.push(filter);
  return found;
};

const env = require("../../../config/env");
env.jwt_secret = env.jwt_secret || "test-secret";

const ctrl = require("../../../controllers/code.controller");
const {
  generateCode,
  normalizeCode,
  CODE_ALPHABET,
  CODE_LENGTH,
} = require("../../../services/inviteCode/inviteCode.service");

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

const VALID_ROW = {
  code: "9JKMNPQRST",
  landlordId: "landlord-1",
  unitId: "unit-1",
  expiresAt: new Date(Date.now() + 86_400_000),
};

function reset() {
  found = null;
  queries = [];
}

async function main() {
  /* -------------- 1) Generated codes: alphabet and length -------------- */

  assert.strictEqual(CODE_LENGTH, 10, "ten symbols over 32 is the guessing cost this relies on");
  assert.strictEqual(CODE_ALPHABET.length, 32);

  for (const confusable of ["I", "L", "O", "U"]) {
    assert.ok(
      !CODE_ALPHABET.includes(confusable),
      `"${confusable}" is too easily misread to put in a code people type`
    );
  }

  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const code = generateCode();
    assert.strictEqual(code.length, CODE_LENGTH);
    for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `"${ch}" is outside the alphabet`);
    seen.add(code);
  }
  assert.strictEqual(seen.size, 500, "500 generated codes must not collide");

  // Every position must vary — a bug pinning one would quietly shrink the space.
  for (let pos = 0; pos < CODE_LENGTH; pos++) {
    const chars = new Set([...seen].map((c) => c[pos]));
    assert.ok(chars.size > 1, `position ${pos} never varies`);
  }

  /* -------------- 2) What a tenant types is canonicalised -------------- */

  for (const typed of ["9jkmnpqrst", "9JKMNPQRST", " 9JKMNPQRST ", "9JKMN-PQRST", "9jkmn pqrst"]) {
    assert.strictEqual(normalizeCode(typed), "9JKMNPQRST", `"${typed}" must resolve to the stored code`);
  }
  for (const junk of [undefined, null, 42, {}]) {
    assert.strictEqual(normalizeCode(junk), "", "a non-string is not a code");
  }

  /* -------------- 3) Verify accepts a live code ------------------------ */

  reset();
  found = VALID_ROW;
  let res = makeRes();
  await ctrl.verifyInviteCode({ body: { code: "9jkmn-pqrst" } }, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.payload.valid, true);
  assert.ok(res.payload.signupToken, "sign-up needs the token this mints");
  assert.strictEqual(queries[0].code, "9JKMNPQRST", "the lookup uses the canonical form, not the typed one");

  /* -------------- 4) Expiry is in the query, not left to the TTL ------- */
  //
  // MongoDB's TTL sweep runs on a background pass that can lag a minute or
  // more, so an expired row can still be present. It must not verify.

  reset();
  found = VALID_ROW;
  res = makeRes();
  await ctrl.verifyInviteCode({ body: { code: "9JKMNPQRST" } }, res);

  assert.ok(queries[0].expiresAt, "the query must filter on expiresAt");
  assert.ok(queries[0].expiresAt.$gt instanceof Date, "and filter it against now");
  const skew = Math.abs(Date.now() - queries[0].expiresAt.$gt.getTime());
  assert.ok(skew < 5000, `the cutoff must be now, off by ${skew}ms`);

  /* -------------- 5) No row: refused, and nothing minted --------------- */

  reset();
  found = null;
  res = makeRes();
  await ctrl.verifyInviteCode({ body: { code: "9JKMNPQRST" } }, res);

  assert.strictEqual(res.statusCode, 404);
  assert.ok(!res.payload.signupToken, "a refusal must not hand back a token");

  /* -------------- 6) Missing code never reaches the database ----------- */

  for (const empty of [undefined, "", "   ", "---"]) {
    reset();
    res = makeRes();
    await ctrl.verifyInviteCode({ body: { code: empty } }, res);
    assert.strictEqual(res.statusCode, 400, `"${empty}" is not a code`);
    assert.strictEqual(queries.length, 0, "and must not cost a query");
  }

  console.log("code.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
