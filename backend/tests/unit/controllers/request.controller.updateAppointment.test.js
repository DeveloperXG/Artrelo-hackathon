// updateAppointment: a booking ended through this endpoint must not leave its
// vendor "selected" on the request -- that is what refused every later search
// with "a selected vendor candidate exists".

const assert = require("assert");

const Appointment = require("../../../models/Appointment");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const AgentActionLog = require("../../../models/AgentActionLog");

let appointmentRow = null;
let requestRow = null;

Appointment.findOne = async () => appointmentRow;
MaintenanceRequest.findById = async () => requestRow;
AgentActionLog.create = async (row) => row;

const ctrl = require("../../../controllers/request.controller");

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

function reset() {
  appointmentRow = {
    _id: "appt-1",
    requestId: "req-1",
    vendorId: "vendor-a",
    status: "awaiting_tenant",
    save: async function save() {
      return this;
    },
  };
  requestRow = {
    _id: "req-1",
    landlordId: "landlord-1",
    selectedVendorId: "vendor-a",
    appointmentStatus: "awaiting_tenant",
    save: async function save() {
      return this;
    },
  };
}

const update = async (status) => {
  const res = makeRes();
  await ctrl.updateAppointment({ params: { id: "appt-1" }, body: { status }, user: { id: "landlord-1" } }, res);
  return res;
};

async function main() {
  for (const status of ["cancelled", "failed"]) {
    reset();
    const res = await update(status);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(requestRow.selectedVendorId, null, `a ${status} booking releases its vendor`);
    assert.strictEqual(requestRow.appointmentStatus, status);
  }

  // Still live, or finished by doing the job: the vendor stays.
  for (const status of ["scheduled", "completed"]) {
    reset();
    await update(status);
    assert.strictEqual(requestRow.selectedVendorId, "vendor-a", `${status} keeps the vendor`);
  }

  // A different vendor's booking ending doesn't touch this selection.
  reset();
  appointmentRow.vendorId = "vendor-b";
  await update("cancelled");
  assert.strictEqual(requestRow.selectedVendorId, "vendor-a");

  console.log("updateAppointment selection tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
