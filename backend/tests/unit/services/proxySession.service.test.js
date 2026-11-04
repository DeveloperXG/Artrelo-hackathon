// The masked SMS channel: allocation, the routing invariant, and teardown.
//
// The invariant under test is the one thing about slice E that cannot be
// deferred. An inbound SMS carries only (From, To), so if two open sessions
// ever share a (proxyNumber, vendorPhone) pair, an inbound message is genuinely
// ambiguous and we would have to guess which tenant's thread it belongs in.
// Guessing wrong shows one tenant a message about another tenant's home.
//
// In production the database enforces this with a unique partial index. Here
// the fake collection enforces the same rule, so these tests describe what that
// index BUYS rather than re-testing Mongo.

const assert = require("assert");

const env = require("../../../config/env");
const ProxySession = require("../../../models/ProxySession");
const VendorIdentity = require("../../../models/VendorIdentity");
const Vendor = require("../../../models/Vendor");
const smsService = require("../../../services/notification/sms.service");

/* ---------------------------------------------------------------- fixtures */

let rows = [];
let nextId = 1;

const matches = (row, filter) =>
  Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$in" in value) return value.$in.map(String).includes(String(row[key]));
      if ("$gte" in value) return new Date(row[key] || 0) >= value.$gte;
    }
    return value === null ? row[key] == null : String(row[key]) === String(value);
  });

