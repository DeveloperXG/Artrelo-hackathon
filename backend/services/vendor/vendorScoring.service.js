const { normalizeVendorOption } = require("./providerShapes.service");
const {
  normalizeSupportedVendorService,
  getReasonLabel,
} = require("./vendorServices.service");

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

// Bonus for a vendor whose specialties match the incident's specific subcategory —
// e.g. a "Leaking pipe" incident favors a plumber who lists "leak"/"pipe" specialties
// over a generic one. A no-match adds nothing (never a penalty), so this can only
// improve targeting, not regress existing rankings.
const SPECIALTY_MATCH_POINTS = 10;
const SPECIALTY_STOPWORDS = new Set([
  "the", "and", "for", "issue", "issues", "problem", "repair", "repairs",
  "service", "services", "general", "other", "maintenance", "fix",
]);

// Light stem so "leaking"/"leaks" match "leak", "cleaning" matches "clean", etc.
// Only strips when the result stays >= 4 chars, so short words like "gas" are safe.
const stemToken = (token) => {
  const stemmed = token.replace(/(ing|ed|s)$/, "");
  return stemmed.length >= 4 ? stemmed : token;
};

const specialtyTokens = (value) =>
  new Set(
    normalizeText(value)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !SPECIALTY_STOPWORDS.has(token))
      .map(stemToken)
  );

function specialtyMatchBonus(subcategory, specialties) {
  const sub = specialtyTokens(subcategory);
  if (!sub.size || !Array.isArray(specialties) || !specialties.length) return 0;
  const matched = specialties.some((specialty) => {
    const tokens = specialtyTokens(specialty);
    for (const token of sub) {
      if (tokens.has(token)) return true;
    }
    return false;
  });
  return matched ? SPECIALTY_MATCH_POINTS : 0;
}

function parseCityFromAddress(address = "") {
  const lowered = normalizeText(address);
  const knownCities = ["regina", "saskatoon", "calgary", "edmonton", "winnipeg"];
  return knownCities.find((city) => lowered.includes(city)) || "";
}

function resolveRequestCity(requestContext = {}) {
  return normalizeText(
    requestContext.city ||
      requestContext.property?.city ||
      parseCityFromAddress(requestContext.property?.address || "")
  );
}

