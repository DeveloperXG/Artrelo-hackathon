const assert = require("assert");
const {
  scoreVendor,
  scoreEligibleCandidates,
  specialtyMatchBonus,
} = require("../../../services/vendor/vendorScoring.service");
const { buildRequestContext } = require("../../../services/vendor/vendorRecommendation.service");

// --- specialtyMatchBonus ---
assert.ok(specialtyMatchBonus("Leaking pipe", ["Leak repair", "Drain cleaning"]) > 0, "stemmed leak match");
assert.ok(specialtyMatchBonus("Clogged drain", ["Drain cleaning"]) > 0, "drain match");
assert.strictEqual(specialtyMatchBonus("Leaking pipe", ["Water heaters", "Furnace tune-up"]), 0, "no overlap");
assert.strictEqual(specialtyMatchBonus("", ["Leak repair"]), 0, "no subcategory");
assert.strictEqual(specialtyMatchBonus("Leaking pipe", []), 0, "no specialties");
assert.strictEqual(specialtyMatchBonus("Leaking pipe", undefined), 0, "missing specialties is safe");
// Generic words must not create spurious matches.
assert.strictEqual(specialtyMatchBonus("General issue", ["General repair"]), 0, "generic words ignored");

// --- scoreVendor includes the component and a match raises the total ---
const baseCandidate = {
  name: "Plumber A",
  category: "Plumbing",
  service: "Plumbing",
  reliabilityScore: 80,
  rating: 4,
  avgResponseMinutes: 60,
  hourlyRate: 90,
  insuranceVerified: true,
  licenseVerified: true,
  source: "preset",
  verificationStatus: "trusted",
};
const ctx = { subcategory: "Leaking pipe", urgency: "medium" };
const matched = scoreVendor(ctx, { ...baseCandidate, specialties: ["Leak repair", "Pipe work"] });
const unmatched = scoreVendor(ctx, { ...baseCandidate, specialties: ["Drain cleaning"] });
assert.strictEqual(matched.scoreBreakdown.specialtyMatch, 10);
assert.strictEqual(unmatched.scoreBreakdown.specialtyMatch, 0);
assert.ok(matched.score > unmatched.score, "specialty match raises the score");

// No subcategory in context -> no bonus, no crash.
const noSub = scoreVendor({ urgency: "medium" }, { ...baseCandidate, specialties: ["Leak repair"] });
assert.strictEqual(noSub.scoreBreakdown.specialtyMatch, 0);

// --- ranking: a matching vendor outranks an otherwise-identical non-matching one ---
const ranked = scoreEligibleCandidates(ctx, [
  { ...baseCandidate, name: "Generic", providerName: "preset", providerVendorId: "g1", specialties: ["Drain cleaning"] },
  { ...baseCandidate, name: "Specialist", providerName: "preset", providerVendorId: "s1", specialties: ["Leak repair"] },
]);
assert.strictEqual(ranked[0].name, "Specialist", "specialist ranks first on subcategory match");

// --- buildRequestContext reads the incident record as the canonical source ---
const incidentCtx = buildRequestContext(
  {
    _id: "req1",
    landlordId: "ll1",
    category: "Plumbing",
    urgency: "high",
    incidentRecord: {
      subcategory: "Leaking pipe",
      trade: "Plumbing",
      severity: 4,
      costTier: "High",
      emergency: false,
      evidence: { confidencePenalty: true },
      confidence: { overall: 0.62 },
    },
  },
  null,
  null,
  null
);
assert.strictEqual(incidentCtx.subcategory, "Leaking pipe");
assert.strictEqual(incidentCtx.vendorTypeNeeded, "Plumbing");
assert.strictEqual(incidentCtx.severity, 4);
assert.strictEqual(incidentCtx.costTier, "High");
assert.strictEqual(incidentCtx.evidenceConfidencePenalty, true);
assert.strictEqual(incidentCtx.incidentConfidence, 0.62);

// Fallback to legacy fields when there is no incident record.
const legacyCtx = buildRequestContext(
  {
    _id: "r2",
    landlordId: "l2",
    category: "HVAC",
    urgency: "medium",
    ai: { suggestedVendorType: "HVAC", severity: 3 },
  },
  null,
  null,
  null
);
assert.strictEqual(legacyCtx.vendorTypeNeeded, "HVAC");
assert.strictEqual(legacyCtx.severity, 3);
assert.strictEqual(legacyCtx.subcategory, null);

console.log("vendorScoring incident-match tests passed");
