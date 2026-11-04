const SUPPORTED_VENDOR_SERVICES = [
  "Plumbing",
  "Electrical",
  "HVAC",
  "Appliance",
  "Pest",
  "Locks/Hardware",
  "Structural",
  "General Handyman",
  // Triage already emits "Cleaning" (categorization.service CATEGORIES); without
  // it here a cleaning request could never be matched to anyone.
  "Cleaning",
];

// The words landlords actually use for a trade, mapped onto the service the
// matcher understands. VENDOR SIDE ONLY: triage output and request categories
// still go through the exact lookup, so a model that answers "Plumber" instead
// of a real service name is rejected rather than quietly steering routing
// (categorization.service.test pins that).
// The Vendor Network form's preset chips are these labels
// ("Pest Control", not "Pest"), and before this map only four of its fifteen
// matched anything -- a vendor tagged "Locksmith" or "Appliance Repair" was
// excluded from every recommendation as `no_supported_service_profile`, hidden
// only because mock vendors filled the gap. Custom specialties typed by the
// landlord go through the same lookup, case-insensitively.
//
// Landscaping is deliberately absent: triage never produces it, so a
// landscaper is a roster entry for manual assignment, not a routing target.
const SERVICE_ALIASES = {
  "appliance repair": "Appliance",
  appliances: "Appliance",
  "pest control": "Pest",
  exterminator: "Pest",
  locksmith: "Locks/Hardware",
  locks: "Locks/Hardware",
  roofing: "Structural",
  "general maintenance": "General Handyman",
  handyman: "General Handyman",
  carpentry: "General Handyman",
  drywall: "General Handyman",
  painting: "General Handyman",
  flooring: "General Handyman",
  "heating & cooling": "HVAC",
  heating: "HVAC",
  "air conditioning": "HVAC",
  electrician: "Electrical",
  plumber: "Plumbing",
  janitorial: "Cleaning",
};

const SERVICE_LOOKUP = SUPPORTED_VENDOR_SERVICES.reduce((acc, service) => {
  acc[service.toLowerCase()] = service;
  return acc;
}, {});

const VENDOR_SPECIALTY_LOOKUP = { ...SERVICE_ALIASES, ...SERVICE_LOOKUP };

const EMERGENCY_SERVICE_HINTS = [
  { service: "Electrical", patterns: [/burning outlet/i, /outlet/i, /breaker/i, /wiring/i, /spark/i, /electrical/i, /shock/i] },
  { service: "Plumbing", patterns: [/burst pipe/i, /pipe/i, /leak/i, /flood/i, /toilet/i, /sink/i, /water/i] },
  { service: "HVAC", patterns: [/gas/i, /furnace/i, /boiler/i, /heater/i, /carbon monoxide/i, /co alarm/i, /heating/i] },
  { service: "Locks\/Hardware", patterns: [/lock/i, /door/i, /window/i, /handle/i] },
  { service: "Structural", patterns: [/ceiling/i, /roof/i, /wall/i, /floor/i, /collapse/i] },
];

const EXCLUSION_REASON_LABELS = {
  blocked_vendor: "Blocked vendor",
  inactive_vendor: "Inactive vendor",
  outside_service_area: "Outside service area",
  no_emergency_coverage: "Not emergency ready",
  vendor_service_unresolved: "Vendor service could not be resolved",
  service_mismatch: "Does not provide the required vendor service",
  no_supported_service_profile: "Vendor profile does not map to a supported service",
  held_for_active_candidate: "On hold because another vendor candidate is active",
  already_active_candidate: "Another vendor candidate is already active for this request",
  request_not_routeable: "Request is not currently routeable",
};

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeSupportedVendorService(value) {
  const normalized = normalizeText(value).toLowerCase();
  return SERVICE_LOOKUP[normalized] || null;
}

// A label on a vendor's profile (preset chip or typed custom trade) -> service.
function normalizeVendorSpecialty(value) {
  return VENDOR_SPECIALTY_LOOKUP[normalizeText(value).toLowerCase()] || null;
}

function isSupportedVendorService(value) {
  return Boolean(normalizeSupportedVendorService(value));
}

function isVendorServiceCategory(value) {
  return isSupportedVendorService(value);
}

function inferVendorServiceFromMessage(message = "") {
  const text = normalizeText(message);
  if (!text) return null;

  for (const hint of EMERGENCY_SERVICE_HINTS) {
    if (hint.patterns.some((pattern) => pattern.test(text))) {
      return hint.service;
    }
  }

  return null;
}

function resolveVendorServiceNeeded({ suggestedVendorType, category, message } = {}) {
  const normalizedSuggested = normalizeSupportedVendorService(suggestedVendorType);
  if (normalizedSuggested) return normalizedSuggested;

  const normalizedCategory = normalizeSupportedVendorService(category);
  if (normalizedCategory) return normalizedCategory;

  return inferVendorServiceFromMessage(message);
}

// Reads a VENDOR's labels, so it takes the alias-aware lookup.
function extractSupportedVendorServices(values = []) {
  const services = [];
  values.forEach((value) => {
    const normalized = normalizeVendorSpecialty(value);
    if (normalized && !services.includes(normalized)) {
      services.push(normalized);
    }
  });
  return services;
}

function getReasonLabel(reasonCode) {
  return EXCLUSION_REASON_LABELS[reasonCode] || reasonCode;
}

module.exports = {
  SUPPORTED_VENDOR_SERVICES,
  SERVICE_ALIASES,
  normalizeSupportedVendorService,
  normalizeVendorSpecialty,
  isSupportedVendorService,
  isVendorServiceCategory,
  inferVendorServiceFromMessage,
  resolveVendorServiceNeeded,
  extractSupportedVendorServices,
  getReasonLabel,
};
