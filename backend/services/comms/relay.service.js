// Masked vendor <-> tenant contact.
//
// The product rule: a vendor communicates entirely off-app (plain SMS from
// their own phone) and a tenant communicates entirely in-app, and NEITHER ever
// learns the other's real number. The masking lives here, in the relay layer —
// the Tenant record is never mutated and no generated number is ever written
// onto it, so there is nothing to reverse when a job ends.
//
// This module is the provider seam, shaped exactly like
// notification/email.service.js: `provider` names the rail, and a stub rail is
// the default so the surrounding flow is exercisable before the real one exists.
//
// THE TWO DIRECTIONS ARE NOT SYMMETRIC, which is the thing to understand here.
// They used to be — getTenantFacingVendorContact simply delegated — and that
// was wrong in a way that would only have shown up in production:
//
//   VENDOR -> TENANT is SMS. The vendor gets a real, dialable proxy number and
//       texts it from their own phone. Inbound resolves on (From, To).
//
//   TENANT -> VENDOR is IN-APP. The tenant posts a comment and the server fans
//       it out. The tenant must NEVER be shown the proxy number, because
//       inbound routing keys on `From` being the VENDOR's phone — a text from
//       the tenant's phone to that number matches no open session and is
//       unroutable, and a voice call to it rings nothing. Handing a tenant a
//       number that silently swallows their messages is worse than handing them
//       no number, and AppointmentCard.tsx renders `phone` whenever it is
//       present, so the projection is the only place this can be prevented.
//
// IMPORTANT: whatever this returns is handed to buildRevealedDetails and shipped
// to a vendor. It must never carry the tenant's real phone or email.

const env = require("../../config/env");
const { getOpenSessionForAppointment } = require("./proxySession.service");

const RELAY_UNAVAILABLE_LABEL =
  "Direct messaging with the tenant isn't available yet — your property manager can relay.";

// While the relay is deliberately switched off there is no "yet" to promise: the
// feature is deferred, not pending. Say only what is true -- who to ask.
const RELAY_OFF_LABEL = "Your property manager can relay messages to the tenant.";
const TENANT_OFF_LABEL = "Your property manager can relay messages to your vendor.";

const RELAY_AVAILABLE_LABEL =
  "Text this number to reach the tenant. Your own number stays private, and so does theirs.";

const TENANT_IN_APP_LABEL =
  "Message your vendor here — they'll get it as a text. Neither of you sees the other's number.";

const TENANT_UNAVAILABLE_LABEL =
  "Messaging with your vendor isn't available yet — your property manager can relay.";

/**
 * The contact block a vendor sees for the tenant, post-acceptance, when there
 * is no channel.
 *
 * Deliberately returns no number at all rather than a plausible-looking
 * placeholder: a fake number that reads as real is worse than an honest gap,
 * because a vendor standing outside a building will dial it.
 */
function buildStubRelayContact({ managerPhone = null } = {}) {
  return {
    channel: "relay",
    provider: "stub",
    phone: null,
    extension: null,
    available: false,
    label: env.relay_sms_enabled ? RELAY_UNAVAILABLE_LABEL : RELAY_OFF_LABEL,
    fallback: { kind: "manager", phone: managerPhone || null },
  };
}

/**
 * Resolve the relay contact for one job — the VENDOR-facing side.
 *
 * Async from the start even though the stub needs nothing: the ProxySession
 * lookup drops in here with no caller change, because making the signature
 * async later would ripple through buildResponsePayload, which is synchronous
 * on purpose.
 */
async function getRelayContact({ requestId, appointmentId, identityId, managerPhone } = {}) {
  void requestId;
  void identityId;

  const session = appointmentId ? await getOpenSessionForAppointment(appointmentId) : null;
  if (!session?.proxyNumber) return buildStubRelayContact({ managerPhone });

  return {
    channel: "relay",
    provider: "twilio",
    // The POOL number, never the tenant's. This is the whole feature.
    phone: session.proxyNumber,
    extension: null,
    available: true,
    label: RELAY_AVAILABLE_LABEL,
    // Kept even when the relay works: a vendor with an access problem at 7am
    // needs a human, and the relay only reaches the tenant.
    fallback: { kind: "manager", phone: managerPhone || null },
  };
}

/**
 * The mirror image: what a TENANT sees for the vendor. Carries NO phone in
 * either state — see the header for why the proxy number must not appear here.
 */
async function getTenantFacingVendorContact({ requestId, appointmentId, managerPhone } = {}) {
  void requestId;

  const session = appointmentId ? await getOpenSessionForAppointment(appointmentId) : null;
  const available = Boolean(session?.proxyNumber);

  return {
    channel: "in_app",
    provider: available ? "twilio" : "stub",
    phone: null,
    extension: null,
    available,
    label: available
      ? TENANT_IN_APP_LABEL
      : env.relay_sms_enabled
        ? TENANT_UNAVAILABLE_LABEL
        : TENANT_OFF_LABEL,
    fallback: { kind: "manager", phone: managerPhone || null },
  };
}

module.exports = {
  getRelayContact,
  getTenantFacingVendorContact,
  buildStubRelayContact,
  RELAY_UNAVAILABLE_LABEL,
  RELAY_AVAILABLE_LABEL,
  TENANT_IN_APP_LABEL,
  TENANT_UNAVAILABLE_LABEL,
};
