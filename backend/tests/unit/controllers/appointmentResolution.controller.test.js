// The manager resolving a booking that went wrong, and the tenant reporting a
// no-show. Pins:
//   1. confirm_time confirms on the tenant's behalf through the SAME path the
//      tenant uses -- status scheduled, confirmedBy "landlord", vendor booking
//      email sent -- and tells the tenant
//   2. reroute derives its reason from the appointment, never from input: a
//      booked visit is a no-show (counted against the vendor), one still
//      waiting on the tenant is tenant silence (not counted)
//   3. reroute refuses a "no-show" for a visit that hasn't happened yet
//   4. a booking another landlord owns is a 404
//   5. the tenant report surfaces the service's refusal codes as-is

const assert = require("assert");

const Appointment = require("../../../models/Appointment");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const AgentActionLog = require("../../../models/AgentActionLog");

const LANDLORD_ID = "landlord-1";
let appointmentRow = null;
let requestRow = null;
const failures = [];
const notices = [];
const bookingEmails = [];
let reportResult = null;

// Stubbed before the controller loads: it destructures these on require.
const failureService = require("../../../services/completion/appointmentFailure.service");
failureService.failAppointment = async (args) => {
  failures.push(args);
  return { failed: true, appointment: { ...appointmentRow, status: "failed" } };
};
failureService.reportNoShow = async () => reportResult;
failureService.dismissNoShow = async () => ({ appointment: appointmentRow });
require("../../../services/notification/notify.service").notifyUser = async (args) => {
  notices.push(args);
};
require("../../../services/vendor/vendorAcceptance.service").sendVendorBookingConfirmation = async (args) => {
  bookingEmails.push(args);
  return { sent: true };
};

Appointment.findOne = async (filter) => {
  if (!appointmentRow) return null;
  if (filter.landlordId && filter.landlordId !== appointmentRow.landlordId) return null;
  return appointmentRow;
};
MaintenanceRequest.findById = async () => requestRow;
AgentActionLog.create = async (row) => row;

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
const req = (userId, body, id = "appt-1") => ({ params: { id }, body, user: { id: userId } });

function makeAppointment(fields = {}) {
  return {
    _id: "appt-1",
    requestId: "req-1",
    tenantId: "tenant-1",
    landlordId: LANDLORD_ID,
    status: "awaiting_tenant",
    confirmedStart: new Date(Date.now() + 24 * 3600 * 1000),
    tenantConfirmation: {},
    save: async function save() {
      return this;
    },
    ...fields,
  };
}
const makeRequest = () => ({
  _id: "req-1",
  landlordId: LANDLORD_ID,
  timeline: [],
  save: async function save() {
    return this;
  },
});

const run = async () => {
  /* ===== 1) Confirm for a silent tenant ===== */
  appointmentRow = makeAppointment();
  requestRow = makeRequest();
  let res = makeRes();
  await ctrl.resolveAppointment(req(LANDLORD_ID, { action: "confirm_time" }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(appointmentRow.status, "scheduled");
  assert.strictEqual(appointmentRow.tenantConfirmation.accepted, true);
  assert.strictEqual(appointmentRow.tenantConfirmation.confirmedBy, "landlord");
  assert.strictEqual(requestRow.appointmentStatus, "scheduled");
  assert.match(requestRow.timeline[0].note, /Manager confirmed/);
  assert.strictEqual(bookingEmails.length, 1, "the vendor gets their job link, as when the tenant confirms");
  assert.strictEqual(notices[0].userId, "tenant-1");
  assert.strictEqual(notices[0].type, "appointment_confirmed");

  // Already booked: nothing to confirm.
  res = makeRes();
  await ctrl.resolveAppointment(req(LANDLORD_ID, { action: "confirm_time" }), res);
  assert.strictEqual(res.statusCode, 409);

  /* ===== 2) Reroute derives the reason ===== */
  appointmentRow = makeAppointment({ status: "awaiting_tenant" });
  res = makeRes();
  await ctrl.resolveAppointment(req(LANDLORD_ID, { action: "reroute", reason: "no_show" }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(failures[0].reason, "tenant_unconfirmed", "input can't pin a no-show on the vendor");

  appointmentRow = makeAppointment({ status: "scheduled", confirmedStart: new Date(Date.now() - 3 * 3600 * 1000) });
  res = makeRes();
  await ctrl.resolveAppointment(req(LANDLORD_ID, { action: "reroute" }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(failures[1].reason, "no_show");
  assert.strictEqual(failures[1].actorRole, "landlord");

  /* ===== 3) Not a no-show before the visit ===== */
  appointmentRow = makeAppointment({ status: "scheduled", confirmedStart: new Date(Date.now() + 3600 * 1000) });
  res = makeRes();
  await ctrl.resolveAppointment(req(LANDLORD_ID, { action: "reroute" }), res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "too_early");
  assert.strictEqual(failures.length, 2);

  /* ===== 4) Scoped to the landlord; unknown actions refused ===== */
  res = makeRes();
  await ctrl.resolveAppointment(req("landlord-2", { action: "reroute" }), res);
  assert.strictEqual(res.statusCode, 404);
  res = makeRes();
  await ctrl.resolveAppointment(req(LANDLORD_ID, { action: "delete" }), res);
  assert.strictEqual(res.statusCode, 400);

  /* ===== 5) Tenant report ===== */
  reportResult = { error: { status: 409, code: "too_early", message: "Wait", reportableAt: new Date() } };
  res = makeRes();
  await ctrl.reportTenantNoShow(req("tenant-1", { note: "x" }), res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "too_early");
  assert.ok(res.body.reportableAt, "the time it opens is passed through for the UI");

  reportResult = { appointment: { _id: "appt-1" } };
  res = makeRes();
  await ctrl.reportTenantNoShow(req("tenant-1", {}), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.already, false);

  console.log("appointmentResolution.controller tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
