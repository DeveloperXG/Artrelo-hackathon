// Alerts that reach a person outside the app: the emailed notification types,
// the emergency phone call, and the new-request alert that ties them together.
//
// Models and transports are stubbed by assigning over them BEFORE the modules
// under test are required (they destructure sendEmail at load).

const assert = require("assert");

const env = require("../../../config/env");
const { Notification } = require("../../../models/Notification");
const Landlord = require("../../../models/Landlord");
const Tenant = require("../../../models/Tenant");
const Property = require("../../../models/Property");
const AgentActionLog = require("../../../models/AgentActionLog");

let emails = [];
let rows = [];
let audits = [];
let people = {};
const leanable = (value) => ({ select: () => leanable(value), lean: async () => value });

require("../../../services/notification/email.service").sendEmail = async (message) => {
  emails.push(message);
  return { stub: true };
};
Notification.create = async (row) => {
  rows.push(row);
  return { ...row, _id: `n-${rows.length}` };
};
Notification.findOneAndUpdate = async (filter, change) => {
  const previous=rows.find(r=>r.eventKey===filter.eventKey);
  if(filter.eventKey && !previous) rows.push({...change.$setOnInsert,_id:`n-${rows.length+1}`});
  return previous || null;
};
Notification.findOne = async filter => rows.find(r=>r.eventKey===filter.eventKey)||null;
const Request=require('../../../models/MaintenanceRequest');
Request.findOneAndUpdate=async()=>({_id:'claimed'});
Request.updateOne=async()=>({matchedCount:1});
Landlord.findById = (id) => leanable(people[id]?.role === "landlord" ? people[id] : null);
Tenant.findById = (id) => leanable(people[id]?.role === "tenant" ? people[id] : null);
Property.findById = () => leanable({ name: "Maple Court" });
AgentActionLog.create = async (row) => {
  audits.push(row);
  return row;
};

const { notifyUser } = require("../../../services/notification/notify.service");
const { toE164, buildEmergencyTwiml, placeEmergencyCall } = require("../../../services/notification/emergencyCall.service");

const reset = () => {
  emails = [];
  rows = [];
  audits = [];
  people = {
    "landlord-1": { role: "landlord", email: "dana@example.com", firstName: "Dana", phone: "(306) 555-0100" },
    "tenant-1": { role: "tenant", email: "tess@example.com", firstName: "Tess" },
    "quiet-1": { role: "landlord", email: "q@example.com", notificationPreferences: { email: false } },
  };
  env.app_public_url = "https://artrelo.com";
  env.emergency_calls_enabled = false;
  env.twilio_account_sid = "AC123";
  env.twilio_auth_token = "secret";
  env.twilio_voice_from = "+13065550199";
};

