// The authorized ceiling is landlord-private.
//
// approvedCeiling used to be a copy of the vendor's OWN quoteHigh, so echoing it
// back to them was harmless. Since counter-offers it can hold the amount the
// manager authorized — their reservation price. A vendor who learns the manager
// would have paid more anchors every future quote upward.
//
// Three separate omissions keep it private (the counter-offer email is not sent
// on the book-at-quote path; buildResponsePayload carries only counterOffer;
// buildVendorCompletionView drops approvedCeiling). This file pins the third;
// vendorPortal.counterOffer.test.js pins the second.

const assert = require("assert");

const {
  buildVendorCompletionView,
} = require("../../../controllers/vendorCompletion.controller");
const {
  buildTenantCompletionView,
  buildLandlordCompletionView,
  LANDLORD_ONLY_KEYS,
} = require("../../../services/completion/completionViews.service");

// Distinctive so a leak is unmistakable in a stringified payload.
const APPROVED_CEILING = 987654;
const ACTUAL_COST = 240;

// The delta over the ceiling. Distinct from both other numbers so a leak is
// traceable to the right field.
const OVERAGE_DELTA = 4321;

// Fixed, never `new Date()`. The leak checks search the serialized payload for
// the figures above as substrings, and a live timestamp serializes its
// milliseconds: any run where "now" ended in .240 contained "240" and failed
// the tenant cost check with nothing leaked. This instant's longest digit runs
// ("2026", "000") can't contain any of the figures.
const AT = new Date("2026-01-15T10:30:00.000Z");

const completion = {
  status: "awaiting_tenant",
  approvedCeiling: APPROVED_CEILING,
  photos: [{ url: "https://cdn.example.com/after.jpg", stage: "after" }],
  checkIn: { at: AT },
  autoConfirmAt: AT,
  evidenceVerdict: "pass",
  evidenceReasons: ["photos_present"],
  overage: { isOver: false, amount: 0 },
  report: {
    workPerformed: "Replaced the P-trap.",
    partsUsed: "P-trap, plumber's tape",
    actualCost: ACTUAL_COST,
    currency: "CAD",
    submittedAt: AT,
  },
};

/* ---- The vendor's own view ---- */

const vendorView = buildVendorCompletionView(completion);
const vendorSerialized = JSON.stringify(vendorView);

assert.ok(
  !vendorSerialized.includes(String(APPROVED_CEILING)),
  "the approved ceiling must not appear anywhere in the vendor's completion view"
);
assert.ok(
  !vendorSerialized.includes("approvedCeiling"),
  "the approvedCeiling key must not be serialized to the vendor"
);
// They may see what they themselves submitted.
assert.strictEqual(vendorView.report.actualCost, ACTUAL_COST, "the vendor sees their own figure");
// And nothing about how the evidence check judged them.
assert.ok(!vendorSerialized.includes("evidenceVerdict"), "the evidence verdict stays internal");

/* ---- The tenant's view ---- */

const tenantSerialized = JSON.stringify(buildTenantCompletionView(completion));
assert.ok(
  !tenantSerialized.includes(String(APPROVED_CEILING)),
  "the tenant must not see the ceiling either"
);
assert.ok(
  !tenantSerialized.includes(String(ACTUAL_COST)),
  "the tenant must not see any cost — they are not the one paying"
);

/* ---- The landlord's view: they ARE the one paying ---- */

const landlordView = buildLandlordCompletionView(completion);
assert.strictEqual(
  landlordView.approvedCeiling,
  APPROVED_CEILING,
  "the manager sees what they authorized"
);
assert.strictEqual(landlordView.actualCost, ACTUAL_COST);

/* ---- The declared boundary and the vendor projection must not drift apart ---- */

assert.ok(
  LANDLORD_ONLY_KEYS.includes("approvedCeiling"),
  "approvedCeiling must stay declared landlord-only"
);
for (const key of LANDLORD_ONLY_KEYS) {
  assert.ok(
    !Object.prototype.hasOwnProperty.call(vendorView, key),
    `${key} is declared landlord-only but reached the vendor view`
  );
}

