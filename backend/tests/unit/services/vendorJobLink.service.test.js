// The job link goes out with the booking confirmation; an hour before arrival
// a link-free reminder points back to it.
//
//   1. tenant confirms: "You're booked" with the job link, at once
//   2. a failed send releases its lease and the sweep retries; a dead
//      process's lease expires and is retried; a delivered link is never resent
//   3. the reminder: only within the hour, once, never with a link, and not
//      for a booking whose link just went out inside that hour
//   4. cancelled bookings get nothing; no vendor email stops the retries

const assert = require("assert");

const Appointment = require("../../../models/Appointment");
const VendorOutreach = require("../../../models/VendorOutreach");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const Landlord = require("../../../models/Landlord");
const Property = require("../../../models/Property");
const jobTokenService = require("../../../services/vendor/jobToken.service");
const emailService = require("../../../services/notification/email.service");

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

/* ------------------------------------------------- in-memory appointments */

let store = new Map();
const val = (doc, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), doc);
function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === "$or") return cond.some((branch) => matches(doc, branch));
    if (key === "$expr") {
      // The one $expr in use: vendorJobLinkSentAt <= confirmedStart - lead.
      const [, [, lead]] = [cond.$lte[0], cond.$lte[1].$subtract];
      return doc.vendorJobLinkSentAt && doc.vendorJobLinkSentAt.getTime() <= doc.confirmedStart.getTime() - lead;
    }
    const actual = val(doc, key);
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, expected]) => {
        if (op === "$ne") return expected === null ? actual != null : String(actual) !== String(expected);
        if (op === "$lte") return actual != null && new Date(actual) <= new Date(expected);
        if (op === "$gt") return actual != null && new Date(actual) > new Date(expected);
        throw new Error(`unsupported ${op}`);
      });
    }
    if (cond === null) return actual == null;
    if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
    return String(actual) === String(cond);
  });
}
const applySet = (doc, update) => Object.assign(doc, update.$set || {});

Appointment.findOneAndUpdate = async (filter, update) => {
  const doc = [...store.values()].find((d) => matches(d, filter));
  if (!doc) return null;
  applySet(doc, update);
  return { ...doc };
};
Appointment.updateOne = async (filter, update) => {
  const doc = [...store.values()].find((d) => matches(d, filter));
  if (doc) applySet(doc, update);
  return { modifiedCount: doc ? 1 : 0 };
};
Appointment.find = (filter) => {
  const rows = [...store.values()].filter((d) => matches(d, filter));
  const chain = {
    sort: () => chain,
    limit: () => chain,
    select: () => chain,
    lean: async () => rows.map((d) => ({ _id: d._id })),
  };
  return chain;
};

const lean = (value) => ({ select: () => ({ lean: async () => value }) });
let vendorEmail = "pro@plumbing.test";
VendorOutreach.findOne = async () => (vendorEmail ? { toEmail: vendorEmail, vendorNameSnapshot: "Sam" } : null);
MaintenanceRequest.findById = () => lean({ issueTitle: "Leaking sink", category: "Plumbing", propertyId: "p1" });
Landlord.findById = () => lean({ firstName: "Pat", lastName: "Lee", companyName: "Pine Holdings" });
Property.findById = () => lean({ address: "1 Main St, Regina, SK", city: "Regina" });

let rotations = 0;
jobTokenService.rotateJobToken = async () => {
  rotations += 1;
  return { rawToken: `tok${rotations}`, jobToken: { jobCode: "ABCD2345" } };
};

const sent = [];
let failNext = 0;
emailService.sendEmail = async (message) => {
  sent.push(message);
  if (failNext > 0) {
    failNext -= 1;
    return { delivered: false, provider: "resend", error: "rate limited" };
  }
  return { delivered: true, provider: "resend", messageId: `m${sent.length}` };
};

const {
  sendVendorBookingConfirmation,
  sweepVendorJobLinks,
  sweepVendorArrivalReminders,
  JOB_LINK_LEASE_MS,
} = require("../../../services/vendor/vendorAcceptance.service");

function appointment(id, startsIn, extra = {}) {
  const start = new Date(T0.getTime() + startsIn);
  store.set(id, {
    _id: id,
    requestId: "r1",
    landlordId: "l1",
    status: "scheduled",
    confirmedStart: start,
    confirmedEnd: new Date(start.getTime() + 90 * MIN),
    vendorBookingNotifiedAt: null,
    vendorJobLinkSentAt: null,
    vendorJobLinkClaimedAt: null,
    vendorArrivalReminderSentAt: null,
    ...extra,
  });
  return store.get(id);
}

