// "Total maintenance spend" must mean money actually spent.
//
// Previously it summed `finalCost || estimatedCost` over EVERY request, and
// since outreach shipped `estimatedCost` holds the vendor's quote ceiling — so
// a queued job with a quote inflated the headline at the highest possible number.

const assert = require("assert");

const Property = require("../../../models/Property");
const Tenant = require("../../../models/Tenant");
const Unit = require("../../../models/Unit");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");

let requestRows = [];
let propertyFilter = null;
let tenantFilter = null;
let tenantRows = [
  { unit: "u1" },
  { unit: "u1" }, // two tenants sharing a unit still occupy ONE unit
  { unit: null, moveOut: null },
  { unit: "u-retired" }, // lives in a unit that has since been retired
  { unit: "u2", moveOut: { status: "requested" } },
];

Property.find = (filter) => {
  propertyFilter = filter;
  return { select: async () => [{ _id: "prop-1", units: ["u1", "u2", "u-retired"] }] };
};
// The retired unit is still in property.units, but the Unit query filters it.
Unit.find = () => ({ select: () => ({ lean: async () => [{ _id: "u1" }, { _id: "u2" }, { _id: "u3" }] }) });
Tenant.find = (filter) => {
  tenantFilter = filter;
  return { select: () => ({ lean: async () => tenantRows }) };
};
MaintenanceRequest.find = () => ({ select: () => ({ lean: async () => requestRows }) });

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
const req = { user: { id: "landlord-1" } };

const thisMonth = new Date();
const lastMonth = new Date(thisMonth.getFullYear(), thisMonth.getMonth() - 1, 15);

const run = async () => {
  /* ===== 1) Only completed work counts toward spend ===== */
  requestRows = [
    // completed: counts, at its final cost
    { status: "completed", urgency: "low", category: "Plumbing", finalCost: 180, estimatedCost: 260,
      createdAt: thisMonth, completedAt: thisMonth, selectedVendorId: "v1" },
    // in flight with a vendor quote: committed, NOT spend
    { status: "assigned", urgency: "medium", category: "HVAC", finalCost: 0, estimatedCost: 500,
      createdAt: thisMonth, selectedVendorId: "v2" },
    // queued with a quote: committed, NOT spend
    { status: "queued", urgency: "low", category: "Pest", finalCost: 0, estimatedCost: 300,
      createdAt: thisMonth, selectedVendorId: "v3" },
    // rejected / cancelled: neither
    { status: "rejected", urgency: "low", category: "Other", finalCost: 0, estimatedCost: 900,
      createdAt: thisMonth, selectedVendorId: "v4" },
    { status: "cancelled", urgency: "low", category: "Other", finalCost: 0, estimatedCost: 700,
      createdAt: thisMonth, selectedVendorId: "v5" },
    // queued with no vendor selected: not committed either
    { status: "queued", urgency: "low", category: "Other", finalCost: 0, estimatedCost: 0,
      createdAt: thisMonth },
  ];

  let res = makeRes();
  await ctrl.getStats(req, res);
  assert.strictEqual(res.statusCode, 200);

  assert.strictEqual(res.body.data.totalCost, 180, "spend is the completed job's final cost only");
  assert.strictEqual(res.body.data.committedCost, 800, "in-flight quotes are committed, not spent");
  assert.strictEqual(res.body.data.completedCount, 1);
  assert.strictEqual(res.body.data.requestCount, 6);

  /* ===== 2) finalCost of 0 is a real value, not a fallback trigger ===== */
  // The old `finalCost || estimatedCost` silently billed the estimate whenever
  // a job genuinely cost nothing (warranty, goodwill, no-fault).
  requestRows = [
    { status: "completed", urgency: "low", category: "Plumbing", finalCost: 0, estimatedCost: 400,
      createdAt: thisMonth, completedAt: thisMonth, selectedVendorId: "v1" },
  ];
  res = makeRes();
  await ctrl.getStats(req, res);
  assert.strictEqual(res.body.data.totalCost, 0, "a zero-cost completed job contributes zero");

  /* ===== 3) Spend lands in the month the job finished ===== */
  requestRows = [
    { status: "completed", urgency: "low", category: "Plumbing", finalCost: 250, estimatedCost: 250,
      createdAt: lastMonth, completedAt: thisMonth, selectedVendorId: "v1" },
  ];
  res = makeRes();
  await ctrl.getStats(req, res);

  const months = res.body.data.monthly;
  const current = months[months.length - 1];
  const previous = months[months.length - 2];
  assert.strictEqual(current.cost, 250, "cost is booked to the completion month");
  assert.strictEqual(current.resolved, 1);
  assert.strictEqual(previous.cost, 0, "not the month it was raised");
  assert.strictEqual(previous.requests, 1, "but the request itself still counts when created");

  /* ===== 4) A completed job with no recorded final cost adds nothing ===== */
  requestRows = [
    { status: "completed", urgency: "low", category: "Plumbing", estimatedCost: 320,
      createdAt: thisMonth, completedAt: thisMonth, selectedVendorId: "v1" },
  ];
  res = makeRes();
  await ctrl.getStats(req, res);
  assert.strictEqual(res.body.data.totalCost, 0, "never falls back to the vendor's quote");

  /* ===== 5) Portfolio tiles count the live portfolio, and who lives in it ===== */
  res = makeRes();
  await ctrl.getStats(req, res);
  assert.strictEqual(propertyFilter.archivedAt, null, "retired properties are not counted");
  assert.deepStrictEqual(tenantFilter.status, { $ne: "inactive" }, "moved-out tenants are not counted");
  const data = res.body.data;
  assert.strictEqual(data.unitCount, 3, "units come from live Unit rows, not property.units");
  assert.strictEqual(data.tenantCount, 5);
  assert.strictEqual(data.occupiedUnitCount, 2, "u1 (shared) and u2; the retired unit doesn't count");
  // Tenants join only through a unit-linked invite code, and a move-out sets
  // them inactive, so a current tenant without a unit no longer exists.
  assert.ok(!("unassignedTenantCount" in data), "no unassigned-tenant count");
  assert.strictEqual(data.pendingMoveOutCount, 1);

  /* ===== 6) Twelve months and thirty days, oldest first, ending now ===== */
  assert.strictEqual(data.monthly.length, 12);
  assert.strictEqual(data.daily.length, 30);
  const today = new Date();
  assert.strictEqual(
    data.daily[29].key,
    `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`,
    "the last daily bucket is today"
  );

  console.log("landlordStats spend tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
