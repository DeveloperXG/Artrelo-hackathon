// Bulk unit creation.
//
// Three things carry this file:
//   1. A landlord may only write into a property they own, and a property they
//      do not own must be indistinguishable from one that does not exist.
//   2. A batch lands whole or not at all. A half-applied import is worse than a
//      rejected one — it leaves the landlord reconciling a list by hand.
//   3. The whole batch costs a fixed number of queries. The entire reason this
//      endpoint exists is that the alternative was N calls to POST /units.

const assert = require("assert");

const Property = require("../../../models/Property");
const Unit = require("../../../models/Unit");

const LANDLORD = "landlord-1";
const PROPERTY = "property-1";

let ownedProperty = null;
let existingUnits = []; // rows Unit.find() returns for the collision check
let insertedRows = []; // what insertMany was handed
let deletedFilter = null; // the compensating delete, if it ran
let propertyUpdate = null; // the $addToSet linking units back to the property
let queryCount = 0;

// After the insert the controller re-reads the batch's identifiers to catch a
// concurrent writer. By default it sees exactly what it wrote.
let postInsertRows = null;

Property.findOne = async (filter) => {
  queryCount += 1;
  if (filter._id !== PROPERTY || filter.landlordId !== LANDLORD) return null;
  return ownedProperty;
};

const linkUnitsToProperty = async (filter, update) => {
  queryCount += 1;
  propertyUpdate = { filter, update };
  return { modifiedCount: 1 };
};
Property.updateOne = linkUnitsToProperty;

