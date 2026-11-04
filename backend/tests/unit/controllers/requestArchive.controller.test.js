// Archive and schedule read paths.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * the working request lists (tenant and landlord) never show an archived
//     request; the tenant's ?archived=1 shows only archived ones;
//   * the landlord archive is landlord-scoped, filterable by property / unit,
//     and pages with an (archivedAt, _id) cursor so a batch archived in one
//     sweep -- identical archivedAt -- is never skipped at a page boundary;
//   * the schedules show live visits only: a finished appointment, OR one whose
//     request is finished (a manual "Mark complete" can leave the appointment
//     non-terminal), is hidden -- but visits awaiting the tenant's review stay;
//   * a query about one request's appointments is history and stays unfiltered.
//
// Services are stubbed BEFORE the controller is required (it destructures them).

const assert = require("assert");

const relay = require("../../../services/comms/relay.service");
relay.getTenantFacingVendorContact = async () => ({ channel: "in_app", phone: null });

const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const Appointment = require("../../../models/Appointment");
const JobCompletion = require("../../../models/JobCompletion");

// A chainable query stub that records the filter and returns `rows`.
function query(rows, sink) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: (n) => {
      sink.limit = n;
      return chain;
    },
    populate: (arg) => {
      (sink.populates = sink.populates || []).push(arg);
      return chain;
    },
    lean: async () => rows,
  };
  return chain;
}

let requestFind = { filter: null, rows: [] };
let apptFind = { filter: null, rows: [] };
MaintenanceRequest.find = (filter) => {
  requestFind.filter = filter;
  return query(requestFind.rows, requestFind);
};
Appointment.find = (filter) => {
  apptFind.filter = filter;
  return query(apptFind.rows, apptFind);
};
JobCompletion.find = () => ({ lean: async () => [] });

const ctrl = require("../../../controllers/request.controller");

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

const LANDLORD = "6650a0a0a0a0a0a0a0a0a0a0";
const TENANT = "6650e0e0e0e0e0e0e0e0e0e0";
const PROP = "6650a1a1a1a1a1a1a1a1a1a1";

async function main() {
  /* -------------- 1) Working lists exclude archived -------------------- */

  let res = makeRes();
  await ctrl.getAllRequests({ user: { id: TENANT, role: "tenant" }, query: {} }, res);
  assert.strictEqual(requestFind.filter.archivedAt, null, "tenant working list hides archived");

  res = makeRes();
  await ctrl.getAllRequests({ user: { id: TENANT, role: "tenant" }, query: { archived: "1" } }, res);
  assert.deepStrictEqual(requestFind.filter.archivedAt, { $ne: null }, "?archived=1 is the history");
  assert.strictEqual(String(requestFind.filter.tenantId), TENANT);

  res = makeRes();
  await ctrl.landlordGetRequests({ user: { id: LANDLORD }, query: {} }, res);
  assert.strictEqual(requestFind.filter.archivedAt, null, "landlord working list hides archived");

  /* -------------- 2) The landlord archive ------------------------------ */

  res = makeRes();
  await ctrl.getLandlordArchive({ user: { id: LANDLORD }, query: { propertyId: PROP } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(String(requestFind.filter.landlordId), LANDLORD, "scoped to the landlord");
  assert.deepStrictEqual(requestFind.filter.archivedAt, { $ne: null });
  assert.strictEqual(requestFind.filter.propertyId, PROP);

  res = makeRes();
  await ctrl.getLandlordArchive({ user: { id: LANDLORD }, query: { unitId: "none" } }, res);
  assert.strictEqual(requestFind.filter.unitId, null, "'none' is the bucket for unit-less requests");

  res = makeRes();
  await ctrl.getLandlordArchive({ user: { id: LANDLORD }, query: { propertyId: "garbage" } }, res);
  assert.strictEqual(res.statusCode, 400, "a malformed id is a 400, not a cast 500");

  // A full page: 51 rows sharing one archivedAt (one sweep) -> a compound cursor.
  const at = new Date("2026-10-08T12:00:00.000Z");
  requestFind.rows = Array.from({ length: 51 }, (_, i) => ({
    _id: `6650f0f0f0f0f0f0f0f0f0${String(99 - i).padStart(2, "0")}`,
    archivedAt: at,
  }));
  res = makeRes();
  await ctrl.getLandlordArchive({ user: { id: LANDLORD }, query: {} }, res);
  assert.strictEqual(res.body.data.length, 50);
  assert.strictEqual(requestFind.limit, 51, "one extra row tells whether there is a next page");
  const cursor = res.body.nextCursor;
  assert.strictEqual(cursor, `${at.toISOString()}_${requestFind.rows[49]._id}`);

  res = makeRes();
  await ctrl.getLandlordArchive({ user: { id: LANDLORD }, query: { before: cursor } }, res);
  assert.deepStrictEqual(
    requestFind.filter.$or,
    [{ archivedAt: { $lt: at } }, { archivedAt: at, _id: { $lt: requestFind.rows[49]._id } }],
    "rows sharing the boundary timestamp are still reachable on the next page"
  );
  requestFind.rows = [];

  res = makeRes();
  await ctrl.getLandlordArchive({ user: { id: LANDLORD }, query: { before: "yesterday" } }, res);
  assert.strictEqual(res.statusCode, 400);

  /* -------------- 3) Schedules show live visits only ------------------- */

  apptFind.rows = [
    { _id: "a1", status: "scheduled", requestId: { status: "assigned" } },
    { _id: "a2", status: "scheduled", requestId: { status: "completed" } }, // manual "Mark complete"
    { _id: "a3", status: "work_verifying", requestId: { status: "in_progress" } }, // tenant must review
    { _id: "a4", status: "awaiting_tenant", requestId: { status: "cancelled" } },
  ];

  res = makeRes();
  apptFind.populates = [];
  await ctrl.listAppointments({ user: { id: LANDLORD }, query: {} }, res);
  assert.deepStrictEqual(apptFind.filter.status, { $nin: ["completed", "cancelled", "failed"] });
  assert.deepStrictEqual(res.body.data.map((row) => row._id), ["a1", "a3"]);

  // The landlord calendar labels each visit with its property and unit, which
  // only the request knows — so the request is populated through to both.
  const requestPopulate = apptFind.populates.find((p) => p && p.path === "requestId");
  assert.ok(requestPopulate, "requestId is populated");
  assert.match(requestPopulate.select, /\bstatus\b/, "status stays selected: the live-row filter reads it");
  assert.deepStrictEqual(
    requestPopulate.populate.map((p) => p.path).sort(),
    ["propertyId", "unitId"],
    "property and unit come through the request"
  );

  res = makeRes();
  await ctrl.listAppointments({ user: { id: LANDLORD }, query: { requestId: "r1" } }, res);
  assert.strictEqual(apptFind.filter.status, undefined, "one request's history is not filtered");
  assert.strictEqual(res.body.data.length, 4);

  res = makeRes();
  await ctrl.listTenantAppointments({ user: { id: TENANT, role: "tenant" }, query: {} }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(apptFind.filter.status, { $nin: ["completed", "cancelled", "failed"] });
  assert.deepStrictEqual(
    res.body.data.map((row) => row._id),
    ["a1", "a3"],
    "the tenant keeps the visit awaiting their review"
  );

  console.log("requestArchive.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
