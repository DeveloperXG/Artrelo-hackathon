const assert = require("assert");
const {
  aiTriage,
  deterministicTriage,
  normalizeTriageOutput,
  buildTriageResult,
  detectIssueResolved,
  TRIAGE_SCHEMA,
} = require("../../../services/ai/categorization.service");
const {
  SUPPORTED_VENDOR_SERVICES,
  resolveVendorServiceNeeded,
} = require("../../../services/vendor/vendorServices.service");

// OpenAI strict json_schema requires EVERY property of an object with
// additionalProperties:false to be listed in its `required` array. Verify this
// recursively so a future field addition cannot silently break live triage.
function assertStrictSchema(node, pathLabel = "root") {
  if (!node || typeof node !== "object") return;
  if (node.type === "object" && node.additionalProperties === false) {
    const propKeys = Object.keys(node.properties || {});
    const requiredKeys = node.required || [];
    assert.deepStrictEqual(
      [...propKeys].sort(),
      [...requiredKeys].sort(),
      `strict schema mismatch at ${pathLabel}: every property must be required`
    );
    propKeys.forEach((key) =>
      assertStrictSchema(node.properties[key], `${pathLabel}.${key}`)
    );
  }
  if (node.type === "array" && node.items) {
    assertStrictSchema(node.items, `${pathLabel}[]`);
  }
}
assertStrictSchema(TRIAGE_SCHEMA.schema, "TRIAGE_SCHEMA");

// buildTriageResult now emits a structured incident record carrying the guided
// intake fields supplied on the triage object.
const guidedEnvelope = buildTriageResult(
  {
    summary: "Water leaking under the kitchen sink.",
    category: "Plumbing",
    subcategory: "Leaking pipe",
    urgency: "high",
    severity: 4,
    impact: "Kitchen sink unusable",
    location: { room: "Kitchen", area: "Under sink" },
    timeline: { started: "2 hours ago", trend: "Worsening" },
    attemptedFixes: ["tightened fitting"],
    access: { permissionToEnter: true, pets: false, preferredTimes: ["Weekday evening"] },
    suggestedVendorType: "Plumbing",
    suggestedResponsibility: "landlord",
    readyToSubmit: true,
    intakeStatus: "ready_to_submit",
  },
  { message: "Water leaking under the kitchen sink.", photos: ["a.jpg"], source: "chat" }
);
assert.ok(guidedEnvelope.incidentRecord, "envelope should include incidentRecord");
assert.strictEqual(guidedEnvelope.incidentRecord.impact, "Kitchen sink unusable");
assert.strictEqual(guidedEnvelope.incidentRecord.location.room, "Kitchen");
assert.strictEqual(guidedEnvelope.incidentRecord.timeline.trend, "Worsening");
assert.strictEqual(guidedEnvelope.incidentRecord.evidence.photos, 1);

const cases = [
  { urgency: "low", modelSeverity: 5, expectedSeverity: 1 },
  { urgency: "medium", modelSeverity: 1, expectedSeverity: 3 },
  { urgency: "high", modelSeverity: 2, expectedSeverity: 4 },
  { urgency: "emergency", modelSeverity: 1, expectedSeverity: 5 },
];

for (const testCase of cases) {
  const normalized = normalizeTriageOutput(
    {
      summary: "Tenant reported a maintenance issue.",
      category: "Plumbing",
      urgency: testCase.urgency,
      severity: testCase.modelSeverity,
      suggestedResponsibility: "unknown",
      suggestedVendorType: "Plumbing",
      followUpQuestions: [],
      safetyWarning: "",
      emergencyServicesRecommended: false,
    },
    "Tenant reported a maintenance issue.",
    "Plumbing"
  );

  assert.strictEqual(
    normalized.severity,
    testCase.expectedSeverity,
    `${testCase.urgency} urgency should normalize severity to ${testCase.expectedSeverity}`
  );
}

const fallback = deterministicTriage({
  message: "There is active flooding from a burst pipe under the sink.",
});

assert.strictEqual(fallback.urgency, "emergency");
assert.strictEqual(fallback.severity, 5);
assert.strictEqual(fallback.readyToSubmit, true);
assert.strictEqual(fallback.intakeStatus, "ready_to_submit");
assert.strictEqual(fallback.suggestedVendorType, "Plumbing");

