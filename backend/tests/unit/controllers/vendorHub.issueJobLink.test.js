// Re-issuing a job link from the vendor hub.
//
// A vendor whose job was still waiting on the tenant to confirm the time
// clicked "Open job" and was told "That job is closed. There's nothing left to
// submit." -- false, and alarming. Not open yet is not closed.

const assert = require("assert");
const VendorOutreach = require("../../../models/VendorOutreach");
const Appointment = require("../../../models/Appointment");

const OUTREACH_ID = "60a1b2c3d4e5f60718abcdef";
let appointmentStatus = "awaiting_tenant";
VendorOutreach.find = () => ({
  select: () => ({ lean: async () => [{ _id: OUTREACH_ID, appointmentId: "appt-1" }] }),
});
Appointment.findById = () => ({ select: () => ({ lean: async () => ({ status: appointmentStatus }) }) });
require("../../../services/vendor/jobToken.service").rotateJobToken = async () => ({ rawToken: "RAW" });

const ctrl = require("../../../controllers/vendorHub.controller");

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
const req = () => ({ params: { ref: "JOB-ABCDEF" }, vendorIdentity: { _id: "identity-1" } });

async function main() {
  let res = makeRes();
  await ctrl.issueJobLink(req(), res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "awaiting_tenant");
  assert.ok(!/closed/i.test(res.body.message), res.body.message);
  assert.match(res.body.message, /tenant is still confirming/);

  appointmentStatus = "completed";
  res = makeRes();
  await ctrl.issueJobLink(req(), res);
  assert.strictEqual(res.statusCode, 409);
  assert.match(res.body.message, /closed/, "a genuinely closed job still says so");

  appointmentStatus = "scheduled";
  res = makeRes();
  await ctrl.issueJobLink(req(), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.data.jobUrl.includes("RAW"));

  console.log("vendorHub issueJobLink tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
