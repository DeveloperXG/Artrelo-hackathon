const assert = require("assert");
const {
  getProtocol,
  toPublicShape,
  formatProtocolForPrompt,
  buildTroubleshooting,
} = require("../../../services/ai/troubleshooting.service");

// --- Protocol lookup ---
assert.strictEqual(getProtocol("Electrical").id, "electrical_no_power_outlet");
assert.strictEqual(getProtocol("Electrical", "anything").id, "electrical_no_power_outlet");
assert.strictEqual(getProtocol("Plumbing", "Clogged drain").id, "plumbing_clogged_drain");
assert.strictEqual(
  getProtocol("Plumbing", "Running/overflowing toilet").id,
  "plumbing_running_toilet"
);
// Plumbing has no default — an unmapped subcategory yields no protocol.
assert.strictEqual(getProtocol("Plumbing", "Mystery"), null);
assert.strictEqual(getProtocol("HVAC").id, "hvac_no_heat_or_cooling");
assert.strictEqual(getProtocol("Appliance").id, "appliance_not_working");
assert.strictEqual(getProtocol("Pest"), null);
assert.strictEqual(getProtocol("Other"), null);

// --- Public shape ---
const shape = toPublicShape(getProtocol("Electrical"));
assert.deepStrictEqual(
  Object.keys(shape).sort(),
  ["allowedSteps", "diagnosticQuestions", "diagnosticCandidates", "steps", "doNotSuggest", "protocolId", "safetyNote", "title"].sort()
);
assert.ok(shape.allowedSteps.length > 0 && shape.doNotSuggest.length > 0);

// --- Prompt formatting carries the hard constraints ---
const prompt = formatProtocolForPrompt(getProtocol("Electrical"));
assert.ok(/NEVER suggest/i.test(prompt));
assert.ok(/wiring/i.test(prompt), "do-not-suggest items appear in the prompt");
assert.ok(/diagnostic questions/i.test(prompt));

// --- buildTroubleshooting gating ---
assert.strictEqual(
  buildTroubleshooting({ category: "Electrical" }).protocolId,
  "electrical_no_power_outlet"
);
assert.strictEqual(
  buildTroubleshooting({ category: "Electrical", emergencyServicesRecommended: true }),
  null,
  "suppressed for emergencies"
);
assert.strictEqual(
  buildTroubleshooting({ category: "Electrical", urgency: "emergency" }),
  null
);
assert.strictEqual(
  buildTroubleshooting({ category: "Electrical", safetyGate: { suppressTroubleshooting: true } }),
  null,
  "suppressed when the safety gate fired"
);
assert.strictEqual(buildTroubleshooting({ category: "Pest" }), null, "no protocol for category");

for (const category of ["Electrical", "HVAC", "Appliance"]) {
  const protocol = buildTroubleshooting({ category });
  assert.strictEqual(new Set(protocol.diagnosticCandidates.map((q) => q.id)).size, protocol.diagnosticCandidates.length);
  assert.strictEqual(new Set(protocol.steps.map((step) => step.id)).size, protocol.steps.length);
}
const attempted = buildTroubleshooting({ category: "Electrical", troubleshootingState: [
  { stepId: "electrical.resetBreaker", state: "unsuccessful" },
  { stepId: "electrical.resetGfci", state: "declined" },
] });
assert.deepStrictEqual(attempted.steps, []);
assert.deepStrictEqual(attempted.allowedSteps, []);
const unknownFilter = buildTroubleshooting({ category: "HVAC", intakeState: {
  askedIds: ["errorCode"], answers: [{ topicId: "filter", state: "unknown" }],
} });
assert.ok(!unknownFilter.diagnosticCandidates.some((q) => ["filter", "errorCode"].includes(q.topicId)));
const repeated = buildTroubleshooting({ category: "Electrical", attemptedFixes: ["Reset breaker twice, keeps tripping"] });
assert.ok(!repeated.allowedSteps.some((step) => /reset|back ON/i.test(step)));

console.log("troubleshooting.service tests passed");
