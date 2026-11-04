// Editing a property or unit.
//
//   1. only name/address/description are writable -- landlordId, units, geo and
//      archivedAt in the body are ignored.
//   2. a rename that collides with another live property is 409; a case-only
//      rename of itself is allowed.
//   3. another landlord's id is a 404; an archived target is read-only (409).
//   4. a new address clears geo and emails each vendor with a booked job there
//      -- WITHOUT the address in the email.
//   5. a unit renamed onto a sibling's number is 409; renaming itself is fine.
//   6. every change is audited with before -> after.

const assert = require("assert");
const mongoose = require("mongoose");

const Property = require("../../../models/Property");
const Unit = require("../../../models/Unit");
const Vendor = require("../../../models/Vendor");
const Appointment = require("../../../models/Appointment");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const audit = require("../../../services/audit/agentAction.service");
const emailService = require("../../../services/notification/email.service");

const id = () => new mongoose.Types.ObjectId();
const LANDLORD = id();
const OTHER = id();
const PROPERTY = id();
const SIBLING_PROPERTY = id();
const UNIT = id();
const VENDOR = id();

let state;
function reset() {
  state = {
    properties: [
      { _id: PROPERTY, landlordId: LANDLORD, name: "Maple Court", address: "1 Old St", geo: { lat: 1, lng: 2 }, archivedAt: null },
      { _id: SIBLING_PROPERTY, landlordId: LANDLORD, name: "Oak House", address: "2 Elm St", archivedAt: null },
    ],
    units: [
      { _id: UNIT, propertyId: PROPERTY, unitNumber: "101", archivedAt: null },
      { _id: id(), propertyId: PROPERTY, unitNumber: "102", archivedAt: null },
    ],
    updates: [],
    audits: [],
    emails: [],
    bookedRequests: [],
    appointments: [],
  };
}

const chain = (value) => ({ select: () => ({ lean: async () => value }), lean: async () => value });
const same = (a, b) => String(a) === String(b);

Property.findOne = (filter) =>
  chain(
    state.properties.find((p) => same(p._id, filter._id) && same(p.landlordId, filter.landlordId)) || null
  );
Property.find = (filter) =>
  chain(
    state.properties.filter(
      (p) =>
        same(p.landlordId, filter.landlordId) &&
        (filter.archivedAt !== null || !p.archivedAt) &&
        (!filter._id?.$ne || !same(p._id, filter._id.$ne))
    )
  );
Property.updateOne = async (filter, update) => {
  state.updates.push({ model: "Property", filter, update });
  return {};
};
Unit.findById = (unitId) => chain(state.units.find((u) => same(u._id, unitId)) || null);
Unit.find = (filter) =>
  chain(
    state.units.filter(
      (u) => same(u.propertyId, filter.propertyId) && !u.archivedAt && !same(u._id, filter._id?.$ne)
    )
  );
Unit.updateOne = async (filter, update) => {
  state.updates.push({ model: "Unit", filter, update });
  return {};
};
MaintenanceRequest.find = () => chain(state.bookedRequests);
Appointment.find = () => chain(state.appointments);
Vendor.find = () => chain([{ _id: VENDOR, name: "Pat's Plumbing", email: "pat@example.com" }]);
audit.logAgentAction = async (entry) => state.audits.push(entry);
emailService.sendEmail = async (email) => state.emails.push(email);

const edit = require("../../../services/portfolio/portfolioEdit.service");

