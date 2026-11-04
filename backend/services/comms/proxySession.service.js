// Opening, resolving and closing a masked SMS channel.
//
// Every function here is FAIL-SOFT, and that is a product decision, not
// defensive habit. The channel is opened at the moment a vendor accepts a job —
// after they have committed an arrival time, after the escrow hold, after the
// tenant has been told someone is coming. Refusing to book a job because a
// number pool is full would let a Twilio subscription tier decide whether a
// plumber gets hired. So a failure here degrades to the honest gap the relay
// layer already renders ("your property manager can relay"), and the job runs.
//
// The mirror of that: we never claim a channel we cannot deliver on. There is
// no half-open state — either an open ProxySession exists and the number in it
// is real and routable, or the vendor is told messaging isn't available.

const ProxySession = require("../../models/ProxySession");
const VendorIdentity = require("../../models/VendorIdentity");
const Vendor = require("../../models/Vendor");
const { normalizePhoneE164 } = require("../vendor/vendorIdentity.service");
const { allocateProxyNumber, poolSize } = require("./numberPool.service");
const { isSmsLive } = require("../notification/sms.service");

/**
 * The vendor's real phone, in E.164, or null.
 *
 * VendorIdentity first: it is the global contractor record and its phoneE164 is
 * already normalized and unique-indexed. Vendor.phone is the landlord-scoped
 * roster entry, free-form, and is the fallback for a vendor whose identity was
 * created from an email-only outreach.
 */
