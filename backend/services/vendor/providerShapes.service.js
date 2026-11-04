const DEFAULT_CURRENCY = "CAD";
const {
  extractSupportedVendorServices,
  normalizeSupportedVendorService,
} = require("./vendorServices.service");

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function normalizeVendorOption(input = {}) {
  const services = extractSupportedVendorServices([
    input.category,
    input.service,
    ...(Array.isArray(input.specialties) ? input.specialties : []),
    // Free-text trades the landlord typed; they route only if they resolve
    // through the same alias lookup as the presets.
    ...(Array.isArray(input.customSpecialties) ? input.customSpecialties : []),
  ]);

  return {
    providerName: String(input.providerName || "manual").trim().toLowerCase(),
    providerVendorId: String(
      input.providerVendorId || input.vendorId || input._id || input.name || "unknown-vendor"
    ).trim(),
    vendorId: input.vendorId || input._id?.toString?.() || null,
    name: String(input.name || "Unknown vendor").trim(),
    // Contact details are carried through so vendor outreach has a channel to
    // reach the candidate. They are stripped/masked again before any candidate
    // leaves the API — see buildScoredLedgerEntries and listVendorOutreach.
    email: String(input.email || "").trim().toLowerCase() || null,
    phone: String(input.phone || "").trim() || null,
    category: String(input.category || input.suggestedVendorType || "Other").trim(),
    specialties: toStringArray(input.specialties),
    // Carried through, not just read: scoring normalizes a candidate a second
    // time, and services are re-derived from whatever survives the first pass.
    customSpecialties: toStringArray(input.customSpecialties),
    service: normalizeSupportedVendorService(input.service) || services[0] || null,
    services,
    city: String(input.city || "").trim(),
    serviceAreas: toStringArray(
      input.serviceAreas?.length ? input.serviceAreas : input.serviceArea ? [input.serviceArea] : []
    ),
    rating: Math.max(0, Math.min(5, toNumber(input.rating, 0))),
    reliabilityScore: Math.max(0, Math.min(100, toNumber(input.reliabilityScore, 0))),
    avgResponseMinutes: Math.max(
      0,
      toNumber(input.avgResponseMinutes, input.responseStats?.averageFirstResponseMinutes || 0)
    ),
    hourlyRate: Math.max(0, toNumber(input.hourlyRate, input.averageCost || 0)),
    emergencyAvailable: Boolean(input.emergencyAvailable),
    // Hours of operation, passed through untouched. Recommendations preview the
    // windows outreach will offer, and those are built from these -- dropping
    // them here is what left every network vendor's availability "Pending".
    operatingHours: input.operatingHours || null,
    businessHours: input.businessHours ? String(input.businessHours) : null,
    insuranceVerified: Boolean(input.insuranceVerified),
    licenseVerified: Boolean(input.licenseVerified),
    source: String(input.source || "manual_dispatch").trim(),
    isDemoVendor: Boolean(input.isDemoVendor),
    verificationStatus: String(input.verificationStatus || "unverified").trim(),
    status: String(input.status || "active").trim(),
  };
}

function normalizePriceEstimate(input = {}, requestContext = {}, vendorOption = {}) {
  const amountLow = Math.max(0, toNumber(input.amountLow, input.low));
  const rawHigh = toNumber(input.amountHigh, input.high || amountLow);
  const amountHigh = rawHigh >= amountLow ? rawHigh : amountLow;

  return {
    providerName: String(
      input.providerName || vendorOption.providerName || requestContext.providerName || "manual"
    ).trim().toLowerCase(),
    providerVendorId: String(
      input.providerVendorId ||
        vendorOption.providerVendorId ||
        requestContext.providerVendorId ||
        "unknown-vendor"
    ).trim(),
    amountLow,
    amountHigh,
    currency: String(input.currency || DEFAULT_CURRENCY).trim().toUpperCase(),
    basis: String(input.basis || "estimate").trim(),
    confidence: String(input.confidence || "medium").trim(),
    summary: String(input.summary || "").trim(),
  };
}

function normalizeAvailabilitySlot(input = {}, vendorOption = {}) {
  const start = input.start ? new Date(input.start).toISOString() : null;
  const end = input.end ? new Date(input.end).toISOString() : null;

  return {
    providerName: String(input.providerName || vendorOption.providerName || "manual")
      .trim()
      .toLowerCase(),
    providerVendorId: String(
      input.providerVendorId || vendorOption.providerVendorId || "unknown-vendor"
    ).trim(),
    slotId: String(input.slotId || input.id || `${start || "slot"}-${end || "open"}`).trim(),
    label: String(input.label || "").trim(),
    start,
    end,
    timeZone: String(input.timeZone || "America/Regina").trim(),
    available: input.available !== false,
  };
}

function normalizeBookingRequest(input = {}) {
  return {
    requestId: String(input.requestId || "").trim(),
    landlordId: String(input.landlordId || "").trim(),
    tenantId: String(input.tenantId || "").trim(),
    vendorOption: normalizeVendorOption(input.vendorOption || {}),
    selectedSlot: input.selectedSlot ? normalizeAvailabilitySlot(input.selectedSlot, input.vendorOption) : null,
    messageDraft: String(input.messageDraft || "").trim(),
    demoMode: input.demoMode !== false,
  };
}

function normalizeBookingResult(input = {}, bookingRequest = {}) {
  return {
    providerName: String(
      input.providerName || bookingRequest.vendorOption?.providerName || "manual"
    ).trim().toLowerCase(),
    providerVendorId: String(
      input.providerVendorId || bookingRequest.vendorOption?.providerVendorId || "unknown-vendor"
    ).trim(),
    bookingId: String(input.bookingId || "").trim(),
    status: String(input.status || "pending").trim(),
    scheduledStart: input.scheduledStart ? new Date(input.scheduledStart).toISOString() : null,
    scheduledEnd: input.scheduledEnd ? new Date(input.scheduledEnd).toISOString() : null,
    note: String(input.note || "").trim(),
    isDemo: input.isDemo !== false,
  };
}

function normalizeProviderResult(input = {}) {
  return {
    providerName: String(input.providerName || "manual").trim().toLowerCase(),
    candidates: Array.isArray(input.candidates)
      ? input.candidates.map((candidate) => normalizeVendorOption(candidate))
      : [],
    meta: input.meta && typeof input.meta === "object" ? input.meta : {},
  };
}

function createProviderError(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

module.exports = {
  DEFAULT_CURRENCY,
  normalizeVendorOption,
  normalizePriceEstimate,
  normalizeAvailabilitySlot,
  normalizeBookingRequest,
  normalizeBookingResult,
  normalizeProviderResult,
  createProviderError,
};
