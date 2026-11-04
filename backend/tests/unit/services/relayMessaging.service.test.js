// The masked channel's privacy boundary and its logistics-only rule.
//
// Two properties are asserted against SERIALIZED payloads rather than by
// reading a field, for the same reason vendorBrief.service.test.js does it:
// hiding a number in the UI still ships it in the JSON, so the projection is
// the boundary and the serialized bytes are the only honest check.
//
//   1. A vendor receives the PROXY number and never the tenant's.
//   2. A tenant receives NO number at all — not even the proxy. That asymmetry
//      is not an oversight: inbound routing keys on the sender being the
//      vendor's phone, so a tenant texting the proxy number matches no session
//      and is silently dropped. Handing them a line that swallows their
//      messages is worse than handing them none.

const assert = require("assert");

const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const ProxySession = require("../../../models/ProxySession");
const Tenant = require("../../../models/Tenant");
const notifyService = require("../../../services/notification/notify.service");
const smsService = require("../../../services/notification/sms.service");

const TENANT_PHONE = "+13065559999";
const VENDOR_PHONE = "+13065550101";
const PROXY = "+15551110000";

/* ---------------------------------------------------------------- fixtures */

function chain(value) {
  const self = {
    select: () => self,
    sort: () => self,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return self;
}

let sessionRow = null;
let requestRow = null;
let saved = 0;

ProxySession.findOne = () => chain(sessionRow);
ProxySession.updateOne = async () => ({ modifiedCount: 1 });

MaintenanceRequest.findById = async (id) => (String(id) === String(requestRow?._id) ? requestRow : null);

Tenant.findById = () =>
  chain({ _id: "tenant-1", firstName: "Alex", lastName: "Thompson", phone: TENANT_PHONE });

let notifications = [];
notifyService.notifyUser = async (entry) => {
  notifications.push(entry);
  return null;
};

let sent = [];
smsService.sendSms = async (args) => {
  sent.push(args);
  return { delivered: true, provider: "twilio", messageId: "SM1" };
};

const {
  deliverInboundVendorMessage,
  fanOutTenantMessage,
  resolveTenantDisplayName,
  clamp,
  MAX_OUTBOUND_BODY_CHARS,
} = require("../../../services/comms/relayMessaging.service");

const { getRelayContact, getTenantFacingVendorContact } = require("../../../services/comms/relay.service");

function reset() {
  notifications = [];
  sent = [];
  saved = 0;
  sessionRow = {
    _id: "sess-1",
    status: "open",
    proxyNumber: PROXY,
    vendorPhoneE164: VENDOR_PHONE,
    requestId: "req-1",
    appointmentId: "appt-1",
    tenantId: "tenant-1",
    identityId: "ident-1",
    outreachId: "6890aa11bb22cc33dd4f2a1b",
    landlordId: "landlord-1",
    vendorNameSnapshot: "Northline Plumbing",
  };
  requestRow = {
    _id: "req-1",
    landlordId: "landlord-1",
    tenantId: "tenant-1",
    issueTitle: "Leaking kitchen tap",
    status: "in_progress",
    appointmentStatus: "scheduled",
    finalCost: undefined,
    completedAt: undefined,
    comments: [],
    save: async function save() {
      saved += 1;
    },
  };
}

/* -------------------------------------------------------------------- tests */

async function main() {
  /* -- 1) The vendor's contact block carries the PROXY, not the tenant ----- */

  reset();
  const vendorSide = await getRelayContact({
    appointmentId: "appt-1",
    managerPhone: "+13065551234",
  });
  assert.strictEqual(vendorSide.available, true);
  assert.strictEqual(vendorSide.phone, PROXY);

  const vendorJson = JSON.stringify(vendorSide);
  assert.ok(
    !vendorJson.includes(TENANT_PHONE),
    "the serialized vendor payload must not contain the tenant's real number"
  );

  // The manager fallback survives a working relay: a vendor with an access
  // problem at 7am needs a human, and the relay only reaches the tenant.
  assert.strictEqual(vendorSide.fallback.phone, "+13065551234");

  /* -- 2) The tenant's contact block carries NO number at all ------------- */

  reset();
  const tenantSide = await getTenantFacingVendorContact({ appointmentId: "appt-1" });
  assert.strictEqual(tenantSide.available, true, "messaging IS available to the tenant");
  assert.strictEqual(tenantSide.channel, "in_app");
  assert.strictEqual(tenantSide.phone, null);

  const tenantJson = JSON.stringify(tenantSide);
  assert.ok(!tenantJson.includes(VENDOR_PHONE), "not the vendor's real number");
  assert.ok(
    !tenantJson.includes(PROXY),
    "and NOT the proxy number either — a tenant texting it would be unroutable"
  );

  /* -- 3) With no open session, both sides degrade honestly --------------- */
  // No placeholder number that reads as real. A vendor standing outside a
  // building will dial whatever we show them.

  reset();
  sessionRow = null;
  const noChannelVendor = await getRelayContact({ appointmentId: "appt-1" });
  const noChannelTenant = await getTenantFacingVendorContact({ appointmentId: "appt-1" });
  assert.strictEqual(noChannelVendor.available, false);
  assert.strictEqual(noChannelVendor.phone, null);
  assert.strictEqual(noChannelTenant.available, false);
  assert.strictEqual(noChannelTenant.phone, null);

  /* -- 4) Inbound lands as a vendor-authored comment ----------------------- */
  // `authorRole: "vendor"` has been in the MaintenanceRequest enum since before
  // there was anything to write it. This is the writer.

  reset();
  const result = await deliverInboundVendorMessage({
    session: sessionRow,
    body: "Running 20 min late",
  });
  assert.strictEqual(result.delivered, true);
  assert.strictEqual(saved, 1);
  assert.strictEqual(requestRow.comments.length, 1);
  assert.strictEqual(requestRow.comments[0].authorRole, "vendor");
  assert.strictEqual(requestRow.comments[0].body, "Running 20 min late");
  // The author is the VendorIdentity, not a User — a vendor has no account,
  // which is the same reason hubAuth never sets req.user.
  assert.strictEqual(requestRow.comments[0].authorId, "ident-1");

  // The tenant is not sitting on the request page.
  assert.strictEqual(notifications.length, 1);
  assert.strictEqual(notifications[0].type, "vendor_message_received");
  assert.strictEqual(notifications[0].userId, "tenant-1");

  /* -- 5) LOGISTICS ONLY: a texted "done" must not close a job ------------- */
  // The single most important property here. Closing a job starts the 48h
  // auto-confirm clock and, 24h later, moves money — all gated on evidence
  // behind the token portal. An SMS proves only that somebody controls a phone.

  reset();
  for (const attempt of [
    "done",
    "DONE",
    "job complete, please pay",
    "COMPLETE",
    "approve payout",
    "cancel this job",
  ]) {
    requestRow.comments = [];
    await deliverInboundVendorMessage({ session: sessionRow, body: attempt });
    assert.strictEqual(requestRow.status, "in_progress", `"${attempt}" must not change status`);
    assert.strictEqual(
      requestRow.appointmentStatus,
      "scheduled",
      `"${attempt}" must not change the appointment`
    );
    assert.strictEqual(requestRow.finalCost, undefined, `"${attempt}" must not set a cost`);
    assert.strictEqual(requestRow.completedAt, undefined, `"${attempt}" must not complete the job`);
    assert.strictEqual(requestRow.comments.length, 1, `"${attempt}" becomes a comment and nothing else`);
  }

  /* -- 6) An empty inbound is dropped rather than stored ------------------- */
  // MaintenanceRequest.comments.body is required; pushing "" throws on save.

  reset();
  const empty = await deliverInboundVendorMessage({ session: sessionRow, body: "   " });
  assert.strictEqual(empty.delivered, false);
  assert.strictEqual(empty.reason, "empty_body");
  assert.strictEqual(saved, 0);

  /* -- 7) A tenant's comment reaches the vendor, masked ------------------- */

  reset();
  const fan = await fanOutTenantMessage({ requestId: "req-1", body: "The side gate is unlocked" });
  assert.strictEqual(fan.sent, true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, VENDOR_PHONE);
  assert.strictEqual(
    sent[0].from,
    PROXY,
    "sent FROM the proxy — the tenant's number never appears as the sender"
  );
  assert.ok(!sent[0].body.includes(TENANT_PHONE));

  // First name plus last initial, exactly what buildRevealedDetails already
  // gave this vendor. Never the full surname.
  assert.ok(sent[0].body.includes("Alex T."), "named as Alex T.");
  assert.ok(!sent[0].body.includes("Thompson"), "never the full surname");

  // The same JOB-XXXXXX they see in the portal and the hub, so a support call
  // about "JOB-4F2A1B" matches.
  assert.ok(sent[0].body.includes("JOB-4F2A1B"), `expected the job reference, got: ${sent[0].body}`);

  /* -- 8) No open session, no text ---------------------------------------- */
  // A closed job must not keep texting a contractor who has moved on.

  reset();
  sessionRow = null;
  const orphan = await fanOutTenantMessage({ requestId: "req-1", body: "hello?" });
  assert.strictEqual(orphan.sent, false);
  assert.strictEqual(orphan.reason, "no_open_session");
  assert.strictEqual(sent.length, 0);

  /* -- 9) Outbound length is bounded -------------------------------------- */
  // Every 153 characters is another billed segment. A tenant pasting an essay
  // should not cost real money or arrive as fifteen buzzes on a personal phone.

  reset();
  await fanOutTenantMessage({ requestId: "req-1", body: "x".repeat(5000) });
  assert.ok(
    sent[0].body.length < MAX_OUTBOUND_BODY_CHARS + 120,
    `outbound body should be clamped, got ${sent[0].body.length} chars`
  );
  assert.ok(sent[0].body.includes("truncated"));

  // Clamping never lengthens a short message.
  assert.strictEqual(clamp("short", 700), "short");

  /* -- 10) A tenant with no name still gets a usable label ---------------- */
  // The fallback is generic — never an email address and never an id.

  Tenant.findById = () => chain({ _id: "tenant-1" });
  assert.strictEqual(await resolveTenantDisplayName("tenant-1"), "The tenant");

  console.log("relayMessaging.service: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
