// The booking gate: when a vendor's accepted quote may turn into an Appointment,
// and at what price.
//
// This module had NO unit coverage while it contained a flag (`quotaApproved`)
// that let a manager authorize $200 against a $900 quote and still book at $900.
// The flag is gone; these tests pin the replacement so it cannot come back.
//
// Models are stubbed by assigning over their statics BEFORE requiring the module
// under test, the same idiom as vendorPortal.controller.test.js.

const assert = require("assert");

const VendorOutreach = require("../../../models/VendorOutreach");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const LandlordPolicy = require("../../../models/LandlordPolicy");
const ApprovalRequest = require("../../../models/ApprovalRequest");
const Appointment = require("../../../models/Appointment");
const Vendor = require("../../../models/Vendor");
const Unit = require("../../../models/Unit");
const AgentActionLog = require("../../../models/AgentActionLog");
const Landlord = require("../../../models/Landlord");

const QUOTA_LIMIT = 300;

let outreachRow = null;
let requestRow = null;
let appointmentsCreated = [];
let appointmentsDeleted = [];
let approvalsSaved = [];
let audits = [];
let snapshotPatches = [];
let claimWins = true;

function makeOutreach(overrides = {}) {
  const { response, counterOffer, ...rest } = overrides;
  return {
    _id: { toString: () => "outreach-1" },
    requestId: "req-1",
    landlordId: "landlord-1",
    tenantId: "tenant-1",
    candidateKey: "preset__vendor-1",
    vendorNameSnapshot: "Prairie Plumbing Partners",
    vendorId: "vendor-1",
    toEmail: "vendor@example.com",
    status: "accepted",
    appointmentId: null,
    attempt: 1,
    tier: "normal",
    sentAt: new Date(Date.now() - 30 * 60 * 1000),
    respondedAt: new Date(),
    authorizedCeiling: null,
    response: {
      outcome: "accepted",
      quoteLow: 180,
      quoteHigh: 320,
      quoteCurrency: "CAD",
      scheduledArrivalAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      durationMinutes: 120,
      selectedWindow: { label: "Wed 8:00 a.m. – 12:00 p.m." },
      ...response,
    },
    counterOffer: { status: "none", ...counterOffer },
    save: async function save() {
      return this;
    },
    ...rest,
  };
}

function makeRequest(overrides = {}) {
  return {
    _id: "req-1",
    landlordId: "landlord-1",
    tenantId: "tenant-1",
    unitId: null,
    status: "approved",
    issueTitle: "Kitchen sink leaking",
    urgency: "medium",
    estimatedCost: null,
    quotaOverride: null,
    quotaSnapshot: null,
    timeline: [],
    vendorRecommendationSnapshot: {
      decision: { actionType: "recommend_preset_vendor", quotaLimit: QUOTA_LIMIT },
      candidateLedger: [
        { candidateKey: "preset__vendor-1", name: "Prairie Plumbing Partners", state: "approved_for_contact" },
      ],
    },
    save: async function save() {
      return this;
    },
    ...overrides,
  };
}

function reset() {
  outreachRow = makeOutreach();
  requestRow = makeRequest();
  appointmentsCreated = [];
  appointmentsDeleted = [];
  approvalsSaved = [];
  audits = [];
  snapshotPatches = [];
  claimWins = true;
}

VendorOutreach.findById = async () => outreachRow;
VendorOutreach.findOneAndUpdate = async (filter, update) => {
  // The appointment idempotency claim: only the first caller may own it.
  if (Object.prototype.hasOwnProperty.call(filter, "appointmentId")) {
    if (!claimWins) return null;
    Object.assign(outreachRow, update.$set || {});
    return outreachRow;
  }
  return outreachRow;
};
VendorOutreach.updateOne = async () => ({ modifiedCount: 1 });

MaintenanceRequest.findById = async () => requestRow;
LandlordPolicy.findOne = () => ({ lean: async () => ({ defaultQuota: QUOTA_LIMIT }) });

ApprovalRequest.findOne = async () => null;
ApprovalRequest.prototype.save = async function save() {
  this._id = { toString: () => `approval-${approvalsSaved.length + 1}` };
  approvalsSaved.push(this);
  return this;
};

Appointment.create = async (row) => {
  const created = { ...row, _id: { toString: () => `appt-${appointmentsCreated.length + 1}` } };
  appointmentsCreated.push(created);
  return created;
};
Appointment.deleteOne = async (filter) => {
  appointmentsDeleted.push(filter);
  return { deletedCount: 1 };
};

