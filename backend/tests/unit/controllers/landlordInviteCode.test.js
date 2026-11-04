// The invite codes a landlord actually issues.
//
// THE RULE THIS FILE EXISTS TO PROTECT: the endpoint behind the dashboard's
// "generate code" button — not some other generator — mints codes in the
// hardened format. That exact gap shipped once: code.controller.js was moved to
// ten base32 characters while landlord.controller.js, the only generator with
// a route, kept minting six hex characters. The service-level tests passed the
// whole time, because they tested the copy nobody called.

const assert = require("assert");

const Property = require("../../../models/Property");
const Unit = require("../../../models/Unit");
const InviteCode = require("../../../models/Code");

let created = [];
let createErrors = [];
Property.findOne = async (filter) => (filter.landlordId === "landlord-1" ? { _id: filter._id } : null);
Unit.findOne = async () => ({ _id: UNIT });
InviteCode.create = async (doc) => {
  if (createErrors.length) throw createErrors.shift();
  created.push(doc);
  return { _id: `code${created.length}`, ...doc };
};

const ctrl = require("../../../controllers/landlord.controller");

const PROP = "6650a1a1a1a1a1a1a1a1a1a1";
const UNIT = "6650b2b2b2b2b2b2b2b2b2b2";
const { CODE_ALPHABET, CODE_LENGTH } = require("../../../services/inviteCode/inviteCode.service");

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

const makeReq = (body) => ({ user: { id: "landlord-1" }, body });

async function main() {
  /* -------------- 1) The dashboard's endpoint mints the hardened format -- */

  created = [];
  let res = makeRes();
  await ctrl.generateInviteCode(makeReq({ propertyId: PROP, unitId: UNIT }), res);

  assert.strictEqual(res.statusCode, 201);
  const code = res.payload.data.code;
  assert.strictEqual(code.length, CODE_LENGTH, `the landlord endpoint minted "${code}"`);
  assert.ok(/^[0-9A-Z]+$/.test(code) && [...code].every((c) => CODE_ALPHABET.includes(c)), `"${code}" is off-alphabet`);
  assert.ok(!/^[0-9A-F]{6}$/.test(code), "the old six-hex format must be gone from the real path");

  /* -------------- 2) Ownership and expiry are still honoured ------------ */

  assert.strictEqual(created[0].landlordId, "landlord-1");
  assert.strictEqual(created[0].propertyId, PROP);
  const days = (created[0].expiresAt - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days <= 7, `default expiry must be 7 days, got ${days.toFixed(2)}`);

  res = makeRes();
  await ctrl.generateInviteCode({ user: { id: "someone-else" }, body: { propertyId: PROP, unitId: UNIT } }, res);
  assert.strictEqual(res.statusCode, 404, "a landlord cannot mint codes for another landlord's property");

  /* -------------- 3) A collision retries instead of failing the landlord - */

  created = [];
  createErrors = [Object.assign(new Error("E11000 duplicate key"), { code: 11000 })];
  res = makeRes();
  await ctrl.generateInviteCode(makeReq({ propertyId: PROP, unitId: UNIT }), res);
  assert.strictEqual(res.statusCode, 201, "one duplicate-key collision must be retried");
  assert.strictEqual(created.length, 1);

  /* -------------- 4) Any other error is not swallowed by the retry ------ */

  createErrors = [new Error("mongo unavailable")];
  res = makeRes();
  const realError = console.error;
  console.error = () => {};
  await ctrl.generateInviteCode(makeReq({ propertyId: PROP, unitId: UNIT }), res);
  console.error = realError;
  assert.strictEqual(res.statusCode, 500, "only duplicate-key errors are retryable");

  console.log("landlordInviteCode tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
