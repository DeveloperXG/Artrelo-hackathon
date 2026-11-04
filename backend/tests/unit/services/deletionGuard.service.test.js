// Deleting a property or unit is RESTRICTED: attached tenants and open
// requests block it, and a target with history is archived, never deleted.
//
// What this file pins:
//   1. pending AND active tenants block (co-tenants are listed separately);
//      inactive (moved-out) tenants do not.
//   2. an open request blocks; a finished one only marks history.
//   3. a property check covers every unit under it.
//   4. retire = archive when there is history, delete when there is none, and
//      outstanding invite codes go either way.
//   5. move-out: a notice marks tenants and notifies each one with a type the
//      closed Notification enum accepts; completing it unlinks the tenant and
//      is refused while that tenant has an open request.
//   6. a tenant with no live unit cannot file a request.

const assert = require("assert");
const mongoose = require("mongoose");

const Property = require("../../../models/Property");
const Unit = require("../../../models/Unit");
const Tenant = require("../../../models/Tenant");
const InviteCode = require("../../../models/Code");
const Landlord = require("../../../models/Landlord");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const { Notification } = require("../../../models/Notification");
const notifyService = require("../../../services/notification/notify.service");

const id = () => new mongoose.Types.ObjectId();
const LANDLORD = id();
const OTHER_LANDLORD = id();
const PROPERTY = id();
const UNIT_A = id();
const UNIT_B = id();

let state;
function reset() {
  state = {
    property: { _id: PROPERTY, landlordId: LANDLORD, name: "Maple Court", archivedAt: null },
    units: [
      { _id: UNIT_A, propertyId: PROPERTY, unitNumber: "101", archivedAt: null },
      { _id: UNIT_B, propertyId: PROPERTY, unitNumber: "102", archivedAt: null },
    ],
    tenants: [],
    requests: [],
    writes: [],
    notified: [],
  };
}

const lean = (value) => ({ lean: async () => value });
const chain = (value) => ({ select: () => ({ lean: async () => value }), lean: async () => value });
const inIds = (ids, value) => (ids || []).some((x) => String(x) === String(value));

Property.findOne = (filter) =>
  lean(
    String(filter._id) === String(state.property._id) &&
      String(filter.landlordId) === String(state.property.landlordId)
      ? state.property
      : null
  );
Unit.find = (filter) => chain(state.units.filter((u) => String(u.propertyId) === String(filter.propertyId)));
Unit.findById = (unitId) => lean(state.units.find((u) => String(u._id) === String(unitId)) || null);

function tenantMatches(tenant, filter) {
  if (filter._id?.$in && !inIds(filter._id.$in, tenant._id)) return false;
  if (filter._id && !filter._id.$in && String(filter._id) !== String(tenant._id)) return false;
  if (filter.unit?.$in && !inIds(filter.unit.$in, tenant.unit)) return false;
  if (filter.unit && !filter.unit.$in && String(filter.unit) !== String(tenant.unit)) return false;
  if (filter.status?.$in && !filter.status.$in.includes(tenant.status)) return false;
  if (filter.landlord && String(filter.landlord) !== String(tenant.landlord)) return false;
  if (filter["moveOut.status"]?.$ne && tenant.moveOut?.status === filter["moveOut.status"].$ne) return false;
  return true;
}
Tenant.find = (filter) => chain(state.tenants.filter((t) => tenantMatches(t, filter)));
Tenant.findOne = (filter) => chain(state.tenants.find((t) => tenantMatches(t, filter)) || null);
Tenant.updateMany = async (filter, update) => {
  state.tenants.filter((t) => tenantMatches(t, filter)).forEach((t) => Object.assign(t, update.$set));
  state.writes.push({ op: "Tenant.updateMany", filter, update });
  return {};
};
Tenant.findOneAndUpdate = (filter, update) => {
  const tenant = state.tenants.find((t) => tenantMatches(t, filter));
  if (tenant) Object.assign(tenant, update.$set);
  return lean(tenant || null);
};

function requestMatches(request, filter) {
  if (filter.$or) return filter.$or.some((clause) => requestMatches(request, clause));
  if (filter.propertyId && String(filter.propertyId) !== String(request.propertyId)) return false;
  if (filter.unitId?.$in && !inIds(filter.unitId.$in, request.unitId)) return false;
  if (filter.unitId && !filter.unitId.$in && String(filter.unitId) !== String(request.unitId)) return false;
  if (filter.tenantId && String(filter.tenantId) !== String(request.tenantId)) return false;
  if (filter.status?.$nin && filter.status.$nin.includes(request.status)) return false;
  return true;
}
MaintenanceRequest.countDocuments = async (filter) => {
  const { status, ...rest } = filter;
  return state.requests.filter((r) => requestMatches(r, rest) && requestMatches(r, { status })).length;
};
MaintenanceRequest.exists = async (filter) => (state.requests.some((r) => requestMatches(r, filter)) ? { _id: 1 } : null);

