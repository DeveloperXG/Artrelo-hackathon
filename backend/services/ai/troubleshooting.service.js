// Category troubleshooting protocols. These are APPROVED, safe-only scripts: the
// AI may ask the diagnostic questions and suggest the allowedSteps, but must never
// suggest anything in doNotSuggest or improvise safety-sensitive instructions.
// Protocols are only offered for non-emergency cases — the Stage 4 safety gate
// suppresses troubleshooting whenever a hard hazard is detected.
//
// The goal is questions/steps whose answers change the next action: a GFCI reset
// or a flipped breaker can resolve an issue without a dispatch; a brand/model +
// error code lets a vendor arrive prepared.

const STEP_IDS = {
  electrical_no_power_outlet: ["electrical.resetBreaker", "electrical.resetGfci"],
  plumbing_clogged_drain: ["plumbing.cleanStopper", "plumbing.plunge", "plumbing.hotWater"],
  plumbing_running_toilet: ["plumbing.shutoff", "plumbing.checkFlapper"],
  hvac_no_heat_or_cooling: ["hvac.thermostat", "hvac.filter", "hvac.breaker"],
  appliance_not_working: ["appliance.power", "appliance.label", "appliance.waterSupply"],
};
const ALL_STEP_IDS = Object.values(STEP_IDS).flat();
const DIAGNOSTIC_TOPICS = {
  electrical_no_power_outlet: ["breaker", "gfci", "extent"],
  plumbing_clogged_drain: ["extent", "disposal", "drainBackup"],
  plumbing_running_toilet: ["toiletOverflow", "toiletFlow"],
  hvac_no_heat_or_cooling: ["thermostat", "filter", "breaker", "errorCode"],
  appliance_not_working: ["applianceModel", "power", "errorCode", "waterSupply"],
};
const PROTOCOLS = {
  Electrical: {
    default: {
      id: "electrical_no_power_outlet",
      title: "No power to one outlet or area",
      diagnosticQuestions: [
        "Did a breaker trip, or is the breaker for that area switched off?",
        "Is there a GFCI outlet nearby (kitchen, bathroom, garage, or outdoors) with a 'reset' button?",
        "Are other outlets or rooms affected, or only this one?",
      ],
      allowedSteps: [
        "Check the breaker panel; if a breaker sits in the middle/tripped position, switch it fully OFF then back ON.",
        "Press the 'reset' button on any nearby GFCI outlet.",
      ],
      doNotSuggest: [
        "Removing outlet covers or switch plates",
        "Touching, stripping, or repairing any wiring",
        "Bypassing, jumping, or forcing a breaker",
        "Using water near an outlet or panel",
      ],
      safetyNote:
        "If there are scorch marks, a burning smell, or sparks, stop immediately and report it as an emergency.",
    },
  },
  Plumbing: {
    "Clogged drain": {
      id: "plumbing_clogged_drain",
      title: "Slow or clogged drain",
      diagnosticQuestions: [
        "Is only this one drain slow, or are other drains backing up too?",
        "If there's a garbage disposal, does it run when switched on?",
        "Does water back up when you run it?",
      ],
      allowedSteps: [
        "Remove and clean any visible hair or debris from the drain stopper.",
        "Try a cup plunger over the drain.",
        "Run hot (not boiling) water to see if it clears.",
      ],
      doNotSuggest: [
        "Using chemical drain cleaners",
        "Removing or disassembling pipes or the P-trap",
        "Reaching a hand into a garbage disposal",
      ],
      safetyNote: "",
    },
    "Running/overflowing toilet": {
      id: "plumbing_running_toilet",
      title: "Running or overflowing toilet",
      diagnosticQuestions: [
        "Is it overflowing right now, or just running?",
        "Is the water running constantly, or only after a flush?",
      ],
      allowedSteps: [
        "If it's overflowing, turn the shutoff valve at the base of the toilet clockwise to stop the water.",
        "Lift the tank lid and check the rubber flapper is sitting flat over the drain.",
      ],
      doNotSuggest: [
        "Disassembling the tank or removing internal components",
        "Continuing to flush an overflowing toilet",
      ],
      safetyNote: "",
    },
  },
  HVAC: {
    default: {
      id: "hvac_no_heat_or_cooling",
      title: "No heat or no cooling",
      diagnosticQuestions: [
        "What is the thermostat set to (heat or cool) and at what temperature?",
        "When was the air filter last changed?",
        "Is the switch or breaker for the unit on?",
        "Is there an error code or blinking light on the unit?",
      ],
      allowedSteps: [
        "Set the thermostat to the right mode and a few degrees past the current room temperature.",
        "Replace or clean a visibly dirty air filter.",
        "Confirm the breaker for the unit is ON.",
      ],
      doNotSuggest: [
        "Opening the furnace, AC, or boiler housing",
        "Touching the gas line, pilot light, or igniter",
        "Bypassing any safety switch",
      ],
      safetyNote:
        "If you smell gas or burning, stop and report it as an emergency.",
    },
  },
  Appliance: {
    default: {
      id: "appliance_not_working",
      title: "Appliance not working",
      diagnosticQuestions: [
        "What's the brand and model? (Usually on a label inside the door or on the back.)",
        "Is it getting power / turning on at all?",
        "Is there an error code on the display?",
        "For a washer or dishwasher: is the water supply turned on?",
      ],
      allowedSteps: [
        "Confirm it's plugged in and the outlet has power.",
        "Note the brand, model, and any error code shown.",
        "For water-fed appliances, check the supply valve is open.",
      ],
      doNotSuggest: [
        "Opening the appliance casing or back panel",
        "Touching internal wiring or heating elements",
        "Repairing any gas connection",
      ],
      safetyNote: "",
    },
  },
};

