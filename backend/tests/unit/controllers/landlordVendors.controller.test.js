// Creating and editing vendors in a landlord's network.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * a landlord can only edit their own vendors (404 otherwise, not 403, so
//     another landlord's vendor ids are not confirmed to exist);
//   * a missing email or hours is a 400 with per-field messages the form can
//     place under each field;
//   * an edit is validated as the vendor WILL be, so renaming a vendor created
//     before email/hours were required still demands both;
//   * the client cannot set system-owned fields on create;
//   * changing the contact clears the stale identity pointer; an unrelated
//     edit leaves it alone.

const assert = require("assert");

const Vendor = require("../../../models/Vendor");

let created = [];
let stored = null;

Vendor.create = async (doc) => {
  created.push(doc);
  return { _id: "v-new", ...doc };
};
Vendor.findOne = async (filter) => {
  if (!stored) return null;
  if (String(filter._id) !== String(stored._id) || String(filter.landlordId) !== String(stored.landlordId)) {
    return null;
  }
  return stored;
};

function makeStored(fields) {
  const doc = new Vendor({ _id: "6650f0f0f0f0f0f0f0f0f0f0", landlordId: "6650a0a0a0a0a0a0a0a0a0a0", ...fields });
  doc.save = async function save() {
    await this.validate();
    this.saved = true;
    return this;
  };
  return doc;
}

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

const LANDLORD = "6650a0a0a0a0a0a0a0a0a0a0";
const VENDOR = "6650f0f0f0f0f0f0f0f0f0f0";

async function main() {
  /* -------------- 1) Create: required fields, per-field errors -------- */

  let res = makeRes();
  await ctrl.createVendor({ user: { id: LANDLORD }, body: { name: "Ace" } }, res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(res.body.fields.email && res.body.fields.operatingHours, "both missing fields are named");
  assert.strictEqual(created.length, 0);

  /* -------------- 2) Create: system-owned fields are ignored ---------- */

  res = makeRes();
  await ctrl.createVendor(
    {
      user: { id: LANDLORD },
      body: {
        name: "Ace",
        email: "ace@example.test",
        operatingHours: { preset: "always" },
        rating: 5,
        verificationStatus: "trusted",
        isDemoVendor: true,
        source: "mock_external",
        landlordId: "someone-else",
      },
    },
    res
  );
  assert.strictEqual(res.statusCode, 201);
  const doc = created[0];
  assert.strictEqual(doc.landlordId, LANDLORD, "landlordId comes from the session, never the body");
  assert.strictEqual(doc.source, "preset");
  for (const forbidden of ["rating", "isDemoVendor"]) {
    assert.ok(!(forbidden in doc), `${forbidden} must not reach the document`);
  }
  assert.strictEqual(
    doc.verificationStatus,
    "unverified",
    "a raw verificationStatus is ignored; only the `trusted` toggle sets trust"
  );

  /* -------------- 3) Update: another landlord's vendor is a 404 ------- */

  stored = makeStored({ name: "Old", email: "old@example.test", operatingHours: { preset: "weekdays", weekly: [] } });
  res = makeRes();
  await ctrl.updateVendor({ user: { id: "6650b0b0b0b0b0b0b0b0b0b0" }, params: { id: VENDOR }, body: { name: "Mine now" } }, res);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(stored.name, "Old");

  /* -------------- 4) Update: a pre-rule vendor must gain email + hours  */

  stored = makeStored({ name: "Legacy Plumbing", specialties: ["Plumbing"] });
  res = makeRes();
  await ctrl.updateVendor({ user: { id: LANDLORD }, params: { id: VENDOR }, body: { name: "Legacy Plumbing Co" } }, res);
  assert.strictEqual(res.statusCode, 400, "renaming alone is not enough when email and hours were never set");
  assert.ok(res.body.fields.email && res.body.fields.operatingHours);

  res = makeRes();
  await ctrl.updateVendor(
    {
      user: { id: LANDLORD },
      params: { id: VENDOR },
      body: { name: "Legacy Plumbing Co", email: "legacy@example.test", operatingHours: { preset: "weekdays" } },
    },
    res
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(stored.saved, true);
  assert.strictEqual(stored.businessHours, "Mon–Fri 9:00–17:00", "the display string is derived from the hours");
  assert.deepStrictEqual([...stored.specialties], ["Plumbing"], "fields not sent keep their stored value");

  /* -------------- 5) Update: specialties replace the categories mirror  */

  stored = makeStored({
    name: "Switcher",
    email: "s@example.test",
    specialties: ["Plumbing"],
    categories: ["Plumbing"],
    operatingHours: { preset: "always", weekly: [{ day: 0, open: "00:00", close: "24:00" }] },
  });
  res = makeRes();
  await ctrl.updateVendor(
    { user: { id: LANDLORD }, params: { id: VENDOR }, body: { specialties: ["Electrical"], operatingHours: { preset: "always" } } },
    res
  );
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual([...stored.categories], ["Electrical"], "the old trade must not linger in categories");

  /* -------------- 6) Identity pointer: cleared only on a contact change */

  const identity = "6650c0c0c0c0c0c0c0c0c0c0";
  stored = makeStored({
    name: "Ident",
    email: "a@example.test",
    phone: "3065550100",
    identityId: identity,
    operatingHours: { preset: "always", weekly: [{ day: 0, open: "00:00", close: "24:00" }] },
  });
  res = makeRes();
  await ctrl.updateVendor(
    { user: { id: LANDLORD }, params: { id: VENDOR }, body: { company: "Ident Ltd", operatingHours: { preset: "always" } } },
    res
  );
  assert.strictEqual(String(stored.identityId), identity, "an edit that leaves contact alone keeps the pointer");

  res = makeRes();
  await ctrl.updateVendor(
    { user: { id: LANDLORD }, params: { id: VENDOR }, body: { email: "b@example.test", operatingHours: { preset: "always" } } },
    res
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(stored.identityId, null, "a new email no longer names the old contractor");

  /* -------------- 7) Trust is the landlord's call, within limits ------ */

  res = makeRes();
  created = [];
  await ctrl.createVendor(
    { user: { id: LANDLORD }, body: { name: "T", email: "t@example.test", operatingHours: { preset: "always" }, trusted: true } },
    res
  );
  assert.strictEqual(created[0].verificationStatus, "trusted", "a landlord can trust their own vendor");
  assert.ok(!("trusted" in created[0]), "trusted is mapped, not stored as a field");

  res = makeRes();
  created = [];
  await ctrl.createVendor(
    { user: { id: LANDLORD }, body: { name: "U", email: "u@example.test", operatingHours: { preset: "always" } } },
    res
  );
  assert.strictEqual(created[0].verificationStatus, "unverified", "untrusted by default");

  stored = makeStored({
    name: "Blocked",
    email: "x@example.test",
    verificationStatus: "blocked",
    operatingHours: { preset: "always", weekly: [{ day: 0, open: "00:00", close: "24:00" }] },
  });
  res = makeRes();
  await ctrl.updateVendor(
    { user: { id: LANDLORD }, params: { id: VENDOR }, body: { trusted: true, operatingHours: { preset: "always" } } },
    res
  );
  assert.strictEqual(stored.verificationStatus, "blocked", "the form cannot unblock a vendor the system blocked");

  console.log("landlordVendors.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
