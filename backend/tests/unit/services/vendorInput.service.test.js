// What a landlord can put on a vendor, and the trades the matcher understands.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * email and hours are required for a vendor created or edited through the
//     API; phone is optional but must look like a phone number if given;
//   * system-owned fields (rating, verificationStatus, isDemoVendor, source...)
//     cannot be set by the client -- the allowlist drops them;
//   * an edit resets `categories` to the new specialties, or a vendor moved off
//     a trade keeps matching it through the stale mirror;
//   * every preset chip on the Vendor Network form resolves to a service the
//     matcher understands (except Landscaping, deliberately), so a landlord's
//     own vendor is never silently unroutable.

const assert = require("assert");

const {
  pickVendorInput,
  validateVendorInput,
} = require("../../../services/vendor/vendorInput.service");
const { validateHours, normalizeHours, formatHours, toPolicyWindow } = require("../../../services/vendor/vendorHours");
const { resolveBusinessHours } = require("../../../services/vendor/vendorOutreachPolicy.service");
const {
  normalizeSupportedVendorService,
  normalizeVendorSpecialty,
  extractSupportedVendorServices,
} = require("../../../services/vendor/vendorServices.service");
const { normalizeVendorOption } = require("../../../services/vendor/providerShapes.service");

const valid = {
  name: "Ace Plumbing",
  email: "Jobs@AcePlumbing.test",
  phone: "(306) 555-0142",
  specialties: ["Plumbing"],
  customSpecialties: ["Backflow testing"],
  operatingHours: { preset: "weekdays" },
  emergencyAvailable: true,
};