const offlineOriginal = 'The kitchen sink drain leaks under the cabinet since yesterday. Water is contained in a bowl.';
const offlineHistory = [
  { role: 'user', content: offlineOriginal },
  { role: 'ai', content: 'What days or times work best for a visit?' },
  { role: 'user', content: 'Saturday from 9 am to 5 pm works.' },
  { role: 'ai', content: "Is it okay for a technician to enter if you are not home?" },
  { role: 'user', content: 'No, only enter when I am home.' },
  { role: 'ai', content: 'Are there any pets the technician should know about?' },
  { role: 'user', content: 'No pets.' },
];
const offlineFollowUp = deterministicTriage({ message: 'No pets.', category: 'Plumbing', context: { conversationHistory: offlineHistory } });
assert(offlineFollowUp.summary.startsWith(offlineOriginal), 'fallback follow-up retains the initial incident rather than replacing it with the final access answer');
assert(offlineFollowUp.summary.includes('Saturday from 9 am to 5 pm works.'));
assert(offlineFollowUp.summary.includes('No pets.'));
assert(!offlineFollowUp.summary.includes('Are there any pets'), 'assistant questions never become the incident narrative');
assert.equal(offlineFollowUp.summary.match(/No pets\./g).length, 1, 'the current turn already in history is not duplicated');
assert(/kitchen sink/i.test(offlineFollowUp.shortTitle));assert.notEqual(offlineFollowUp.shortTitle, 'No pets');
assert.equal(offlineFollowUp.access.permissionToEnter, false, 'narrative preservation does not turn a presence condition into affirmative entry permission');

const emergencyServiceInference = deterministicTriage({
  message: "The bedroom outlet is burning and sparking right now.",
});

assert.strictEqual(emergencyServiceInference.suggestedVendorType, "Electrical");
assert.ok(["Electrical", "Safety/Emergency"].includes(emergencyServiceInference.category));

const invalidVendorTypeNormalized = normalizeTriageOutput(
  {
    summary: "Tenant says they need a plumber.",
    category: "Other",
    urgency: "medium",
    severity: 3,
    suggestedResponsibility: "unknown",
    suggestedVendorType: "Plumber",
    followUpQuestions: [],
    safetyWarning: "",
    emergencyServicesRecommended: false,
  },
  "Need a plumber for a mystery issue.",
  "Other"
);

assert.strictEqual(invalidVendorTypeNormalized.suggestedVendorType, null);

const emergencyCategoryNormalized = normalizeTriageOutput(
  {
    summary: "Burning outlet in the kitchen.",
    category: "Safety/Emergency",
    urgency: "emergency",
    severity: 5,
    suggestedResponsibility: "unknown",
    suggestedVendorType: null,
    followUpQuestions: [],
    safetyWarning: "Stay clear of the outlet.",
    emergencyServicesRecommended: true,
  },
  "The outlet is burning and sparking.",
  "Safety/Emergency"
);

assert.strictEqual(emergencyCategoryNormalized.suggestedVendorType, "Electrical");

const unresolvedService = resolveVendorServiceNeeded({
  suggestedVendorType: "Plumber",
  category: "Other",
  message: "Something is wrong but I do not know what it is.",
});

assert.strictEqual(unresolvedService, null);
assert.ok(SUPPORTED_VENDOR_SERVICES.includes("Plumbing"));

const earlyIntake = normalizeTriageOutput(
  {
    summary: "Tenant reported a slow sink drain.",
    category: "Plumbing",
    urgency: "medium",
    severity: 3,
    suggestedResponsibility: "unknown",
    suggestedVendorType: "Plumbing",
    followUpQuestions: ["When did this start?"],
    safetyWarning: "",
    emergencyServicesRecommended: false,
  },
  "Tenant reported a slow sink drain.",
  "Plumbing",
  { conversationHistory: [{ role: "user", content: "My sink is draining slowly." }] }
);

assert.strictEqual(earlyIntake.readyToSubmit, false);
assert.strictEqual(earlyIntake.intakeStatus, "needs_more_info");
assert.deepStrictEqual(earlyIntake.missingFields, ["When did this start?"]);

