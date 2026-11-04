// The vendor-facing projections of a maintenance request.
//
// THIS FILE IS THE PRIVACY BOUNDARY. It is enforced server-side on purpose:
// hiding fields in the UI still ships them in the JSON, and anyone with the
// magic link can read the network tab. A vendor who has not accepted the job
// must not receive tenant-identifying data at all.
//
//   buildPublicBrief(...)      -> safe to send to anyone holding the token
//   buildRevealedDetails(...)  -> ONLY after outreach.status === "accepted"
//
// If you add a field here, add it to the correct function and extend
// tests/unit/services/vendorBrief.service.test.js, which asserts that a
// serialized public brief contains none of the protected strings.

const { resolveRequestCity, formatCityLabel } = require("./vendorScoring.service");
const { getTierLabel } = require("./vendorOutreachPolicy.service");
const { buildStubRelayContact } = require("../comms/relay.service");

const URGENCY_LABELS = {
  low: "Low",
  medium: "Standard",
  high: "High",
  emergency: "Emergency",
};

// "Alex Thompson" -> "Alex T." Never the full surname.
function buildTenantDisplayName(tenant) {
  const first = String(tenant?.firstName || "").trim();
  const lastInitial = String(tenant?.lastName || "").trim().charAt(0);
  if (!first) return "The tenant";
  return lastInitial ? `${first} ${lastInitial}.` : first;
}

function buildManagerPublic(landlord) {
  const name = [landlord?.firstName, landlord?.lastName].filter(Boolean).join(" ").trim();
  return {
    name: name || "Property manager",
    company: landlord?.companyName || null,
    // Deliberately no phone/email — those are revealed only after accepting.
  };
}

// Generic, non-identifying access facts. Enough for a vendor to price the job
// (a pet on site changes how you plan entry) without describing the household.
function buildAccessConstraints(request) {
  const constraints = [];
  const access = request?.incidentRecord?.access;
  if (access?.pets === true) constraints.push("Pets on site");
  if (access?.permissionToEnter === true) constraints.push("Entry permission already granted");
  if (access?.permissionToEnter === false) constraints.push("Tenant must be present for entry");
  const room = request?.incidentRecord?.location?.room;
  if (room) constraints.push(`Work area: ${room}`);
  return constraints;
}

// The tenant's timing preference, as the AI normalised it at intake: short
// phrases like "weekday mornings", at most five. Safe before acceptance in a
// way the free-text `request.preferredTime` is not -- that field is entry notes
// typed by the tenant and can carry names, buzzer codes and numbers, so it
// stays post-accept (buildRevealedDetails). Capped per phrase so a long
// sentence the model kept verbatim can't smuggle detail through.
function buildPreferredTimes(request) {
  const raw = request?.incidentRecord?.access?.preferredTimes;
  return (Array.isArray(raw) ? raw : [])
    .map((value) => String(value || "").trim())
    .filter((value) => value && value.length <= 60)
    .slice(0, 5);
}

function buildEvidencePhotos(request) {
  const assets = request?.incidentRecord?.evidence?.assets || [];
  return assets
    .filter((asset) => asset?.url)
    .map((asset) => ({
      url: asset.url,
      type: asset.type || "image",
      label: asset.label || null,
    }));
}

// The offered windows as the vendor page needs them. `timeZone` is the zone
// the windows (and their labels) were built in, so the page turns a typed
// arrival into an instant in THAT zone rather than the phone's.
function publicWindows(windows) {
  return (windows || []).map((slot) => ({
    slotId: slot.slotId,
    label: slot.label,
    start: slot.start || null,
    end: slot.end || null,
    kind: slot.kind || "window",
    timeZone: slot.timeZone || null,
  }));
}

/**
 * Pre-accept projection. Safe to return to any holder of a valid token.
 *
 * Deliberately excluded: street address, unit number, tenant name, tenant
 * phone/email, entry instructions, preferred-time free text, manager direct
 * contact, internal scores/reasonCodes, the recommendation snapshot.
 * (The AI-normalised preferredTimes phrases ARE included -- see
 * buildPreferredTimes for why those differ from the free text.)
 */
