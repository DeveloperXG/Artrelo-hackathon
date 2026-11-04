// The counter-offer round on the public vendor portal.
//
// A separate file from vendorPortal.controller.test.js on purpose: that file's
// findOneAndUpdate stub emulates only the OFFER round's guard (status sent/viewed),
// and blurring the two would make it unclear which CAS is under test.
//
// What matters here: exactly one of {confirm, decline, sweep} may win; the
// client cannot influence the price; `response` is never touched; and the
// manager's authorization never leaks to the vendor.

const assert = require("assert");

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

// Deliberately far above the vendor's quote so a leak is unmistakable in a
// stringified payload.
const AUTHORIZED_CEILING = 987654;
const NEGOTIATED_AMOUNT = 250;

let outreachRow = null;
let savedPatches = [];
let finalizeCalls = [];
let advanceCalls = [];

function makeOutreach(overrides = {}) {
  const { counterOffer, ...rest } = overrides;
  return {
    _id: { toString: () => "60a1b2c3d4e5f60718293a4b" },
    requestId: "req-1",
    landlordId: "landlord-1",
    tenantId: "tenant-1",
    candidateKey: "preset__vendor-1",
    vendorNameSnapshot: "Prairie Plumbing Partners",
    toEmail: "vendor@example.com",
    attempt: 1,
    status: "accepted",
    tier: "normal",
    submitAttempts: 0,
    appointmentId: null,
    respondedAt: new Date(),
    revealedAt: new Date(),
    responseDeadlineAt: new Date(Date.now() - 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + 25 * 60 * 60 * 1000),
    offeredWindows: [],
    // The manager's private authorization. Must never reach the vendor.
    authorizedCeiling: AUTHORIZED_CEILING,
    response: {
      outcome: "accepted",
      quoteLow: 180,
      quoteHigh: 320,
      quoteCurrency: "CAD",
      quoteNotes: "Includes the P-trap replacement.",
    },
    counterOffer: {
      status: "pending",
      amount: NEGOTIATED_AMOUNT,
      currency: "CAD",
      quotedLow: 180,
      quotedHigh: 320,
      deadlineAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      respondedAt: null,
      declineReason: null,
      ...counterOffer,
    },
    ...rest,
  };
}

// Apply a $set that uses dotted paths, the way Mongo would.
function applyDotted(target, update) {
  Object.entries(update).forEach(([path, value]) => {
    const parts = path.split(".");
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      cursor[parts[i]] = cursor[parts[i]] || {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  });
}

function reset(overrides = {}) {
  outreachRow = makeOutreach(overrides);
  savedPatches = [];
  finalizeCalls = [];
  advanceCalls = [];
}

VendorOutreach.findOne = async () => outreachRow;
VendorOutreach.findById = async () => outreachRow;
VendorOutreach.updateOne = async (_filter, update) => {
  savedPatches.push(update);
  if (update.$set) applyDotted(outreachRow, update.$set);
  if (update.$unset) Object.keys(update.$unset).forEach((key) => delete outreachRow[key]);
  return { modifiedCount: 1 };
};
VendorOutreach.findOneAndUpdate = async (filter, update) => {
  // The counter-offer single-use guard.
  if (filter["counterOffer.status"] && outreachRow.counterOffer?.status !== filter["counterOffer.status"]) {
    return null;
  }
  if (
    filter["counterOffer.deadlineAt"]?.$gt &&
    outreachRow.counterOffer.deadlineAt <= filter["counterOffer.deadlineAt"].$gt
  ) {
    return null;
  }
  if (
    Object.prototype.hasOwnProperty.call(filter, "appointmentId") &&
    outreachRow.appointmentId !== filter.appointmentId
  ) {
    return null;
  }
  if (update.$set) applyDotted(outreachRow, update.$set);
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
    propertyId: "prop-1",
    unitId: "unit-1",
    tenantId: "tenant-1",
    ai: { shortTitle: "Kitchen sink leaking", summary: "Steady drip" },
    incidentRecord: { trade: "Plumbing", summary: "Steady drip from the P-trap" },
  }),
});