// Even when the model returns NO follow-ups, intake stays open and surfaces a
// derived question while high-value structured fields are still missing.
const keepsAsking = normalizeTriageOutput(
  {
    summary: "Tenant reports a leak.",
    category: "Plumbing",
    urgency: "medium",
    severity: 3,
    suggestedResponsibility: "unknown",
    suggestedVendorType: "Plumbing",
    followUpQuestions: [],
    safetyWarning: "",
    emergencyServicesRecommended: false,
  },
  "There is a leak.",
  "Plumbing",
  { conversationHistory: [{ role: "user", content: "There is a leak." }] }
);
assert.strictEqual(
  keepsAsking.readyToSubmit,
  false,
  "missing high-value fields keep intake open even when the model returns no questions"
);
assert.ok(keepsAsking.missingFields.length > 0, "a derived follow-up question is surfaced");

const exhaustedIntake = normalizeTriageOutput(
  {
    ...earlyIntake,
    readyToSubmit: false,
    intakeStatus: "needs_more_info",
    missingFields: ["When did this start?"],
  },
  "Tenant reported a slow sink drain.",
  "Plumbing",
  {
    conversationHistory: [
      { role: "user", content: "My sink is draining slowly." },
      { role: "user", content: "It has been getting worse." },
      { role: "user", content: "I do not know when it started." },
      { role: "user", content: "I have not tried anything." },
      { role: "user", content: "Not sure about the room." },
      { role: "user", content: "It just affects the sink." },
      { role: "user", content: "Any time is fine I guess." },
      { role: "user", content: "Still not sure." },
      { role: "user", content: "I really cannot say." },
      { role: "user", content: "No idea." },
      { role: "user", content: "Can't tell you." },
      { role: "user", content: "Don't know." },
      { role: "user", content: "Unsure." },
      { role: "user", content: "Nope." },
      { role: "user", content: "I cannot add more right now." },
    ],
  }
);

// After the turn cap (MAX_INTAKE_TURNS) we stop asking and submit on best known
// facts, even when structured fields are still missing.
assert.strictEqual(exhaustedIntake.readyToSubmit, true);
assert.strictEqual(exhaustedIntake.intakeStatus, "ready_to_submit");
assert.deepStrictEqual(exhaustedIntake.missingFields, []);

// Once the four core fields are captured but access is still unknown, intake stays
// open for a scheduling/access pass (non-emergency).
const schedulingPass = normalizeTriageOutput(
  {
    summary: "Dishwasher not draining at the end of cycles.",
    category: "Appliance",
    subcategory: "Dishwasher",
    urgency: "medium",
    severity: 3,
    impact: "Cannot run the dishwasher",
    location: { room: "Kitchen", area: "Dishwasher" },
    timeline: { started: "yesterday", trend: "Stable" },
    attemptedFixes: ["cleaned the filter"],
    suggestedResponsibility: "shared",
    suggestedVendorType: "Appliance",
    followUpQuestions: [],
    safetyWarning: "",
    emergencyServicesRecommended: false,
  },
  "Dishwasher won't drain.",
  "Appliance",
  { conversationHistory: [{ role: "user", content: "Dishwasher won't drain." }] }
);
assert.strictEqual(
  schedulingPass.readyToSubmit,
  false,
  "core complete but access unknown should keep intake open"
);
assert.ok(
  /technician to enter|times work|visit/i.test(schedulingPass.missingFields[0] || ""),
  "the scheduling/access question is asked after the core fields"
);

// Reworded repeat detection: a question already asked earlier must not be surfaced
// again even when the model rephrases it (reproduces the HVAC air-filter transcript).
const airFilterHistory = [
  { role: "user", content: "My AC isn't cooling" },
  { role: "ai", content: "What is the thermostat set to and at what temperature?" },
  { role: "user", content: "Cool, 13C" },
  { role: "ai", content: "When was the air filter last changed?" },
  { role: "user", content: "I'm not sure" },
  { role: "ai", content: "Is the switch or breaker for the unit on?" },
  { role: "user", content: "Yes" },
];
const airFilterModelOutput = {
  summary: "AC not cooling.",
  category: "HVAC",
  subcategory: "No cooling",
  urgency: "medium",
  severity: 3,
  suggestedResponsibility: "landlord",
  suggestedVendorType: "HVAC",
  followUpQuestions: ["What was the last time the air filter was changed?"],
  safetyWarning: "",
  emergencyServicesRecommended: false,
};
const airFilterRepeat = normalizeTriageOutput(
  airFilterModelOutput,
  "My AC isn't cooling",
  "HVAC",
  { conversationHistory: airFilterHistory }
);
assert.ok(
  !airFilterRepeat.missingFields.some((q) => /air filter/i.test(q)),
  "a reworded repeat of the air-filter question must not be surfaced again"
);
// The actual display path reads followUpQuestions first — it must also be filtered,
// not the raw model output.
assert.ok(
  !airFilterRepeat.followUpQuestions.some((q) => /air filter/i.test(q)),
  "followUpQuestions (what the tenant actually sees) must not repeat the question"
);
assert.ok(
  !/air filter/i.test(buildTriageResult(airFilterRepeat).tenantResponse.message || ""),
  "the tenant-facing prompt must not repeat the question"
);