async function resolveVendorPhone({ identityId, vendorId }) {
  if (identityId) {
    const identity = await VendorIdentity.findById(identityId).select("phoneE164").lean();
    if (identity?.phoneE164) return identity.phoneE164;
  }
  if (vendorId) {
    const vendor = await Vendor.findById(vendorId).select("phone").lean();
    const normalized = normalizePhoneE164(vendor?.phone);
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Open the channel for one job. Idempotent: re-entry returns the existing open
 * session rather than allocating a second number for the same appointment.
 *
 * Returns { opened, session, reason }. `reason` names WHY there is no channel,
 * because the three no-channel cases are genuinely different operational
 * problems: `sms_disabled` is waiting on carrier paperwork, `no_vendor_phone`
 * is a data gap on one vendor, and `pool_exhausted` means buy more numbers.
 */
async function openProxySession({
  requestId,
  appointmentId,
  tenantId,
  identityId = null,
  vendorId = null,
  landlordId = null,
  outreachId = null,
  vendorNameSnapshot = null,
}) {
  if (!requestId || !appointmentId || !tenantId) {
    return { opened: false, session: null, reason: "missing_context" };
  }

  const existing = await ProxySession.findOne({ appointmentId, status: "open" });
  if (existing) return { opened: false, session: existing, reason: "already_open" };

  // Checked before allocating rather than after. Burning a number from the pool
  // on a channel that cannot send is how a pool silently exhausts itself while
  // registration is still pending.
  if (!isSmsLive()) return { opened: false, session: null, reason: "sms_disabled" };
  if (!poolSize()) return { opened: false, session: null, reason: "pool_unconfigured" };

  const vendorPhoneE164 = await resolveVendorPhone({ identityId, vendorId });
  if (!vendorPhoneE164) return { opened: false, session: null, reason: "no_vendor_phone" };

  const proxyNumber = await allocateProxyNumber({ vendorPhoneE164 });
  if (!proxyNumber) {
    // Every number is already paired with THIS vendor — they are holding as
    // many concurrent jobs as we have numbers. See models/ProxySession.js.
    console.error(
      `[proxySession] pool exhausted for ${vendorPhoneE164}: ${poolSize()} numbers, all already paired with this vendor`
    );
    return { opened: false, session: null, reason: "pool_exhausted" };
  }

  try {
    const session = await ProxySession.create({
      proxyNumber,
      vendorPhoneE164,
      requestId,
      appointmentId,
      tenantId,
      identityId,
      landlordId,
      outreachId,
      vendorNameSnapshot,
      status: "open",
      openedAt: new Date(),
    });
    return { opened: true, session, reason: null };
  } catch (err) {
    // A duplicate key here is one of the two unique partial indexes firing —
    // either a concurrent open for the same appointment, or (the invariant) a
    // racing allocation that picked the same number for the same vendor. Both
    // mean "somebody else won"; re-read rather than retry.
    if (err?.code === 11000) {
      const winner = await ProxySession.findOne({ appointmentId, status: "open" });
      if (winner) return { opened: false, session: winner, reason: "already_open" };
      return { opened: false, session: null, reason: "allocation_conflict" };
    }
    throw err;
  }
}

/**
 * Close the channel. Idempotent — the status claim is the guard, so the
 * completion sweeper and a tenant confirming at the same instant both land on
 * one close.
 */
async function closeProxySession({ appointmentId, reason = "job_closed" }) {
  if (!appointmentId) return { closed: false, reason: "missing_context" };
  const session = await ProxySession.findOneAndUpdate(
    { appointmentId, status: "open" },
    { $set: { status: "closed", closedAt: new Date(), closeReason: reason } },
    { new: true }
  );
  if (!session) return { closed: false, reason: "not_open" };
  return { closed: true, session };
}

/**
 * Close every open channel on a request, whatever appointment it hangs off.
 *
 * closeProxySession is keyed on an appointment because that is what a job close
 * knows. A CANCELLED request is different: it can be cancelled from the request
 * itself, without anyone loading the appointment, and it must still tear the
 * channel down. Leaving it open would be two separate faults at once — a live
 * line into a tenant's request thread for a vendor who is no longer on the job,
 * and a pool number pinned to that vendor forever, which the routing invariant
 * then counts against their next real job.
 *
 * Plural on purpose: this is the cleanup path, so it takes whatever it finds
 * rather than assuming the usual one-open-session case holds.
 */
async function closeProxySessionsForRequest({ requestId, reason = "job_cancelled" }) {
  if (!requestId) return { closed: 0 };
  const result = await ProxySession.updateMany(
    { requestId, status: "open" },
    { $set: { status: "closed", closedAt: new Date(), closeReason: reason } }
  );
  return { closed: result?.modifiedCount || 0 };
}

/**
 * Inbound routing. `from` is the vendor's real phone, `to` is our proxy number,
 * and this pair is the ONLY routing information an SMS carries.
 *
 * The unique partial index on (proxyNumber, vendorPhoneE164) over open rows is
 * what makes at-most-one true in the database rather than merely likely here.
 */
async function resolveInboundSession({ from, to }) {
  const vendorPhoneE164 = normalizePhoneE164(from);
  const proxyNumber = normalizePhoneE164(to);
  if (!vendorPhoneE164 || !proxyNumber) return null;
  return ProxySession.findOne({ vendorPhoneE164, proxyNumber, status: "open" });
}

/**
 * The open channel for a job, if any. Used by the relay projection.
 *
 * NON-THROWING, deliberately. This is called once per row while building a
 * tenant's appointment list, purely to decorate each row with a contact block.
 * A lookup that throws — a malformed id, a Mongo blip — would take down the
 * entire list over a decoration, and the caller has already loaded the rows it
 * actually needs. Degrading to "no channel" renders the honest unavailable
 * state instead, which is a state the UI already handles.
 */
async function getOpenSessionForAppointment(appointmentId) {
  if (!appointmentId) return null;
  try {
    return await ProxySession.findOne({ appointmentId, status: "open" }).lean();
  } catch (err) {
    console.error("[proxySession] session lookup failed", err.message);
    return null;
  }
}

/**
 * The open channel for a REQUEST. postComment has a request and no appointment,
 * so this is the outbound fan-out's entry point.
 *
 * A request can accumulate several appointments over its life (a vendor falls
 * through, a second is routed), but only one channel is ever open at a time —
 * closeProxySession runs before the next acceptance can open one. The sort is
 * belt-and-braces so a stale open row from a crashed close cannot outrank the
 * live channel.
 */
async function getOpenSessionForRequest(requestId) {
  if (!requestId) return null;
  try {
    return await ProxySession.findOne({ requestId, status: "open" }).sort({ openedAt: -1 }).lean();
  } catch (err) {
    console.error("[proxySession] request session lookup failed", err.message);
    return null;
  }
}

module.exports = {
  openProxySession,
  closeProxySession,
  closeProxySessionsForRequest,
  resolveInboundSession,
  getOpenSessionForAppointment,
  getOpenSessionForRequest,
  resolveVendorPhone,
};
