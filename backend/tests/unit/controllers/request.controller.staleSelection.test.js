// A request whose vendors are all gone must still be able to move.
//
// The stuck request this pins: every vendor declined, routing paused, and the
// panel said "assign manually, or generate a new search". Both were refused.
// Generate answered "Vendor recommendations cannot be refreshed while a
// selected vendor candidate exists" because selectedVendorId still named a
// vendor whose booking was long gone, and Reject answered "cannot be rejected
// after vendor contact has been approved" because the retired vendor kept
// contactApproval "approved". Nothing on the page could move the request.
//
//   1. a selection with no live booking is released (and appointmentStatus
//      settles onto the real booking status); a live one is left alone
//   2. Generate still refuses while the selected vendor's booking is live
//   3. a request is rejectable once every approved vendor has been retired

const assert = require("assert");

const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const Appointment = require("../../../models/Appointment");
const ApprovalRequest = require("../../../models/ApprovalRequest");
const AgentActionLog = require("../../../models/AgentActionLog");
const { Notification } = require("../../../models/Notification");

let requestRow = null;
let liveAppointment = false;
let latestAppointmentStatus = null;
let audits = [];

const populateChain = (doc) => {
  const chain = {
    populate: () => chain,
    then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
  };
  return chain;
};

// Generate loads through five .populate() calls; reject awaits findOne directly.
MaintenanceRequest.findOne = () => populateChain(requestRow);
Appointment.exists = async () => (liveAppointment ? { _id: "appt-1" } : null);
Appointment.findOne = () => ({
  sort: () => ({ select: () => ({ lean: async () => (latestAppointmentStatus ? { status: latestAppointmentStatus } : null) }) }),
});
ApprovalRequest.updateMany = async () => ({});
AgentActionLog.create = async (row) => {
  audits.push(row);
  return row;
};
Notification.create = async (row) => row;

const ctrl = require("../../../controllers/request.controller");
const { hasEngagedContactCandidate } = require("../../../services/request/routingGuidance.service");

const makeRes = () => ({
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
});

// The screenshot's request: Reads declined, nobody left, routing paused --
// with selectedVendorId and appointmentStatus still describing Reads' booking.
function reset() {
  requestRow = {
    _id: "req-1",
    landlordId: "landlord-1",
    tenantId: "tenant-1",
    issueTitle: "Clogged toilet",
    status: "approved",
    routingStatus: "paused",
    selectedVendorId: "vendor-reads",
    appointmentStatus: "awaiting_tenant",
    timeline: [],
    vendorRecommendationSnapshot: {
      lastRound: { resolution: "exhausted", vendorName: "Reads", reason: "declined" },
      candidateLedger: [
        {
          candidateKey: "preset__reads",
          name: "Reads",
          state: "excluded",
          displayGroup: "excluded",
          // Retiring a candidate never reset this -- the root of the reject lock.
          contactApproval: { status: "approved" },
          outreach: { status: "declined" },
        },
      ],
    },
    saved: 0,
    save: async function save() {
      this.saved += 1;
      return this;
    },
  };
  liveAppointment = false;
  latestAppointmentStatus = "cancelled";
  audits = [];
}

async function main() {
  /* 1) a selection with no live booking is released --------------------- */
  reset();
  const released = await ctrl.releaseStaleVendorSelection(requestRow);
  assert.strictEqual(released, true);
  assert.strictEqual(requestRow.selectedVendorId, null, "the dead selection no longer locks Generate");
  assert.strictEqual(
    requestRow.appointmentStatus,
    "cancelled",
    "the workflow bar reads the booking's real status, not a stale awaiting_tenant"
  );
  assert.strictEqual(requestRow.saved, 1);
  assert.strictEqual(audits[0].actionType, "vendor_selection_released", "and it is on the record");

  // Nothing stale: no write, no audit.
  audits = [];
  assert.strictEqual(await ctrl.releaseStaleVendorSelection(requestRow), false);
  assert.strictEqual(requestRow.saved, 1);
  assert.strictEqual(audits.length, 0);

  // No booking was ever made: falls back to "none".
  reset();
  latestAppointmentStatus = null;
  await ctrl.releaseStaleVendorSelection(requestRow);
  assert.strictEqual(requestRow.appointmentStatus, "none");

  // A live booking is the vendor's job, not stale state.
  reset();
  liveAppointment = true;
  assert.strictEqual(await ctrl.releaseStaleVendorSelection(requestRow), false);
  assert.strictEqual(requestRow.selectedVendorId, "vendor-reads");
  assert.strictEqual(requestRow.appointmentStatus, "awaiting_tenant");

  /* 2) Generate still refuses while that booking is live ---------------- */
  const res = makeRes();
  await ctrl.generateVendorRecommendations(
    { params: { id: "req-1" }, body: {}, user: { id: "landlord-1" } },
    res
  );
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.message, /selected vendor candidate exists/);

  /* 3) rejectable once every approved vendor is retired ----------------- */
  reset();
  assert.strictEqual(
    hasEngagedContactCandidate(requestRow.vendorRecommendationSnapshot),
    false,
    "a declined vendor is not engaged, whatever its old contactApproval says"
  );
  const rejectRes = makeRes();
  await ctrl.putMarkRequestRejected(
    { params: { id: "req-1" }, body: { reason: "Tenant fixed it themselves" }, user: { id: "landlord-1" } },
    rejectRes
  );
  assert.strictEqual(rejectRes.statusCode, 200, JSON.stringify(rejectRes.body));
  assert.strictEqual(requestRow.status, "rejected");

  // A vendor still approved for contact keeps the lock.
  reset();
  requestRow.vendorRecommendationSnapshot.candidateLedger.push({
    candidateKey: "preset__next",
    name: "Next Plumbing",
    state: "approved_for_contact",
    contactApproval: { status: "approved" },
  });
  const lockedRes = makeRes();
  await ctrl.putMarkRequestRejected(
    { params: { id: "req-1" }, body: { reason: "Changed my mind" }, user: { id: "landlord-1" } },
    lockedRes
  );
  assert.strictEqual(lockedRes.statusCode, 409);
  assert.strictEqual(lockedRes.body.code, "request_not_rejectable");

  console.log("stale vendor selection tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