// Control: with no prior asking, the same question IS surfaced (proves it was the
// repeat filter that removed it above, not something else).
const airFilterFresh = normalizeTriageOutput(
  airFilterModelOutput,
  "My AC isn't cooling",
  "HVAC",
  { conversationHistory: [{ role: "user", content: "My AC isn't cooling" }] }
);
assert.ok(
  airFilterFresh.missingFields.some((q) => /affect/i.test(q)),
  "an essential missing impact is prioritized ahead of the optional air filter question"
);

// TRUNCATION REGRESSION: a question asked early in a long conversation (beyond the
// model-context window) must still be recognized as a repeat — repeat detection
// scans the FULL history, not the last 12 messages. Fails under the old slice(-12),
// which is what let the thermostat/air-filter/error-code questions come back.
const longHistory = [
  { role: "user", content: "My AC isn't cooling" }, // 0
  { role: "ai", content: "What is the thermostat set to and at what temperature?" }, // 1 (dropped by slice -12)
  { role: "user", content: "Cool, 13C" }, // 2
  { role: "ai", content: "When was the air filter last changed?" }, // 3
  { role: "user", content: "I'm not sure" }, // 4
  { role: "ai", content: "Is the switch or breaker for the unit on?" }, // 5
  { role: "user", content: "Yes" }, // 6
  { role: "ai", content: "How is this affecting your use of the space right now?" }, // 7
  { role: "user", content: "It's hot and I can't cool off" }, // 8
  { role: "ai", content: "When did you first notice it?" }, // 9
  { role: "user", content: "About a day ago" }, // 10
  { role: "ai", content: "Where exactly is the issue?" }, // 11
  { role: "user", content: "My living room" }, // 12
  { role: "ai", content: "Have you tried anything to fix or stop it so far?" }, // 13
];
const thermostatRepeat = normalizeTriageOutput(
  {
    summary: "AC not cooling.",
    category: "HVAC",
    subcategory: "No cooling",
    urgency: "medium",
    severity: 3,
    impact: "Cannot cool off",
    location: { room: "Living room", area: "" },
    timeline: { started: "about a day ago", trend: "Stable" },
    attemptedFixes: [],
    suggestedResponsibility: "landlord",
    suggestedVendorType: "HVAC",
    followUpQuestions: ["What is the thermostat set to (heat or cool)?"],
    safetyWarning: "",
    emergencyServicesRecommended: false,
  },
  "No",
  "HVAC",
  { conversationHistory: longHistory }
);
assert.ok(
  !thermostatRepeat.followUpQuestions.some((q) => /thermostat/i.test(q)),
  "a question asked beyond the model window must still be filtered as a repeat"
);
assert.ok(
  thermostatRepeat.readyToSubmit,
  "after six follow-ups intake permits submission instead of asking more questions"
);

// GREETING POISONING: the opening greeting mentions "when it started, what you've
// tried, and anything that affects access" — generic phrasing that must NOT count as
// having ASKED those questions. attemptedFixes and access still need to be asked.
const greetingPoison = normalizeTriageOutput(
  {
    summary: "AC not cooling.",
    category: "HVAC",
    subcategory: "No cooling",
    urgency: "medium",
    severity: 3,
    impact: "Cannot cool off",
    location: { room: "Living room", area: "" },
    timeline: { started: "a day ago", trend: "Stable" },
    attemptedFixes: [],
    suggestedResponsibility: "landlord",
    suggestedVendorType: "HVAC",
    followUpQuestions: [],
    safetyWarning: "",
    emergencyServicesRecommended: false,
  },
  "living room",
  "HVAC",
  {
    conversationHistory: [
      {
        role: "ai",
        content:
          "Hi! Describe your HVAC issue with as much detail as possible - when it started, what you've tried, and anything that affects access to your unit.",
      },
      { role: "user", content: "My AC isn't cooling" },
      { role: "ai", content: "How is this affecting your use of the space right now?" },
      { role: "user", content: "It's hot and I can't cool off" },
      { role: "ai", content: "When did you first notice it?" },
      { role: "user", content: "A day ago" },
      { role: "ai", content: "Where exactly is the issue?" },
      { role: "user", content: "Living room" },
    ],
  }
);
assert.strictEqual(
  greetingPoison.readyToSubmit,
  false,
  "must not be ready: attempted fixes and access were never actually asked"
);
assert.ok(
  greetingPoison.followUpQuestions.some(
    (q) => /tried|attempt/i.test(q) || /technician|visit|enter/i.test(q)
  ),
  "intake asks the still-unasked attempted-fixes (or access) question"
);

