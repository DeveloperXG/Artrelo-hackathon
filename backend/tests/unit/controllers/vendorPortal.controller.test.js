// End-to-end-ish coverage of the public vendor portal handlers with the
// Mongoose models stubbed (same approach as intakePrecheck.service.test.js).
//
// This is where the security-critical behaviour of the magic-link surface is
// pinned down: the privacy gate, the single-use response guard, the
// server-side window allowlist, and the generic 404 for every dead-token case.

const assert = require("assert");
// New review workflow is covered separately; no model/DB/provider work here.
require("../../../services/quotes/review.service").queueRuntimeReview = async () => ({ pending: true });
require("../../../services/quotes/quoteCheckpoint.service").claimQuoteCheckpoint = async () => ({ reused: false });

/* ---------------- Stub the models BEFORE the controller requires them ------ */

const VendorOutreach = require("../../../models/VendorOutreach");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const Landlord = require("../../../models/Landlord");
const Property = require("../../../models/Property");
const Unit = require("../../../models/Unit");
const Tenant = require("../../../models/Tenant");
const AgentActionLog = require("../../../models/AgentActionLog");

const STREET = "8842 Zephyrhill Crescent";
const UNIT_NUMBER = "3071B";
const TENANT_FIRST = "Marisol";
const TENANT_LAST = "Vandergriff";
const TENANT_PHONE = "+1-306-555-8842";

// Concrete window bounds so in-window arrival validation is actually exercised.
const HOUR = 60 * 60 * 1000;
const W1_START = new Date(Date.now() + 24 * HOUR);
const W1_END = new Date(W1_START.getTime() + 4 * HOUR);
const W2_START = new Date(Date.now() + 48 * HOUR);
const W2_END = new Date(W2_START.getTime() + 4 * HOUR);
const W1_ARRIVAL = new Date(W1_START.getTime() + 30 * 60 * 1000);
const W2_ARRIVAL = new Date(W2_START.getTime() + 90 * 60 * 1000);

let outreachRow = null;
let savedPatches = [];

const clone = (value) => JSON.parse(JSON.stringify(value));

function makeOutreach(overrides = {}) {
  return {
    _id: { toString: () => "60a1b2c3d4e5f60718293a4b" },
    requestId: "req-1",
    landlordId: "landlord-1",
    tenantId: "tenant-1",
    candidateKey: "preset__vendor-1",
    vendorNameSnapshot: "Prairie Plumbing Partners",
    toEmail: "excelojeifo3.0@gmail.com",
    attempt: 1,
    status: "sent",
    tier: "normal",
    viewCount: 0,
    submitAttempts: 0,
    firstViewedAt: null,
    respondedAt: null,
    responseDeadlineAt: new Date(Date.now() + 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + 25 * 60 * 60 * 1000),
    messageBody: "Artrelo is coordinating a maintenance request in Regina.",
    offeredWindows: [
      { slotId: "w-window-1", label: "Wed 8:00 a.m. – 12:00 p.m.", kind: "window",
        start: W1_START, end: W1_END },
      { slotId: "w-window-2", label: "Thu 1:00 p.m. – 5:00 p.m.", kind: "window",
        start: W2_START, end: W2_END },
      { slotId: "w-flexible", label: "Flexible — any weekday", kind: "flexible",
        start: null, end: null },
    ],
    response: {},
    ...overrides,
  };
}

VendorOutreach.findOne = async () => outreachRow;
VendorOutreach.findById = async () => outreachRow;
VendorOutreach.updateOne = async (_filter, update) => {
  savedPatches.push(update);
  return { modifiedCount: 1 };
};
VendorOutreach.findOneAndUpdate = async (filter, update) => {
  // Emulate the conditional update that makes the response single-use.
  if (filter.status?.$in && !filter.status.$in.includes(outreachRow.status)) return null;
  if (filter.firstViewedAt === null && outreachRow.firstViewedAt !== null) return null;
  if (filter.responseDeadlineAt?.$gt && outreachRow.responseDeadlineAt <= filter.responseDeadlineAt.$gt) {
    return null;
  }
  Object.assign(outreachRow, update.$set || {});
  Object.entries(update.$inc || {}).forEach(([key, delta]) => {
    outreachRow[key] = (outreachRow[key] || 0) + delta;
  });
  return outreachRow;
};

