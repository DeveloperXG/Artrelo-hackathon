// GET /landlords/reports: a bad range is a 400 naming the field, and every
// query is scoped to the signed-in landlord.

const assert = require("assert");

const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const Property = require("../../../models/Property");
const Vendor = require("../../../models/Vendor");
const JobCompletion = require("../../../models/JobCompletion");

const filters = {};
const chain = (rows, name) => (filter) => {
  filters[name] = filter;
  const c = { select: () => c, lean: async () => rows };
  return c;
};

MaintenanceRequest.find = chain(
  [
    {
      _id: "r1",
      status: "completed",
      category: "Plumbing",
      finalCost: 120,
      createdAt: new Date(2026, 9, 2),
      completedAt: new Date(2026, 9, 3),
      propertyId: "p1",
      selectedVendorId: "v1",
    },
  ],
  "requests"
);
JobCompletion.find = chain([{ requestId: "r1", tenantConfirmation: { rating: 4 } }], "completions");
Property.find = chain([{ _id: "p1", name: "Maple Court" }], "properties");
Vendor.find = chain([{ _id: "v1", name: "BluePeak", responseStats: { averageFirstResponseMinutes: 12 } }], "vendors");

const ctrl = require("../../../controllers/reports.controller");

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

const run = async () => {
  /* ===== 1) A bad range answers 400 with the field ===== */
  let res = makeRes();
  await ctrl.getReport({ user: { id: "landlord-1" }, query: { from: "2026-10-09", to: "2026-10-01" } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.field, "from");

  /* ===== 2) A good one builds the report, scoped and named ===== */
  res = makeRes();
  await ctrl.getReport({ user: { id: "landlord-1" }, query: { from: "2026-10-01", to: "2026-10-31" } }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(filters.requests.landlordId, "landlord-1");
  assert.strictEqual(filters.completions.landlordId, "landlord-1");
  assert.strictEqual(filters.properties.landlordId, "landlord-1", "property names only from this landlord's properties");

  const data = res.body.data;
  assert.strictEqual(data.totals.spend, 120);
  assert.deepStrictEqual(data.spendByProperty, [{ propertyId: "p1", spend: 120, name: "Maple Court" }]);
  assert.strictEqual(data.vendorPerformance[0].name, "BluePeak");
  assert.strictEqual(data.vendorPerformance[0].avgRating, 4);
  assert.strictEqual(data.vendorPerformance[0].avgFirstResponseMinutes, 12);

  console.log("reports.controller tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