async function main() {
  /* -------------- 1) Which notifications are emailed ------------------- */
  reset();
  await notifyUser({
    userId: "landlord-1",
    type: "decision_needed",
    title: "A quote is over your limit",
    message: "Ace Plumbing quoted $360 against your $300 limit.",
    metadata: { workOrderId: "req-9" },
  });
  assert.strictEqual(rows.length, 1, "the bell row is written");
  assert.strictEqual(emails.length, 1, "a decision is emailed");
  assert.strictEqual(emails[0].to, "dana@example.com");
  assert.strictEqual(emails[0].subject, "A quote is over your limit");
  assert.match(emails[0].text, /https:\/\/artrelo\.com\/dashboard\/decisions\?request=req-9/, "linked to where it is decided");

  reset();
  await notifyUser({ userId: "landlord-1", type: "tenant_message_received", title: "New message", message: "Hi", metadata: {} });
  assert.strictEqual(emails.length, 0, "messages stay in the app");

  reset();
  await notifyUser({ userId: "quiet-1", type: "decision_needed", title: "t", message: "m", metadata: {} });
  assert.strictEqual(emails.length, 0, "a landlord who turned email off is not emailed");

  reset();
  await notifyUser({
    userId: "landlord-1",
    type: "payment_overdue",
    title: "Low balance",
    message: "m",
    email: "dana@example.com",
    emailSubject: "Your balance is running low",
    metadata: {},
  });
  assert.strictEqual(emails.length, 1, "a caller's own email is sent once, not twice");
  assert.strictEqual(emails[0].subject, "Your balance is running low");

  reset();
  await notifyUser({
    userId: "tenant-1",
    type: "maintenance_verification_requested",
    title: "Your repair is done — take a look",
    message: "Confirm it was fixed.",
    metadata: { workOrderId: "req-3" },
  });
  assert.strictEqual(emails.length, 1, "a tenant asked to confirm a repair is emailed");
  assert.match(emails[0].text, /\/portal\/requests\/req-3/, "to the tenant portal, not the dashboard");
  assert.ok(/sent a maintenance request/.test(emails[0].html), "with the tenant footer");

  reset();
  await notifyUser({
    userId: "landlord-1",
    type: "work_order_created",
    title: "Emergency: Burst pipe",
    message: "Water through the ceiling.",
    metadata: { workOrderId: "req-1", priority: "emergency" },
  });
  assert.strictEqual(emails[0].subject, "EMERGENCY: Burst pipe", "said once, not 'EMERGENCY: Emergency:'");
  assert.ok(emails[0].text.startsWith("EMERGENCY"), "an emergency says so first");

  // A notification that can't find its person still writes the bell row.
  reset();
  const orphan = await notifyUser({ userId: "nobody", type: "decision_needed", title: "t", message: "m", metadata: {} });
  assert.ok(orphan, "the row stands even when no email can be sent");
  assert.strictEqual(emails.length, 0);

  /* -------------- 2) The emergency call --------------------------------- */
  assert.strictEqual(toE164("(306) 555-0100"), "+13065550100");
  assert.strictEqual(toE164("1-306-555-0100"), "+13065550100");
  assert.strictEqual(toE164("+44 20 7946 0958"), "+442079460958");
  assert.strictEqual(toE164("555-0100"), null, "too short to dial");
  assert.strictEqual(toE164(""), null);

  const twiml = buildEmergencyTwiml({ issueTitle: "Burst pipe <kitchen> & hall", where: "Maple Court, unit 4B" });
  assert.ok(twiml.includes("Burst pipe &lt;kitchen&gt; &amp; hall"), "the tenant's words are escaped into the XML");
  assert.strictEqual((twiml.match(/<Say/g) || []).length, 2, "said twice");

  reset();
  let calls = [];
  const fakeFetch = (ok, body = { sid: "CA1" }) => async (url, init) => {
    calls.push({ url, init });
    return { ok, status: ok ? 201 : 400, json: async () => body };
  };
  let call = await placeEmergencyCall({ phone: "(306) 555-0100", issueTitle: "Burst pipe", where: "x", fetchImpl: fakeFetch(true) });
  assert.deepStrictEqual(call, { placed: false, reason: "disabled" }, "off unless switched on");
  assert.strictEqual(calls.length, 0);

  env.emergency_calls_enabled = true;
  call = await placeEmergencyCall({ phone: "(306) 555-0100", issueTitle: "Burst pipe", where: "x", fetchImpl: fakeFetch(true) });
  assert.deepStrictEqual(call, { placed: true, callSid: "CA1" });
  const sent = new URLSearchParams(calls[0].init.body);
  assert.strictEqual(sent.get("To"), "+13065550100");
  assert.strictEqual(sent.get("From"), "+13065550199");
  assert.match(calls[0].url, /\/Accounts\/AC123\/Calls\.json$/);
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
  assert.strictEqual(sent.get("MachineDetection"), "DetectMessageEnd", "a voicemail gets the whole message");

  // Twilio refuses inline TwiML over 4000 characters; a tenant's essay must not.
  const long = buildEmergencyTwiml({ issueTitle: "water ".repeat(1000), where: "Maple Court ".repeat(100) });
  assert.ok(long.length < 4000, `TwiML is ${long.length} characters`);

  call = await placeEmergencyCall({ phone: null, issueTitle: "x", where: "", fetchImpl: fakeFetch(true) });
  assert.strictEqual(call.reason, "no_phone", "no number, no call");

  const origErr = console.error;
  console.error = () => {};
  call = await placeEmergencyCall({ phone: "3065550100", issueTitle: "x", where: "", fetchImpl: fakeFetch(false, { message: "bad" }) });
  console.error = origErr;
  assert.strictEqual(call.reason, "twilio_error", "a refusal is reported, never thrown");

  /* -------------- 3) The new-request alert ------------------------------ */
  const callService = require("../../../services/notification/emergencyCall.service");
  let placed = [];
  callService.placeEmergencyCall = async (args) => {
    placed.push(args);
    return { placed: true, callSid: "CA9" };
  };
  // Required after the stub so it picks up the replacement.
  delete require.cache[require.resolve("../../../services/notification/newRequestAlert.service")];
  const { alertLandlordOfNewRequest } = require("../../../services/notification/newRequestAlert.service");

  reset();
  await alertLandlordOfNewRequest({
    request: { _id: "req-1", landlordId: "landlord-1", propertyId: "prop-1", urgency: "emergency", issueTitle: "Burst pipe" },
    tenant: { firstName: "Tess", lastName: "Tenant", phone: "306-555-0111" },
    unitNumber: "4B",
  });
  assert.strictEqual(rows[0].title, "Emergency: Burst pipe");
  assert.match(rows[0].message, /Tess Tenant at Maple Court, unit 4B reported an emergency/);
  assert.match(rows[0].message, /306-555-0111/, "the tenant's number, so the manager can call back");
  assert.strictEqual(emails[0].subject, "EMERGENCY: Burst pipe");
  assert.strictEqual(placed.length, 1, "an emergency rings the landlord's phone");
  assert.strictEqual(placed[0].phone, "(306) 555-0100");
  assert.strictEqual(placed[0].where, "Maple Court, unit 4B");
  assert.ok(audits.some((a) => a.actionType === "emergency_call_placed"));

  reset();
  placed = [];
  await alertLandlordOfNewRequest({
    request: { _id: "req-2", landlordId: "landlord-1", urgency: "medium", issueTitle: "Dripping tap" },
    tenant: { firstName: "Tess", lastName: "Tenant" },
  });
  assert.strictEqual(rows[0].title, "New maintenance request");
  assert.strictEqual(emails.length, 1, "every new request is emailed");
  assert.ok(!/EMERGENCY/.test(emails[0].subject));
  assert.strictEqual(placed.length, 0, "only an emergency places a call");

  console.log("alerts tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
