// What a landlord may set on a vendor in their network, and what it must be.
//
// WHY AN ALLOWLIST. createVendor used to destructure two dozen fields straight
// off req.body, so a landlord's own client could create a vendor with
// rating: 5, reliabilityScore: 100, verificationStatus: "trusted" or
// isDemoVendor: true -- every one of which the recommendation engine reads as
// earned signal. Those are system-owned. A landlord edits contact details,
// trades, coverage and hours -- and one judgement that is genuinely theirs:
// whether they trust this vendor enough to skip the per-job approval
// (`trusted`, mapped onto verificationStatus trusted/unverified). "blocked"
// and the demo statuses stay out of reach.
//
// WHY REQUIRED HERE AND NOT IN THE SCHEMA. Email and hours are mandatory for
// new and edited vendors, but rows that predate the rule have neither, and the
// sweepers .save() vendors to update stats. A schema `required` would make
// every one of those saves throw. The API boundary is where the rule applies.

const { validateHours, normalizeHours } = require("./vendorHours");

const EDITABLE_FIELDS = [
  "name",
  "email",
  "phone",
  "company",
  "city",
  "serviceAreas",
  "specialties",
  "customSpecialties",
  "operatingHours",
  "emergencyAvailable",
  "notes",
  "trusted",
];

const MAX_CUSTOM_SPECIALTIES = 5;
const MAX_CUSTOM_LENGTH = 40;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = (value) => (value === undefined || value === null ? "" : String(value).trim());
const strArray = (value) =>
  (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .map((entry) => str(entry))
    .filter(Boolean);

/** Only the editable keys that are present in `body`. */
function pickVendorInput(body = {}) {
  const picked = {};
  for (const key of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) picked[key] = body[key];
  }
  return picked;
}

/**
 * Validate a complete set of editable fields (for an update, the stored values
 * with the request's changes laid over them). Returns { value, fields }:
 * `value` is the cleaned document fragment to save, `fields` maps a field name
 * to the message the form shows under it. `fields` empty means valid.
 */
function validateVendorInput(input = {}) {
  const fields = {};

  const name = str(input.name);
  if (!name) fields.name = "Enter the vendor's name.";
  else if (name.length > 120) fields.name = "Keep the name under 120 characters.";

  const email = str(input.email).toLowerCase();
  if (!email) fields.email = "Enter an email address. Job offers are sent by email.";
  else if (!EMAIL_RE.test(email)) fields.email = "Enter a valid email address.";

  const phone = str(input.phone);
  if (phone) {
    const digits = phone.replace(/\D/g, "");
    if (!/^[+\d\s().-]+$/.test(phone) || digits.length < 7 || digits.length > 15) {
      fields.phone = "Enter a valid phone number, or leave it blank.";
    }
  }

  const hoursError = validateHours(input.operatingHours);
  if (hoursError) fields.operatingHours = hoursError;

  const specialties = strArray(input.specialties);
  const customSpecialties = strArray(input.customSpecialties);
  if (customSpecialties.length > MAX_CUSTOM_SPECIALTIES) {
    fields.customSpecialties = `Add at most ${MAX_CUSTOM_SPECIALTIES} other specialties.`;
  } else if (customSpecialties.some((value) => value.length > MAX_CUSTOM_LENGTH)) {
    fields.customSpecialties = `Keep each specialty under ${MAX_CUSTOM_LENGTH} characters.`;
  }

  if (Object.keys(fields).length) return { value: null, fields };

  return {
    value: {
      name,
      email,
      phone: phone || undefined,
      company: str(input.company) || undefined,
      city: str(input.city) || undefined,
      serviceAreas: strArray(input.serviceAreas),
      specialties,
      // The schema keeps `categories` as a mirror of specialties, but only
      // fills it when empty -- so an edit must set it, or a vendor moved off
      // Plumbing would keep matching plumbing jobs through the stale mirror.
      categories: specialties,
      customSpecialties,
      operatingHours: normalizeHours(input.operatingHours),
      emergencyAvailable: Boolean(input.emergencyAvailable),
      notes: str(input.notes) || undefined,
      // Not a schema field; the controller maps it onto verificationStatus.
      trusted: Boolean(input.trusted),
    },
    fields,
  };
}

/** The stored editable values of a vendor document, for merging an update. */
function editableSnapshot(vendor = {}) {
  const doc = typeof vendor.toObject === "function" ? vendor.toObject() : vendor;
  const snapshot = {};
  for (const key of EDITABLE_FIELDS) snapshot[key] = doc[key];
  snapshot.trusted = doc.verificationStatus === "trusted";
  return snapshot;
}

const contactKey = ({ phone, email } = {}) =>
  `${str(phone).replace(/\D/g, "")}|${str(email).toLowerCase()}`;

module.exports = {
  EDITABLE_FIELDS,
  pickVendorInput,
  validateVendorInput,
  editableSnapshot,
  contactKey,
};
