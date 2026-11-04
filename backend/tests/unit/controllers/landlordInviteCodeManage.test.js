// Generating, listing and deleting a landlord's tenant invite codes.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * a code needs BOTH a property and a unit -- a unit-less code signed a
//     tenant up attached to nothing -- and the 400 names each missing field so
//     the dialog can mark it;
//   * a landlord can delete their own codes, and another landlord's code id
//     (or garbage) is a 404, never a delete or a 500;
//   * the list never shows an expired code, even before the TTL sweep runs.

const assert = require("assert");

const Property = require("../../../models/Property");
const Unit = require("../../../models/Unit");
const InviteCode = require("../../../models/Code");

const LANDLORD = "6650a0a0a0a0a0a0a0a0a0a0";
const PROP = "6650a1a1a1a1a1a1a1a1a1a1";
const UNIT = "6650b2b2b2b2b2b2b2b2b2b2";
const CODE = "6650c3c3c3c3c3c3c3c3c3c3";

let deleted = [];
let created = [];
let lastFindFilter = null;

Property.findOne = async (filter) => (String(filter.landlordId) === LANDLORD ? { _id: filter._id } : null);
Unit.findOne = async () => ({ _id: UNIT });
InviteCode.create = async (doc) => {
  created.push(doc);
  return { _id: CODE, ...doc };
};
InviteCode.findOneAndDelete = async (filter) => {
  if (String(filter._id) === CODE && String(filter.landlordId) === LANDLORD) {
    deleted.push(filter);
    return { _id: CODE };
  }
  return null;
};
InviteCode.find = (filter) => {
  lastFindFilter = filter;
  const chain = { sort: () => chain, populate: () => chain, lean: async () => [] };
  return chain;
};

const ctrl = require("../../../controllers/landlord.controller");

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function main() {
  /* -------------- 1) Property AND unit, with per-field messages -------- */

  let res = makeRes();
  await ctrl.generateInviteCode({ user: { id: LANDLORD }, body: { propertyId: PROP } }, res);
  assert.strictEqual(res.statusCode, 400, "a property alone is no longer enough");
  assert.deepStrictEqual(Object.keys(res.body.fields), ["unitId"]);

  res = makeRes();
  await ctrl.generateInviteCode({ user: { id: LANDLORD }, body: {} }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(res.body.fields.propertyId && res.body.fields.unitId, "both missing fields are named");

  res = makeRes();
  await ctrl.generateInviteCode({ user: { id: LANDLORD }, body: { propertyId: "nope", unitId: "nope" } }, res);
  assert.strictEqual(res.statusCode, 400, "a malformed id is a field error, not a 500 from a cast");
  assert.strictEqual(created.length, 0);

  res = makeRes();
  await ctrl.generateInviteCode({ user: { id: LANDLORD }, body: { propertyId: PROP, unitId: UNIT } }, res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(created[0].unitId, UNIT);

  /* -------------- 2) Delete: own code only --------------------------- */

  res = makeRes();
  await ctrl.deleteInviteCode({ user: { id: LANDLORD }, params: { id: CODE } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(deleted.length, 1);

  res = makeRes();
  await ctrl.deleteInviteCode({ user: { id: "6650d4d4d4d4d4d4d4d4d4d4" }, params: { id: CODE } }, res);
  assert.strictEqual(res.statusCode, 404, "another landlord's code is not found, not deleted");
  assert.strictEqual(deleted.length, 1);

  res = makeRes();
  await ctrl.deleteInviteCode({ user: { id: LANDLORD }, params: { id: "garbage" } }, res);
  assert.strictEqual(res.statusCode, 404, "a malformed id is a 404, not a 500");

  /* -------------- 3) The list hides expired codes ---------------------- */

  res = makeRes();
  await ctrl.listInviteCodes({ user: { id: LANDLORD } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(String(lastFindFilter.landlordId), LANDLORD);
  assert.ok(lastFindFilter.expiresAt?.$gt instanceof Date, "only unexpired codes are listed");

  console.log("landlordInviteCodeManage tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