// Resolve the best protocol for a category (optionally refined by subcategory).
function getProtocol(category, subcategory) {
  const byCategory = PROTOCOLS[category];
  if (!byCategory) return null;
  if (subcategory && byCategory[subcategory]) return byCategory[subcategory];
  return byCategory.default || null;
}

// Public, tenant-safe shape surfaced in the triage envelope.
function toPublicShape(protocol) {
  if (!protocol) return null;
  return {
    protocolId: protocol.id,
    title: protocol.title,
    diagnosticQuestions: [...protocol.diagnosticQuestions],
    allowedSteps: [...protocol.allowedSteps],
    doNotSuggest: [...protocol.doNotSuggest],
    safetyNote: protocol.safetyNote || "",
    diagnosticCandidates: protocol.diagnosticQuestions.map((question, index) => ({
      id: `${protocol.id}.${DIAGNOSTIC_TOPICS[protocol.id][index]}`,
      topicId: DIAGNOSTIC_TOPICS[protocol.id][index], question,
    })),
    steps: protocol.allowedSteps.map((instruction, index) => ({ id: STEP_IDS[protocol.id][index], instruction })),
  };
}

// Instruction block injected into the model prompt. Hard-constrains the model to
// the approved script.
function formatProtocolForPrompt(protocol) {
  if (!protocol) return "";
  const lines = [
    `Approved troubleshooting script for this issue ("${protocol.title}"). Stay strictly within it:`,
    `- Ask these diagnostic questions to narrow down the cause (skip any already answered): ${protocol.diagnosticQuestions.join(" | ")}`,
    `- You may ONLY suggest these safe steps, and only when relevant: ${protocol.allowedSteps.join(" | ")}`,
    `- Stable step identifiers: ${JSON.stringify(protocol.steps || toPublicShape(protocol)?.steps || [])}`,
    `- NEVER suggest any of the following: ${protocol.doNotSuggest.join(" | ")}`,
    `- Do not improvise any other safety-sensitive instructions. If the tenant reports a hazard while troubleshooting, stop and treat it as an emergency.`,
  ];
  return lines.join("\n");
}

// Whether troubleshooting is allowed for this triage (suppressed for emergencies /
// safety-gated cases), and the protocol if one exists.
function isSuppressed(triage = {}) {
  return Boolean(
    triage?.safetyGate?.suppressTroubleshooting ||
      triage?.emergencyServicesRecommended ||
      triage?.urgency === "emergency"
  );
}

function buildTroubleshooting(triage = {}) {
  if (isSuppressed(triage)) return null;
  const shape = toPublicShape(getProtocol(triage.category, triage.subcategory));
  if (!shape) return null;
  const answered = new Set((triage.intakeState?.answers || []).map((a) => a.topicId));
  const asked = new Set(triage.intakeState?.askedIds || []);
  shape.diagnosticCandidates = shape.diagnosticCandidates.filter((q) => !answered.has(q.topicId) && !asked.has(q.topicId));
  shape.diagnosticQuestions = shape.diagnosticCandidates.map((q) => q.question);
  const done = new Set((triage.troubleshootingState || []).map((s) => s.stepId));
  const text = [...(triage.attemptedFixes || []), triage.additionalNotes || ""].join(" ");
  const repeatedBreaker = /breaker.*(?:again|repeat|keeps?|won't stay|twice|multiple|several|trip)|(?:again|repeat|keeps?|twice|multiple).*breaker/i.test(text);
  shape.steps = shape.steps.filter(({ id }) => {
    if (done.has(id)) return false;
    if (repeatedBreaker && /reset|breaker/i.test(id)) return false;
    if (/resetBreaker/.test(id) && /(?:reset|tried|checked).*breaker|breaker.*(?:reset|tried|checked)/i.test(text)) return false;
    if (/resetGfci/.test(id) && /(?:reset|tried|checked).*gfci|gfci.*(?:reset|tried|checked)/i.test(text)) return false;
    if (/thermostat/.test(id) && /thermostat.*(?:set|check)|(?:set|check).*thermostat/i.test(text)) return false;
    if (/filter/.test(id) && /filter.*(?:clean|chang|check)|(?:clean|chang|check).*filter/i.test(text)) return false;
    return true;
  });
  shape.allowedSteps = shape.steps.map((s) => s.instruction);
  return shape;
}

module.exports = {
  PROTOCOLS,
  getProtocol,
  toPublicShape,
  formatProtocolForPrompt,
  buildTroubleshooting,
  isSuppressed,
  ALL_STEP_IDS,
};
