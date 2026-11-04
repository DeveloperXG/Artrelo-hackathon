// The evidence scorer decides whether a job may auto-confirm without a human,
// so every verdict path is pinned here.
//
// The single most important case is section 2: Property.geo is optional and
// NOTHING geocodes it today, so if a missing reference point demoted the
// verdict, every completion in the system would land in the review queue and
// auto-confirm would never fire — defeating the entire point of auto mode.

const assert = require("assert");
const {
  evaluateCompletionEvidence,
  evaluateGeoStamp,
  haversineMeters,
  GEOFENCE_RADIUS_M,
} = require("../../../services/completion/evidenceCheck.service");

const NOW = new Date("2026-08-06T12:00:00.000Z");
const PROPERTY = { lat: 50.4452, lng: -104.6189 }; // Regina

const photo = (overrides = {}) => ({
  url: "https://cdn.example.com/after.jpg",
  stage: "after",
  receivedAt: NOW,
  exifTakenAt: null,
  ...overrides,
});
const onSite = (overrides = {}) => ({
  source: "client_reported",
  at: NOW,
  lat: PROPERTY.lat,
  lng: PROPERTY.lng,
  ...overrides,
});

/* ---------------- 1) Distance maths ---------------------------------- */

assert.strictEqual(haversineMeters(PROPERTY, PROPERTY), 0);
// ~1.1km north.
const km = haversineMeters(PROPERTY, { lat: PROPERTY.lat + 0.01, lng: PROPERTY.lng });
assert.ok(km > 1000 && km < 1200, `expected ~1.1km, got ${km}`);
assert.strictEqual(haversineMeters(null, PROPERTY), null);
assert.strictEqual(haversineMeters({ lat: "x", lng: "y" }, PROPERTY), null);

/* ---------------- 2) No property coords => geofence is NOT APPLICABLE --- */

const noGeofence = evaluateGeoStamp(onSite(), null);
assert.strictEqual(noGeofence.verdict, "pass", "a missing geofence must not demote");
assert.strictEqual(noGeofence.applicable, false);
assert.strictEqual(noGeofence.reason, "geofence_not_configured");

// And it must not demote even when the vendor denied permission — there was
// nothing to check them against either way.
const deniedNoGeofence = evaluateGeoStamp({ source: "denied" }, null);
assert.strictEqual(deniedNoGeofence.verdict, "pass");

// End to end: the common case today (photo, no geocoded property) must PASS,
// or nothing ever auto-confirms.
const today = evaluateCompletionEvidence({
  photos: [photo()],
  checkIn: onSite(),
  propertyCoords: null,
  now: NOW,
});
assert.strictEqual(today.verdict, "pass", "the common case today must be able to auto-confirm");
assert.ok(today.reasons.includes("geofence_not_configured"), "but it is recorded as a reason");

/* ---------------- 3) With a geofence, distance is enforced ------------- */

const inside = evaluateGeoStamp(onSite(), PROPERTY);
assert.strictEqual(inside.verdict, "pass");
assert.strictEqual(inside.distanceMeters, 0);
assert.strictEqual(inside.applicable, true);

const outside = evaluateGeoStamp(
  onSite({ lat: PROPERTY.lat + 0.05 }), // ~5.5km
  PROPERTY
);
assert.strictEqual(outside.verdict, "review");
assert.strictEqual(outside.reason, "geo_outside_radius");
assert.ok(outside.distanceMeters > GEOFENCE_RADIUS_M);

/* ---------------- 4) Denied permission => review, never a block -------- */
// The vendor did the work whether or not their browser let us look, so this
// routes to a human rather than refusing the completion.

const denied = evaluateCompletionEvidence({
  photos: [photo()],
  checkIn: { source: "denied", at: NOW },
  propertyCoords: PROPERTY,
  now: NOW,
});
assert.strictEqual(denied.verdict, "review");
assert.ok(denied.reasons.includes("checkin_geo_denied"));
assert.notStrictEqual(denied.verdict, "fail", "a permission prompt must never fail a job");

