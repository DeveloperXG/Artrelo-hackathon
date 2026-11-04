// Outreach scheduled for the vendor's opening hours.
//
// Approving contact at 6 PM on a Friday for a vendor open weekdays 8-3 used to
// email a closed business at once and start their response clock. Pins:
//   1. a Standard job to a closed vendor creates a `scheduled` row: no email,
//      no response deadline, scheduledFor = Monday 08:00
//   2. urgent / emergency jobs still send immediately
//   3. the release sweep delivers it at the opening -- windows and the SLA
//      computed THEN (Monday-relative), with a fresh link
//   4. a request cancelled in the meantime is revoked, never emailed
//   5. a scheduled row carries a real (unusable) token hash, so two of them
//      can't collide on the sparse unique tokenHash index

const assert = require("assert");
const env = require("../../../config/env");
env.outreach_timezone = "America/Regina";
env.outreach_email_enabled = true;

const VendorOutreach = require("../../../models/VendorOutreach");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const Vendor = require("../../../models/Vendor");
const Landlord = require("../../../models/Landlord");
const AgentActionLog = require("../../../models/AgentActionLog");
const { normalizeHours } = require("../../../services/vendor/vendorHours");
// Delivery timing is tested independently from authorization. The separate
// actual Mongo ordering gate qualifies the real transactional contact claim.
require('../../../services/vendor/firstContact.service').claim = async () => ({ record: { _id: 'synthetic-permission-receipt' } });

const EIGHT_TO_THREE = normalizeHours({
  preset: "custom",
  weekly: [1, 2, 3, 4, 5].map((day) => ({ day, open: "08:00", close: "15:00" })),
});
const FRI_6PM = new Date("2026-08-01T00:00:00.000Z"); // Fri Jul 31 18:00 Regina
const MON_8AM = new Date("2026-08-03T14:00:00.000Z");

let rows = [];
let emails = [];
let requestRow = null;
let liveVendor = null;
let emailResult = {delivered:true,provider:'test'};

class FakeOutreach {
  constructor(fields) {
    Object.assign(this, { _id: `o${rows.length + 1}`, attempt: 1, createdAt: new Date(), ...fields });
  }
  async save() {
    return this;
  }
}

VendorOutreach.create = async (fields) => {
  // Mirror the sparse unique index the model declares on tokenHash.
  if (rows.some((row) => row.tokenHash && row.tokenHash === fields.tokenHash)) {
    throw Object.assign(new Error("E11000 tokenHash"), { code: 11000 });
  }
  const row = new FakeOutreach(fields);
  rows.push(row);
  return row;
};
VendorOutreach.find = (filter) => ({
  select: () => ({
    lean: async () =>
      rows.filter((row) => row.status === filter.status && row.scheduledFor <= filter.scheduledFor.$lte),
  }),
});
VendorOutreach.findOneAndUpdate = async (filter, update) => {
  const row = rows.find((r) => r._id === filter._id && r.status === filter.status);
  if (!row) return null;
  Object.assign(row, update.$set);
  return row;
};
VendorOutreach.updateOne = async (filter, update) => {
  const row = rows.find((r) => r._id === filter._id);
  if (row) {
    Object.assign(row, update.$set || {});
    if (update.$unset?.tokenHash) row.tokenHash = undefined;
  }
  return {};
};

const populated = () => {
  const chain = { populate: () => chain, select: () => chain, lean: async () => requestRow,
    then: (resolve, reject) => Promise.resolve(requestRow).then(resolve, reject) };
  return chain;
};
MaintenanceRequest.findById = () => populated();
MaintenanceRequest.updateOne = async () => ({ matchedCount: 1 });
Vendor.findOne = () => ({
  select: () => ({ lean: () => Promise.resolve({ email: "plumber@example.com", operatingHours: EIGHT_TO_THREE }) }),
});
Landlord.findById = () => ({ select: () => ({ lean: async () => ({ firstName: "Lena", lastName: "Landlord" }) }) });
AgentActionLog.create = async () => ({});
require("../../../services/notification/email.service").sendEmail = async (email) => {
  emails.push(email);
  return emailResult;
};
require("../../../services/vendor/vendorIdentity.service").ensureVendorIdentity = async () => ({ identity: { _id: "507f191e810c19729de860ef" } });
require("../../../models/LandlordPolicy").findOne = () => ({ lean: async () => ({ maxOutreachAttempts: 3 }) });
require("../../../services/vendor/vendorRecommendation.service").loadPresetCandidates = async () => liveVendor ? [liveVendor] : [];
require("../../../services/notification/notify.service").notifyUser = async () => ({});