const emergencyWrapped = buildTriageResult(
  deterministicTriage({
    message: "There is active flooding from a burst pipe and water is spreading quickly.",
  })
);
assert.strictEqual(emergencyWrapped.tenantResponse.nextAction, "emergency_guidance");
assert.strictEqual(emergencyWrapped.workflow.shouldEscalateEmergency, true);

const notReadyWrapped = buildTriageResult(
  normalizeTriageOutput(
    {
      summary: "Possible electrical issue in bedroom outlet.",
      category: "Electrical",
      urgency: "high",
      severity: 4,
      suggestedResponsibility: "unknown",
      suggestedVendorType: "Electrical",
      followUpQuestions: ["Is there smoke or burning smell right now?"],
      safetyWarning: "",
      emergencyServicesRecommended: false,
      readyToSubmit: false,
      intakeStatus: "needs_more_info",
      missingFields: ["Is there smoke or burning smell right now?"],
      confidence: "low",
    },
    "Bedroom outlet issue",
    "Electrical",
    { conversationHistory: [{ role: "user", content: "My outlet is acting weird." }] }
  )
);
assert.strictEqual(notReadyWrapped.tenantResponse.nextAction, "ask_follow_up");
assert.strictEqual(notReadyWrapped.workflow.actionType, "ask_follow_up");
assert.strictEqual(notReadyWrapped.workflow.shouldCreateTicket, false);

// A genuinely complete triage (all high-value structured fields captured) is ready
// on the first turn even though the model returns no follow-up questions.
const readyWrapped = buildTriageResult(
  normalizeTriageOutput(
    {
      summary: "Kitchen faucet leak with clear location and urgency details.",
      category: "Plumbing",
      subcategory: "Leaking pipe",
      urgency: "high",
      severity: 4,
      impact: "Cannot use the kitchen sink",
      location: { room: "Kitchen", area: "Faucet base" },
      timeline: { started: "this morning", trend: "Worsening" },
      attemptedFixes: ["turned the faucet off"],
      access: { permissionToEnter: true, pets: false, preferredTimes: ["Weekday evening"] },
      suggestedResponsibility: "unknown",
      suggestedVendorType: "Plumbing",
      followUpQuestions: [],
      safetyWarning: "",
      emergencyServicesRecommended: false,
      readyToSubmit: true,
      intakeStatus: "ready_to_submit",
      missingFields: [],
      confidence: "medium",
    },
    "Kitchen faucet leak",
    "Plumbing",
    { conversationHistory: [{ role: "user", content: "Faucet leaking since this morning. The technician can enter if I am out." }] }
  )
);
assert.strictEqual(readyWrapped.tenantResponse.nextAction, "submit_request");
assert.strictEqual(readyWrapped.workflow.shouldCreateTicket, true);
assert.strictEqual(readyWrapped.workflow.shouldSearchVendor, true);

