// The privacy-boundary guard.
//
// The whole point of the pre-accept projection is that address / unit / tenant
// identity are physically absent from the payload, not merely hidden in the UI.
// If this file fails, a vendor who never accepted a job can read a tenant's
// address out of the network tab.

const assert = require("assert");
const {
  buildPublicBrief,
  buildRevealedDetails,
  buildTenantDisplayName,
} = require("../../../services/vendor/vendorBrief.service");

// Distinctive values so a substring search can't produce a false pass.
const STREET = "8842 Zephyrhill Crescent";
const UNIT_NUMBER = "3071B";
const PROPERTY_NAME = "Quillfeather Court";
const TENANT_FIRST = "Marisol";
const TENANT_LAST = "Vandergriff";
const TENANT_PHONE = "+1-306-555-8842";
const ENTRY_NOTES = "Lockbox code 9931 by the side gate";
const MANAGER_PHONE = "+1-306-555-0002";
const MANAGER_EMAIL = "manager@example.com";

const property = { name: PROPERTY_NAME, address: `${STREET}, Regina, SK` };
const unit = { unitNumber: UNIT_NUMBER };
const tenant = { firstName: TENANT_FIRST, lastName: TENANT_LAST, phone: TENANT_PHONE };
const landlord = {
  firstName: "Excel",
  lastName: "Ojeifo",
  companyName: "Northline Properties",
  phone: MANAGER_PHONE,
  email: MANAGER_EMAIL,
};

const request = {
  category: "Plumbing",
  urgency: "medium",
  issueTitle: "Kitchen sink leaking",
  vendorTypeNeeded: "Plumbing",
  accessPermission: true,
  preferredTime: ENTRY_NOTES,
  ai: { shortTitle: "Kitchen sink leaking under cabinet", summary: "Steady drip from the P-trap" },
  incidentRecord: {
    category: "Plumbing",
    trade: "Plumbing",
    summary: "Steady drip from the P-trap",
    impact: "Cabinet base is swelling",
    severity: 3,
    safety: { safetyRisk: false, riskType: null },
    location: { room: "Kitchen", area: "Under sink" },
    timeline: { started: "3 days ago", trend: "Worsening" },
    evidence: { assets: [{ url: "https://cdn.example.com/a.jpg", type: "image", label: "Leak" }] },
    access: { permissionToEnter: true, pets: true, preferredTimes: ["Weekday mornings"] },
  },
};

const outreach = {
  _id: "60a1b2c3d4e5f60718293a4b",
  tier: "normal",
  messageBody: "Artrelo is coordinating a maintenance request in Regina.",
  offeredWindows: [
    { slotId: "w-window-1", label: "Wed, Jul 29, 8:00 a.m. – 12:00 p.m.", kind: "window" },
  ],
  responseDeadlineAt: new Date("2026-07-28T19:00:00.000Z"),
  response: {
    outcome: "accepted",
    quoteLow: 120,
    quoteHigh: 260,
    quoteCurrency: "CAD",
    selectedWindow: { label: "Wed, Jul 29, 8:00 a.m. – 12:00 p.m." },
    scheduledArrivalAt: new Date("2026-07-29T15:30:00.000Z"),
    durationMinutes: 120,
  },
};

/* ---------------- 1) Pre-accept brief leaks nothing ---------------- */

const brief = buildPublicBrief({ request, outreach, landlord, property });
const serialized = JSON.stringify(brief);

// Values a vendor must NEVER receive, at any stage of the job. The tenant's
// phone lives here rather than in the pre-accept list: it used to be revealed on
// acceptance, and it is now masked behind the relay in both projections.
const FORBIDDEN_ALWAYS = [TENANT_LAST, TENANT_PHONE];

const FORBIDDEN_PRE_ACCEPT = [
  ...FORBIDDEN_ALWAYS,
  STREET,
  UNIT_NUMBER,
  PROPERTY_NAME,
  TENANT_FIRST,
  ENTRY_NOTES,
  MANAGER_PHONE,
  MANAGER_EMAIL,
];

FORBIDDEN_PRE_ACCEPT.forEach((secret) => {
  assert.ok(
    !serialized.includes(secret),
    `Public brief leaked protected value: ${secret}\nPayload: ${serialized}`
  );
});

// The tenant's normalised time preference IS shared pre-accept, so the vendor
// can pick the window closest to it -- the free-text entry notes are not
// (ENTRY_NOTES is in the forbidden list above).
assert.deepStrictEqual(brief.preferredTimes, ["Weekday mornings"]);
const sneaky = buildPublicBrief({
  request: {
    ...request,
    incidentRecord: {
      ...request.incidentRecord,
      access: {
        preferredTimes: [
          "Evenings",
          "After 5 when Marisol is home, buzz 4412 and call 306-555-0100 if no answer",
          "",
        ],
      },
    },
  },
  outreach,
  landlord,
  property,
});
assert.deepStrictEqual(sneaky.preferredTimes, ["Evenings"], "a long verbatim sentence is dropped, not shipped");

// The request _id must not be exposed either — the job reference is derived
// from the outreach id so it addresses nothing else in the system.
assert.ok(brief.jobReference.startsWith("JOB-"), "job reference should be opaque");
assert.ok(!serialized.includes("60a1b2c3d4e5f60718293a4b"), "raw outreach id must not appear");

/* ---------------- 2) Pre-accept brief still carries what a vendor needs ---- */

