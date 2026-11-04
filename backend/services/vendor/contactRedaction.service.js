// Masks contact and location details in tenant free text before it reaches a
// vendor-facing surface.
//
// The tenant's additional notes are the one piece of raw tenant prose that goes
// into an outreach draft, and the draft becomes a real email sent BEFORE the
// vendor accepts -- the city-only rule in vendorBrief.service.js applies. Two
// layers, because neither is enough alone:
//
//   1. Known values from the request itself (tenant name, unit number, property
//      name, street line). Exact, so no false positives, but only as good as
//      what is populated.
//   2. Pattern matches for the shapes those details take in prose (emails,
//      phone numbers, "unit 4B" / "apt 12" / "#305", "1200 Broad Street").
//
// It cannot catch everything -- a neighbour's name, say. That is acceptable
// because the draft is shown to the landlord, editable, before it is sent.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// 306-555-0199, (306) 555 0199, +1 306.555.0199, 3065550199
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const UNIT_PHRASE = /\b(?:unit|apt|apartment|suite|ste|room|rm)\b\.?\s*(?:no\.?|number|#)?\s*[A-Z]?\d+[A-Z]?\b/gi;
const HASH_UNIT = /(^|[\s(])#\s?\d+[A-Z]?\b/gi;
const STREET =
  /\b\d{1,6}\s+(?:[A-Z][A-Za-z]*\.?\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Crescent|Cres|Lane|Ln|Way|Court|Ct|Place|Pl|Terrace|Trail|Parkway|Pkwy)\b\.?/g;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceKnown(text, values, mask) {
  let out = text;
  for (const raw of values) {
    const value = String(raw || "").trim();
    // A one-letter value ("B") would mask half the sentence.
    if (value.length < 2) continue;
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegex(value)}(?![A-Za-z0-9])`, "gi"), mask);
  }
  return out;
}

// The parts of a populated request worth masking. Missing or unpopulated
// references (bare ObjectIds) simply contribute nothing.
function knownDetailsFromRequest(request) {
  const tenant = request?.tenantId && typeof request.tenantId === "object" ? request.tenantId : {};
  const property = request?.propertyId && typeof request.propertyId === "object" ? request.propertyId : {};
  const unit = request?.unitId && typeof request.unitId === "object" ? request.unitId : {};
  const address = typeof property.address === "string" ? property.address : property.address?.street;
  return {
    names: [tenant.firstName, tenant.lastName, tenant.name].filter(Boolean),
    addresses: [address ? String(address).split(",")[0] : null].filter(Boolean),
    properties: [property.name].filter(Boolean),
    // A unit number only counts when it has a digit: "Main" or "Upper" as a
    // unit label would collide with ordinary words.
    units: [unit.unitNumber, unit.name].filter((value) => /\d/.test(String(value || ""))),
  };
}

function redactContactDetails(text, known = {}) {
  let out = String(text || "");
  if (!out.trim()) return "";
  out = out.replace(EMAIL, "[email]");
  out = out.replace(PHONE, "[phone]");
  out = replaceKnown(out, known.addresses || [], "[address]");
  out = out.replace(STREET, "[address]");
  out = replaceKnown(out, known.properties || [], "[property]");
  out = out.replace(UNIT_PHRASE, "[unit]");
  out = out.replace(HASH_UNIT, "$1[unit]");
  out = replaceKnown(out, known.units || [], "[unit]");
  out = replaceKnown(out, known.names || [], "[name]");
  return out;
}

module.exports = { redactContactDetails, knownDetailsFromRequest };