// When the model's summary merely echoes the tenant's words but structured fields
// are present, the summary is rebuilt into a rich operational recap (issue +
// location + timeline + impact + attempted fixes) rather than a dry generic line.
const echoMessage = "Water is leaking under my kitchen sink and it is getting worse.";
const synthesized = normalizeTriageOutput(
  {
    summary: echoMessage,
    category: "Plumbing",
    subcategory: "Leaking pipe",
    urgency: "high",
    severity: 4,
    impact: "Kitchen sink unusable",
    location: { room: "Kitchen", area: "Under sink" },
    timeline: { started: "2 hours ago", trend: "Worsening" },
    attemptedFixes: ["tightened the fitting"],
    suggestedResponsibility: "landlord",
    suggestedVendorType: "Plumbing",
    followUpQuestions: [],
    safetyWarning: "",
    emergencyServicesRecommended: false,
  },
  echoMessage,
  "Plumbing"
);
assert.notStrictEqual(synthesized.summary, echoMessage, "echoed summary should be rebuilt");
assert.ok(/leaking pipe/i.test(synthesized.summary), "recap names the subcategory");
assert.ok(/kitchen/i.test(synthesized.summary), "recap includes the location");
assert.ok(/2 hours ago|worsening/i.test(synthesized.summary), "recap includes the timeline");
assert.ok(/unusable/i.test(synthesized.summary), "recap includes the impact");
assert.ok(/tightened/i.test(synthesized.summary), "recap includes attempted fixes");

// With no structured detail, an echoed summary is kept as-is (the tenant's own
// description) rather than replaced with a generic line.
const echoOnly = normalizeTriageOutput(
  {
    summary: "My garage door will not open.",
    category: "Other",
    urgency: "medium",
    severity: 3,
    suggestedResponsibility: "unknown",
    suggestedVendorType: null,
    followUpQuestions: [],
    safetyWarning: "",
    emergencyServicesRecommended: false,
  },
  "My garage door will not open.",
  "Other"
);
assert.ok(/garage door/i.test(echoOnly.summary), "thin echo keeps the tenant's description");

// The deterministic safety gate overrides a non-emergency model classification when
// the tenant's words contain a hard hazard — it can only escalate, never downgrade.
const gateEscalated = buildTriageResult(
  normalizeTriageOutput(
    {
      summary: "Tenant reports a smell in the kitchen.",
      category: "Other",
      urgency: "medium",
      severity: 3,
      suggestedResponsibility: "unknown",
      suggestedVendorType: null,
      followUpQuestions: ["When can a technician access the property?"],
      safetyWarning: "",
      emergencyServicesRecommended: false,
    },
    "I smell gas in my kitchen",
    "Other",
    { conversationHistory: [{ role: "user", content: "I smell gas in my kitchen" }] }
  )
);
assert.strictEqual(gateEscalated.triage.urgency, "emergency", "gas smell forces emergency");
assert.strictEqual(gateEscalated.triage.emergencyServicesRecommended, true);
assert.strictEqual(gateEscalated.triage.severity, 5);
assert.strictEqual(gateEscalated.triage.safety.riskType, "gas");
assert.strictEqual(gateEscalated.triage.safety.lifeSafetyConcern, true);
assert.strictEqual(gateEscalated.triage.readyToSubmit, true, "emergencies are immediately ready");
assert.strictEqual(gateEscalated.tenantResponse.nextAction, "emergency_guidance");
assert.strictEqual(gateEscalated.workflow.shouldEscalateEmergency, true);
assert.strictEqual(gateEscalated.workflow.notifyManager, true);
assert.strictEqual(gateEscalated.workflow.suppressTroubleshooting, true);
assert.ok(
  gateEscalated.workflow.hazards.some((h) => h.code === "gas_leak"),
  "workflow carries the matched hazard"
);
// The incident record reflects the gate's safety verdict.
assert.strictEqual(gateEscalated.incidentRecord.safety.riskType, "gas");
assert.strictEqual(gateEscalated.incidentRecord.emergency, true);
// Troubleshooting is suppressed for a safety-gated emergency.
assert.strictEqual(gateEscalated.troubleshooting, null, "no troubleshooting during a hazard");
// Scheduling/access follow-ups are dropped for the escalated emergency.
assert.ok(
  !gateEscalated.triage.followUpQuestions.some((q) => /access the property/i.test(q)),
  "scheduling questions are filtered for gate-escalated emergencies"
);