Vendor.findById = () => ({ select: async () => ({ responseStats: {} }) });
Vendor.updateOne = async () => ({ modifiedCount: 1 });
Unit.findById = () => ({ select: () => ({ lean: async () => null }) });
AgentActionLog.create = async (row) => {
  audits.push(row);
  return row;
};

// Side services: their failure must never change the booking decision.
require("../../../services/vendor/vendorOutreach.service").applyOutreachToSnapshot = async (patch) => {
  snapshotPatches.push(patch);
  return null;
};
require("../../../services/vendor/jobToken.service").mintJobToken = async () => ({
  rawToken: null,
  jobCode: null,
});
// Counted, not just swallowed. Acceptance must send the vendor NOTHING: the
// appointment is `awaiting_tenant`, jobToken.middleware refuses that status, so
// a "you're booked" email here hands them a dead link. The hub intro is the one
// exception and is asserted separately below.
let emailsSent = [];
require("../../../services/notification/email.service").sendEmail = async (message) => {
  emailsSent.push(message);
  return { stub: true };
};
require("../../../services/notification/notify.service").notifyUser = async () => ({});

// How the landlord pays vendors, read once at booking and copied onto the
// appointment. Platform by default here, so the hold tests keep their meaning.
let landlordRow = { paymentMode: "platform" };
Landlord.findById = () => ({ select: () => ({ lean: async () => landlordRow }) });
let holdsCreated = [];
require("../../../services/ledger/ledger.service").createHold = async (args) => {
  holdsCreated.push(args);
  return { entry: { _id: "hold-1" }, guardFailed: false };
};
require("../../../services/ledger/lowBalance.service").warnIfLowBalance = async () => null;

const { finalizeVendorAcceptance } = require("../../../services/vendor/vendorAcceptance.service");

/* ------------------------------------------------------------------ *
 * 1. Under quota, no ceiling: books at the vendor's high quote.
 * ------------------------------------------------------------------ */
async function testUnderQuotaBooks() {
  reset();
  emailsSent = [];
  requestRow.quotaOverride = 500; // quote 320 now sits under the limit

  const result = await finalizeVendorAcceptance({ outreachId: "outreach-1" });

  assert.strictEqual(appointmentsCreated.length, 1, "books exactly one appointment");
  assert.strictEqual(appointmentsCreated[0].status, "awaiting_tenant");
  // Without a deadline an unanswered booking sat at awaiting_tenant forever.
  // The arrival is 24h out, so the deadline is an hour before it rather than
  // the flat 48h that let a tenant confirm a visit already gone.
  const confirmWindowMs = appointmentsCreated[0].tenantConfirmBy - Date.now();
  assert.ok(
    confirmWindowMs > 22.9 * 3600 * 1000 && confirmWindowMs <= 23 * 3600 * 1000,
    "the tenant must confirm an hour before the arrival"
  );
  assert.ok(appointmentsCreated[0].tenantRemindAt < appointmentsCreated[0].tenantConfirmBy, "with a reminder before then");
  // The regression this pins: the job-link email used to go out right here,
  // pointing at a page that 404s until the tenant confirms.
  assert.strictEqual(
    emailsSent.filter((m) => (m.categories || []).includes("vendor_job_link")).length,
    0,
    "no 'you're booked' email at acceptance — that waits for the tenant"
  );
  assert.strictEqual(result.overQuota, false);
  // A ceiling is a ceiling, not a price: a $500 limit does not book at $500.
  assert.strictEqual(requestRow.estimatedCost, 320, "books at the quote, not the limit");
  assert.strictEqual(approvalsSaved.length, 0, "no approval raised under quota");
}

/* ------------------------------------------------------------------ *
 * 2. Over quota, nothing authorized: holds AND patches the ledger.
 * ------------------------------------------------------------------ */
async function testOverQuotaHoldsAndPatchesLedger() {
  reset(); // quote 320 vs limit 300

  const result = await finalizeVendorAcceptance({ outreachId: "outreach-1" });

  assert.strictEqual(appointmentsCreated.length, 0, "must NOT book while over quota");
  assert.strictEqual(result.overQuota, true);
  assert.strictEqual(approvalsSaved.length, 1, "raises exactly one approval");
  assert.strictEqual(approvalsSaved[0].payload.source, "vendor_quote");
  assert.strictEqual(requestRow.routingStatus, "approval_needed");

  // The regression this whole slice started from: without a ledger patch here,
  // the landlord's request page shows a green "Vendor accepted — booking" over a
  // request that is actually parked.
  assert.strictEqual(snapshotPatches.length, 1, "patches the ledger on the hold path");
  assert.strictEqual(
    snapshotPatches[0].patch.quotaCheck.overQuota,
    true,
    "ledger learns the quote is over quota"
  );
}