const { sendVendorOutreach } = require("../../../services/vendor/vendorOutreach.service");
const { releaseScheduledOutreach } = require("../../../services/vendor/vendorOutreachSweeper.service");

const candidate = {
  candidateKey: "preset__v1",
  name: "Eight To Three Plumbing",
  vendorId: "507f191e810c19729de860eb",
  providerName: "preset",
  providerVendorId: "507f191e810c19729de860eb",
};

function reset({ urgency = "medium", status = "approved" } = {}) {
  emailResult = {delivered:true,provider:'test'};
  rows = [];
  emails = [];
  liveVendor = { vendorId: candidate.vendorId, email: "plumber@example.com", status: "active",
    verificationStatus: "trusted", category: "Plumbing", city: "Regina" };
  requestRow = {
    _id: "req-1",
    landlordId: "land-1",
    tenantId: "tenant-1",
    status,
    urgency,
    category: "Plumbing",
    issueTitle: "Leak",
    ai: { summary: "Leak under the sink", severity: 3 },
    propertyId: { name: "Maple", address: "1 Main St, Regina, SK" },
    vendorRecommendationSnapshot: {
      candidateLedger: [{ ...candidate, state: "approved_for_contact", outreach: { status: "not_sent" } }],
    },
    save: async function save() {
      return this;
    },
  };
}