// A non-emergency request is left untouched by the gate.
const gateUntouched = buildTriageResult(
  normalizeTriageOutput(
    {
      summary: "Dishwasher won't drain at the end of the cycle.",
      category: "Appliance",
      subcategory: "Dishwasher",
      urgency: "medium",
      severity: 3,
      impact: "Cannot run the dishwasher",
      location: { room: "Kitchen", area: "Dishwasher" },
      timeline: { started: "yesterday", trend: "Stable" },
      attemptedFixes: ["cleaned the filter"],
      access: { permissionToEnter: true, pets: false, preferredTimes: ["Weekday"] },
      suggestedResponsibility: "shared",
      suggestedVendorType: "Appliance",
      followUpQuestions: [],
      safetyWarning: "",
      emergencyServicesRecommended: false,
    },
    "My dishwasher won't drain. The technician can enter if I am out.",
    "Appliance"
  )
);
assert.strictEqual(gateUntouched.triage.urgency, "medium", "gate does not escalate a benign issue");
assert.strictEqual(gateUntouched.triage.emergencyServicesRecommended, false);
assert.strictEqual(gateUntouched.workflow.actionType, "submit_request");
// A safe, non-emergency issue carries its category troubleshooting protocol.
assert.ok(gateUntouched.troubleshooting, "non-emergency issue includes a troubleshooting protocol");
assert.strictEqual(gateUntouched.troubleshooting.protocolId, "appliance_not_working");
assert.ok(gateUntouched.troubleshooting.doNotSuggest.length > 0);

// An electrical no-power issue surfaces the electrical protocol.
const electricalTriage = buildTriageResult(
  normalizeTriageOutput(
    {
      summary: "One bedroom outlet has no power.",
      category: "Electrical",
      subcategory: "Dead outlet",
      urgency: "medium",
      severity: 3,
      suggestedResponsibility: "landlord",
      suggestedVendorType: "Electrical",
      followUpQuestions: [],
      safetyWarning: "",
      emergencyServicesRecommended: false,
    },
    "The outlet in my bedroom stopped working",
    "Electrical"
  )
);
assert.strictEqual(electricalTriage.troubleshooting.protocolId, "electrical_no_power_outlet");
assert.ok(
  electricalTriage.troubleshooting.diagnosticQuestions.some((q) => /breaker|gfci/i.test(q)),
  "electrical protocol asks about breaker/GFCI"
);

// The envelope carries an agent-facing routing-readiness verdict.
assert.ok(gateEscalated.routingReadiness, "envelope includes routingReadiness");
assert.strictEqual(
  gateEscalated.routingReadiness.state,
  "emergency_escalation",
  "gas emergency routes to escalation"
);
assert.ok(electricalTriage.routingReadiness, "non-emergency request has a readiness verdict");
assert.ok(
  ["ready_to_route", "need_one_more_answer", "need_photo_evidence", "needs_manager_review"].includes(
    electricalTriage.routingReadiness.state
  ),
  "non-emergency readiness is one of the non-escalation states"
);

// --- Resolution detection ---
assert.strictEqual(detectIssueResolved("it's working now, thanks!"), true);
assert.strictEqual(detectIssueResolved("the reset worked, all good"), true);
assert.strictEqual(detectIssueResolved("I fixed it myself"), true);
assert.strictEqual(detectIssueResolved("no longer leaking"), true);
assert.strictEqual(detectIssueResolved("don't need a technician anymore"), false);
// Negations and bare words must NOT trip it.
assert.strictEqual(detectIssueResolved("it's still not working"), false);
assert.strictEqual(detectIssueResolved("that didn't work"), false);
assert.strictEqual(detectIssueResolved("it needs to be fixed"), false);
assert.strictEqual(detectIssueResolved("the heater is working but makes noise"), false);
assert.strictEqual(detectIssueResolved("my sink is clogged"), false);

// A resolved message closes the chat: no questions, no ticket, no vendor search.
const resolved = buildTriageResult(
  normalizeTriageOutput(
    {
      summary: "Bedroom outlet had no power.",
      category: "Electrical",
      subcategory: "Dead outlet",
      urgency: "medium",
      severity: 3,
      suggestedResponsibility: "landlord",
      suggestedVendorType: "Electrical",
      followUpQuestions: ["Did a breaker trip?"],
      safetyWarning: "",
      emergencyServicesRecommended: false,
    },
    "I reset the GFCI and it works now",
    "Electrical",
    {
      conversationHistory: [
        { role: "user", content: "bedroom outlet has no power" },
        { role: "ai", content: "Is there a GFCI outlet nearby with a reset button?" },
        { role: "user", content: "I reset the GFCI and it works now" },
      ],
    }
  )
);
assert.strictEqual(resolved.triage.resolved, true);
assert.strictEqual(resolved.triage.readyToSubmit, false);
assert.deepStrictEqual(resolved.triage.missingFields, []);
assert.strictEqual(resolved.tenantResponse.nextAction, "issue_resolved");
assert.strictEqual(resolved.workflow.actionType, "resolved_closed");
assert.strictEqual(resolved.workflow.shouldCreateTicket, false);
assert.strictEqual(resolved.workflow.shouldSearchVendor, false);