assert.strictEqual(brief.city, "Regina", "city should be present and title-cased");
assert.strictEqual(brief.category, "Plumbing");
assert.strictEqual(brief.shortTitle, "Kitchen sink leaking under cabinet");
assert.strictEqual(brief.summary, "Steady drip from the P-trap");
assert.strictEqual(brief.impact, "Cabinet base is swelling");
assert.strictEqual(brief.urgencyLabel, "Standard");
assert.strictEqual(brief.tierLabel, "Standard");
assert.strictEqual(brief.photoCount, 1);
assert.strictEqual(brief.offeredWindows.length, 1);
assert.strictEqual(brief.manager.name, "Excel Ojeifo");
assert.strictEqual(brief.manager.company, "Northline Properties");
assert.strictEqual(brief.manager.phone, undefined, "manager phone must not be in the public brief");
assert.strictEqual(brief.manager.email, undefined, "manager email must not be in the public brief");

// Generic access constraints only — no household description.
assert.ok(brief.accessConstraints.includes("Pets on site"));
assert.ok(brief.accessConstraints.some((item) => item.includes("Kitchen")));

// Numeric severity is internal and must not be projected.
assert.strictEqual(brief.severity, undefined, "numeric severity must not be exposed");
assert.strictEqual(brief.score, undefined);
assert.strictEqual(brief.reasonCodes, undefined);

/* ---------------- 3) Safety risk IS disclosed pre-accept ------------------ */
// A vendor must know it's a gas job before deciding whether to take it.

const gasBrief = buildPublicBrief({
  request: {
    ...request,
    incidentRecord: {
      ...request.incidentRecord,
      safety: { safetyRisk: true, riskType: "gas" },
    },
  },
  outreach,
  landlord,
  property,
});
assert.strictEqual(gasBrief.riskType, "gas");
assert.strictEqual(gasBrief.safetyRisk, true);

/* ---------------- 4) Post-accept reveals the operational details ---------- */

const revealed = buildRevealedDetails({ request, outreach, landlord, property, unit, tenant });

assert.ok(revealed.property.address.includes(STREET), "address should be revealed after accepting");
assert.strictEqual(revealed.property.unitNumber, UNIT_NUMBER);
assert.strictEqual(revealed.property.name, PROPERTY_NAME);
assert.strictEqual(revealed.manager.phone, MANAGER_PHONE);
assert.strictEqual(revealed.manager.email, MANAGER_EMAIL);
assert.strictEqual(revealed.access.entryNotes, ENTRY_NOTES);
assert.deepStrictEqual(revealed.access.preferredTimes, ["Weekday mornings"]);
assert.strictEqual(revealed.quote.high, 260);
// The precise commitment, not just the window, is what the tenant confirms.
assert.strictEqual(
  new Date(revealed.scheduledArrivalAt).toISOString(),
  "2026-07-29T15:30:00.000Z"
);
assert.strictEqual(revealed.durationMinutes, 120);
assert.strictEqual(revealed.quote.calloutFee, undefined, "call-out fee is gone");

// Even after accepting, the tenant's surname and phone are never sent.
const revealedSerialized = JSON.stringify(revealed);
FORBIDDEN_ALWAYS.forEach((secret) => {
  assert.ok(
    !revealedSerialized.includes(secret),
    `Revealed details leaked an always-protected value: ${secret}\nPayload: ${revealedSerialized}`
  );
});
assert.strictEqual(revealed.tenant.displayName, "Marisol V.");

/* -------- 4b) The tenant's number is masked, not merely omitted ----------- */
// A `phone` key that happens to be null today is one careless edit away from
// being repopulated, so assert the key is absent AND that a relay contact took
// its place.
assert.strictEqual(revealed.tenant.phone, undefined, "tenant.phone must not exist at all");
assert.ok(revealed.tenant.contact, "tenant contact envelope must be present");
assert.strictEqual(revealed.tenant.contact.available, false, "stub relay is not available yet");
assert.strictEqual(revealed.tenant.contact.phone, null, "stub relay carries no number");
assert.strictEqual(
  revealed.tenant.contact.fallback.phone,
  MANAGER_PHONE,
  "the manager is the interim fallback channel"
);

// An explicitly supplied relay contact is used verbatim — this is the seam the
// Twilio proxy number arrives through.
const PROXY_NUMBER = "+1-306-555-7777";
const relayed = buildRevealedDetails({
  request,
  outreach,
  landlord,
  property,
  unit,
  tenant,
  relayContact: {
    channel: "relay",
    provider: "twilio",
    phone: PROXY_NUMBER,
    available: true,
    label: "Text the tenant",
    fallback: { kind: "manager", phone: MANAGER_PHONE },
  },
});
assert.strictEqual(relayed.tenant.contact.phone, PROXY_NUMBER);
assert.ok(
  !JSON.stringify(relayed).includes(TENANT_PHONE),
  "a live relay must still never carry the tenant's real number"
);

/* ---------------- 5) Display-name edge cases ------------------------------ */

assert.strictEqual(buildTenantDisplayName({ firstName: "Sam", lastName: "Okafor" }), "Sam O.");
assert.strictEqual(buildTenantDisplayName({ firstName: "Sam" }), "Sam");
assert.strictEqual(buildTenantDisplayName({}), "The tenant");
assert.strictEqual(buildTenantDisplayName(null), "The tenant");

console.log("vendorBrief.service privacy-boundary tests passed");
