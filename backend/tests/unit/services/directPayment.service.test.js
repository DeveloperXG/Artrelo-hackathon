// Direct pay: the landlord pays the vendor themselves and Artrelo records it.
//
// Pins the rules that keep direct-pay jobs out of the money path:
//   - which rail an absent field means (landlord: direct; appointment: platform)
//   - "due" is recorded once, only for a direct job, only for a real amount
//   - "paid" is the landlord's own, once, and never for a platform job
//   - a direct job link can't reach a payout account
//
// Models are stubbed by assigning over their statics BEFORE requiring the
// modules under test, the same idiom as the other service tests. Appointments
// live in an in-memory array with just enough query matching for these calls.

const assert = require("assert");

const Appointment = require("../../../models/Appointment");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const VendorOutreach = require("../../../models/VendorOutreach");
const AgentActionLog = require("../../../models/AgentActionLog");

let appointments = [];
let notifications = [];
let audits = [];

const getPath = (row, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), row);
const matches = (row, filter) =>
  Object.entries(filter).every(([key, want]) => {
    const have = getPath(row, key);
    if (want && typeof want === "object" && !Array.isArray(want) && !(want instanceof Date)) {
      if ("$exists" in want) return want.$exists ? have !== undefined : have === undefined;
      if ("$ne" in want) return have !== want.$ne;
    }
    return String(have) === String(want);
  });
const applySet = (row, set) => {
  for (const [key, value] of Object.entries(set)) {
    const parts = key.split(".");
    let target = row;
    for (const part of parts.slice(0, -1)) target = target[part] = target[part] || {};
    target[parts[parts.length - 1]] = value;
  }
};
const clone = (row) => (row ? JSON.parse(JSON.stringify(row)) : row);
const leanable = (value) => ({ lean: async () => clone(value), select: () => leanable(value) });

Appointment.findOneAndUpdate = (filter, update) => {
  const row = appointments.find((a) => matches(a, filter));
  if (row) applySet(row, update.$set);
  return leanable(row || null);
};
Appointment.findOne = (filter) => leanable(appointments.find((a) => matches(a, filter)) || null);
Appointment.findById = (id) => leanable(appointments.find((a) => String(a._id) === String(id)) || null);
MaintenanceRequest.findById = () => leanable({ issueTitle: "Kitchen sink leaking" });
VendorOutreach.findOne = () => leanable({ vendorNameSnapshot: "Pat's Plumbing" });
AgentActionLog.create = async (row) => {
  audits.push(row);
  return row;
};
require("../../../services/notification/notify.service").notifyUser = async (n) => {
  notifications.push(n);
  return {};
};

const {
  landlordPaymentMode,
  appointmentPaymentMode,
} = require("../../../services/ledger/paymentMode");
const { recordDirectPaymentDue, markDirectPaymentPaid } = require("../../../services/ledger/directPayment.service");
const ledgerCtrl = require("../../../controllers/ledger.controller");
const vendorCompletionCtrl = require("../../../controllers/vendorCompletion.controller");
const { describe } = require("../../../scripts/payment_mode");

const makeAppointment = (overrides = {}) => ({
  _id: "appt-1",
  requestId: "req-1",
  landlordId: "landlord-1",
  status: "completed",
  paymentMode: "direct",
  ...overrides,
});
const reset = (rows = [makeAppointment()]) => {
  appointments = rows;
  notifications = [];
  audits = [];
};
const makeRes = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