// No check-in at all is the same story.
const noStamp = evaluateCompletionEvidence({
  photos: [photo()],
  checkIn: null,
  propertyCoords: PROPERTY,
  now: NOW,
});
assert.strictEqual(noStamp.verdict, "review");

/* ---------------- 5) Missing photo => review, never fail --------------- */

const noPhoto = evaluateCompletionEvidence({
  photos: [],
  checkIn: onSite(),
  propertyCoords: PROPERTY,
  now: NOW,
});
assert.strictEqual(noPhoto.verdict, "review");
assert.ok(noPhoto.reasons.includes("no_after_photo"));

// Cloudinary unconfigured is an operator problem, not vendor fraud — and the
// flow has to stay demoable without credentials.
const noUploader = evaluateCompletionEvidence({
  photos: [],
  checkIn: onSite(),
  propertyCoords: PROPERTY,
  now: NOW,
  cloudinaryConfigured: false,
});
assert.ok(noUploader.reasons.includes("uploads_not_configured"));
assert.notStrictEqual(noUploader.verdict, "fail");

// A BEFORE photo does not satisfy the after-photo requirement.
const beforeOnly = evaluateCompletionEvidence({
  photos: [photo({ stage: "before" })],
  checkIn: onSite(),
  propertyCoords: PROPERTY,
  now: NOW,
});
assert.strictEqual(beforeOnly.verdict, "review");
assert.ok(beforeOnly.reasons.includes("no_after_photo"));

/* ---------------- 6) Recycled-photo detection ------------------------- */

const stale = evaluateCompletionEvidence({
  photos: [photo({ exifTakenAt: new Date(NOW.getTime() - 10 * 24 * 3600 * 1000) })],
  checkIn: onSite(),
  propertyCoords: PROPERTY,
  now: NOW,
});
assert.strictEqual(stale.verdict, "review");
assert.ok(stale.reasons.includes("photo_timestamp_mismatch"));

// Inside the 48h allowance — a vendor with no signal in a basement uploads late.
const late = evaluateCompletionEvidence({
  photos: [photo({ exifTakenAt: new Date(NOW.getTime() - 6 * 3600 * 1000) })],
  checkIn: onSite(),
  propertyCoords: PROPERTY,
  now: NOW,
});
assert.strictEqual(late.verdict, "pass");

// No EXIF at all is not held against the vendor — plenty of cameras strip it.
const noExif = evaluateCompletionEvidence({
  photos: [photo({ exifTakenAt: null })],
  checkIn: onSite(),
  propertyCoords: PROPERTY,
  now: NOW,
});
assert.strictEqual(noExif.verdict, "pass");

/* ---------------- 7) The clean pass, and the returned stamps ---------- */

const clean = evaluateCompletionEvidence({
  photos: [photo()],
  checkIn: onSite(),
  checkOut: onSite({ at: new Date(NOW.getTime() + 3600 * 1000) }),
  propertyCoords: PROPERTY,
  now: NOW,
});
assert.strictEqual(clean.verdict, "pass");
assert.deepStrictEqual(clean.reasons, []);
// The server-computed distance is handed back to be persisted — the input is
// client-supplied but the computation is not.
assert.strictEqual(clean.checkIn.distanceMeters, 0);
assert.strictEqual(clean.checkOut.distanceMeters, 0);
assert.strictEqual(clean.checkIn.verdict, "pass");

/* ---------------- 8) Purity -------------------------------------------- */
// Same inputs, same verdict, no hidden clock. This has to be re-derivable
// months later in a dispute.

const args = {
  photos: [photo({ exifTakenAt: new Date(NOW.getTime() - 100 * 3600 * 1000) })],
  checkIn: onSite(),
  propertyCoords: PROPERTY,
  now: NOW,
};
assert.deepStrictEqual(
  evaluateCompletionEvidence(args).reasons,
  evaluateCompletionEvidence(args).reasons
);

const frozen = { ...args, photos: [...args.photos] };
evaluateCompletionEvidence(args);
assert.deepStrictEqual(args.photos.length, frozen.photos.length, "inputs must not be mutated");

console.log("evidenceCheck.service tests passed");
