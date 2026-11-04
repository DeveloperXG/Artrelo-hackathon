// Tenant-facing appointment confirmation.
//
// This is the third leg of "booked" (vendor time + tenant access + quota
// approval) and the only thing that drives awaiting_tenant -> scheduled.
// Models are stubbed, same approach as vendorPortal.controller.test.js.

const assert = require("assert");

const Appointment = require("../../../models/Appointment");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const AgentActionLog = require("../../../models/AgentActionLog");
// listTenantAppointments now attaches the completion projection, so this model
// has to be stubbed too — unstubbed it would attempt a real connection under
// the hermetic preload (and casts "appt-1" to ObjectId before it even gets
// there).
const JobCompletion = require("../../../models/JobCompletion");

const TENANT_ID = "tenant-1";
const OTHER_TENANT_ID = "tenant-2";

let appointmentRow = null;
let savedRequest = null;
let auditRows = [];

function makeAppointment(overrides = {}) {
  return {
    _id: "appt-1",
    requestId: "req-1",
    tenantId: TENANT_ID,
    landlordId: "landlord-1",
    vendorId: "vendor-1",
    status: "awaiting_tenant",
    confirmedStart: new Date(Date.now() + 24 * 3600 * 1000),
    confirmedEnd: new Date(Date.now() + 26 * 3600 * 1000),
    proposedWindows: ["Thu, Jul 30, 8:00 a.m. – 12:00 p.m."],
    vendorConfirmation: { accepted: true, respondedAt: new Date(), note: "Includes the P-trap" },
    tenantConfirmation: {},
    save: async function save() {
      return this;
    },
    ...overrides,
  };
}

// Only return the row when the query's tenant scope matches — this is what the
// cross-tenant test actually exercises.
Appointment.findOne = async (filter) => {
  if (!appointmentRow) return null;
  if (filter.tenantId && filter.tenantId !== appointmentRow.tenantId) return null;
  if (filter._id && filter._id !== appointmentRow._id) return null;
  return appointmentRow;
};
Appointment.find = (filter) => ({
  populate() {
    return this;
  },
  sort() {
    return this;
  },
  lean: async () =>
    appointmentRow && filter.tenantId === appointmentRow.tenantId ? [appointmentRow] : [],
});

let completionRow = null;
JobCompletion.find = (filter) => ({
  lean: async () => {
    void filter;
    return completionRow ? [completionRow] : [];
  },
});
JobCompletion.findOne = async () => completionRow;
JobCompletion.findById = async () => completionRow;
JobCompletion.findOneAndUpdate = async (filter, update) => {
  if (!completionRow) return null;
  if (filter.status && completionRow.status !== filter.status) return null;
  Object.assign(completionRow, update.$set || {});
  return completionRow;
};
JobCompletion.updateOne = async () => ({ modifiedCount: completionRow ? 1 : 0 });

MaintenanceRequest.findById = async () => savedRequest;
AgentActionLog.create = async (row) => {
  auditRows.push(row);
  return row;
};

// The vendor's "you're booked" email now fires from HERE rather than at vendor
// acceptance — their job link only resolves once the appointment is
// `scheduled`. Stubbed before the controller loads (it destructures on
// require), so the assertions below are about WHEN it is called.
let bookingEmails = [];
require("../../../services/vendor/vendorAcceptance.service").sendVendorBookingConfirmation =
  async (args) => {
    bookingEmails.push(args);
    return { sent: true };
  };

const ctrl = require("../../../controllers/request.controller");

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
const makeReq = (userId, body = {}, id = "appt-1") => ({
  params: { id },
  body,
  user: { id: userId },
});

function freshRequest() {
  return {
    _id: "req-1",
    landlordId: "landlord-1",
    appointmentStatus: "awaiting_tenant",
    timeline: [],
    save: async function save() {
      return this;
    },
  };
}

