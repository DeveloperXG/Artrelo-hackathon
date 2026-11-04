const PROVINCE_OR_REGION_PATTERN =
  /\b(ab|alberta|bc|british columbia|mb|manitoba|nb|new brunswick|nl|newfoundland and labrador|ns|nova scotia|nt|northwest territories|nu|nunavut|on|ontario|pe|prince edward island|qc|quebec|sk|saskatchewan|yt|yukon|ca|canada|usa|united states)\b/gi;

const normalizeSpacing = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s,.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function normalizeCity(value) {
  const normalized = normalizeSpacing(value);
  if (!normalized) return "";

  const commaParts = normalized
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const candidate = (commaParts[0] || normalized)
    .replace(PROVINCE_OR_REGION_PATTERN, " ")
    .replace(/[.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return candidate;
}

function deriveCityFromAddress(value) {
  const normalized = normalizeSpacing(value);
  if (!normalized) return "";

  const parts = normalized
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return normalizeCity(parts[1]);
  }

  return normalizeCity(parts[0]);
}

function cityMatches(unitCity, vendorCity, serviceAreas = []) {
  const normalizedUnitCity = normalizeCity(unitCity);
  if (!normalizedUnitCity) return false;

  const candidateCities = [vendorCity, ...(Array.isArray(serviceAreas) ? serviceAreas : [])]
    .map((value) => normalizeCity(value))
    .filter(Boolean);

  return candidateCities.includes(normalizedUnitCity);
}

function distanceKm(a, b) {
  if (!a || !b) return null;
  if (
    typeof a.lat !== "number" ||
    typeof a.lng !== "number" ||
    typeof b.lat !== "number" ||
    typeof b.lng !== "number"
  ) {
    return null;
  }

  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const haversine =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(deltaLng / 2) *
      Math.sin(deltaLng / 2);

  const arc = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return earthRadiusKm * arc;
}

module.exports = {
  normalizeCity,
  deriveCityFromAddress,
  cityMatches,
  distanceKm,
};