async function main() {
  /* ---- 1) whitelist ------------------------------------------------------ */
  reset();
  let result = await edit.updateProperty({
    landlordId: LANDLORD,
    id: String(PROPERTY),
    input: { name: "Maple Court East", landlordId: String(OTHER), units: [], geo: { lat: 9 }, archivedAt: new Date() },
  });
  assert.ok(!result.error, JSON.stringify(result.error));
  assert.deepStrictEqual(result.changed, ["name"]);
  const set = state.updates[0].update.$set;
  assert.deepStrictEqual(Object.keys(set), ["name"], "only whitelisted fields are written");
  assert.strictEqual(state.updates[0].update.$unset, undefined, "a rename keeps geo");
  assert.strictEqual(state.audits[0].actionType, "property_updated");
  assert.strictEqual(state.audits[0].input.before.name, "Maple Court");
  assert.strictEqual(state.audits[0].output.after.name, "Maple Court East");

  /* ---- 2) collisions ----------------------------------------------------- */
  reset();
  result = await edit.updateProperty({ landlordId: LANDLORD, id: String(PROPERTY), input: { name: "oak house" } });
  assert.strictEqual(result.error.status, 409);
  assert.ok(result.error.fields.name);
  assert.strictEqual(state.updates.length, 0);

  reset();
  result = await edit.updateProperty({ landlordId: LANDLORD, id: String(PROPERTY), input: { name: "MAPLE COURT" } });
  assert.ok(!result.error, "a case-only rename of itself is allowed");
  assert.strictEqual(state.updates[0].update.$set.name, "MAPLE COURT");

  // An archived sibling's name is free to reuse.
  reset();
  state.properties[1].archivedAt = new Date();
  result = await edit.updateProperty({ landlordId: LANDLORD, id: String(PROPERTY), input: { name: "Oak House" } });
  assert.ok(!result.error);

  // Empty name is a field error, not a write.
  reset();
  result = await edit.updateProperty({ landlordId: LANDLORD, id: String(PROPERTY), input: { name: "   " } });
  assert.strictEqual(result.error.status, 422);
  assert.ok(result.error.fields.name);

  // No real change, no write and no audit.
  reset();
  result = await edit.updateProperty({ landlordId: LANDLORD, id: String(PROPERTY), input: { name: "Maple  Court" } });
  assert.deepStrictEqual(result.changed, []);
  assert.strictEqual(state.updates.length + state.audits.length, 0);

  /* ---- 3) ownership and archived ---------------------------------------- */
  reset();
  result = await edit.updateProperty({ landlordId: OTHER, id: String(PROPERTY), input: { name: "Mine now" } });
  assert.strictEqual(result.error.status, 404);
  result = await edit.updateProperty({ landlordId: LANDLORD, id: "nope", input: { name: "x" } });
  assert.strictEqual(result.error.status, 404);
  state.properties[0].archivedAt = new Date();
  result = await edit.updateProperty({ landlordId: LANDLORD, id: String(PROPERTY), input: { name: "x" } });
  assert.strictEqual(result.error.status, 409);
  assert.strictEqual(result.error.code, "archived");

  /* ---- 4) address change: geo cleared, vendors told, no address in mail -- */
  reset();
  state.bookedRequests = [{ _id: id(), category: "Plumbing" }];
  state.appointments = [{ _id: id(), requestId: state.bookedRequests[0]._id, vendorId: VENDOR }];
  result = await edit.updateProperty({
    landlordId: LANDLORD,
    id: String(PROPERTY),
    input: { address: "99 New Rd" },
    managerLabel: "Oak Property Co",
  });
  assert.ok(!result.error);
  assert.deepStrictEqual(state.updates[0].update.$unset, { geo: 1 }, "a new address clears the old geofence");
  assert.strictEqual(result.property.geo, undefined);
  assert.strictEqual(result.notifiedVendors, 1);
  assert.strictEqual(state.emails.length, 1);
  const mail = state.emails[0];
  assert.strictEqual(mail.to, "pat@example.com");
  for (const part of [mail.subject, mail.text, mail.html]) {
    assert.ok(!part.includes("99 New Rd"), "the new address must never be in a vendor email");
    assert.ok(!part.includes("1 Old St"), "nor the old one");
  }
  assert.match(mail.text, /plumbing job/);

  const impact = await edit.getEditImpact({ landlordId: LANDLORD, id: String(PROPERTY) });
  assert.deepStrictEqual(impact, { bookedJobs: 1 });

  /* ---- 5) unit rename ---------------------------------------------------- */
  reset();
  result = await edit.updateUnit({ landlordId: LANDLORD, id: String(UNIT), input: { unitNumber: "102" } });
  assert.strictEqual(result.error.status, 409, "a sibling's number is taken");
  assert.ok(result.error.fields.unitNumber);
  result = await edit.updateUnit({ landlordId: LANDLORD, id: String(UNIT), input: { unitNumber: "  " } });
  assert.strictEqual(result.error.status, 422);
  result = await edit.updateUnit({ landlordId: OTHER, id: String(UNIT), input: { unitNumber: "1A" } });
  assert.strictEqual(result.error.status, 404);
  result = await edit.updateUnit({ landlordId: LANDLORD, id: String(UNIT), input: { unitNumber: "101" } });
  assert.deepStrictEqual(result.changed, [], "renaming to itself writes nothing");
  result = await edit.updateUnit({ landlordId: LANDLORD, id: String(UNIT), input: { unitNumber: "1A" } });
  assert.ok(!result.error);
  assert.strictEqual(state.updates.at(-1).update.$set.unitNumber, "1A");
  assert.strictEqual(state.audits.at(-1).actionType, "unit_updated");

  state.units[0].archivedAt = new Date();
  result = await edit.updateUnit({ landlordId: LANDLORD, id: String(UNIT), input: { unitNumber: "1B" } });
  assert.strictEqual(result.error.status, 409);

  console.log("portfolioEdit.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
