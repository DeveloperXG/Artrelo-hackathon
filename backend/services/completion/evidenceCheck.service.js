// Scores the evidence a vendor submitted with a completion.
//
// PURE. No I/O, no clock of its own — `now` is injected. That is deliberate:
// the verdict decides whether money can move without a human, so it has to be
// reproducible months later during a dispute, and tunable without a migration.
//
// WHAT THIS IS NOT: proof of presence. The server cannot derive GPS. Browser
// geolocation is client-supplied and trivially spoofed, and IP geolocation is
// city-level and wrong behind mobile carriers and VPNs. So every geo signal
// here is labelled client_reported and can only ever push a job toward REVIEW —
// never toward "verified". The genuinely server-side facts are the receive
// timestamp, the distance computation, and the EXIF read.
//
// The verdicts:
//   pass   -> may enter awaiting_tenant, and may therefore auto-confirm
//   review -> a human decides before any payout, regardless of auto mode
//   fail   -> reserved; nothing produces it today (see the note on photos)

const GEOFENCE_RADIUS_M = 250;
// A photo taken more than two days before it was uploaded is very likely a
// recycled one. Generous on purpose — a vendor with no signal in a basement
// legitimately uploads hours later.
const STALE_PHOTO_MS = 48 * 60 * 60 * 1000;

const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (Number(deg) * Math.PI) / 180;

/**
 * Great-circle distance. Server-side, so the threshold cannot be tampered with
 * even though the coordinates it is fed can be.
 */
function haversineMeters(a, b) {
  if (!a || !b) return null;
  const [lat1, lng1, lat2, lng2] = [a.lat, a.lng, b.lat, b.lng].map(Number);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Grade one geo stamp against the property's coordinates.
 *
 * A denied permission is REVIEW, never a block: the vendor did the work
 * regardless of whether their browser let us look, and refusing to accept a
 * completion because of a permission prompt would strand real jobs.
 */
function evaluateGeoStamp(stamp, propertyCoords, { radiusMeters = GEOFENCE_RADIUS_M } = {}) {
  // Checked FIRST, before anything about the vendor.
  //
  // Property.geo is optional and nothing geocodes it yet, so this is the normal
  // case today. You cannot hold a vendor to a geofence you do not have: if this
  // demoted, every completion in the system would land in the review queue and
  // auto-confirm would never fire, which would defeat the entire point of auto
  // mode. Recorded as informational (`applicable: false`), never as a demotion.
  if (!propertyCoords) {
    return {
      verdict: "pass",
      distanceMeters: null,
      reason: "geofence_not_configured",
      applicable: false,
    };
  }
  if (!stamp || stamp.source === "denied") {
    return { verdict: "review", distanceMeters: null, reason: "geo_denied", applicable: true };
  }
  if (stamp.source !== "client_reported") {
    return { verdict: "review", distanceMeters: null, reason: "geo_unavailable", applicable: true };
  }

  const distanceMeters = haversineMeters(stamp, propertyCoords);
  if (distanceMeters === null) {
    return { verdict: "review", distanceMeters: null, reason: "geo_unparseable", applicable: true };
  }
  if (distanceMeters > radiusMeters) {
    return { verdict: "review", distanceMeters, reason: "geo_outside_radius", applicable: true };
  }
  return { verdict: "pass", distanceMeters, reason: null, applicable: true };
}

/**
 * The completion-level verdict.
 *
 * Returns { verdict, reasons, checkIn, checkOut } where checkIn/checkOut carry
 * the server-computed distance to be persisted back onto the document.
 */
function evaluateCompletionEvidence({
  photos = [],
  checkIn = null,
  checkOut = null,
  propertyCoords = null,
  now = new Date(),
  cloudinaryConfigured = true,
  radiusMeters = GEOFENCE_RADIUS_M,
  stalePhotoMs = STALE_PHOTO_MS,
} = {}) {
  const reasons = [];
  let verdict = "pass";
  const demote = (reason) => {
    reasons.push(reason);
    verdict = "review";
  };

  const afterPhotos = photos.filter((photo) => (photo?.stage || "after") === "after");

  // Never `fail` for a missing photo. Cloudinary may be unconfigured in dev, and
  // the whole flow has to stay demoable without credentials — the same reason
  // the email stub counts as sent. An unconfigured uploader is an operator
  // problem, not vendor fraud.
  if (!afterPhotos.length) {
    demote(cloudinaryConfigured ? "no_after_photo" : "uploads_not_configured");
  }

  // Recycled-photo check. EXIF is read server-side at upload; a vendor cannot
  // strip it without also losing the thing that would have cleared them.
  for (const photo of afterPhotos) {
    if (!photo.exifTakenAt) continue;
    const taken = new Date(photo.exifTakenAt).getTime();
    const received = new Date(photo.receivedAt || now).getTime();
    if (!Number.isFinite(taken) || !Number.isFinite(received)) continue;
    if (Math.abs(received - taken) > stalePhotoMs) {
      demote("photo_timestamp_mismatch");
      break;
    }
  }

  const checkInResult = evaluateGeoStamp(checkIn, propertyCoords, { radiusMeters });
  const checkOutResult = checkOut
    ? evaluateGeoStamp(checkOut, propertyCoords, { radiusMeters })
    : null;

  if (checkInResult.verdict !== "pass") demote(`checkin_${checkInResult.reason}`);
  else if (checkInResult.applicable === false) reasons.push(checkInResult.reason);

  if (checkOutResult && checkOutResult.verdict !== "pass") {
    demote(`checkout_${checkOutResult.reason}`);
  }

  return {
    verdict,
    reasons,
    checkIn: checkIn
      ? { ...checkIn, distanceMeters: checkInResult.distanceMeters, verdict: checkInResult.verdict }
      : null,
    checkOut:
      checkOut && checkOutResult
        ? { ...checkOut, distanceMeters: checkOutResult.distanceMeters, verdict: checkOutResult.verdict }
        : null,
  };
}

module.exports = {
  evaluateCompletionEvidence,
  evaluateGeoStamp,
  haversineMeters,
  GEOFENCE_RADIUS_M,
  STALE_PHOTO_MS,
};