async function main() {
  /* 1) closed vendor, Standard job -> scheduled ------------------------- */
  reset();
  let result = await sendVendorOutreach({ request: requestRow, candidate, draftMessage: "Hello", now: FRI_6PM });
  assert.strictEqual(result.scheduled, true);
  assert.strictEqual(emails.length, 0, "nothing is emailed to a closed business");
  const row = rows[0];
  assert.strictEqual(row.status, "scheduled");
  assert.strictEqual(row.scheduledFor.toISOString(), MON_8AM.toISOString(), "Friday 6 PM -> Monday 8 AM");
  assert.strictEqual(row.responseDeadlineAt, undefined, "no response clock until it is actually sent");
  assert.ok(row.tokenHash, "a real (unusable) hash, never null");
  const ledgerOutreach = requestRow.vendorRecommendationSnapshot.candidateLedger[0].outreach;
  assert.strictEqual(ledgerOutreach.status, "scheduled", "the snapshot shows it scheduled");
  assert.strictEqual(ledgerOutreach.scheduledFor, MON_8AM.toISOString());

  // 5) a second scheduled row doesn't collide on tokenHash.
  await sendVendorOutreach({
    request: requestRow,
    candidate: { ...candidate, candidateKey: "preset__v2" },
    draftMessage: "Hello",
    now: FRI_6PM,
  });
  assert.strictEqual(rows.length, 2);

  /* 3) released at the opening, Monday-relative --------------------------- */
  const SAT = new Date("2026-08-01T18:00:00.000Z");
  assert.strictEqual(await releaseScheduledOutreach(SAT), 0, "not before Monday 8 AM");
  rows = [row];
  const released = await releaseScheduledOutreach(new Date(MON_8AM.getTime() + 30 * 1000));
  assert.strictEqual(released, 1);
  assert.strictEqual(row.status, "sent");
  assert.strictEqual(emails.length, 1);
  assert.strictEqual(emails[0].to, "plumber@example.com");
  assert.ok(row.responseDeadlineAt > MON_8AM, "the response clock starts Monday, not Friday");
  assert.ok(
    row.offeredWindows.every((slot) => !slot.start || new Date(slot.start) > MON_8AM),
    "windows are offered from Monday onward"
  );
  assert.ok(emails[0].text.includes("/vendor-response/"), "a fresh link is minted at delivery");

  /* 4) cancelled in the meantime -> revoked, not emailed ------------------ */
  reset({ status: "cancelled" });
  await sendVendorOutreach({
    request: { ...requestRow, status: "approved" },
    candidate,
    draftMessage: "Hello",
    now: FRI_6PM,
  });
  assert.strictEqual(await releaseScheduledOutreach(new Date(MON_8AM.getTime() + 1000)), 0);
  assert.strictEqual(rows[0].status, "revoked");
  assert.strictEqual(emails.length, 0, "a cancelled job is never emailed");

  reset();
  await sendVendorOutreach({ request: requestRow, candidate, draftMessage: "Hello", now: FRI_6PM });
  liveVendor.verificationStatus = "blocked";
  assert.strictEqual(await releaseScheduledOutreach(MON_8AM), 0);
  assert.strictEqual(rows[0].status, "delivery_failed");
  assert.strictEqual(emails.length, 0, "a vendor blocked after approval must not be contacted");

  /* 2) urgent goes now ----------------------------------------------------- */
  reset({ urgency: "high" });
  result = await sendVendorOutreach({ request: requestRow, candidate, draftMessage: "Hello", now: FRI_6PM });
  assert.strictEqual(result.scheduled, false);
  assert.strictEqual(emails.length, 1, "an urgent job is emailed now");

  /* 6) a failed delivery always says why, and logs it --------------------- */
  // Production showed "Email could not be delivered" with no reason and no
  // log line: vendor email was switched off, and that path stored nothing.
  reset({ urgency: "high" });
  env.outreach_email_enabled = false;
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    await sendVendorOutreach({ request: requestRow, candidate, draftMessage: "Hello", now: FRI_6PM });
  } finally {
    console.warn = realWarn;
    env.outreach_email_enabled = true;
  }
  assert.strictEqual(emails.length, 0);
  assert.strictEqual(rows[0].status, "delivery_failed");
  assert.match(rows[0].deliveryError, /switched off/, "the manager sees the reason");
  assert.ok(
    warnings.some((line) => /delivery failed/.test(line) && /OUTREACH_EMAIL_ENABLED is off/.test(line)),
    "and the hosted logs say which switch"
  );
  assert.ok(!warnings.some((line) => line.includes("plumber@example.com")), "no address in the log");

  reset({urgency:'high'});
  emailResult = {stub:true,delivered:false,provider:'stub'};
  result = await sendVendorOutreach({request:requestRow,candidate,draftMessage:'Hello',now:FRI_6PM,initiation:'policy_auto_start'});
  assert.strictEqual(result.delivered,false,'stub does not prove vendor contact');
  assert.strictEqual(rows[0].status,'delivery_failed');
  assert.strictEqual(rows[0].initiation,'policy_auto_start');
  reset({urgency:'high'});
  emailResult = {delivered:false,provider:'test',uncertain:true,error:'Transport timed out'};
  await sendVendorOutreach({request:requestRow,candidate,draftMessage:'Hello',now:FRI_6PM});
  assert.strictEqual(rows[0].deliveryUnconfirmed,true);
  assert.strictEqual(rows[0].sentAt,undefined);
  reset();
  await sendVendorOutreach({request:requestRow,candidate,draftMessage:'Hello',now:FRI_6PM});
  requestRow.safetyAssessment={state:'needs_review',revision:1};
  assert.strictEqual(await releaseScheduledOutreach(MON_8AM),0);
  assert.strictEqual(emails.length,0,'a new safety concern pauses the scheduled send');
  reset();
  requestRow.intakeFollowUp={state:'awaiting_answers',revision:1,remainingTopics:['location']};
  await assert.rejects(()=>sendVendorOutreach({request:requestRow,candidate,draftMessage:'Hello',now:FRI_6PM}),e=>e.code==='intake_review_required');
  assert.strictEqual(rows.length,0,'review hold is enforced before persisting outreach');
  console.log("scheduled outreach tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