MaintenanceRequest.findById = () => ({
  lean: async () => ({
    _id: "req-1",
    category: "Plumbing",
    urgency: "medium",
    issueTitle: "Kitchen sink leaking",
    accessPermission: true,
    preferredTime: "Lockbox code 9931 by the side gate",
    propertyId: "prop-1",
    unitId: "unit-1",
    tenantId: "tenant-1",
    ai: { shortTitle: "Kitchen sink leaking under cabinet", summary: "Steady drip" },
    incidentRecord: {
      trade: "Plumbing",
      summary: "Steady drip from the P-trap",
      impact: "Cabinet base swelling",
      safety: { safetyRisk: false, riskType: null },
      location: { room: "Kitchen" },
      timeline: { started: "3 days ago", trend: "Worsening" },
      evidence: { assets: [{ url: "https://cdn.example.com/a.jpg", type: "image" }] },
      access: { permissionToEnter: true, pets: true, preferredTimes: ["Weekday mornings"] },
    },
  }),
});

const selectLean = (doc) => ({ select: () => ({ lean: async () => doc }) });
Landlord.findById = () =>
  selectLean({
    firstName: "Excel",
    lastName: "Ojeifo",
    companyName: "Northline Properties",
    phone: "+1-306-555-0002",
    email: "manager@example.com",
  });
Property.findById = () => selectLean({ name: "Quillfeather Court", address: `${STREET}, Regina, SK` });
Unit.findById = () => selectLean({ unitNumber: UNIT_NUMBER });
Tenant.findById = () =>
  selectLean({ firstName: TENANT_FIRST, lastName: TENANT_LAST, phone: TENANT_PHONE });

AgentActionLog.create = async () => ({});

// Downstream services need a DB; the portal's contract with them is only that
// their failure must not break the vendor's response, so stub them out.
require("../../../services/vendor/vendorAcceptance.service").finalizeVendorAcceptance = async () => ({});
require("../../../services/vendor/vendorOutreachSweeper.service").advanceOutreach = async () => ({});
require("../../../services/vendor/vendorOutreach.service").applyOutreachToSnapshot = async () => null;

const ctrl = require("../../../controllers/vendorPortal.controller");
const { hashToken } = require("../../../services/vendor/vendorOutreach.service");

/* ---------------- Fake req/res ---------------- */

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

const makeReq = (token, body = {}) => ({
  params: { token },
  body,
  ip: "203.0.113.42",
  get: () => "test-agent",
});