async function main() {
  /* -------------- 1) What an absent field means ------------------------ */
  assert.strictEqual(landlordPaymentMode({}), "direct", "a landlord who never chose pays directly");
  assert.strictEqual(landlordPaymentMode(null), "direct");
  assert.strictEqual(landlordPaymentMode({ paymentMode: "platform" }), "platform");
  assert.strictEqual(
    appointmentPaymentMode({}),
    "platform",
    "an appointment from before the field was booked on the wallet rail and has a hold"
  );
  assert.strictEqual(appointmentPaymentMode({ paymentMode: "direct" }), "direct");

  /* -------------- 2) Due: once, direct only, real amounts only ---------- */
  reset();
  let due = await recordDirectPaymentDue({ appointmentId: "appt-1", amountCents: 28000 });
  assert.strictEqual(due.recorded, true);
  assert.strictEqual(appointments[0].directPayment.status, "due");
  assert.strictEqual(appointments[0].directPayment.amountCents, 28000);
  assert.strictEqual(notifications.length, 1, "the landlord is told to pay");
  assert.strictEqual(notifications[0].type, "vendor_payment_due");
  assert.match(notifications[0].title, /Pay Pat's Plumbing \$280\.00/);
  assert.ok(audits.some((a) => a.actionType === "direct_payment_due"));

  // closeJobCompletion and the manual Mark complete can both reach this. The
  // first amount stands, and the landlord is told once.
  due = await recordDirectPaymentDue({ appointmentId: "appt-1", amountCents: 99999 });
  assert.strictEqual(due.recorded, false);
  assert.strictEqual(appointments[0].directPayment.amountCents, 28000, "the first amount recorded stands");
  assert.strictEqual(notifications.length, 1, "and the landlord is not told twice");

  reset([makeAppointment({ paymentMode: "platform" })]);
  due = await recordDirectPaymentDue({ appointmentId: "appt-1", amountCents: 28000 });
  assert.strictEqual(due.recorded, false, "a platform job is paid from the wallet, never recorded as owed");
  assert.strictEqual(appointments[0].directPayment, undefined);

  reset([makeAppointment({ paymentMode: undefined })]);
  due = await recordDirectPaymentDue({ appointmentId: "appt-1", amountCents: 28000 });
  assert.strictEqual(due.recorded, false, "nor is a job booked before the field existed");

  reset();
  due = await recordDirectPaymentDue({ appointmentId: "appt-1", amountCents: 0 });
  assert.strictEqual(due.recorded, false, "a $0 job (warranty, goodwill) owes nothing");
  assert.strictEqual(notifications.length, 0);

  /* -------------- 3) Paid: the landlord's own, once --------------------- */
  reset();
  await recordDirectPaymentDue({ appointmentId: "appt-1", amountCents: 28000 });

  let paid = await markDirectPaymentPaid({ appointmentId: "appt-1", landlordId: "landlord-2" });
  assert.strictEqual(paid.refused, "not_found", "another landlord's job does not exist to them");
  assert.strictEqual(appointments[0].directPayment.status, "due");

  paid = await markDirectPaymentPaid({ appointmentId: "appt-1", landlordId: "landlord-1", reference: "  ET-4471  " });
  assert.strictEqual(paid.refused, undefined);
  assert.strictEqual(appointments[0].directPayment.status, "paid");
  assert.strictEqual(appointments[0].directPayment.reference, "ET-4471", "the reference is trimmed");
  assert.ok(appointments[0].directPayment.paidAt);
  assert.ok(audits.some((a) => a.actionType === "direct_payment_marked_paid" && a.actor === "landlord"));

  const paidAt = appointments[0].directPayment.paidAt;
  paid = await markDirectPaymentPaid({ appointmentId: "appt-1", landlordId: "landlord-1", reference: "other" });
  assert.strictEqual(paid.alreadyPaid, true, "a double-click is not an error");
  assert.strictEqual(appointments[0].directPayment.reference, "ET-4471", "and changes nothing");
  assert.strictEqual(appointments[0].directPayment.paidAt, paidAt);

  reset([makeAppointment({ paymentMode: "platform" })]);
  paid = await markDirectPaymentPaid({ appointmentId: "appt-1", landlordId: "landlord-1" });
  assert.strictEqual(paid.refused, "not_direct", "a wallet payout is settled by Stripe, not by a landlord's word");

  reset([makeAppointment({ status: "scheduled" })]);
  paid = await markDirectPaymentPaid({ appointmentId: "appt-1", landlordId: "landlord-1" });
  assert.strictEqual(paid.refused, "not_due", "nothing is owed before the job closes");

  reset();
  await recordDirectPaymentDue({ appointmentId: "appt-1", amountCents: 28000 });
  paid = await markDirectPaymentPaid({ appointmentId: "appt-1", landlordId: "landlord-1", reference: "x".repeat(500) });
  assert.strictEqual(appointments[0].directPayment.reference.length, 120, "a reference is capped");

  /* -------------- 4) The endpoint says what happened -------------------- */
  reset();
  await recordDirectPaymentDue({ appointmentId: "appt-1", amountCents: 28000 });
  let res = makeRes();
  await ledgerCtrl.markDirectPaymentPaid(
    { user: { id: "landlord-1" }, params: { id: "appt-1" }, body: { reference: "ET-1" } },
    res
  );
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.data.status, "paid");
  assert.strictEqual(res.body.data.amount, 280, "dollars out, like the rest of the wallet API");

  res = makeRes();
  await ledgerCtrl.markDirectPaymentPaid({ user: { id: "landlord-2" }, params: { id: "appt-1" }, body: {} }, res);
  assert.strictEqual(res.statusCode, 404);

  reset([makeAppointment({ paymentMode: "platform" })]);
  res = makeRes();
  await ledgerCtrl.markDirectPaymentPaid({ user: { id: "landlord-1" }, params: { id: "appt-1" }, body: {} }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "not_direct");

  /* -------------- 5) A direct job link reaches no payout account -------- */
  const directReq = { appointment: makeAppointment(), jobToken: { identityId: "identity-1" }, params: { token: "t" } };
  res = makeRes();
  await vendorCompletionCtrl.getPayoutStatus(directReq, res);
  assert.strictEqual(res.body.data.supported, false);
  assert.strictEqual(res.body.data.reason, "direct_pay");
  assert.match(res.body.data.message, /pays you directly/);

  assert.strictEqual(vendorCompletionCtrl.startPayoutOnboarding, undefined,
    "job-scoped payout onboarding has been removed for every payment mode");
  assert.strictEqual(vendorCompletionCtrl.getPayoutUpdateLink, undefined,
    "job-scoped payout updates have been removed for every payment mode");

  /* -------------- 6) The operator is warned before stranding money ------ */
  const view = describe({
    landlord: { email: "dana@example.com", paymentMode: "platform" },
    ledger: { available: 12000, held: 30000 },
    liveHoldCount: 1,
    directDue: { count: 2, cents: 45000 },
  });
  assert.strictEqual(view.mode, "platform");
  assert.strictEqual(view.directDue, "2 job(s), $450.00");
  assert.strictEqual(view.warnings.length, 2, "a balance and a live hold are both called out");
  assert.deepStrictEqual(describe({ landlord: { email: "new@example.com" }, ledger: null }).warnings, []);
  assert.strictEqual(describe({ landlord: { email: "new@example.com" }, ledger: null }).mode, "direct");

  console.log("directPayment.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
