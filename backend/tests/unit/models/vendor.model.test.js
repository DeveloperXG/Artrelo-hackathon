const assert = require("assert");
const mongoose = require("mongoose");
const Vendor = require("../../../models/Vendor");

const landlordId = new mongoose.Types.ObjectId();

async function run() {
  const withLocation = new Vendor({
    landlordId,
    name: "Calgary Plumbing Co",
    specialties: ["Plumbing"],
    city: "Calgary",
    serviceAreas: ["Calgary", "Airdrie"],
  });

  await withLocation.validate();
  assert.strictEqual(withLocation.status, "active");
  assert.strictEqual(withLocation.active, true);
  assert.deepStrictEqual(withLocation.categories, ["Plumbing"]);

  const withoutLocation = new Vendor({
    landlordId,
    name: "Legacy Vendor",
    specialties: ["Electrical"],
  });

  await withoutLocation.validate();
  assert.deepStrictEqual(withoutLocation.serviceAreas, []);
  assert.strictEqual(withoutLocation.city, "");

  const legacyServiceArea = new Vendor({
    landlordId,
    name: "Legacy Area Vendor",
    specialties: ["HVAC"],
    serviceArea: "Calgary, AB",
    active: false,
  });

  await legacyServiceArea.validate();
  assert.deepStrictEqual(legacyServiceArea.serviceAreas, ["Calgary, AB"]);
  assert.strictEqual(legacyServiceArea.status, "inactive");

  console.log("vendor.model Phase 3 schema tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