const record = (op) => async (...args) => {
  state.writes.push({ op, args });
  return {};
};
InviteCode.deleteMany = record("InviteCode.deleteMany");
Unit.updateMany = record("Unit.updateMany");
Unit.updateOne = record("Unit.updateOne");
Unit.deleteMany = record("Unit.deleteMany");
Unit.deleteOne = record("Unit.deleteOne");
Property.updateOne = record("Property.updateOne");
Property.deleteOne = record("Property.deleteOne");
Landlord.findByIdAndUpdate = record("Landlord.findByIdAndUpdate");
Landlord.findById = () => chain({ companyName: "Oak Property Co" });

notifyService.notifyUser = async (payload) => {
  state.notified.push(payload);
  return {};
};

const guard = require("../../../services/portfolio/deletionGuard.service");

const tenant = (overrides) => ({
  _id: id(),
  firstName: "Ada",
  lastName: "Lee",
  email: `t${Math.random()}@example.com`,
  landlord: LANDLORD,
  unit: UNIT_A,
  status: "active",
  ...overrides,
});
const ops = (name) => state.writes.filter((w) => w.op === name);

async function main() {
  /* ---- 1) tenants block; inactive ones don't ---------------------------- */
  reset();
  state.tenants = [
    tenant({ status: "active" }),
    tenant({ status: "pending", firstName: "Bo" }), // co-tenant, not yet verified
    tenant({ status: "inactive", unit: UNIT_A }),
  ];
  let check = await guard.checkDeletion({ landlordId: LANDLORD, kind: "unit", id: String(UNIT_A) });
  assert.strictEqual(check.blocked, true);
  assert.strictEqual(check.blockers.tenants.length, 2, "pending and active block; inactive does not");
  assert.strictEqual(check.blockers.tenants[0].unitLabel, "Unit 101");
  assert.strictEqual(guard.serializeCheck(check).action, null, "a blocked check offers no action");

  /* ---- 2) open request blocks; finished one is history only ------------- */
  reset();
  state.requests = [{ unitId: UNIT_A, propertyId: PROPERTY, status: "assigned", tenantId: id() }];
  check = await guard.checkDeletion({ landlordId: LANDLORD, kind: "unit", id: String(UNIT_A) });
  assert.strictEqual(check.blockers.openRequests, 1);
  assert.strictEqual(check.blocked, true);

  state.requests[0].status = "completed";
  check = await guard.checkDeletion({ landlordId: LANDLORD, kind: "unit", id: String(UNIT_A) });
  assert.strictEqual(check.blocked, false);
  assert.strictEqual(check.hasHistory, true);
  assert.strictEqual(guard.serializeCheck(check).action, "archive");

  /* ---- 3) a property covers all of its units ---------------------------- */
  reset();
  state.tenants = [tenant({ unit: UNIT_B })];
  check = await guard.checkDeletion({ landlordId: LANDLORD, kind: "property", id: String(PROPERTY) });
  assert.strictEqual(check.blockers.tenants.length, 1, "a tenant in ANY unit blocks the property");
  assert.strictEqual(check.blockers.tenants[0].unitLabel, "Unit 102");

  // Another landlord's property is indistinguishable from a missing one.
  check = await guard.checkDeletion({ landlordId: OTHER_LANDLORD, kind: "property", id: String(PROPERTY) });
  assert.strictEqual(check, null);
  check = await guard.checkDeletion({ landlordId: LANDLORD, kind: "unit", id: "not-an-id" });
  assert.strictEqual(check, null);

  /* ---- 4) retire: archive with history, delete without ------------------ */
  reset();
  state.requests = [{ unitId: UNIT_A, propertyId: PROPERTY, status: "cancelled" }];
  check = await guard.checkDeletion({ landlordId: LANDLORD, kind: "property", id: String(PROPERTY) });
  let result = await guard.retireTarget(check);
  assert.strictEqual(result.action, "archived");
  assert.strictEqual(ops("InviteCode.deleteMany").length, 1, "invite codes for a retired property are removed");
  assert.strictEqual(ops("Unit.updateMany").length, 1, "archiving a property archives its units");
  assert.strictEqual(ops("Property.updateOne").length, 1);
  assert.strictEqual(ops("Property.deleteOne").length, 0, "history means archive, never delete");
  assert.strictEqual(ops("Unit.deleteMany").length, 0);

  reset();
  check = await guard.checkDeletion({ landlordId: LANDLORD, kind: "unit", id: String(UNIT_B) });
  result = await guard.retireTarget(check);
  assert.strictEqual(result.action, "deleted");
  assert.strictEqual(ops("Unit.deleteOne").length, 1);
  assert.strictEqual(ops("InviteCode.deleteMany").length, 1, "and on a real delete too");
  assert.strictEqual(String(ops("InviteCode.deleteMany")[0].args[0].unitId), String(UNIT_B));

  /* ---- 5) move-out notice and completion -------------------------------- */
  reset();
  const ada = tenant({ status: "active" });
  const bo = tenant({ status: "active", firstName: "Bo" });
  state.tenants = [ada, bo];
  const sent = await guard.sendMoveOutNotices({ landlordId: LANDLORD, kind: "unit", id: String(UNIT_A) });
  assert.strictEqual(sent.notified, 2);
  assert.strictEqual(ada.moveOut.status, "requested");
  assert.strictEqual(ada.moveOut.reason, "unit_retired");
  assert.strictEqual(state.notified.length, 2);
  const enumTypes = Notification.schema.path("type").enumValues;
  state.notified.forEach((n) => {
    assert.ok(enumTypes.includes(n.type), `${n.type} must be in the closed Notification enum`);
    assert.ok(n.email, "the notice is emailed too");
    assert.ok(!/undefined|null/.test(n.message), n.message);
  });

  // Resend keeps the original requestedAt.
  const firstAsked = ada.moveOut.requestedAt;
  await guard.sendMoveOutNotices({ landlordId: LANDLORD, kind: "unit", id: String(UNIT_A) });
  assert.strictEqual(ada.moveOut.requestedAt, firstAsked);
  assert.strictEqual(state.notified.length, 4, "but everyone still attached is re-notified");

  // An open request on the unit refuses the move-out.
  state.requests = [{ unitId: UNIT_A, tenantId: ada._id, status: "in_progress" }];
  let done = await guard.completeMoveOut({ tenantId: String(ada._id), by: "tenant" });
  assert.strictEqual(done.error.status, 409);
  assert.strictEqual(done.error.code, "open_requests");

  state.requests[0].status = "completed";
  done = await guard.completeMoveOut({ tenantId: String(ada._id), by: "tenant" });
  assert.ok(!done.error);
  assert.strictEqual(ada.unit, null);
  assert.strictEqual(ada.status, "inactive");
  assert.strictEqual(ada.moveOut.status, "completed");
  assert.strictEqual(ada.moveOut.completedBy, "tenant");
  assert.strictEqual(String(ada.moveOut.fromUnit), String(UNIT_A), "the old unit stays traceable");

  // A tenant can't self-unlink without being asked; the landlord can.
  const cy = tenant({ status: "active" });
  state.tenants.push(cy);
  done = await guard.completeMoveOut({ tenantId: String(cy._id), by: "tenant" });
  assert.strictEqual(done.error.code, "no_move_out_requested");
  done = await guard.completeMoveOut({ tenantId: String(cy._id), landlordId: OTHER_LANDLORD, by: "landlord" });
  assert.strictEqual(done.error.status, 404, "another landlord's tenant is a 404");
  done = await guard.completeMoveOut({ tenantId: String(cy._id), landlordId: LANDLORD, by: "landlord" });
  assert.ok(!done.error);
  assert.strictEqual(cy.moveOut.completedBy, "landlord");

  // With Ada and Cy out, only Bo still blocks.
  check = await guard.checkDeletion({ landlordId: LANDLORD, kind: "unit", id: String(UNIT_A) });
  assert.strictEqual(check.blockers.tenants.length, 1);

  /* ---- 6) no live unit, no new requests --------------------------------- */
  assert.strictEqual(guard.tenantUnitProblem({ status: "active", unit: { _id: UNIT_A } }), null);
  assert.strictEqual(guard.tenantUnitProblem({ status: "inactive", unit: null }).code, "tenant_no_unit");
  assert.strictEqual(guard.tenantUnitProblem({ status: "active", unit: null }).code, "tenant_no_unit");
  assert.strictEqual(
    guard.tenantUnitProblem({ status: "active", unit: { _id: UNIT_A, archivedAt: new Date() } }).code,
    "tenant_no_unit"
  );

  console.log("deletionGuard.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