/* ---- The empty case must not leak either ---- */

const emptySerialized = JSON.stringify(buildVendorCompletionView(null));
assert.ok(!emptySerialized.includes("approvedCeiling"));
// Same shape as the populated view, so the UI cannot read undefined.
assert.ok(
  Object.prototype.hasOwnProperty.call(buildVendorCompletionView(null), "costReview"),
  "the empty view must carry the same keys as the populated one"
);

/* ------------------------------------------------------------------ *
 * costReview: the vendor learns THAT the close is held, never by how much.
 *
 * overage.amount is the delta over the ceiling. A vendor knows their own
 * actualCost, so actualCost - delta recovers approvedCeiling exactly — which
 * makes this field a second, less obvious route to the same leak.
 * ------------------------------------------------------------------ */

const heldCompletion = {
  ...completion,
  overage: {
    isOver: true,
    amount: OVERAGE_DELTA,
    decision: "pending",
    approvalRequestId: "approval-1",
  },
};

const heldView = buildVendorCompletionView(heldCompletion);
const heldSerialized = JSON.stringify(heldView);

assert.deepStrictEqual(
  heldView.costReview,
  { status: "pending" },
  "the vendor gets a status and nothing else"
);
assert.ok(
  !heldSerialized.includes(String(OVERAGE_DELTA)),
  "the overage delta must not reach the vendor — it reveals the ceiling by subtraction"
);
assert.ok(
  !heldSerialized.includes(String(APPROVED_CEILING)),
  "and neither must the ceiling itself"
);
assert.ok(!heldSerialized.includes("approvalRequestId"), "internal ids stay internal");

// Both resolutions are surfaced. Neither may carry the ceiling or the delta.
for (const decision of ["approved", "rejected"]) {
  const view = buildVendorCompletionView({
    ...completion,
    overage: { isOver: true, amount: OVERAGE_DELTA, decision },
  });
  assert.strictEqual(view.costReview.status, decision);
  assert.ok(!JSON.stringify(view).includes(String(OVERAGE_DELTA)));
  assert.ok(!JSON.stringify(view).includes(String(APPROVED_CEILING)));
}

/* ------------------------------------------------------------------ *
 * The ONE figure a vendor may see: what they are being paid.
 *
 * A manager can authorize LESS than was invoiced, and that authorized amount
 * is this vendor's own payout — it lands in their bank and is already on their
 * hub history, so withholding it here protected nothing and left them reading
 * "Cost approved" beside a number they were not going to receive.
 *
 * It is NOT the ceiling. The rule this file exists to defend is that a vendor
 * must never learn the manager's reservation price, and an authorized payout
 * is a different fact that only exists after the work and the quote are both
 * settled — there is nothing left to price against.
 * ------------------------------------------------------------------ */
const AUTHORIZED = 265;
const authorizedView = buildVendorCompletionView({
  ...completion,
  overage: { isOver: true, amount: OVERAGE_DELTA, decision: "approved", approvedAmount: AUTHORIZED },
});
assert.strictEqual(authorizedView.costReview.approvedAmount, AUTHORIZED, "the vendor sees their payout");
const authorizedSerialized = JSON.stringify(authorizedView);
assert.ok(
  !authorizedSerialized.includes(String(APPROVED_CEILING)),
  "and still never the ceiling"
);
assert.ok(
  !authorizedSerialized.includes(String(OVERAGE_DELTA)),
  "and still never the delta"
);

// Pending carries no figure at all — the key is absent, not null.
const pendingView = buildVendorCompletionView({
  ...completion,
  overage: { isOver: true, amount: OVERAGE_DELTA, decision: "pending", approvedAmount: AUTHORIZED },
});
assert.ok(
  !("approvedAmount" in pendingView.costReview),
  "nothing is disclosed before a decision exists"
);

// Not over: no card at all, rather than a card saying "fine".
assert.strictEqual(
  buildVendorCompletionView(completion).costReview,
  null,
  "a within-budget job shows no cost-review state"
);

console.log("ceiling privacy tests passed");