function buildPublicBrief({ request, outreach, landlord, property }) {
  const incident = request?.incidentRecord || null;
  const photos = buildEvidencePhotos(request);

  return {
    // Derived from the outreach id, NOT the requestId — a vendor never learns
    // an identifier that addresses anything else in the system.
    jobReference: `JOB-${String(outreach?._id || "").slice(-6).toUpperCase()}`,
    category: request?.category || incident?.category || "Maintenance",
    trade: incident?.trade || request?.vendorTypeNeeded || null,
    shortTitle: request?.ai?.shortTitle || request?.issueTitle || "Maintenance request",
    summary: incident?.summary || request?.ai?.summary || "",
    impact: incident?.impact || "",
    timeline: {
      started: incident?.timeline?.started || "",
      trend: incident?.timeline?.trend || "Unknown",
    },
    // Urgency label and tier only — never the numeric severity or the internal
    // routing reason codes.
    urgencyLabel: URGENCY_LABELS[request?.urgency] || "Standard",
    tier: outreach?.tier || "normal",
    tierLabel: getTierLabel(outreach?.tier),
    // A vendor must know it's a gas job before deciding whether to take it.
    riskType: incident?.safety?.riskType || null,
    safetyRisk: Boolean(incident?.safety?.safetyRisk),
    // City only. No street address, no unit, no property name.
    city: formatCityLabel(resolveRequestCity({ property })) || "",
    accessConstraints: buildAccessConstraints(request),
    // Before accepting, so the vendor can pick the window closest to it.
    preferredTimes: buildPreferredTimes(request),
    photos,
    photoCount: photos.length,
    manager: buildManagerPublic(landlord),
    messageBody: outreach?.messageBody || "",
    offeredWindows: publicWindows(outreach?.offeredWindows),
    responseDeadlineAt: outreach?.responseDeadlineAt || null,
    quoteCurrency: "CAD",
    ...(outreach?.quoteContractVersion === 2 ? { quoteContractVersion: 2 } : {}),
  };
}

/**
 * Post-accept projection. Only ever returned once the vendor has committed —
 * callers MUST check outreach.status === "accepted" before invoking this.
 *
 * Still excluded at this stage: tenant email, tenant PHONE, tenant full surname,
 * other tenants at the property, other candidates' quotes, landlord quota
 * figures.
 *
 * The tenant's real number used to be revealed here. It no longer is, and there
 * is deliberately no deprecated alias for it — an alias would be the exact leak
 * this closes. Vendors reach the tenant through the masked relay instead
 * (services/comms/relay.service.js), which the CALLER resolves and passes in as
 * `relayContact`; this module stays a pure synchronous projection.
 */
function buildRevealedDetails({ request, outreach, landlord, property, unit, tenant, relayContact }) {
  const incident = request?.incidentRecord || null;

  return {
    property: {
      name: property?.name || "",
      address: property?.address || "",
      unitNumber: unit?.unitNumber || "",
    },
    tenant: {
      displayName: buildTenantDisplayName(tenant),
      // No `phone` key at all. See buildStubRelayContact for why this carries no
      // placeholder number.
      contact: relayContact || buildStubRelayContact({ managerPhone: landlord?.phone || null }),
    },
    access: {
      permissionToEnter:
        incident?.access?.permissionToEnter !== null &&
        incident?.access?.permissionToEnter !== undefined
          ? incident.access.permissionToEnter
          : request?.accessPermission ?? null,
      pets: incident?.access?.pets ?? null,
      preferredTimes: incident?.access?.preferredTimes || [],
      entryNotes: request?.preferredTime || "",
    },
    manager: {
      ...buildManagerPublic(landlord),
      phone: landlord?.phone || null,
      email: landlord?.email || null,
    },
    confirmedWindow: outreach?.response?.selectedWindow || null,
    // The precise commitment, which is what everyone actually coordinates on.
    scheduledArrivalAt: outreach?.response?.scheduledArrivalAt || null,
    durationMinutes: outreach?.response?.durationMinutes ?? null,
    quote: {
      low: require("../quotes/currentQuote.service").currentQuote(outreach).low,
      high: require("../quotes/currentQuote.service").currentQuote(outreach).high,
      currency: outreach?.response?.quoteCurrency || "CAD",
    },
    nextSteps:
      "The property manager has been notified. The tenant will confirm your arrival time before the appointment is final — you'll get a confirmation email.",
  };
}

module.exports = {
  publicWindows,
  buildPublicBrief,
  buildRevealedDetails,
  buildTenantDisplayName,
  buildManagerPublic,
  buildAccessConstraints,
};