let unitFindCalls = 0;
Unit.find = () => ({
  select: () => ({
    lean: async () => {
      queryCount += 1;
      unitFindCalls += 1;
      // First call is the pre-insert collision check, second is the race check.
      if (unitFindCalls === 1) return existingUnits;
      return postInsertRows !== null ? postInsertRows : insertedRows;
    },
  }),
});
Unit.insertMany = async (docs) => {
  queryCount += 1;
  insertedRows = docs.map((doc, index) => ({ ...doc, _id: `unit-${index}` }));
  return insertedRows;
};
Unit.deleteMany = async (filter) => {
  queryCount += 1;
  deletedFilter = filter;
  return { deletedCount: 0 };
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

function makeReq(units, { propertyId = PROPERTY, landlordId = LANDLORD } = {}) {
  return { user: { id: landlordId }, params: { propertyId }, body: { units } };
}

function reset() {
  ownedProperty = { _id: PROPERTY, landlordId: LANDLORD, units: [] };
  existingUnits = [];
  insertedRows = [];
  postInsertRows = null;
  deletedFilter = null;
  propertyUpdate = null;
  unitFindCalls = 0;
  queryCount = 0;
  Property.updateOne = linkUnitsToProperty;
}

const run = async () => {
  /* ===== 1) The happy path creates every row and links them to the property ===== */
  reset();
  let res = makeRes();
  await ctrl.createUnitsBulk(makeReq(["101", "102", "103"]), res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(
    insertedRows.map((row) => row.unitNumber),
    ["101", "102", "103"]
  );
  assert.strictEqual(res.body.data.summary.created, 3);
  assert.ok(propertyUpdate, "created units are linked back onto the property");
  assert.deepStrictEqual(propertyUpdate.update.$addToSet.units.$each, ["unit-0", "unit-1", "unit-2"]);
  assert.strictEqual(deletedFilter, null, "nothing to roll back");

  /* ===== 2) The batch costs a fixed number of queries, not one per unit ===== */
  reset();
  res = makeRes();
  const bigBatch = Array.from({ length: 240 }, (_, i) => String(101 + i));
  await ctrl.createUnitsBulk(makeReq(bigBatch), res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(insertedRows.length, 240);
  assert.ok(
    queryCount <= 6,
    `240 units should take a handful of queries, not one each (took ${queryCount})`
  );

  /* ===== 3) Identifiers are normalized on the way in, casing preserved ===== */
  reset();
  res = makeRes();
  await ctrl.createUnitsBulk(makeReq(["  PH1 ", "Unit  A"]), res);
  assert.deepStrictEqual(
    insertedRows.map((row) => row.unitNumber),
    ["PH1", "Unit A"]
  );

  /* ===== 4) One bad row rejects the batch — nothing is written ===== */
  reset();
  res = makeRes();
  existingUnits = [{ unitNumber: "102" }];
  await ctrl.createUnitsBulk(makeReq(["101", "102", "103", "103", ""]), res);

  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(insertedRows.length, 0, "not a single unit was created");
  assert.strictEqual(res.body.data.summary.collisions, 1);
  assert.strictEqual(res.body.data.summary.duplicates, 1);
  assert.strictEqual(res.body.data.summary.empty, 1);
  assert.strictEqual(res.body.data.rows.length, 5, "per-row detail so the table can mark each one");

  /* ===== 5) Authorization: another landlord's property is simply not found ===== */
  reset();
  res = makeRes();
  await ctrl.createUnitsBulk(makeReq(["101"], { landlordId: "landlord-2" }), res);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(
    res.body.message,
    "Property not found",
    "same answer as a nonexistent property, so the endpoint cannot be used to probe for ids"
  );
  assert.strictEqual(insertedRows.length, 0);

  reset();
  res = makeRes();
  await ctrl.createUnitsBulk(makeReq(["101"], { propertyId: "property-does-not-exist" }), res);
  assert.strictEqual(res.statusCode, 404);

  /* ===== 6) A concurrent import that wins the race gets ours rolled back ===== */
  reset();
  res = makeRes();
  // Our insert succeeds, but the re-read shows "102" twice: someone else
  // created it between our collision check and our write.
  postInsertRows = [{ unitNumber: "101" }, { unitNumber: "102" }, { unitNumber: "102" }];
  await ctrl.createUnitsBulk(makeReq(["101", "102"]), res);

  assert.strictEqual(res.statusCode, 409);
  assert.deepStrictEqual(res.body.data.conflicts, ["102"]);
  assert.ok(deletedFilter, "the batch we wrote is deleted again");
  assert.deepStrictEqual(deletedFilter._id.$in, ["unit-0", "unit-1"]);
  assert.strictEqual(propertyUpdate, null, "and never linked onto the property");

  /* ===== 7) A failure after the insert also rolls the batch back ===== */
  reset();
  res = makeRes();
  Property.updateOne = async () => {
    throw new Error("write concern failed");
  };
  await ctrl.createUnitsBulk(makeReq(["101", "102"]), res);
  assert.strictEqual(res.statusCode, 500);
  assert.ok(deletedFilter, "an error linking the units still undoes the insert");
  assert.deepStrictEqual(deletedFilter._id.$in, ["unit-0", "unit-1"]);

  /* ===== 8) Batch size guards ===== */
  reset();
  res = makeRes();
  await ctrl.createUnitsBulk(makeReq([]), res);
  assert.strictEqual(res.statusCode, 400);

  reset();
  res = makeRes();
  await ctrl.createUnitsBulk(makeReq("not-an-array"), res);
  assert.strictEqual(res.statusCode, 400);

  reset();
  res = makeRes();
  const tooMany = Array.from({ length: 5001 }, (_, i) => `u${i}`);
  await ctrl.createUnitsBulk(makeReq(tooMany), res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.message, /at most 5000/);
  assert.strictEqual(insertedRows.length, 0);

  /* ===== 9) The dry run reports the same verdict and writes nothing ===== */
  reset();
  res = makeRes();
  existingUnits = [{ unitNumber: "101" }];
  await ctrl.validateUnitsBulk(makeReq(["101", "102", "102"]), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.valid, false);
  assert.strictEqual(res.body.data.summary.collisions, 1);
  assert.strictEqual(res.body.data.summary.duplicates, 1);
  assert.strictEqual(insertedRows.length, 0, "a dry run never writes");
  assert.strictEqual(propertyUpdate, null);

  reset();
  res = makeRes();
  await ctrl.validateUnitsBulk(makeReq(["101"], { landlordId: "landlord-2" }), res);
  assert.strictEqual(res.statusCode, 404, "the dry run is authorized exactly like the commit");

  console.log("unitsBulk.controller tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