const selectLean = (doc) => ({ select: () => ({ lean: async () => doc }) });
Landlord.findById = () =>
  selectLean({ firstName: "Excel", lastName: "Ojeifo", companyName: "Northline Properties" });
Property.findById = () => selectLean({ name: "Quillfeather Court", address: `${STREET}, Regina, SK` });
Unit.findById = () => selectLean({ unitNumber: UNIT_NUMBER });
Tenant.findById = () => selectLean({ firstName: TENANT_FIRST, lastName: TENANT_LAST });
AgentActionLog.create = async () => ({});

require("../../../services/vendor/vendorAcceptance.service").finalizeVendorAcceptance = async (args) => {
  finalizeCalls.push(args);
  return {};
};
require("../../../services/vendor/vendorOutreachSweeper.service").advanceOutreach = async (args) => {
  advanceCalls.push(args);
  return {};
};
require("../../../services/vendor/vendorOutreach.service").applyOutreachToSnapshot = async () => null;

const ctrl = require("../../../controllers/vendorPortal.controller");

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

const makeReq = (body = {}) => ({
  params: { token: "raw-token" },
  body,
  ip: "203.0.113.9",
  get: () => "test-agent",
});

const GENERIC_NOT_FOUND = {
  success: false,
  code: "invalid_link",
  message: "This link is not valid. It may have been replaced by a newer one.",
};

/* ------------------------------------------------------------------ */

async function testConfirm() {
  reset();
  const res = makeRes();
  await ctrl.submitCounterOfferResponse(makeReq({ decision: "confirmed" }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(outreachRow.counterOffer.status, "confirmed");
  assert.strictEqual(outreachRow.status, "accepted", "confirming does not close the row");
  assert.strictEqual(finalizeCalls.length, 1, "hands off to the booking gate exactly once");
  // The link stays live so the vendor can reopen and re-read the address.
  assert.ok(
    !savedPatches.some((patch) => patch.$unset?.tokenHash),
    "a confirm must not retire the token"
  );
}

async function testDecline() {
  reset();
  const res = makeRes();
  await ctrl.submitCounterOfferResponse(
    makeReq({ decision: "declined", declineReason: "Parts alone cost more than that." }),
    res
  );

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(outreachRow.counterOffer.status, "declined");
  assert.strictEqual(outreachRow.status, "declined", "declining closes the row");
  assert.strictEqual(
    outreachRow.counterOffer.declineReason,
    "Parts alone cost more than that."
  );
  assert.ok(
    savedPatches.some((patch) => patch.$unset?.tokenHash),
    "declining retires the token immediately"
  );
  assert.strictEqual(advanceCalls.length, 1);
  assert.strictEqual(advanceCalls[0].reason, "counter_offer_declined");
  assert.strictEqual(finalizeCalls.length, 0, "a decline must never reach the booking gate");
}

async function testDoubleSubmit() {
  reset();
  await ctrl.submitCounterOfferResponse(makeReq({ decision: "confirmed" }), makeRes());
  assert.strictEqual(finalizeCalls.length, 1);

  const res = makeRes();
  await ctrl.submitCounterOfferResponse(makeReq({ decision: "declined" }), res);

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "counter_offer_answered");
  assert.ok(res.body.data, "echoes the state that did land");
  assert.strictEqual(finalizeCalls.length, 1, "must not book twice");
  assert.strictEqual(outreachRow.counterOffer.status, "confirmed", "the first answer stands");
}

async function testNoRoundOpen() {
  reset({ counterOffer: { status: "none" } });
  const frozenResponse = JSON.parse(JSON.stringify(outreachRow.response));
  const res = makeRes();

  await ctrl.submitCounterOfferResponse(makeReq({ decision: "confirmed" }), res);

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "counter_offer_closed");
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(outreachRow.response)),
    frozenResponse,
    "response is untouched when no round is open"
  );
}

async function testPastDeadline() {
  reset({ counterOffer: { deadlineAt: new Date(Date.now() - 10 * 60 * 1000) } });
  const res = makeRes();

  await ctrl.submitCounterOfferResponse(makeReq({ decision: "confirmed" }), res);

  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(finalizeCalls.length, 0);
}