const run = async () => {
  /* ===== 1) Unknown token -> generic 404 ===== */
  outreachRow = null;
  let res = makeRes();
  await ctrl.getOutreachBrief(makeReq("nope"), res);
  assert.strictEqual(res.statusCode, 404);
  const unknownBody = clone(res.body);
  assert.strictEqual(unknownBody.code, "invalid_link");

  /* ===== 2) Superseded token -> byte-identical 404 ===== */
  outreachRow = makeOutreach({ status: "superseded" });
  res = makeRes();
  await ctrl.getOutreachBrief(makeReq("whatever"), res);
  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(
    clone(res.body),
    unknownBody,
    "superseded and unknown tokens must be indistinguishable"
  );

  /* ===== 3) Expired token -> 410, distinguishable by design ===== */
  outreachRow = makeOutreach({ status: "expired" });
  res = makeRes();
  await ctrl.getOutreachBrief(makeReq("t"), res);
  assert.strictEqual(res.statusCode, 410);
  assert.strictEqual(res.body.code, "outreach_expired");

  /* ===== 4) Valid token -> brief with NO protected data ===== */
  outreachRow = makeOutreach();
  res = makeRes();
  await ctrl.getOutreachBrief(makeReq("t"), res);
  assert.strictEqual(res.statusCode, 200);

  const serialized = JSON.stringify(res.body);
  [STREET, UNIT_NUMBER, TENANT_FIRST, TENANT_LAST, TENANT_PHONE, "Quillfeather Court",
   "Lockbox code 9931", "manager@example.com", "+1-306-555-0002"].forEach((secret) => {
    assert.ok(!serialized.includes(secret), `GET brief leaked: ${secret}`);
  });
  assert.strictEqual(res.body.data.revealed, undefined, "revealed must be absent before accepting");
  assert.strictEqual(res.body.data.brief.city, "Regina");
  assert.strictEqual(res.body.data.brief.offeredWindows.length, 3);
  assert.strictEqual(outreachRow.viewCount, 1, "first view is counted");
  assert.strictEqual(outreachRow.status, "viewed");

  /* ===== 5) Window allowlist is enforced server-side ===== */
  outreachRow = makeOutreach();
  res = makeRes();
  await ctrl.submitOutreachResponse(
    makeReq("t", {
      outcome: "accepted", selectedSlotId: "w-forged", quoteLow: 10, quoteHigh: 20,
      scheduledArrivalAt: W1_ARRIVAL.toISOString(), durationMinutes: 60,
    }),
    res
  );
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/offered time windows/i.test(res.body.message));

  /* ===== 6) Quote validation ===== */
  const validExtras = {
    scheduledArrivalAt: W1_ARRIVAL.toISOString(),
    durationMinutes: 60,
  };
  const badQuotes = [
    { selectedSlotId: "w-window-1", quoteLow: 300, quoteHigh: 100 }, // inverted
    { selectedSlotId: "w-window-1", quoteLow: -5, quoteHigh: 100 }, // negative
    { selectedSlotId: "w-window-1", quoteLow: "abc", quoteHigh: 100 }, // non-numeric
    { selectedSlotId: "w-window-1", quoteLow: 10, quoteHigh: 9999999 }, // out of range
  ];
  for (const quote of badQuotes) {
    outreachRow = makeOutreach();
    res = makeRes();
    await ctrl.submitOutreachResponse(
      makeReq("t", { outcome: "accepted", ...validExtras, ...quote }),
      res
    );
    assert.strictEqual(res.statusCode, 400, `should reject ${JSON.stringify(quote)}`);
  }

  /* ===== 6b) Arrival time must sit inside the chosen window ===== */
  // A window is what the vendor CAN do; the arrival is the actual commitment,
  // so it has to be inside the slot the tenant was told about.
  const badArrivals = [
    { label: "before the window", scheduledArrivalAt: new Date(W1_START.getTime() - HOUR).toISOString() },
    { label: "after the window", scheduledArrivalAt: new Date(W1_END.getTime() + HOUR).toISOString() },
    { label: "exactly at the end", scheduledArrivalAt: W1_END.toISOString() },
    { label: "belongs to the other window", scheduledArrivalAt: W2_ARRIVAL.toISOString() },
    { label: "missing", scheduledArrivalAt: undefined },
    { label: "not a date", scheduledArrivalAt: "sometime tuesday" },
  ];
  for (const attempt of badArrivals) {
    outreachRow = makeOutreach();
    res = makeRes();
    await ctrl.submitOutreachResponse(
      makeReq("t", {
        outcome: "accepted", selectedSlotId: "w-window-1", quoteLow: 100, quoteHigh: 200,
        durationMinutes: 60, scheduledArrivalAt: attempt.scheduledArrivalAt,
      }),
      res
    );
    assert.strictEqual(res.statusCode, 400, `arrival ${attempt.label} should be rejected`);
  }

  /* ===== 6c) Duration: 15 min to 12 h, in 15-minute steps ===== */
  for (const durationMinutes of [undefined, 0, 10, 50, 735, 999, 90.5, "two hours"]) {
    outreachRow = makeOutreach();
    res = makeRes();
    await ctrl.submitOutreachResponse(
      makeReq("t", {
        outcome: "accepted", selectedSlotId: "w-window-1", quoteLow: 100, quoteHigh: 200,
        scheduledArrivalAt: W1_ARRIVAL.toISOString(), durationMinutes,
      }),
      res
    );
    assert.strictEqual(res.statusCode, 400, `duration ${durationMinutes} should be rejected`);
  }
  // A custom length that the old four presets couldn't express.
  for (const durationMinutes of [15, 105, 720]) {
    outreachRow = makeOutreach();
    res = makeRes();
    await ctrl.submitOutreachResponse(
      makeReq("t", {
        outcome: "accepted", selectedSlotId: "w-window-1", quoteLow: 100, quoteHigh: 200,
        scheduledArrivalAt: W1_ARRIVAL.toISOString(), durationMinutes,
      }),
      res
    );
    assert.notStrictEqual(res.statusCode, 400, `duration ${durationMinutes} should be accepted: ${JSON.stringify(res.body)}`);
  }

  /* ===== 6d) A flexible slot has no bounds, so any sane future time works ==== */
  outreachRow = makeOutreach();
  res = makeRes();
  await ctrl.submitOutreachResponse(
    makeReq("t", {
      outcome: "accepted", selectedSlotId: "w-flexible", quoteLow: 100, quoteHigh: 200,
      scheduledArrivalAt: new Date(Date.now() + 5 * 24 * HOUR).toISOString(), durationMinutes: 120,
    }),
    res
  );
  assert.strictEqual(res.statusCode, 200, "flexible slot accepts a vendor-chosen date");

  // ...but not one in the past.
  outreachRow = makeOutreach();
  res = makeRes();
  await ctrl.submitOutreachResponse(
    makeReq("t", {
      outcome: "accepted", selectedSlotId: "w-flexible", quoteLow: 100, quoteHigh: 200,
      scheduledArrivalAt: new Date(Date.now() - 5 * 24 * HOUR).toISOString(), durationMinutes: 120,
    }),
    res
  );
  assert.strictEqual(res.statusCode, 400, "flexible slot rejects a past date");

  /* ===== 7) Accept reveals the protected details ===== */
  outreachRow = makeOutreach();
  res = makeRes();
  await ctrl.submitOutreachResponse(
    makeReq("t", {
      outcome: "accepted",
      selectedSlotId: "w-window-2",
      quoteLow: 120,
      quoteHigh: 260,
      scheduledArrivalAt: W2_ARRIVAL.toISOString(),
      durationMinutes: 120,
      quoteNotes: "Includes the P-trap replacement.",
    }),
    res
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(outreachRow.status, "accepted");

  const revealed = res.body.data.revealed;
  assert.ok(revealed, "accepting must reveal the details");
  assert.ok(revealed.property.address.includes(STREET));
  assert.strictEqual(revealed.property.unitNumber, UNIT_NUMBER);
  assert.strictEqual(revealed.tenant.displayName, "Marisol V.");
  assert.strictEqual(revealed.manager.email, "manager@example.com");
  // Surname AND phone are never revealed, even post-accept: the vendor reaches
  // the tenant through the masked relay, so the real number never crosses the
  // wire in either projection.
  assert.ok(!JSON.stringify(revealed).includes(TENANT_LAST));
  assert.ok(
    !JSON.stringify(revealed).includes(TENANT_PHONE),
    "the tenant's real number must never reach a vendor"
  );
  assert.strictEqual(revealed.tenant.phone, undefined, "tenant.phone must not exist at all");
  assert.strictEqual(revealed.tenant.contact.available, false);
  // The selected window is the one the server matched, not a client string.
  assert.strictEqual(outreachRow.response.selectedWindow.slotId, "w-window-2");
  assert.strictEqual(outreachRow.response.quoteHigh, 260);
  // The precise arrival commitment is stored, and the call-out fee is gone.
  assert.strictEqual(
    new Date(outreachRow.response.scheduledArrivalAt).toISOString(),
    W2_ARRIVAL.toISOString()
  );
  assert.strictEqual(outreachRow.response.durationMinutes, 120);
  assert.strictEqual(outreachRow.response.calloutFee, undefined, "call-out fee removed");
  // IP/UA are hashed, never stored raw.
  assert.ok(!JSON.stringify(outreachRow.response).includes("203.0.113.42"));
  assert.strictEqual(typeof outreachRow.response.submitterIpHash, "string");

  /* ===== 8) Second submit -> 409 echoing the original decision ===== */
  res = makeRes();
  await ctrl.submitOutreachResponse(
    makeReq("t", { outcome: "declined", declineReason: "changed my mind" }),
    res
  );
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "already_responded");
  assert.strictEqual(res.body.data.decision, "accepted", "echoes the decision that landed");
  assert.strictEqual(outreachRow.response.outcome, "accepted", "original response is unchanged");

  /* ===== 9) Past the deadline -> cannot respond ===== */
  outreachRow = makeOutreach({ responseDeadlineAt: new Date(Date.now() - 10 * 60 * 1000) });
  res = makeRes();
  await ctrl.submitOutreachResponse(
    makeReq("t", {
      outcome: "accepted", selectedSlotId: "w-window-1", quoteLow: 1, quoteHigh: 2,
      scheduledArrivalAt: W1_ARRIVAL.toISOString(), durationMinutes: 60,
    }),
    res
  );
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "outreach_closed");

  /* ===== 10) Decline records a reason and retires the token ===== */
  outreachRow = makeOutreach();
  savedPatches = [];
  res = makeRes();
  await ctrl.submitOutreachResponse(
    makeReq("t", { outcome: "declined", declineReason: "Fully booked this week" }),
    res
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(outreachRow.status, "declined");
  assert.strictEqual(outreachRow.response.declineReason, "Fully booked this week");
  assert.strictEqual(res.body.data.revealed, undefined, "declining reveals nothing");
  assert.ok(
    savedPatches.some((patch) => patch.$unset && patch.$unset.tokenHash),
    "declining must retire the magic link"
  );

  /* ===== 11) Bad outcome value ===== */
  outreachRow = makeOutreach();
  res = makeRes();
  await ctrl.submitOutreachResponse(makeReq("t", { outcome: "maybe" }), res);
  assert.strictEqual(res.statusCode, 400);

  /* ===== 11b) Time ran out while the form was open ===== */
  // The window the vendor picked has since passed: answered with the fresh
  // list, and NOT counted toward the attempt limit that revokes the link.
  const passedStart = new Date(Date.now() - 4 * HOUR);
  const passedEnd = new Date(Date.now() + 10 * 60 * 1000);
  outreachRow = makeOutreach({
    offeredWindows: [
      { slotId: "w-window-passed", label: "This morning", kind: "window", start: passedStart, end: passedEnd },
      ...makeOutreach().offeredWindows,
    ],
  });
  res = makeRes();
  await ctrl.submitOutreachResponse(
    makeReq("t", {
      outcome: "accepted", selectedSlotId: "w-window-passed", quoteLow: 10, quoteHigh: 20,
      scheduledArrivalAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), durationMinutes: 60,
    }),
    res
  );
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "window_expired");
  assert.ok(!res.body.data.offeredWindows.some((w) => w.slotId === "w-window-passed"), "the fresh list leaves it out");
  assert.strictEqual(outreachRow.submitAttempts, 0, "a slow vendor is not walked toward revocation");

  // A still-open window, but an arrival time that has already gone by.
  const openStart = new Date(Date.now() - 2 * HOUR);
  const openEnd = new Date(Date.now() + 2 * HOUR);
  outreachRow = makeOutreach({
    offeredWindows: [{ slotId: "w-window-open", label: "Now", kind: "window", start: openStart, end: openEnd }],
  });
  res = makeRes();
  await ctrl.submitOutreachResponse(
    makeReq("t", {
      outcome: "accepted", selectedSlotId: "w-window-open", quoteLow: 10, quoteHigh: 20,
      scheduledArrivalAt: new Date(Date.now() - HOUR).toISOString(), durationMinutes: 60,
    }),
    res
  );
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, "arrival_past");
  assert.strictEqual(outreachRow.submitAttempts, 0);

  /* ===== 12) Token hashing is what's looked up, never the raw value ===== */
  assert.strictEqual(hashToken("abc").length, 64);
  assert.notStrictEqual(hashToken("abc"), "abc");

  // Itemized applicability is server-owned and independent of bookingVersion.
  const itemizedBody = { outcome: "accepted", selectedSlotId: "w-window-1",
    scheduledArrivalAt: W1_ARRIVAL.toISOString(), durationMinutes: 60, expectedRevision: 0,
    itemization: { pricingMode: "range", currency: "CAD", items: [
      { description: "Repair", category: "labour", lowMinor: 18000, highMinor: 22000 },
    ], totals: { lowMinor: 18000, highMinor: 22000 } } };
  outreachRow = makeOutreach({ quoteContractVersion: 2 }); savedPatches = [];
  res = makeRes();
  await ctrl.submitOutreachResponse(makeReq("t", { ...itemizedBody, quoteHigh: 250, quoteLow: 180 }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.code, "quote_total_mismatch");
  assert.strictEqual(outreachRow.status, "sent", "bad items never claim a response");
  res = makeRes();
  await ctrl.submitOutreachResponse(makeReq("t", itemizedBody), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(outreachRow.response.quoteLow, 180);
  assert.strictEqual(outreachRow.response.quoteHigh, 220);
  assert.strictEqual(outreachRow.quoteRevisions.length, 1);
  assert.strictEqual(outreachRow.quoteReview.state, "pending");
  assert.strictEqual(res.body.data.quote.itemization.items[0].description, "Repair");
  const savedHash = outreachRow.quoteRevisions[0].hash;
  res = makeRes();
  await ctrl.submitOutreachResponse(makeReq("t", itemizedBody), res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(outreachRow.quoteRevisions.length, 1, "duplicate submit cannot append a quote");
  assert.strictEqual(outreachRow.quoteRevisions[0].hash, savedHash);
  outreachRow = makeOutreach({ quoteContractVersion: 2 });
  res = makeRes();
  await ctrl.submitOutreachResponse(makeReq("t", { ...itemizedBody, itemization: undefined }), res);
  assert.strictEqual(res.statusCode, 400, "missing client items cannot downgrade the contract");

  console.log("vendorPortal.controller tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
