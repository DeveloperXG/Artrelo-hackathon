const assert = require("assert");
const {
  buildIncidentRecord,
  computeConfidence,
  inferSubcategory,
  deriveCostTier,
} = require("../../../services/ai/incidentRecord.service");

// Subcategory inference from free text.
assert.strictEqual(
  inferSubcategory("Plumbing", "water leaking under the kitchen sink"),
  "Leaking pipe"
);
assert.strictEqual(
  inferSubcategory("Electrical", "the outlet is sparking and burning"),
  "Sparking/burning outlet"
);
assert.strictEqual(inferSubcategory("Other", "something odd"), null);

// Cost tier heuristic.
assert.strictEqual(deriveCostTier({ category: "Plumbing", severity: 5 }), "High");
assert.strictEqual(deriveCostTier({ category: "Electrical", severity: 4 }), "High");
assert.strictEqual(deriveCostTier({ category: "Pest", severity: 3 }), "Medium");
assert.strictEqual(deriveCostTier({ category: "Cleaning", severity: 1 }), "Low");

// A sparse triage yields a low-confidence record with the right missing fields.
const sparse = buildIncidentRecord({
  triage: {
    summary: "Sink draining slowly.",
    category: "Plumbing",
    urgency: "medium",
    severity: 3,
    suggestedVendorType: "Plumbing",
    suggestedResponsibility: "unknown",
  },
  message: "My sink drains slowly.",
  photos: [],
  source: "chat",
});

assert.strictEqual(sparse.category, "Plumbing");
assert.strictEqual(sparse.trade, "Plumbing");
assert.strictEqual(sparse.subcategory, "Clogged drain");
assert.strictEqual(sparse.evidence.photos, 0);
assert.strictEqual(sparse.evidence.confidencePenalty, true);
assert.ok(sparse.confidence.overall < 0.6, "sparse record should be low confidence");
assert.ok(sparse.confidence.missingFields.includes("impact"));
assert.ok(sparse.confidence.missingFields.includes("location"));
assert.ok(sparse.confidence.missingFields.includes("evidence"));

// A complete triage yields a high-confidence record with no penalty.
const complete = buildIncidentRecord({
  triage: {
    summary: "Water leaking under the kitchen sink, bucket placed.",
    category: "Plumbing",
    subcategory: "Leaking pipe",
    urgency: "high",
    severity: 4,
    impact: "Kitchen sink unusable",
    location: { room: "Kitchen", area: "Under sink" },
    timeline: { started: "2 hours ago", trend: "Worsening" },
    attemptedFixes: ["tightened visible pipe fitting"],
    access: { permissionToEnter: true, pets: false, preferredTimes: ["Weekday evening"] },
    suggestedVendorType: "Plumbing",
    suggestedResponsibility: "landlord",
  },
  message: "Water leaking under the kitchen sink.",
  photos: ["a.jpg", "b.jpg", "c.jpg"],
  source: "chat",
});

assert.strictEqual(complete.evidence.photos, 3);
assert.strictEqual(complete.evidence.confidencePenalty, false);
assert.strictEqual(complete.timeline.trend, "Worsening");
assert.strictEqual(complete.location.room, "Kitchen");
assert.strictEqual(complete.responsibility, "landlord");
assert.strictEqual(complete.costTier, "High");
assert.ok(complete.confidence.overall >= 0.9, "complete record should be high confidence");
assert.deepStrictEqual(complete.confidence.missingFields, []);

// Emergencies are floored high regardless of completeness.
const emergency = buildIncidentRecord({
  triage: {
    summary: "Active flooding from burst pipe.",
    category: "Plumbing",
    urgency: "emergency",
    severity: 5,
    emergencyServicesRecommended: true,
    suggestedVendorType: "Plumbing",
  },
  message: "Burst pipe flooding the kitchen.",
  photos: [],
});

assert.strictEqual(emergency.emergency, true);
assert.strictEqual(emergency.safety.lifeSafetyConcern, true);
assert.ok(emergency.confidence.overall >= 0.9, "emergency confidence is floored high");

// Structured evidence assets drive the counts/flags (not the legacy photo array).
const withEvidence = buildIncidentRecord({
  triage: {
    summary: "Leaking pipe under sink.",
    category: "Plumbing",
    severity: 4,
    suggestedVendorType: "Plumbing",
  },
  message: "Leaking pipe under sink.",
  evidence: [
    { url: "https://cdn/x/wide.jpg", type: "image", label: "Wide shot", publicId: "x/wide" },
    { url: "https://cdn/x/close.jpg", type: "image", label: "Close-up" },
    { url: "https://cdn/x/clip.mp4", type: "video", label: "Drip" },
  ],
  source: "chat",
});
assert.strictEqual(withEvidence.evidence.photos, 2, "two image assets counted as photos");
assert.strictEqual(withEvidence.evidence.video, true, "video asset sets the video flag");
assert.strictEqual(withEvidence.evidence.confidencePenalty, false);
assert.strictEqual(withEvidence.evidence.assets.length, 3);
assert.strictEqual(withEvidence.evidence.assets[0].label, "Wide shot");

// An invalid timeline trend is normalized to Unknown.
const badTrend = computeConfidence({ category: "Plumbing" });
assert.ok(Array.isArray(badTrend.missingFields));

console.log("incidentRecord.service tests passed");