function main() {
  /* -------------- 1) Hours ------------------------------------------- */

  assert.strictEqual(validateHours(undefined), "Set the vendor's hours of operation.");
  assert.strictEqual(validateHours({ preset: "nights" }), "Choose when this vendor works.");
  assert.strictEqual(validateHours({ preset: "weekdays" }), null);
  assert.strictEqual(validateHours({ preset: "always" }), null);
  assert.match(validateHours({ preset: "custom", weekly: [] }), /at least one day/);
  assert.match(
    validateHours({ preset: "custom", weekly: [{ day: 1, open: "17:00", close: "09:00" }] }),
    /must close after it opens/,
    "an overnight shift is rejected rather than guessed at"
  );
  assert.match(
    validateHours({
      preset: "custom",
      weekly: [
        { day: 1, open: "09:00", close: "17:00" },
        { day: 1, open: "10:00", close: "12:00" },
      ],
    }),
    /listed twice/
  );
  assert.strictEqual(
    validateHours({ preset: "custom", weekly: [{ day: 6, open: "00:00", close: "24:00" }] }),
    null,
    "24:00 is a valid close so a whole day is representable"
  );

  const weekdays = normalizeHours({ preset: "weekdays" });
  assert.strictEqual(weekdays.weekly.length, 5, "a preset is expanded so weekly is always the source of truth");
  assert.strictEqual(formatHours(weekdays), "Mon–Fri 9:00–17:00");
  assert.strictEqual(formatHours(normalizeHours({ preset: "always" })), "24/7");
  assert.strictEqual(
    formatHours(
      normalizeHours({
        preset: "custom",
        weekly: [
          { day: 3, open: "08:00", close: "16:00" },
          { day: 1, open: "08:00", close: "16:00" },
          { day: 2, open: "08:00", close: "16:00" },
          { day: 6, open: "10:00", close: "14:00" },
        ],
      })
    ),
    "Mon–Wed 8:00–16:00 · Sat 10:00–14:00",
    "consecutive identical days fold into a range, in Mon-first order"
  );

  /* -------------- 2) Required fields, with field-level messages ------- */

  let result = validateVendorInput({ name: "Ace" });
  assert.strictEqual(result.value, null);
  assert.ok(result.fields.email, "email is required");
  assert.ok(result.fields.operatingHours, "hours are required");
  assert.strictEqual(result.fields.phone, undefined, "phone is optional");

  result = validateVendorInput({ ...valid, email: "not-an-email" });
  assert.match(result.fields.email, /valid email/);

  result = validateVendorInput({ ...valid, phone: "call me" });
  assert.match(result.fields.phone, /valid phone/);

  result = validateVendorInput({ ...valid, phone: "" });
  assert.deepStrictEqual(result.fields, {}, "a blank phone is fine");
  assert.strictEqual(result.value.phone, undefined);

  result = validateVendorInput({ ...valid, customSpecialties: ["a", "b", "c", "d", "e", "f"] });
  assert.match(result.fields.customSpecialties, /at most 5/);

  /* -------------- 3) Cleaned value ------------------------------------ */

  result = validateVendorInput(valid);
  assert.deepStrictEqual(result.fields, {});
  assert.strictEqual(result.value.email, "jobs@aceplumbing.test", "email is lower-cased");
  assert.deepStrictEqual(result.value.categories, ["Plumbing"], "categories mirror the new specialties");
  assert.strictEqual(result.value.operatingHours.weekly.length, 5);

  /* -------------- 4) The allowlist ------------------------------------ */

  const picked = pickVendorInput({
    ...valid,
    rating: 5,
    reliabilityScore: 100,
    verificationStatus: "trusted",
    isDemoVendor: true,
    source: "mock_external",
    landlordId: "someone-else",
    identityId: "id-1",
  });
  for (const forbidden of ["rating", "reliabilityScore", "verificationStatus", "isDemoVendor", "source", "landlordId", "identityId"]) {
    assert.ok(!(forbidden in picked), `${forbidden} must not be settable by the client`);
  }
  assert.ok(!("phone" in pickVendorInput({ name: "x" })), "absent keys stay absent so an update can merge");

  /* -------------- 5) Every preset chip resolves to a service ---------- */

  // Mirror of SPECIALTY_OPTIONS in
  // frontend/src/app/components/landlord/vendors/vendorSpecialties.ts.
  const PRESETS = [
    "Plumbing", "Electrical", "HVAC", "Appliance Repair", "Carpentry", "Painting",
    "Roofing", "Flooring", "Landscaping", "Pest Control", "Cleaning", "Locksmith",
    "Drywall", "Structural", "General Maintenance",
  ];
  for (const label of PRESETS) {
    const service = normalizeVendorSpecialty(label);
    if (label === "Landscaping") {
      assert.strictEqual(service, null, "landscaping is deliberately manual-only");
    } else {
      assert.ok(service, `preset "${label}" must map to a matcher service`);
    }
  }
  assert.strictEqual(normalizeVendorSpecialty("pest control"), "Pest", "aliases are case-insensitive");
  assert.strictEqual(normalizeVendorSpecialty("Locksmith"), "Locks/Hardware");
  assert.strictEqual(normalizeVendorSpecialty("Cleaning"), "Cleaning");
  assert.strictEqual(
    normalizeSupportedVendorService("Plumber"),
    null,
    "aliases are vendor-side only; triage output still needs an exact service name"
  );

  /* -------------- 6) Custom specialties route, through both passes ---- */

  const once = normalizeVendorOption({ name: "Lock Co", specialties: [], customSpecialties: ["locksmith"] });
  assert.deepStrictEqual(once.services, ["Locks/Hardware"], "a typed trade that resolves is routable");
  const twice = normalizeVendorOption(once);
  assert.deepStrictEqual(
    twice.services,
    ["Locks/Hardware"],
    "scoring re-normalizes the candidate; the custom trade must survive the second pass"
  );
  assert.deepStrictEqual(
    extractSupportedVendorServices(["Backflow testing"]),
    [],
    "an unknown custom trade is displayed but not invented into a service"
  );

  /* -------------- 7) Outreach schedules inside the structured hours ---- */

  // The display string uses en dashes ("Mon–Fri 9:00–17:00", "24/7") that the
  // legacy businessHours parser cannot read. Before resolveBusinessHours
  // preferred operatingHours, every vendor saved through the new form fell
  // back to the default weekday window -- a 24/7 vendor offered no weekend.
  const always = normalizeHours({ preset: "always" });
  assert.deepStrictEqual(
    resolveBusinessHours({ operatingHours: always, businessHours: formatHours(always) }),
    { days: [0, 1, 2, 3, 4, 5, 6], startMinutes: 0, endMinutes: 1440 },
    "a 24/7 vendor is schedulable every day, all day"
  );

  const withShortSaturday = normalizeHours({
    preset: "custom",
    weekly: [
      { day: 1, open: "08:00", close: "16:00" },
      { day: 2, open: "08:00", close: "16:00" },
      { day: 3, open: "08:00", close: "16:00" },
      { day: 6, open: "10:00", close: "14:00" },
    ],
  });
  assert.deepStrictEqual(
    toPolicyWindow(withShortSaturday),
    { days: [1, 2, 3], startMinutes: 480, endMinutes: 960 },
    "the shared window wins, and a short day is left out rather than offered slots it is closed for"
  );

  assert.deepStrictEqual(
    resolveBusinessHours({ businessHours: "Mon-Sat 08:00-18:00" }),
    { days: [1, 2, 3, 4, 5, 6], startMinutes: 480, endMinutes: 1080 },
    "a vendor from before structured hours still has its string parsed"
  );
  assert.strictEqual(toPolicyWindow(undefined), null);

  console.log("vendorInput.service tests passed");
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