const T0 = new Date("2026-10-13T15:00:00Z");
const at = (offset) => new Date(T0.getTime() + offset);

async function main() {
  /* 1) Confirmed two days out: booked, with the link, now ----------------- */
  const a = appointment("a1", 48 * HOUR);
  let result = await sendVendorBookingConfirmation({ appointmentId: "a1", now: T0 });
  assert.strictEqual(result.sent, true);
  assert.strictEqual(sent.length, 1, "one email");
  assert.match(sent[0].subject, /^You're booked — Plumbing in Regina/);
  assert.ok(sent[0].previewUrl.endsWith("tok1"), "carrying the job link");
  assert.ok(a.vendorBookingNotifiedAt && a.vendorJobLinkSentAt);

  result = await sendVendorBookingConfirmation({ appointmentId: "a1", now: T0 });
  assert.strictEqual(result.sent, false, "the confirmation claim holds");
  assert.strictEqual(await sweepVendorJobLinks({ now: at(MIN) }), 0, "a delivered link is never resent");
  assert.strictEqual(rotations, 1);

  /* 2) Failure releases the lease; a stuck lease expires ------------------- */
  const b = appointment("b1", 30 * HOUR);
  failNext = 1;
  result = await sendVendorBookingConfirmation({ appointmentId: "b1", now: T0 });
  assert.strictEqual(result.sent, false);
  assert.strictEqual(b.vendorJobLinkSentAt, null, "a rejected send is not marked sent");
  assert.strictEqual(b.vendorJobLinkClaimedAt, null, "and its lease is released at once");
  assert.strictEqual(await sweepVendorJobLinks({ now: at(MIN) }), 1, "the next tick retries");
  assert.ok(b.vendorJobLinkSentAt);

  const c = appointment("c1", 20 * HOUR, { vendorJobLinkClaimedAt: T0 }); // a send that died mid-flight
  assert.strictEqual(await sweepVendorJobLinks({ now: at(MIN) }), 0, "a live lease is respected");
  assert.strictEqual(await sweepVendorJobLinks({ now: at(JOB_LINK_LEASE_MS) }), 1, "an expired lease is retried");
  assert.ok(c.vendorJobLinkSentAt);

  /* 3) The arrival reminder ------------------------------------------------- */
  // a1 arrives at T0+48h; its link went out at T0.
  let before = sent.length;
  const rotationsBefore = rotations;
  assert.strictEqual(await sweepVendorArrivalReminders({ now: at(46 * HOUR) }), 0, "not before the hour");
  assert.strictEqual(await sweepVendorArrivalReminders({ now: at(47 * HOUR) }), 1, "an hour out");
  const nudge = sent[sent.length - 1];
  assert.match(nudge.subject, /^Starting soon — plumbing job in Regina/);
  assert.match(nudge.text, /"You're booked" email/);
  assert.strictEqual(nudge.previewUrl, undefined);
  assert.ok(!/tok\d/.test(nudge.text + nudge.html), "no link, so the vendor's link stays live");
  assert.strictEqual(rotations, rotationsBefore, "and no token rotated for it");
  assert.strictEqual(await sweepVendorArrivalReminders({ now: at(47 * HOUR + MIN) }), 0, "once");
  assert.strictEqual(sent.length, before + 1);

  // Booked inside the hour: the link just arrived, so no reminder on top.
  const d = appointment("d1", 40 * MIN);
  await sendVendorBookingConfirmation({ appointmentId: "d1", now: T0 });
  assert.ok(d.vendorJobLinkSentAt);
  before = sent.length;
  await sweepVendorArrivalReminders({ now: at(MIN) });
  assert.strictEqual(d.vendorArrivalReminderSentAt, null, "no reminder for a fresh booking");
  assert.strictEqual(sent.length, before);

  // Already arrived: too late to remind.
  const e = appointment("e1", -10 * MIN, { vendorJobLinkSentAt: at(-5 * HOUR) });
  await sweepVendorArrivalReminders({ now: T0 });
  assert.strictEqual(e.vendorArrivalReminderSentAt, null);

  /* 4) Cancelled gets nothing; no email stops retrying ----------------------- */
  appointment("x1", 10 * HOUR, { status: "cancelled" });
  vendorEmail = null;
  const f = appointment("f1", 10 * HOUR);
  const count = sent.length;
  await sweepVendorJobLinks({ now: T0 });
  assert.strictEqual(sent.length, count, "nothing sent");
  assert.strictEqual(store.get("x1").vendorJobLinkSentAt, null, "the cancelled booking is untouched");
  assert.ok(f.vendorJobLinkSentAt, "unfixable: marked done so the sweep stops picking it up");

  console.log("vendor job link tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
