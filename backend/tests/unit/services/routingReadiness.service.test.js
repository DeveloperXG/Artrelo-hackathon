const assert = require("assert");
const {
  deriveRoutingReadiness,
  ROUTE_CONFIDENCE_BAR,
} = require("../../../services/ai/routingReadiness.service");

// Helper to build an incident record with sensible defaults.
const incident = (overrides = {}) => ({
  category: "Plumbing",
  trade: "Plumbing",
  severity: 3,
  emergency: false,
  costTier: "Medium",
  responsibility: "landlord",
  evidence: { confidencePenalty: false },
  confidence: { overall: 0.8, missingFields: [] },
  ...overrides,
});

// 1) Emergency wins over everything.
let r = deriveRoutingReadiness({
  incidentRecord: incident({ emergency: true, confidence: { overall: 0.9, missingFields: [] } }),
  triage: { safetyGate: { triggered: true } },
});
assert.strictEqual(r.state, "emergency_escalation");
assert.strictEqual(r.blocking, true);

// Emergency via triage flag even if the record didn't carry it.
r = deriveRoutingReadiness({
  incidentRecord: incident(),
  triage: { emergencyServicesRecommended: true },
});
assert.strictEqual(r.state, "emergency_escalation");

// 2) No resolvable trade -> manual assignment.
r = deriveRoutingReadiness({ incidentRecord: incident({ trade: null }) });
assert.strictEqual(r.state, "manual_assignment_required");

// 3) High cost tier -> manager review (even when confident).
r = deriveRoutingReadiness({ incidentRecord: incident({ costTier: "High" }) });
assert.strictEqual(r.state, "needs_manager_review");
assert.ok(/cost/i.test(r.reason));

// Tenant/shared responsibility -> manager review for the cost split.
r = deriveRoutingReadiness({ incidentRecord: incident({ responsibility: "tenant" }) });
assert.strictEqual(r.state, "needs_manager_review");

// 4) Below the bar with a missing high-value field -> one more answer.
r = deriveRoutingReadiness({
  incidentRecord: incident({
    confidence: { overall: 0.4, missingFields: ["timeline", "subcategory"] },
  }),
});
assert.strictEqual(r.state, "need_one_more_answer");
assert.ok(/timeline/.test(r.reason));

// 5) Below the bar, high-value fields present, no photo -> need photo evidence.
r = deriveRoutingReadiness({
  incidentRecord: incident({
    confidence: { overall: 0.6, missingFields: ["subcategory", "access"] },
    evidence: { confidencePenalty: true },
  }),
});
assert.strictEqual(r.state, "need_photo_evidence");

// Below the bar, nothing obvious to ask, photo present -> manager review.
r = deriveRoutingReadiness({
  incidentRecord: incident({
    confidence: { overall: 0.6, missingFields: ["subcategory"] },
    evidence: { confidencePenalty: false },
  }),
});
assert.strictEqual(r.state, "needs_manager_review");

// 6) Safe, trade known, confident -> ready to route.
r = deriveRoutingReadiness({ incidentRecord: incident() });
assert.strictEqual(r.state, "ready_to_route");
assert.strictEqual(r.blocking, false);

// Confidence exactly at the bar is "ready".
r = deriveRoutingReadiness({
  incidentRecord: incident({ confidence: { overall: ROUTE_CONFIDENCE_BAR, missingFields: [] } }),
});
assert.strictEqual(r.state, "ready_to_route");

console.log("routingReadiness.service tests passed");