const run = async () => {
  /* ===== 1) Accepting completes the booking ===== */
  appointmentRow = makeAppointment();
  savedRequest = freshRequest();
  auditRows = [];
  bookingEmails = [];
  let res = makeRes();
  await ctrl.confirmTenantAppointment(makeReq(TENANT_ID, { accepted: true, note: "Works for me" }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(appointmentRow.status, "scheduled", "awaiting_tenant -> scheduled");
  assert.strictEqual(appointmentRow.tenantConfirmation.accepted, true, "tenantConfirmation written");
  assert.ok(appointmentRow.tenantConfirmation.respondedAt instanceof Date);
  assert.strictEqual(appointmentRow.tenantConfirmation.note, "Works for me");
  assert.strictEqual(savedRequest.appointmentStatus, "scheduled", "mirrored onto the request");
  assert.strictEqual(savedRequest.timeline.length, 1, "timeline entry added");
  assert.strictEqual(savedRequest.timeline[0].actorRole, "tenant");
  assert.ok(
    auditRows.some((r) => r.actionType === "appointment_tenant_confirmed"),
    "logged appointment_tenant_confirmed"
  );
  assert.strictEqual(
    bookingEmails.length,
    1,
    "the vendor is told the job is booked once the tenant confirms, and not before"
  );
  assert.strictEqual(bookingEmails[0].appointmentId, "appt-1");

  /* ===== 2) Declining hands it back for re-coordination ===== */
  appointmentRow = makeAppointment();
  savedRequest = freshRequest();
  auditRows = [];
  bookingEmails = [];
  res = makeRes();
  await ctrl.confirmTenantAppointment(
    makeReq(TENANT_ID, { accepted: false, note: "I'm at work until 5" }),
    res
  );

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(appointmentRow.status, "proposed", "declining returns it to proposed");
  assert.strictEqual(appointmentRow.tenantConfirmation.accepted, false);
  assert.strictEqual(savedRequest.appointmentStatus, "proposed");
  assert.strictEqual(savedRequest.timeline.length, 0, "no assignment entry on decline");
  assert.ok(
    auditRows.some((r) => r.actionType === "appointment_tenant_declined"),
    "logged appointment_tenant_declined"
  );
  assert.strictEqual(
    bookingEmails.length,
    0,
    "a decline books nothing, so the vendor is told nothing"
  );

  /* ===== 3) A tenant cannot touch another tenant's appointment ===== */
  appointmentRow = makeAppointment({ tenantId: OTHER_TENANT_ID });
  savedRequest = freshRequest();
  res = makeRes();
  await ctrl.confirmTenantAppointment(makeReq(TENANT_ID, { accepted: true }), res);
  assert.strictEqual(res.statusCode, 404, "cross-tenant confirm is a 404");
  assert.strictEqual(appointmentRow.status, "awaiting_tenant", "untouched");

  /* ===== 4) Already-scheduled appointments do not need confirming ===== */
  for (const status of ["scheduled", "completed", "cancelled"]) {
    appointmentRow = makeAppointment({ status });
    savedRequest = freshRequest();
    res = makeRes();
    await ctrl.confirmTenantAppointment(makeReq(TENANT_ID, { accepted: true }), res);
    assert.strictEqual(res.statusCode, 409, `${status} should be 409`);
    assert.strictEqual(res.body.code, "appointment_not_confirmable");
  }

  /* ===== 4b) A time that has already gone can't be confirmed ===== */
  appointmentRow = makeAppointment({ confirmedStart: new Date(Date.now() - 2 * 3600 * 1000) });
  savedRequest = freshRequest();
  bookingEmails = [];
  res = makeRes();
  await ctrl.confirmTenantAppointment(makeReq(TENANT_ID, { accepted: true }), res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "arrival_passed");
  assert.strictEqual(appointmentRow.status, "awaiting_tenant", "not booked into the past");
  assert.strictEqual(bookingEmails.length, 0, "and the vendor is not sent a booking");

  // Declining it is still fine: that is the tenant telling us it won't work.
  appointmentRow = makeAppointment({ confirmedStart: new Date(Date.now() - 2 * 3600 * 1000) });
  savedRequest = freshRequest();
  res = makeRes();
  await ctrl.confirmTenantAppointment(makeReq(TENANT_ID, { accepted: false, note: "Missed it" }), res);
  assert.strictEqual(res.statusCode, 200);

  /* ===== 5) `accepted` is required and must be a boolean ===== */
  for (const body of [{}, { accepted: "yes" }, { accepted: 1 }, { note: "hi" }]) {
    appointmentRow = makeAppointment();
    res = makeRes();
    await ctrl.confirmTenantAppointment(makeReq(TENANT_ID, body), res);
    assert.strictEqual(res.statusCode, 400, `${JSON.stringify(body)} should be 400`);
  }

  /* ===== 6) Listing is scoped to the caller and hides vendor pricing ===== */
  appointmentRow = makeAppointment();
  res = makeRes();
  await ctrl.listTenantAppointments(makeReq(TENANT_ID), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.length, 1);
  assert.strictEqual(
    res.body.data[0].vendorConfirmation.note,
    undefined,
    "the vendor's quote note must not reach the tenant"
  );
  assert.strictEqual(res.body.data[0].vendorConfirmation.accepted, true);

  res = makeRes();
  await ctrl.listTenantAppointments(makeReq(OTHER_TENANT_ID), res);
  assert.strictEqual(res.body.data.length, 0, "another tenant sees nothing");

  console.log("tenantAppointment.controller tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
