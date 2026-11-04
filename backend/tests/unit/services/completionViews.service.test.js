// The tenant-side privacy boundary, modelled on vendorBrief.service.test.js.
//
// If this file fails, a tenant can read what their landlord is paying a vendor
// out of the network tab. Distinctive magic numbers throughout so a substring
// search cannot produce a false pass.

const assert = require("assert");
const {
  buildTenantCompletionView,
  buildLandlordCompletionView,
} = require("../../../services/completion/completionViews.service");

const ACTUAL_COST = 743.19;
const APPROVED_CEILING = 812.55;
const OVERAGE_AMOUNT = 271.83;
const WORK_PERFORMED = "Replaced the P-trap and resealed the basin waste";
const AUTO_CONFIRM_AT = new Date("2026-08-08T12:00:00.000Z");
// Artrelo's fee on the job: what the LANDLORD pays Artrelo. As private from the
// tenant as the vendor's price.
const SERVICE_FEE_CENTS = 61937;

const completion = {
  status: "awaiting_tenant",
  report: {
    workPerformed: WORK_PERFORMED,
    partsUsed: "1x P-trap, plumber's putty",
    followUpNeeded: false,
    actualCost: ACTUAL_COST,
    currency: "CAD",
    completedAt: new Date("2026-08-06T15:30:00.000Z"),
    submittedAt: new Date("2026-08-06T15:35:00.000Z"),
  },
  photos: [
    { url: "https://cdn.example.com/after.jpg", label: "Under sink", stage: "after" },
    { url: "", label: "dropped", stage: "after" },
  ],
  approvedCeiling: APPROVED_CEILING,
  evidenceVerdict: "review",
  evidenceReasons: ["checkin_geo_outside_radius"],
  overage: { isOver: true, amount: OVERAGE_AMOUNT, decision: "pending" },
  checkIn: { source: "client_reported", lat: 50.4452, lng: -104.6189, distanceMeters: 4120 },
  ledger: {
    payoutStatus: "pending",
    serviceFee: { listCents: SERVICE_FEE_CENTS, chargedCents: SERVICE_FEE_CENTS, waivedReason: null, decidedAt: new Date() },
  },
  autoConfirmAt: AUTO_CONFIRM_AT,
  tenantConfirmation: {},
};

/* ---------------- 1) The tenant view leaks no money ------------------- */

const tenantView = buildTenantCompletionView(completion);
const serialized = JSON.stringify(tenantView);

const FORBIDDEN = [
  String(ACTUAL_COST),
  String(APPROVED_CEILING),
  String(OVERAGE_AMOUNT),
  "actualCost",
  "approvedCeiling",
  "overage",
  "ledger",
  "serviceFee",
  String(SERVICE_FEE_CENTS),
  String(SERVICE_FEE_CENTS / 100),
];

FORBIDDEN.forEach((secret) => {
  assert.ok(
    !serialized.includes(secret),
    `Tenant completion view leaked protected value: ${secret}\nPayload: ${serialized}`
  );
});

// The evidence verdict is withheld too. Not money — but telling a tenant "our
// checks flagged this vendor" would bias the one honest signal we are asking
// them for.
assert.strictEqual(tenantView.evidenceVerdict, undefined);
assert.strictEqual(tenantView.evidenceReasons, undefined);
assert.ok(!serialized.includes("geo_outside_radius"), "evidence reasons must not reach the tenant");

// Nor the raw coordinates of the vendor's phone.
assert.strictEqual(tenantView.checkIn, undefined);
assert.ok(!serialized.includes("50.4452"));

/* ---------------- 2) It still carries what the tenant must decide on --- */

assert.strictEqual(tenantView.workPerformed, WORK_PERFORMED);
assert.strictEqual(tenantView.partsUsed, "1x P-trap, plumber's putty");
assert.strictEqual(tenantView.needsVerification, true);
assert.strictEqual(tenantView.photos.length, 1, "assets with no url are dropped");
assert.strictEqual(tenantView.photos[0].url, "https://cdn.example.com/after.jpg");

// The auto-close deadline MUST be exposed. An auto-close the tenant only
// discovers after the fact is how you lose their trust.
assert.strictEqual(
  new Date(tenantView.autoConfirmAt).toISOString(),
  AUTO_CONFIRM_AT.toISOString(),
  "the tenant has to be able to see when silence becomes acceptance"
);

// Unanswered means no confirmation block at all.
assert.strictEqual(tenantView.confirmation, null);

/* ---------------- 3) needsVerification is exactly awaiting_tenant ------ */

for (const status of ["draft", "in_review", "confirmed", "closed", "disputed", "void"]) {
  assert.strictEqual(
    buildTenantCompletionView({ ...completion, status }).needsVerification,
    false,
    `${status} must not prompt the tenant`
  );
}
assert.strictEqual(
  buildTenantCompletionView({ ...completion, status: "awaiting_tenant" }).needsVerification,
  true
);

/* ---------------- 4) An answered completion reports the outcome -------- */

const answered = buildTenantCompletionView({
  ...completion,
  status: "confirmed",
  tenantConfirmation: {
    outcome: "confirmed",
    rating: 5,
    respondedAt: new Date("2026-08-07T09:00:00.000Z"),
    autoConfirmed: true,
  },
});
assert.strictEqual(answered.confirmation.outcome, "confirmed");
assert.strictEqual(answered.confirmation.rating, 5);
assert.strictEqual(answered.confirmation.autoConfirmed, true);

/* ---------------- 5) The landlord DOES see the money ------------------- */

const landlordView = buildLandlordCompletionView(completion);
assert.strictEqual(landlordView.actualCost, ACTUAL_COST);
assert.strictEqual(landlordView.approvedCeiling, APPROVED_CEILING);
assert.strictEqual(landlordView.overage.amount, OVERAGE_AMOUNT);
assert.strictEqual(landlordView.evidenceVerdict, "review");
assert.deepStrictEqual(landlordView.evidenceReasons, ["checkin_geo_outside_radius"]);
assert.strictEqual(landlordView.checkIn.distanceMeters, 4120);
// And still everything the tenant sees.
assert.strictEqual(landlordView.workPerformed, WORK_PERFORMED);

/* ---------------- 6) Null-safety --------------------------------------- */

assert.strictEqual(buildTenantCompletionView(null), null);
assert.strictEqual(buildLandlordCompletionView(null), null);
assert.deepStrictEqual(buildTenantCompletionView({ status: "draft" }).photos, []);

/* ---------------- The landlord does see the fee --------------------- */

const landlordFee = buildLandlordCompletionView(completion).serviceFee;
assert.deepStrictEqual(landlordFee, { amount: SERVICE_FEE_CENTS / 100, charged: SERVICE_FEE_CENTS / 100, waived: null });
assert.strictEqual(buildLandlordCompletionView({ ...completion, ledger: {} }).serviceFee, null, "no fee -> null, not zeros");

console.log("completionViews.service privacy-boundary tests passed");
