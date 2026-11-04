// Pure logic and the sweep claim for the counter-offer round.
//
// The disjointness assertions matter most: the offer sweep and the counter-offer
// sweep must never be able to claim the same row, or a bug in one silently
// expires work belonging to the other.

const assert = require("assert");

const {
  COUNTER_OFFER_GRACE_MS,
  MIN_COUNTER_OFFER_MS,
  resolveBookedAmount,
  resolveCounterOfferDeadline,
  expiredCounterOfferFilter,
} = require("../../../services/vendor/vendorCounterOffer.service");

const { expiredOutreachFilter } = require("../../../services/vendor/vendorOutreachSweeper.service");

/* ---- resolveBookedAmount: the ceiling-is-not-a-price rule ---- */

function testResolveBookedAmount() {
  // Only a CONFIRMED counter-offer books at the negotiated number.
  assert.strictEqual(
    resolveBookedAmount({ counterOffer: { status: "confirmed", amount: 250 }, response: { quoteHigh: 320 } }),
    250
  );
  // Everything else books at the vendor's own ceiling.
  assert.strictEqual(
    resolveBookedAmount({ counterOffer: { status: "none" }, response: { quoteHigh: 320 } }),
    320
  );
  assert.strictEqual(
    resolveBookedAmount({ counterOffer: { status: "pending", amount: 250 }, response: { quoteHigh: 320 } }),
    320,
    "a pending offer is not an agreement"
  );
  assert.strictEqual(
    resolveBookedAmount({ counterOffer: { status: "declined", amount: 250 }, response: { quoteHigh: 320 } }),
    320
  );
  assert.strictEqual(resolveBookedAmount({ response: {} }), null);
  assert.strictEqual(resolveBookedAmount({ response: { quoteHigh: 0 } }), 0, "an explicitly free quote is a real price");
  assert.strictEqual(resolveBookedAmount({ response: { quoteHigh: null } }), null, "an unknown price remains unknown");
  assert.strictEqual(resolveBookedAmount(null), null);
  assert.strictEqual(resolveBookedAmount(undefined), null);
}

/* ---- Deadline floor ---- */

function testDeadlineFloor() {
  const from = new Date("2026-03-02T15:00:00Z");

  // An emergency SLA is 15 minutes. That is a fine window for "will you take
  // this job" and a terrible one for "will you take less money".
  const emergency = resolveCounterOfferDeadline({ tier: "emergency", from });
  assert.strictEqual(
    emergency.getTime(),
    from.getTime() + MIN_COUNTER_OFFER_MS,
    "emergency is floored to the negotiation minimum"
  );

  const urgent = resolveCounterOfferDeadline({ tier: "urgent", from });
  assert.ok(
    urgent.getTime() >= from.getTime() + MIN_COUNTER_OFFER_MS,
    "no tier may produce a deadline under the floor"
  );

  // A slower tier keeps its own, longer SLA rather than being clamped down.
  const low = resolveCounterOfferDeadline({ tier: "low", from });
  assert.ok(low.getTime() >= from.getTime() + MIN_COUNTER_OFFER_MS);
}

/* ---- The sweep claim ---- */

function testFilterShape() {
  const now = new Date("2026-03-02T15:00:00Z");
  assert.deepStrictEqual(expiredCounterOfferFilter(now), {
    "counterOffer.status": "pending",
    "counterOffer.deadlineAt": { $lte: new Date(now.getTime() - COUNTER_OFFER_GRACE_MS) },
  });
}

/* ---- Disjointness, asserted in both directions ---- */

function testSweepsAreDisjoint() {
  const now = new Date();
  const offerFilter = expiredOutreachFilter(now);
  const counterFilter = expiredCounterOfferFilter(now);

  // A row mid-offer-round.
  const offerRow = {
    status: "sent",
    responseDeadlineAt: new Date(now.getTime() - 10 * 60 * 1000),
    counterOffer: { status: "none" },
  };
  // A row mid-counter-offer round: `accepted`, which the offer sweep excludes.
  const counterRow = {
    status: "accepted",
    responseDeadlineAt: new Date(now.getTime() - 10 * 60 * 1000),
    counterOffer: {
      status: "pending",
      deadlineAt: new Date(now.getTime() - 10 * 60 * 1000),
    },
  };

  const matchesOffer = (row) =>
    offerFilter.status.$in.includes(row.status) &&
    row.responseDeadlineAt <= offerFilter.responseDeadlineAt.$lte;
  const matchesCounter = (row) =>
    row.counterOffer?.status === counterFilter["counterOffer.status"] &&
    row.counterOffer.deadlineAt <= counterFilter["counterOffer.deadlineAt"].$lte;

  assert.strictEqual(matchesOffer(offerRow), true);
  assert.strictEqual(matchesCounter(offerRow), false, "the offer row must not match the counter sweep");

  assert.strictEqual(matchesCounter(counterRow), true);
  assert.strictEqual(
    matchesOffer(counterRow),
    false,
    "a row awaiting a counter-offer answer sits at `accepted` and must be invisible to the offer sweep, even though its ORIGINAL deadline is long past"
  );
}

testResolveBookedAmount();
testDeadlineFloor();
testFilterShape();
testSweepsAreDisjoint();
console.log("vendorCounterOffer.service tests passed");