/* ------------------------------------------------------------------ *
 * 3. A pending counter-offer never books and never re-asks.
 * ------------------------------------------------------------------ */
async function testPendingCounterOfferHolds() {
  reset();
  outreachRow.authorizedCeiling = 250;
  outreachRow.counterOffer = { status: "pending", amount: 250 };

  const result = await finalizeVendorAcceptance({ outreachId: "outreach-1" });

  assert.strictEqual(result.awaitingCounterOffer, true);
  assert.strictEqual(appointmentsCreated.length, 0, "no booking while awaiting the vendor");
  assert.strictEqual(approvalsSaved.length, 0, "manager already ruled — must not re-ask");
}

/* ------------------------------------------------------------------ *
 * 4. A confirmed counter-offer books AT THE NEGOTIATED AMOUNT.
 * ------------------------------------------------------------------ */
async function testConfirmedCounterOfferBooksAtAmount() {
  reset();
  outreachRow.authorizedCeiling = 250;
  outreachRow.counterOffer = { status: "confirmed", amount: 250, quotedLow: 180, quotedHigh: 320 };

  await finalizeVendorAcceptance({ outreachId: "outreach-1" });

  assert.strictEqual(appointmentsCreated.length, 1);
  assert.strictEqual(appointmentsCreated[0].vendorNameSnapshot, outreachRow.vendorNameSnapshot, "historical visits retain the booked vendor name");
  assert.strictEqual(requestRow.estimatedCost, 250, "books at the negotiated 250, not the quoted 320");
  assert.strictEqual(requestRow.quotaOverride, 250, "promotes the authorization only now");
  assert.strictEqual(
    requestRow.vendorRecommendationSnapshot.decision.quotaLimit,
    250,
    "snapshot decision agrees with the override"
  );
}

/* ------------------------------------------------------------------ *
 * 5. A closed counter-offer never books, however often it is retried.
 * ------------------------------------------------------------------ */
async function testClosedCounterOfferNeverBooks() {
  for (const status of ["declined", "expired", "withdrawn"]) {
    reset();
    outreachRow.authorizedCeiling = 250;
    outreachRow.counterOffer = { status, amount: 250 };

    await finalizeVendorAcceptance({ outreachId: "outreach-1" });
    await finalizeVendorAcceptance({ outreachId: "outreach-1" });

    assert.strictEqual(appointmentsCreated.length, 0, `must never book after ${status}`);
  }
}

/* ------------------------------------------------------------------ *
 * 6. The hole this slice closed: an authorization BELOW the quote, with no
 *    confirmation, must not book. This is the case that used to book at $320.
 * ------------------------------------------------------------------ */
async function testCeilingBelowQuoteRefusesToBook() {
  reset();
  outreachRow.authorizedCeiling = 250; // below quoteHigh 320
  outreachRow.counterOffer = { status: "none" };

  const result = await finalizeVendorAcceptance({ outreachId: "outreach-1" });

  assert.strictEqual(appointmentsCreated.length, 0, "must refuse to book above the authorization");
  assert.strictEqual(result.needsCounterOffer, true);
  assert.strictEqual(result.ceiling, 250);
}

/* ------------------------------------------------------------------ *
 * 7. Idempotency: an already-booked outreach is a no-op.
 * ------------------------------------------------------------------ */
async function testAlreadyFinalized() {
  reset();
  outreachRow.appointmentId = "appt-existing";

  const result = await finalizeVendorAcceptance({ outreachId: "outreach-1" });

  assert.strictEqual(result.alreadyFinalized, true);
  assert.strictEqual(appointmentsCreated.length, 0, "no second appointment");
}

/* ------------------------------------------------------------------ *
 * 8. Losing the appointment claim deletes the duplicate it just created.
 * ------------------------------------------------------------------ */
async function testClaimRaceDeletesDuplicate() {
  reset();
  requestRow.quotaOverride = 500;
  claimWins = false; // another caller won

  const result = await finalizeVendorAcceptance({ outreachId: "outreach-1" });

  assert.strictEqual(result.alreadyFinalized, true);
  assert.strictEqual(appointmentsCreated.length, 1, "created one before discovering the loss");
  assert.strictEqual(appointmentsDeleted.length, 1, "and deleted it again");
  assert.deepStrictEqual(appointmentsDeleted[0], { _id: appointmentsCreated[0]._id });
}