// A chainable stub for .select().lean() / .sort().lean(), which the service uses.
function chain(value) {
  const self = {
    select: () => self,
    sort: () => self,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return self;
}

ProxySession.find = (filter) => chain(rows.filter((r) => matches(r, filter)));
ProxySession.findOne = (filter) => chain(rows.find((r) => matches(r, filter)) || null);
ProxySession.create = async (doc) => {
  // THE INVARIANT, as the unique partial index enforces it in Mongo.
  if (
    doc.status === "open" &&
    rows.some(
      (r) =>
        r.status === "open" &&
        r.proxyNumber === doc.proxyNumber &&
        r.vendorPhoneE164 === doc.vendorPhoneE164
    )
  ) {
    const err = new Error("E11000 duplicate key");
    err.code = 11000;
    throw err;
  }
  // One open channel per appointment, the second partial index.
  if (
    doc.status === "open" &&
    rows.some((r) => r.status === "open" && String(r.appointmentId) === String(doc.appointmentId))
  ) {
    const err = new Error("E11000 duplicate key");
    err.code = 11000;
    throw err;
  }
  const row = { _id: `s${nextId++}`, inboundCount: 0, outboundCount: 0, ...doc };
  rows.push(row);
  return row;
};
ProxySession.findOneAndUpdate = async (filter, update) => {
  const row = rows.find((r) => matches(r, filter));
  if (!row) return null;
  Object.assign(row, update.$set || {});
  return row;
};
ProxySession.updateOne = async () => ({ modifiedCount: 1 });
ProxySession.updateMany = async (filter, update) => {
  const hit = rows.filter((r) => matches(r, filter));
  hit.forEach((r) => Object.assign(r, update.$set || {}));
  return { modifiedCount: hit.length };
};

let identities = {};
let vendors = {};
VendorIdentity.findById = (id) => chain(identities[id] || null);
Vendor.findById = (id) => chain(vendors[id] || null);

// The rail is off by default (A2P 10DLC has not cleared), so every open would
// short-circuit on `sms_disabled` and prove nothing. Force it live for the
// tests that are about routing rather than about the gate.
let smsLive = true;
smsService.isSmsLive = () => smsLive;

const {
  openProxySession,
  closeProxySession,
  closeProxySessionsForRequest,
  resolveInboundSession,
  resolveVendorPhone,
} = require("../../../services/comms/proxySession.service");

const PLUMBER = "+13065550101";
const OTHER_VENDOR = "+13065550202";

function reset({ pool = ["+15551110000", "+15552220000"] } = {}) {
  rows = [];
  nextId = 1;
  smsLive = true;
  env.twilio_proxy_numbers = pool;
  identities = {
    ident1: { _id: "ident1", phoneE164: PLUMBER },
    ident2: { _id: "ident2", phoneE164: OTHER_VENDOR },
    noPhone: { _id: "noPhone", phoneE164: undefined },
  };
  vendors = { vend1: { _id: "vend1", phone: "(306) 555-0101" } };
}

const openFor = (appointmentId, identityId = "ident1") =>
  openProxySession({
    requestId: `req-${appointmentId}`,
    appointmentId,
    tenantId: `tenant-${appointmentId}`,
    identityId,
    landlordId: "landlord-1",
    vendorNameSnapshot: "Northline Plumbing",
  });

/* -------------------------------------------------------------------- tests */

async function main() {
  /* -- 1) One vendor, two live jobs, two DIFFERENT numbers ---------------- */
  // The headline consequence of the routing invariant. Reusing the number here
  // would make both jobs' inbound messages resolve to the same pair.

  reset();
  const first = await openFor("appt-1");
  const second = await openFor("appt-2");

  assert.ok(first.opened && second.opened, "both jobs get a channel");
  assert.notStrictEqual(
    first.session.proxyNumber,
    second.session.proxyNumber,
    "a vendor holding two live jobs must be on two different proxy numbers"
  );

  /* -- 2) The pool is per-VENDOR, not global ------------------------------ */
  // A different vendor may hold the very same number at the same time. If this
  // were not true, pool size would cap total concurrent jobs across the whole
  // platform instead of concurrent jobs per vendor.

  const otherVendor = await openFor("appt-3", "ident2");
  assert.ok(otherVendor.opened, "a second vendor still gets a channel from a 2-number pool");
  assert.ok(
    [first.session.proxyNumber, second.session.proxyNumber].includes(
      otherVendor.session.proxyNumber
    ),
    "and it reuses a number already held by a DIFFERENT vendor"
  );

  /* -- 3) Exhaustion fails soft, and names why ---------------------------- */
  // The third concurrent job for the same vendor has no free number. The job
  // must still proceed: a full pool cannot be allowed to decide whether a
  // plumber gets hired.

  const third = await openFor("appt-4");
  assert.strictEqual(third.opened, false);
  assert.strictEqual(third.reason, "pool_exhausted");
  assert.strictEqual(third.session, null, "no half-open channel is claimed");

  /* -- 4) Closing releases the number ------------------------------------- */
  // Without this a pool of N dies after N jobs per vendor, because the partial
  // index would keep every historical pair reserved.

  const released = first.session.proxyNumber;
  const closed = await closeProxySession({ appointmentId: "appt-1" });
  assert.strictEqual(closed.closed, true);
  assert.strictEqual(closed.session.closeReason, "job_closed");

  const reopened = await openFor("appt-5");
  assert.ok(reopened.opened, "the freed number is usable again");
  assert.strictEqual(reopened.session.proxyNumber, released);

  /* -- 5) Close is idempotent --------------------------------------------- */
  // closeJobCompletion and the auto-confirm sweeper can both reach step 5.

  const again = await closeProxySession({ appointmentId: "appt-1" });
  assert.strictEqual(again.closed, false);
  assert.strictEqual(again.reason, "not_open");

  /* -- 6) Re-entry does not burn a second number -------------------------- */
  // finalizeVendorAcceptance re-enters after a quota approval. It must return
  // the existing channel, not allocate another one for the same appointment.

  reset();
  const once = await openFor("appt-1");
  const twice = await openFor("appt-1");
  assert.strictEqual(twice.opened, false);
  assert.strictEqual(twice.reason, "already_open");
  assert.strictEqual(String(twice.session._id), String(once.session._id));
  assert.strictEqual(rows.filter((r) => r.status === "open").length, 1);

  /* -- 7) Inbound resolves on (From, To) and nothing else ----------------- */

  reset();
  const jobA = await openFor("appt-1");
  const jobB = await openFor("appt-2");

  const routedA = await resolveInboundSession({
    from: PLUMBER,
    to: jobA.session.proxyNumber,
  });
  const routedB = await resolveInboundSession({
    from: PLUMBER,
    to: jobB.session.proxyNumber,
  });
  assert.strictEqual(String(routedA._id), String(jobA.session._id));
  assert.strictEqual(String(routedB._id), String(jobB.session._id));
  assert.notStrictEqual(String(routedA._id), String(routedB._id));

  // Un-normalized inbound is the normal case: Twilio sends E.164, but a
  // formatted number must resolve identically rather than silently miss.
  const formatted = await resolveInboundSession({
    from: "(306) 555-0101",
    to: jobA.session.proxyNumber,
  });
  assert.strictEqual(String(formatted?._id), String(jobA.session._id));

  // A stranger texting a pool number resolves to nothing rather than to
  // whichever session happens to hold that number.
  assert.strictEqual(
    await resolveInboundSession({ from: "+15559998888", to: jobA.session.proxyNumber }),
    null
  );

  /* -- 8) A closed channel stops routing ---------------------------------- */
  await closeProxySession({ appointmentId: "appt-1" });
  assert.strictEqual(
    await resolveInboundSession({ from: PLUMBER, to: jobA.session.proxyNumber }),
    null,
    "a text to a closed channel must not land in the tenant's thread"
  );

  /* -- 9) No channel is claimed before the rail can carry it -------------- */
  // A2P 10DLC is carrier paperwork. While it is pending the relay must report
  // an honest gap — and crucially must not consume pool numbers on channels
  // that cannot deliver, or the pool is empty on the day it clears.

  reset();
  smsLive = false;
  const blocked = await openFor("appt-1");
  assert.strictEqual(blocked.opened, false);
  assert.strictEqual(blocked.reason, "sms_disabled");
  assert.strictEqual(rows.length, 0, "no row, no number consumed");

  reset({ pool: [] });
  const unconfigured = await openFor("appt-1");
  assert.strictEqual(unconfigured.reason, "pool_unconfigured");

  /* -- 10) A vendor with no phone is a named data gap --------------------- */
  // Not an error and not a crash: outreach is email-first, so an identity with
  // no phone is a legitimate state. It simply has no SMS channel.

  reset();
  const noPhone = await openFor("appt-1", "noPhone");
  assert.strictEqual(noPhone.opened, false);
  assert.strictEqual(noPhone.reason, "no_vendor_phone");

  /* -- 11) Vendor.phone is the fallback, normalized ----------------------- */
  // VendorIdentity is the global record and wins, but an identity created from
  // an email-only outreach has no phone while the landlord's roster row does.

  reset();
  assert.strictEqual(await resolveVendorPhone({ identityId: "ident1" }), PLUMBER);
  assert.strictEqual(
    await resolveVendorPhone({ identityId: "noPhone", vendorId: "vend1" }),
    PLUMBER,
    "a free-form roster phone is normalized to E.164, or the routing key would never match"
  );

  /* -- 12) Cancelling a request tears the channel down -------------------- */
  // The one terminal route that never reaches closeJobCompletion. Left open, it
  // is a live line into a cancelled request's thread for a vendor who is no
  // longer coming — and it pins a pool number to that vendor forever, which the
  // routing invariant then counts against their NEXT real job.

  // A ONE-number pool, so "the number came back" is unambiguous: with a larger
  // pool the allocator would legitimately hand out a different number (see 13),
  // and the assertion would pass without proving anything.
  reset({ pool: ["+15551110000"] });
  const live = await openFor("appt-1");
  assert.ok(live.opened);

  const torn = await closeProxySessionsForRequest({ requestId: "req-appt-1" });
  assert.strictEqual(torn.closed, 1);
  assert.strictEqual(
    await resolveInboundSession({ from: PLUMBER, to: live.session.proxyNumber }),
    null,
    "a text after cancellation must not reach the tenant"
  );

  // Without the teardown this would be pool_exhausted forever.
  const afterCancel = await openFor("appt-9");
  assert.ok(afterCancel.opened, "the number is genuinely back in circulation");
  assert.strictEqual(afterCancel.session.proxyNumber, live.session.proxyNumber);

  /* -- 13) Allocation avoids the number this vendor most recently used ---- */
  // Not load balancing — any free number is equally correct for routing. It is
  // about the vendor's phone: their messaging app threads by sender, so reusing
  // last week's number drops a new job into an old job's thread and a vendor
  // scrolling up reads the wrong address.

  reset();
  const jobOne = await openFor("appt-1");
  await closeProxySession({ appointmentId: "appt-1" });
  const jobTwo = await openFor("appt-2");
  assert.notStrictEqual(
    jobTwo.session.proxyNumber,
    jobOne.session.proxyNumber,
    "a fresh number is preferred over the one they just finished a job on"
  );

  console.log("proxySession.service: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