// resolveRequestCity normalizes to lowercase for matching. Anything shown to a
// human (vendor email, response form) should go through this first.
function formatCityLabel(city = "") {
  return String(city)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function resolveNeededCategory(requestContext = {}) {
  return normalizeSupportedVendorService(
    requestContext.vendorTypeNeeded ||
      requestContext.request?.vendorTypeNeeded ||
      requestContext.category ||
      requestContext.request?.category
  );
}

function candidateMatchesCategory(candidate, requestContext) {
  const needed = resolveNeededCategory(requestContext);
  if (!needed) return true;

  const services = Array.isArray(candidate.services)
    ? candidate.services
    : candidate.service
    ? [candidate.service]
    : [];

  return services.includes(needed);
}

function candidateMatchesCity(candidate, requestContext) {
  const city = resolveRequestCity(requestContext);
  if (!city) return true;

  const values = [candidate.city, ...(candidate.serviceAreas || [])]
    .map(normalizeText)
    .filter(Boolean);

  return values.some((value) => value === city || value.includes(city) || city.includes(value));
}

function evaluateHardConstraints(requestContext = {}, vendorOption = {}) {
  const candidate = normalizeVendorOption(vendorOption);
  const reasonCodes = [];

  if (candidate.status !== "active") reasonCodes.push("inactive_vendor");
  if (candidate.verificationStatus === "blocked") reasonCodes.push("blocked_vendor");
  if (!candidate.services?.length) reasonCodes.push("no_supported_service_profile");
  if (!candidateMatchesCategory(candidate, requestContext)) reasonCodes.push("service_mismatch");
  if (!candidateMatchesCity(candidate, requestContext)) reasonCodes.push("outside_service_area");

  const urgency = normalizeText(requestContext.urgency || requestContext.request?.urgency);
  if (urgency === "emergency" && !candidate.emergencyAvailable) {
    reasonCodes.push("no_emergency_coverage");
  }

  return {
    candidate,
    eligible: reasonCodes.length === 0,
    reasonCodes,
    humanReadableReasons: reasonCodes.map((reasonCode) => getReasonLabel(reasonCode)),
  };
}

function scoreVendor(requestContext = {}, vendorOption = {}, extras = {}) {
  const candidate = normalizeVendorOption(vendorOption);
  const priceEstimate = extras.priceEstimate || { amountHigh: candidate.hourlyRate || 0 };
  const urgency = normalizeText(requestContext.urgency || requestContext.request?.urgency);

  const reliabilityComponent = Math.round((candidate.reliabilityScore / 100) * 30);
  const responseComponent = Math.max(
    0,
    Math.round(20 - Math.min(candidate.avgResponseMinutes || 240, 240) / 12)
  );
  const costAnchor = Math.max(Number(priceEstimate.amountHigh || candidate.hourlyRate || 0), 0);
  // An unknown cost scores the midpoint. Anchoring it at $0 gave a vendor with
  // no price history the BEST possible cost score -- rewarding the unproven
  // vendor over one whose paid jobs we can actually see.
  const costComponent =
    costAnchor > 0 ? Math.max(0, Math.round(20 - Math.min(costAnchor, 400) / 20)) : 10;
  const verificationComponent =
    (candidate.insuranceVerified ? 5 : 0) +
    (candidate.licenseVerified ? 3 : 0) +
    (candidate.verificationStatus === "trusted" || candidate.verificationStatus === "mock_verified"
      ? 2
      : 0);
  const emergencyComponent =
    urgency === "emergency" || urgency === "high"
      ? candidate.emergencyAvailable
        ? 12
        : 0
      : candidate.emergencyAvailable
      ? 4
      : 0;
  const sourceComponent =
    candidate.source === "preset"
      ? 12
      : candidate.source === "manual_dispatch"
      ? 8
      : 0;
  const ratingComponent = Math.round((candidate.rating / 5) * 12);
  // Incident-driven: reward vendors whose specialties fit the specific subcategory.
  const specialtyComponent = specialtyMatchBonus(
    requestContext.subcategory,
    candidate.specialties
  );

  const scoreBreakdown = {
    reliability: reliabilityComponent,
    responseTime: responseComponent,
    cost: costComponent,
    verification: verificationComponent,
    emergencyFit: emergencyComponent,
    sourcePreference: sourceComponent,
    rating: ratingComponent,
    specialtyMatch: specialtyComponent,
  };

  const score = Object.values(scoreBreakdown).reduce((total, value) => total + value, 0);

  return {
    ...candidate,
    score,
    scoreBreakdown,
  };
}

function scoreEligibleCandidates(requestContext = {}, candidates = [], extrasByKey = {}) {
  const sourceTier = (source) => {
    if (source === "preset") return 0;
    if (source === "manual_dispatch") return 1;
    return 2;
  };

  return candidates
    .map((candidate) =>
      scoreVendor(
        requestContext,
        candidate,
        extrasByKey[candidate.providerName + "::" + candidate.providerVendorId] || {}
      )
    )
    .sort((left, right) => {
      if (sourceTier(left.source) !== sourceTier(right.source)) {
        return sourceTier(left.source) - sourceTier(right.source);
      }
      if (left.score !== right.score) return right.score - left.score;
      if (left.reliabilityScore !== right.reliabilityScore) {
        return right.reliabilityScore - left.reliabilityScore;
      }
      return left.name.localeCompare(right.name);
    });
}

function applyHardConstraints(requestContext = {}, candidates = []) {
  const evaluations = candidates.map((candidate) =>
    evaluateHardConstraints(requestContext, candidate)
  );

  return {
    eligible: evaluations.filter((entry) => entry.eligible).map((entry) => entry.candidate),
    excluded: evaluations
      .filter((entry) => !entry.eligible)
      .map((entry) => ({
        candidate: entry.candidate,
        reasonCodes: entry.reasonCodes,
        humanReadableReasons: entry.humanReadableReasons,
      })),
  };
}

module.exports = {
  parseCityFromAddress,
  resolveRequestCity,
  formatCityLabel,
  resolveNeededCategory,
  evaluateHardConstraints,
  applyHardConstraints,
  scoreVendor,
  scoreEligibleCandidates,
  specialtyMatchBonus,
};