async function testUnknownToken() {
  reset();
  outreachRow = null;
  const res = makeRes();

  await ctrl.submitCounterOfferResponse(makeReq({ decision: "confirmed" }), res);

  assert.strictEqual(res.statusCode, 404);
  assert.deepStrictEqual(res.body, GENERIC_NOT_FOUND, "byte-identical generic 404");
}

async function testRetiredStatuses() {
  for (const status of ["superseded", "revoked"]) {
    reset({ status });
    const res = makeRes();
    await ctrl.submitCounterOfferResponse(makeReq({ decision: "confirmed" }), res);
    assert.strictEqual(res.statusCode, 404, `${status} is a dead link`);
    assert.deepStrictEqual(res.body, GENERIC_NOT_FOUND);
  }
}

async function testSubmitAttemptCap() {
  reset({ submitAttempts: 20 });
  const res = makeRes();

  await ctrl.submitCounterOfferResponse(makeReq({ decision: "confirmed" }), res);

  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(outreachRow.status, "revoked", "hammering the link revokes it");
}

/* The security property: the price is server-side, always. */
async function testClientSuppliedAmountIsIgnored() {
  reset();
  const res = makeRes();

  await ctrl.submitCounterOfferResponse(
    makeReq({ decision: "confirmed", amount: 999999, counterOffer: { amount: 999999 } }),
    res
  );

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(
    outreachRow.counterOffer.amount,
    NEGOTIATED_AMOUNT,
    "a client-supplied amount must never change what the job books at"
  );
  assert.strictEqual(res.body.data.counterOffer.amount, NEGOTIATED_AMOUNT);
}

async function testDeclineReasonLength() {
  reset();
  const res = makeRes();

  await ctrl.submitCounterOfferResponse(
    makeReq({ decision: "declined", declineReason: "x".repeat(501) }),
    res
  );

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(outreachRow.counterOffer.status, "pending", "the round stays open");
}

async function testInvalidDecision() {
  reset();
  const res = makeRes();
  await ctrl.submitCounterOfferResponse(makeReq({ decision: "maybe" }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(outreachRow.counterOffer.status, "pending");
}

/* ------------------------------------------------------------------ *
 * The 2k privacy boundary: authorizedCeiling is the manager's reservation
 * price and must never reach the vendor. The counter-offer AMOUNT may.
 * ------------------------------------------------------------------ */
async function testCeilingNeverLeaksToVendor() {
  // No round running: the vendor should learn nothing about the authorization.
  reset({ counterOffer: { status: "none" } });
  const res = makeRes();
  await ctrl.getOutreachBrief(makeReq(), res);

  const serialized = JSON.stringify(res.body);
  assert.ok(
    !serialized.includes(String(AUTHORIZED_CEILING)),
    "the authorized ceiling must not appear anywhere in the vendor payload"
  );
  assert.ok(
    !serialized.includes("authorizedCeiling"),
    "the authorizedCeiling key must not be serialized to the vendor"
  );
  assert.strictEqual(res.body.data.counterOffer, null, "no round, no block");

  // Round running: the amount IS disclosed — that is the ask. The ceiling still
  // is not, so this pins the boundary in both directions rather than only
  // asserting an absence.
  reset();
  const res2 = makeRes();
  await ctrl.getOutreachBrief(makeReq(), res2);

  const serialized2 = JSON.stringify(res2.body);
  assert.strictEqual(res2.body.data.counterOffer.amount, NEGOTIATED_AMOUNT);
  assert.ok(serialized2.includes(String(NEGOTIATED_AMOUNT)), "the amount is the whole ask");
  assert.ok(
    !serialized2.includes(String(AUTHORIZED_CEILING)),
    "the ceiling stays private even while asking"
  );
  assert.ok(!serialized2.includes("authorizedCeiling"));
}

async function main() {
  await testConfirm();
  await testDecline();
  await testDoubleSubmit();
  await testNoRoundOpen();
  await testPastDeadline();
  await testUnknownToken();
  await testRetiredStatuses();
  await testSubmitAttemptCap();
  await testClientSuppliedAmountIsIgnored();
  await testDeclineReasonLength();
  await testInvalidDecision();
  await testCeilingNeverLeaksToVendor();
  console.log("vendorPortal counter-offer tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