// Safety always wins: a hazard is never treated as "resolved" on a reassurance.
const hazardNotResolved = buildTriageResult(
  normalizeTriageOutput(
    {
      summary: "Smell of gas reported.",
      category: "HVAC",
      urgency: "medium",
      severity: 3,
      suggestedResponsibility: "landlord",
      suggestedVendorType: "HVAC",
      followUpQuestions: [],
      safetyWarning: "",
      emergencyServicesRecommended: false,
    },
    "there's a gas smell but I think it's fine now",
    "HVAC",
    { conversationHistory: [{ role: "user", content: "there's a gas smell but I think it's fine now" }] }
  )
);
assert.strictEqual(hazardNotResolved.triage.resolved, false, "safety gate overrides resolution");
assert.strictEqual(hazardNotResolved.triage.urgency, "emergency");
assert.strictEqual(hazardNotResolved.tenantResponse.nextAction, "emergency_guidance");

// Summary lock: once a request is ready to submit, later tenant detail must not
// overwrite the canonical summary — it is preserved verbatim and any genuinely new
// detail is captured in an append-only additionalNotes field.
const lockedSummary =
  "Active leak under the kitchen sink; tenant shut off the supply valve and placed a bucket. Access via back door, dog on site.";
const previousTriage = {
  summary: lockedSummary,
  additionalNotes: "",
  category: "Plumbing",
  urgency: "high",
  readyToSubmit: true,
  intakeStatus: "ready_to_submit",
};

const lockedFollowUp = normalizeTriageOutput(
  {
    // Model tries to rewrite the summary around a low-value detail and even mislabels it.
    summary: "Tenant mentioned the cabinet under the sink is a light oak color.",
    additionalNotes: "Cabinet under the sink is light oak.",
    category: "Plumbing",
    urgency: "high",
    severity: 4,
    suggestedResponsibility: "unknown",
    suggestedVendorType: "Plumbing",
    followUpQuestions: [],
    safetyWarning: "",
    emergencyServicesRecommended: false,
    readyToSubmit: true,
    intakeStatus: "ready_to_submit",
    missingFields: [],
    confidence: "medium",
  },
  "The cabinet under the sink is light oak.",
  "Plumbing",
  {
    previousTriage,
    conversationHistory: [
      { role: "user", content: "There is a leak under my kitchen sink." },
      { role: "user", content: "I shut the valve off and put a bucket down." },
      { role: "user", content: "The cabinet under the sink is light oak." },
    ],
  }
);

assert.strictEqual(
  lockedFollowUp.summary,
  lockedSummary,
  "locked summary must be preserved verbatim after ready_to_submit"
);
assert.ok(
  lockedFollowUp.additionalNotes.includes("light oak"),
  "new detail should be captured in additionalNotes"
);
assert.strictEqual(lockedFollowUp.readyToSubmit, true);
assert.strictEqual(lockedFollowUp.intakeStatus, "ready_to_submit");

// Deterministic fallback path honors the same lock.
const lockedDeterministic = deterministicTriage({
  message: "Also the kitchen light bulb is a warm white tone.",
  category: "Plumbing",
  context: { previousTriage },
});
assert.strictEqual(
  lockedDeterministic.summary,
  lockedSummary,
  "deterministic path must also preserve the locked summary"
);
assert.ok(
  lockedDeterministic.additionalNotes.length > 0,
  "deterministic path should route new detail into additionalNotes"
);

const runAsyncChecks = async () => {
  const result = await aiTriage({ message: "My toilet is leaking badly.", category: "Plumbing" });
  assert.ok(result.triage, "wrapped result should include triage");
  assert.ok(result.tenantResponse, "wrapped result should include tenantResponse");
  assert.ok(result.workflow, "wrapped result should include workflow");
  assert.ok(Object.prototype.hasOwnProperty.call(result.workflow, "shouldCreateTicket"));
  assert.ok(Object.prototype.hasOwnProperty.call(result.workflow, "shouldEscalateEmergency"));
};

runAsyncChecks()
  .then(() => {
    console.log("categorization.service severity normalization tests passed");
    console.log("categorization.service response layer tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