/* ------------------------------------------------------------------ *
 * 9. A request that moved on underneath a long counter-offer round.
 * ------------------------------------------------------------------ */
async function testCancelledRequestNeverBooks() {
  for (const status of ["cancelled", "completed", "rejected"]) {
    reset();
    requestRow.quotaOverride = 500;
    requestRow.status = status;

    const result = await finalizeVendorAcceptance({ outreachId: "outreach-1" });

    assert.strictEqual(result.closed, true, `${status} request is closed`);
    assert.strictEqual(appointmentsCreated.length, 0, `must not book onto a ${status} request`);
  }
}

/* ------------------------------------------------------------------ *
 * 10. response is evidence — no path may mutate it.
 * ------------------------------------------------------------------ */
async function testResponseNeverMutated() {
  const scenarios = [
    { label: "under quota", setup: () => { requestRow.quotaOverride = 500; } },
    { label: "over quota hold", setup: () => {} },
    { label: "confirmed counter-offer", setup: () => {
      outreachRow.authorizedCeiling = 250;
      outreachRow.counterOffer = { status: "confirmed", amount: 250 };
    } },
    { label: "refused ceiling", setup: () => { outreachRow.authorizedCeiling = 250; } },
  ];

  for (const scenario of scenarios) {
    reset();
    scenario.setup();
    const frozen = JSON.parse(JSON.stringify(outreachRow.response));

    await finalizeVendorAcceptance({ outreachId: "outreach-1" });

    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(outreachRow.response)),
      frozen,
      `response must survive "${scenario.label}" untouched — it is the quote evidence`
    );
  }
}

/* ------------------------------------------------------------------ *
 * 11. The booking takes the landlord's payment rail with it.
 * ------------------------------------------------------------------ */
async function testPaymentModeIsSnapshotted() {
  // Platform: the appointment says so, and the booked amount is escrowed.
  reset();
  landlordRow = { paymentMode: "platform" };
  holdsCreated = [];
  requestRow.quotaOverride = 500;
  await finalizeVendorAcceptance({ outreachId: "outreach-1" });
  assert.strictEqual(appointmentsCreated[0].paymentMode, "platform");
  assert.strictEqual(holdsCreated.length, 1, "a platform booking escrows the amount");
  assert.strictEqual(holdsCreated[0].amountCents, 32000);

  // Direct: nothing is held, because nothing passes through Artrelo.
  reset();
  landlordRow = { paymentMode: "direct" };
  holdsCreated = [];
  requestRow.quotaOverride = 500;
  await finalizeVendorAcceptance({ outreachId: "outreach-1" });
  assert.strictEqual(appointmentsCreated[0].paymentMode, "direct");
  assert.strictEqual(holdsCreated.length, 0, "a direct booking holds nothing");

  // A landlord who never chose (no field, as a .lean() read returns it) is direct.
  reset();
  landlordRow = {};
  holdsCreated = [];
  requestRow.quotaOverride = 500;
  await finalizeVendorAcceptance({ outreachId: "outreach-1" });
  assert.strictEqual(appointmentsCreated[0].paymentMode, "direct", "direct is the default");
  assert.strictEqual(holdsCreated.length, 0);
  landlordRow = { paymentMode: "platform" };
}

async function main() {
  reset();
  outreachRow.quoteContractVersion = 2;
  outreachRow.currentQuoteRevision = 1;
  outreachRow.quoteRevisions = [{ revision: 1, hash: "current" }];
  let itemized = await finalizeVendorAcceptance({ outreachId: "outreach-1" });
  assert.strictEqual(itemized.awaitingCostReview, true);
  assert.strictEqual(appointmentsCreated.length, 0);
  outreachRow.quoteReview = { state: "cleared", quoteHash: "stale" };
  itemized = await finalizeVendorAcceptance({ outreachId: "outreach-1" });
  assert.strictEqual(itemized.awaitingCostReview, true, "a cleared old revision cannot book a new quote");
  assert.strictEqual(holdsCreated.length, 0);
  await testUnderQuotaBooks();
  await testOverQuotaHoldsAndPatchesLedger();
  await testPendingCounterOfferHolds();
  await testConfirmedCounterOfferBooksAtAmount();
  await testClosedCounterOfferNeverBooks();
  await testCeilingBelowQuoteRefusesToBook();
  await testAlreadyFinalized();
  await testClaimRaceDeletesDuplicate();
  await testCancelledRequestNeverBooks();
  await testResponseNeverMutated();
  await testPaymentModeIsSnapshotted();
  console.log("vendorAcceptance.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
