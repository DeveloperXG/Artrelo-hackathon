// Portfolio import.
//
// The rule that carries this file: a portfolio half-imported is worse than one
// not imported at all. The landlord cannot tell which buildings landed without
// walking the list, and re-running collides with whatever did. So when anything
// fails after the first write, everything written is taken back.
//
// The second rule is that the import costs a fixed number of writes. Twelve
// properties and 438 units is two inserts and two updates, not 450 round trips.

const assert = require("assert");

const Property = require("../../../models/Property");
const Unit = require("../../../models/Unit");
const Landlord = require("../../../models/Landlord");

const LANDLORD = "landlord-1";

let existingProperties = []; // what the landlord already owns
let insertedProperties = [];
let insertedUnits = [];
let bulkWriteOps = null;
let landlordUpdates = [];
let deletedUnits = null;
let deletedProperties = null;
let writeCount = 0;

// Overridable failure injection, to prove the rollback path.
let failOn = null; // 'units' | 'bulkWrite' | 'landlord'

Property.find = () => ({
  select: () => ({
    lean: async () => {
      writeCount += 1;
      return existingProperties;
    },
  }),
});
Property.insertMany = async (docs) => {
  writeCount += 1;
  insertedProperties = docs.map((doc, index) => ({ ...doc, _id: `prop-${index}` }));
  return insertedProperties;
};
Property.bulkWrite = async (ops) => {
  writeCount += 1;
  if (failOn === "bulkWrite") throw new Error("bulkWrite failed");
  bulkWriteOps = ops;
  return { modifiedCount: ops.length };
};
Property.deleteMany = async (filter) => {
  deletedProperties = filter;
  return { deletedCount: 0 };
};
Unit.insertMany = async (docs) => {
  writeCount += 1;
  if (failOn === "units") throw new Error("unit insert failed");
  insertedUnits = docs.map((doc, index) => ({ ...doc, _id: `unit-${index}` }));
  return insertedUnits;
};
Unit.deleteMany = async (filter) => {
  deletedUnits = filter;
  return { deletedCount: 0 };
};
Landlord.findByIdAndUpdate = async (id, update) => {
  writeCount += 1;
  if (failOn === "landlord" && update.$addToSet) throw new Error("landlord link failed");
  landlordUpdates.push({ id, update });
  return {};
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

const makeReq = (properties, landlordId = LANDLORD) => ({
  user: { id: landlordId },
  body: { properties },
});

const property = (name, address, units) => ({ name, address, units });

function reset() {
  existingProperties = [];
  insertedProperties = [];
  insertedUnits = [];
  bulkWriteOps = null;
  landlordUpdates = [];
  deletedUnits = null;
  deletedProperties = null;
  writeCount = 0;
  failOn = null;
}

const run = async () => {
  /* ===== 1) A clean portfolio lands, units attached to the right properties ===== */
  reset();
  let res = makeRes();
  await ctrl.importPortfolio(
    makeReq([
      property("Maple Apartments", "123 Main St", ["101", "102", "103"]),
      property("Oak Tower", "98 Oak Ave", ["PH1", "PH2"]),
    ]),
    res
  );

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.data.summary.propertiesCreated, 2);
  assert.strictEqual(res.body.data.summary.unitsCreated, 5);

  // Every unit is filed under the property whose row it came from.
  assert.deepStrictEqual(
    insertedUnits.map((unit) => `${unit.propertyId}:${unit.unitNumber}`),
    ["prop-0:101", "prop-0:102", "prop-0:103", "prop-1:PH1", "prop-1:PH2"]
  );
  assert.deepStrictEqual(bulkWriteOps[0].updateOne.update.$addToSet.units.$each, [
    "unit-0",
    "unit-1",
    "unit-2",
  ]);
  assert.deepStrictEqual(bulkWriteOps[1].updateOne.update.$addToSet.units.$each, [
    "unit-3",
    "unit-4",
  ]);
  assert.deepStrictEqual(landlordUpdates[0].update.$addToSet.properties.$each, [
    "prop-0",
    "prop-1",
  ]);
  assert.strictEqual(insertedProperties[0].landlordId, LANDLORD, "properties belong to the caller");

  /* ===== 2) The whole import is a fixed number of writes ===== */
  reset();
  res = makeRes();
  const big = Array.from({ length: 12 }, (_, p) =>
    property(`Building ${p}`, `${p} Some St`, Array.from({ length: 36 }, (_, u) => `${p}-${u}`))
  );
  await ctrl.importPortfolio(makeReq(big), res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.data.summary.unitsCreated, 432);
  assert.ok(
    writeCount <= 6,
    `12 properties and 432 units should be a handful of queries (took ${writeCount})`
  );

  /* ===== 3) One bad row rejects the import — nothing is written ===== */
  reset();
  res = makeRes();
  await ctrl.importPortfolio(
    makeReq([
      property("Maple Apartments", "123 Main St", ["101", "102"]),
      property("Oak Tower", "", ["PH1"]),
      property("Elm Court", "5 Elm Rd", ["1", "1"]),
    ]),
    res
  );

  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(insertedProperties.length, 0, "not one property was created");
  assert.strictEqual(insertedUnits.length, 0, "not one unit was created");
  assert.strictEqual(res.body.data.summary.invalidProperties, 2);
  assert.strictEqual(res.body.data.summary.properties, 3);
  assert.strictEqual(res.body.data.summary.units, 5);
  assert.strictEqual(res.body.data.properties.length, 3, "per-row detail for the review table");

  /* ===== 4) A name the landlord already owns blocks the import ===== */
  reset();
  res = makeRes();
  existingProperties = [{ name: "Maple Apartments" }];
  await ctrl.importPortfolio(
    makeReq([property("maple apartments", "123 Main St", ["101"])]),
    res
  );
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.body.data.summary.existingProperties, 1);
  assert.strictEqual(insertedProperties.length, 0);

  /* ===== 5) A failure after the units land takes everything back ===== */
  reset();
  res = makeRes();
  failOn = "bulkWrite";
  await ctrl.importPortfolio(
    makeReq([property("Maple Apartments", "123 Main St", ["101", "102"])]),
    res
  );

  assert.strictEqual(res.statusCode, 500);
  assert.ok(deletedUnits, "the units are deleted again");
  assert.deepStrictEqual(deletedUnits._id.$in, ["unit-0", "unit-1"]);
  assert.ok(deletedProperties, "and so are the properties");
  assert.deepStrictEqual(deletedProperties._id.$in, ["prop-0"]);
  assert.ok(
    landlordUpdates.some((update) => update.update.$pull),
    "and the landlord's property list is unwound"
  );

  /* ===== 6) A failure between the two inserts takes back the first ===== */
  reset();
  res = makeRes();
  failOn = "units";
  await ctrl.importPortfolio(
    makeReq([property("Maple Apartments", "123 Main St", ["101"])]),
    res
  );

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(deletedUnits, null, "there were no units to delete");
  assert.deepStrictEqual(deletedProperties._id.$in, ["prop-0"], "the property does not survive");

  /* ===== 7) Size guards ===== */
  reset();
  res = makeRes();
  await ctrl.importPortfolio(makeReq([]), res);
  assert.strictEqual(res.statusCode, 400);

  reset();
  res = makeRes();
  await ctrl.importPortfolio(makeReq(undefined), res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(insertedProperties.length, 0);

  /* ===== 8) The dry run reports the same verdict and writes nothing ===== */
  reset();
  res = makeRes();
  existingProperties = [{ name: "Oak Tower" }];
  await ctrl.validatePortfolio(
    makeReq([
      property("Maple Apartments", "123 Main St", ["101", "101"]),
      property("Oak Tower", "98 Oak Ave", ["PH1"]),
    ]),
    res
  );

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.valid, false);
  assert.strictEqual(res.body.data.summary.properties, 2);
  assert.strictEqual(res.body.data.summary.units, 3);
  assert.strictEqual(res.body.data.summary.duplicateUnits, 1);
  assert.strictEqual(res.body.data.summary.existingProperties, 1);
  assert.strictEqual(insertedProperties.length, 0, "a dry run never writes");
  assert.strictEqual(insertedUnits.length, 0);

  console.log("portfolioImport.controller tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
