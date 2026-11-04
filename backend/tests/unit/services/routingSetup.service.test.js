// What vendor routing can reach: vendor count versus the policy's vendor cap.
//
// Pinned: the count uses the SAME filter as recommendation generation (so the
// Policy page and the routing panel agree on "how many vendors"), and a missing
// policy or cap falls back to the schema default rather than `|| 3`, which
// would turn a deliberate 0 into 3.

const assert = require("assert");

const Vendor = require("../../../models/Vendor");
const LandlordPolicy = require("../../../models/LandlordPolicy");

let countFilter = null;
let vendorCount = 0;
let policyRow = null;

Vendor.countDocuments = async (filter) => {
  countFilter = filter;
  return vendorCount;
};
LandlordPolicy.findOne = () => ({ select: () => ({ lean: async () => policyRow }) });

const {
  assertRoutingSetupReady,
  getRoutingSetup,
  resolveMaxVendors,
} = require("../../../services/vendor/routingSetup.service");
const { routableVendorFilter } = require("../../../services/vendor/vendorRecommendation.service");

const SCHEMA_DEFAULT = LandlordPolicy.schema.path("maxOutreachAttempts").defaultValue;

async function main() {
  /* -------- fewer vendors than the cap: the network is the limit -------- */
  vendorCount = 2;
  policyRow = { maxOutreachAttempts: 3 };
  const small = await getRoutingSetup("landlord-1");
  assert.deepStrictEqual(small, {
    activeVendorCount: 2,
    maxOutreachAttempts: 3,
    effectiveCap: 2,
    ready: true,
    missing: [],
  });
  assert.deepStrictEqual(
    countFilter,
    routableVendorFilter("landlord-1"),
    "counts exactly the vendors generation would consider"
  );

  /* -------- more vendors than the cap: the policy is the limit -------- */
  vendorCount = 6;
  const large = await getRoutingSetup("landlord-1");
  assert.strictEqual(large.effectiveCap, 3);

  /* -------- the cap's fallbacks -------- */
  assert.strictEqual(resolveMaxVendors(null), SCHEMA_DEFAULT, "no policy document yet");
  assert.strictEqual(resolveMaxVendors({}), SCHEMA_DEFAULT, "a lean read skips schema defaults");
  assert.strictEqual(resolveMaxVendors({ maxOutreachAttempts: null }), SCHEMA_DEFAULT);
  assert.strictEqual(resolveMaxVendors({ maxOutreachAttempts: 0 }), 0, "a deliberate 0 stays 0");
  assert.strictEqual(resolveMaxVendors({ maxOutreachAttempts: "4" }), 4);

  /* -------- a brand-new landlord: nothing can be contacted -------- */
  assert.strictEqual(SCHEMA_DEFAULT, 3, "new landlords can route once they have a vendor; no quota still requires approval");
  vendorCount = 0;
  policyRow = null;
  const fresh = await getRoutingSetup("landlord-1");
  assert.strictEqual(fresh.ready, false);
  assert.deepStrictEqual(fresh.missing, ["vendors"], "only the real vendor network is missing");

  await assert.rejects(assertRoutingSetupReady("landlord-1"), (err) => {
    assert.strictEqual(err.statusCode, 409);
    assert.strictEqual(err.code, "routing_setup_incomplete");
    assert.ok(err.message.includes("Add at least one vendor"), err.message);
    assert.deepStrictEqual(err.setup, fresh, "the setup rides on the error for the client");
    return true;
  });

  /* -------- a vendor but no cap: only the cap is missing -------- */
  vendorCount = 1;
  policyRow = { maxOutreachAttempts: 0 };
  await assert.rejects(assertRoutingSetupReady("landlord-1"), (err) => {
    assert.deepStrictEqual(err.setup.missing, ["max_vendors"]);
    assert.ok(err.message.includes("Policy page"), err.message);
    return true;
  });

  /* -------- both in place: resolves with the setup -------- */
  policyRow = { maxOutreachAttempts: 1 };
  const ready = await assertRoutingSetupReady("landlord-1");
  assert.strictEqual(ready.ready, true);

  console.log("routingSetup.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
