const { runTriage } = require("./triageProvider.service");
const { extractFacts } = require("./deterministicFacts.service");
const {
  SUPPORTED_VENDOR_SERVICES,
  resolveVendorServiceNeeded,
} = require("../vendor/vendorServices.service");
const {
  buildIncidentRecord,
  TIMELINE_TRENDS,
  RISK_TYPES,
  COST_TIERS,
} = require("./incidentRecord.service");
const { evaluateSafetyGate } = require("./safetyGate.service");
const {
  ALL_STEP_IDS,
  formatProtocolForPrompt,
  buildTroubleshooting,
} = require("./troubleshooting.service");
const { deriveRoutingReadiness } = require("./routingReadiness.service");
const { TOPIC_IDS, ANSWER_STATES, CORRECTABLE_FIELDS, topicOf, mergeFacts, explicitEntryConsent, selectQuestion } = require("./intakeState.service");

const CATEGORIES = [
  "Plumbing",
  "Electrical",
  "HVAC",
  "Appliance",
  "Structural",
  "Pest",
  "Locks/Hardware",
  "Cleaning",
  "Safety/Emergency",
  "Other",
];

const URGENCIES = ["low", "medium", "high", "emergency"];
const INTAKE_STATUSES = ["needs_more_info", "ready_to_submit"];
const TENANT_NEXT_ACTIONS = [
  "ask_follow_up",
  "submit_request",
  "emergency_guidance",
  "needs_more_info",
  "issue_resolved",
];

// Detects when a tenant's latest message says the issue is already fixed /
// successfully troubleshooted, so intake can close instead of asking more
// questions. Positive markers require resolution context (now/again/"it's fixed"/
// "that worked") so bare words like "fixed" in "needs to be fixed" don't trip it,
// and any negation ("still broken", "didn't work") vetoes a match.
const RESOLVED_POSITIVE = new RegExp(
  [
    "\\bfixed it\\b",
    "\\bi fixed\\b",
    "\\b(it'?s|its|all|now|already)\\s+fixed\\b",
    "\\bgot it (fixed|working|sorted)\\b",
    "\\bresolved it\\b",
    "\\bresolved itself\\b",
    "\\b(it'?s|its|now)\\s+resolved\\b",
    "\\bsorted it\\b",
    "\\b(it'?s|its|now)\\s+sorted\\b",
    "\\b(it|that)\\s+works?\\s+(now|again)\\b",
    "\\b(it|that)\\s+worked\\b",
    "\\bworking\\s+(now|again)\\b",
    "\\b(that|the reset|resetting|unplugging|the breaker)\\b.*\\b(worked|did it|fixed it)\\b",
    "\\bno longer (an issue|a problem|happening|leaking)\\b",
    "\\bstopped (leaking|happening|dripping)\\b",
    "\\bnever ?mind\\b.*\\b(work|fix|fine|good|sorted|resolved)\\b",
  ].join("|"),
  "i"
);
const RESOLVED_NEGATION =
  /\b(not (fixed|working|resolved|sorted)|isn'?t (fixed|working|resolved)|still (broken|not working|leaking|happening|an issue|a problem|the same)|didn'?t (work|fix|help)|won'?t (work|turn on|fix)|no luck|hasn'?t (worked|fixed|helped)|nothing (worked|helped)|needs? (to be |a )?(fixed|repair))\b/i;

function detectIssueResolved(message = "", context = {}) {
  const text = String(message || "").replace(/’/g, "'");
  if (!text.trim()) return false;
  // Agreement to a visit or entry is not evidence that a repair worked. Still
  // accept a volunteered, explicit repair outcome during an access conversation.
  const history = Array.isArray(context.conversationHistory) ? context.conversationHistory : [];
  const lastAssistant = history.findLast((turn) => ["ai", "assistant"].includes(turn?.role));
  const lastQuestion = String(lastAssistant?.content || "").match(/[^.?!\n]*\?/g)?.at(-1);
  const topic = context.previousTriage?.intakeState?.selectedQuestion?.topicId || topicOf(lastQuestion);
  if (["availability", "entryPermission", "pets"].includes(topic) &&
      !/\b(?:fixed|resolved|sorted|reset|unplugged|issue|problem|repair|leak(?:ing)?|drip(?:ping)?|sink|drain|toilet|outlet|socket|breaker|furnace|heater|heating|cooling|appliance|fridge|oven|washer|dryer|door|lock|window|fan|light|crack|pests?|mice)\b/i.test(text)) return false;
  if (RESOLVED_NEGATION.test(text)) return false;
  if (/\b(?:keeps?|continues?) (?:tripping|leaking|failing|stopping)\b|\b(?:trips?|leaks?|fails?) (?:again|every|repeatedly)\b/i.test(text)) return false;
  if (/\b(?:fixed it|i fixed|worked|stopped leaking)\b.*\b(?:yesterday|last week|last time|previously|before|used to)\b/i.test(text) &&
      !/\b(?:now|currently|still working|remains? (?:fixed|resolved))\b/i.test(text)) return false;
  if (/\b(?:temporar(?:y|ily)|briefly|for (?:a |an )?(?:few |couple of |\d+ )?(?:minutes?|hours?|days?))\b/i.test(text) &&
      !/\b(?:still working|remains? (?:fixed|resolved)|working (?:well )?now)\b/i.test(text)) return false;
  if (/\b(?:then|but|however|after(?:wards)?|now)\b[^.!?]*(?:stopped (?:working|cooling|heating|again)|broke|failed|tripped|(?<!stopped )(?<!no longer )leaking|no (?:power|heat|water)|not working|unusable)/i.test(text)) return false;
  if (/\b(?:(?<!stopped )(?<!no longer )leaking|tripping|broken|no power|no heat|stopped working|power is out)\b[^.!?]*\bagain\b/i.test(text)) return false;
  if (/\b(?:another|other)\b[^.!?]*\b(?:working|fixed)\b/i.test(text)) return false;
  return RESOLVED_POSITIVE.test(text);
}

const SEVERITY_BY_URGENCY = {
  low: 1,
  medium: 3,
  high: 4,
  emergency: 5,
};

const RESPONSIBILITIES = [
  "landlord",
  "tenant",
  "shared",
  "insurance",
  "unknown",
];

const MODEL_HISTORY_LIMIT = 0; // Intake is capped at six follow-ups; retain the whole conversation.

// Text budgets. These were previously three disagreeing magic numbers (240 on the
// model summary, 300 inside synthesizeSummary, 480 on notes) applied at different
// points in the pipeline, which is how a summary got cut mid-sentence and then
// frozen that way by applySummaryLock.
//
// The prompt asks for a CUMULATIVE recap — issue, subcategory, room, when it
// started, the trend, the impact, what the tenant already tried, growing richer
// each turn. 240 characters cannot hold that. These are sized to let a complete
// recap through and exist only as a backstop against a runaway generation.
const SUMMARY_MAX_CHARS = 1200;
const NOTES_MAX_CHARS = 800;
const SHORT_TITLE_MAX_CHARS = 80;
const FALLBACK_TITLE_MAX_CHARS = 60;

const confidenceLabel = (overall) =>
  overall >= 0.75 ? "high" : overall >= 0.45 ? "medium" : "low";

const KEYWORD_RULES = [
  { category: "Plumbing", urgency: "high", words: ["leak", "leaking", "flood", "burst pipe", "no water", "toilet", "drain", "sink"] },
  { category: "Electrical", urgency: "high", words: ["spark", "shock", "outlet", "no power", "breaker", "electric", "wiring", "smoke"] },
  { category: "HVAC", urgency: "medium", words: ["heat", "heater", "ac", "air condition", "furnace", "hvac", "thermostat", "cold", "hot"] },
  { category: "Appliance", urgency: "medium", words: ["fridge", "refrigerator", "stove", "oven", "dishwasher", "washer", "dryer", "appliance"] },
  { category: "Pest", urgency: "medium", words: ["mouse", "rat", "roach", "cockroach", "ants", "bug", "pest", "insect"] },
  { category: "Locks/Hardware", urgency: "medium", words: ["lock", "key", "door", "window", "handle", "knob"] },
  { category: "Structural", urgency: "high", words: ["ceiling", "wall", "crack", "floor", "roof", "mold"] },
  { category: "Safety/Emergency", urgency: "emergency", words: ["fire", "gas", "carbon monoxide", "co alarm", "smoke detector", "burst", "flooding"] },
];

const wordSet = (text = "") =>
  new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );

const jaccard = (a = "", b = "") => {
  const A = wordSet(a);
  const B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => {
    if (B.has(w)) inter += 1;
  });
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
};

const capitalizeFirst = (text = "") =>
  text ? text.charAt(0).toUpperCase() + text.slice(1) : text;

// Whether we have enough structured detail to compose a genuine operational recap
// rather than falling back to a generic line.
function hasStructuredDetail(triage = {}) {
  return Boolean(
    (triage.subcategory && String(triage.subcategory).trim()) ||
      triage.location?.room ||
      triage.location?.area ||
      triage.timeline?.started ||
      triage.impact ||
      (Array.isArray(triage.attemptedFixes) && triage.attemptedFixes.length)
  );
}

// Build a synthesized recap from the structured incident fields — the issue, where
// it is, when it started and the trend, the impact, and what the tenant already
// tried. This is the dynamic "issue + answers" summary used when the model's own
// summary is just an echo of the tenant's words.
function synthesizeSummary(triage = {}) {
  const category =
    triage.category && triage.category !== "Other" ? triage.category : null;
  const subject =
    (triage.subcategory && String(triage.subcategory).trim()) ||
    (category ? `${category} issue` : "Maintenance issue");

  const room = String(triage.location?.room || "").trim();
  const area = String(triage.location?.area || "").trim();
  const started = String(triage.timeline?.started || "").trim();
  const trend = String(triage.timeline?.trend || "").trim();
  const validTrend = trend && trend !== "Unknown" ? trend.toLowerCase() : "";
  const impact = String(triage.impact || "").trim();
  const fixes = Array.isArray(triage.attemptedFixes)
    ? triage.attemptedFixes.map((f) => String(f || "").trim()).filter(Boolean)
    : [];

  const sentences = [];
  let lead = capitalizeFirst(subject);
  if (room) lead += ` in the ${room}`;
  if (area) lead += ` (${area})`;
  sentences.push(`${lead.replace(/\.+$/, "")}.`);

  if (started || validTrend) {
    const timeParts = [];
    if (started) timeParts.push(`started ${started}`);
    if (validTrend) timeParts.push(validTrend);
    sentences.push(`${capitalizeFirst(timeParts.join(", "))}.`);
  }
  if (impact) sentences.push(`${capitalizeFirst(impact).replace(/\.+$/, "")}.`);
  if (fixes.length) sentences.push(`Tenant already attempted: ${fixes.join("; ")}.`);

  // No cap here. There is exactly ONE summary budget and normalizeTriageOutput
  // applies it after this runs — a second, smaller cap in here is what used to
  // chop the synthesized recap mid-word.
  return sentences.join(" ");
}

function severityForUrgency(urgency = "medium") {
  return SEVERITY_BY_URGENCY[urgency] || SEVERITY_BY_URGENCY.medium;
}

// `limit` caps how many recent messages are kept (used to bound the LLM context).
// Pass 0 for the FULL history — required for repeat detection and turn counting,
// which must see every prior question, not just the last window.
function normalizeConversationHistory(history = [], limit = MODEL_HISTORY_LIMIT) {
  const arr = Array.isArray(history) ? history : [];
  const scoped = limit && limit > 0 ? arr.slice(-limit) : arr;
  return scoped
    .map((m) => ({
      role: m.role === "ai" ? "assistant" : m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || ""),
    }))
    .filter((m) => m.content.trim().length > 0);
}

function mergeAdditionalNotes(previousNotes = "", incoming = "") {
  const prev = String(previousNotes || "").trim();
  const next = String(incoming || "").trim();
  if (!next) return prev;
  if (!prev) return next;
  // Avoid re-appending a detail we have already captured.
  if (prev.toLowerCase().includes(next.toLowerCase())) {
    return prev;
  }
  if (next.toLowerCase().includes(prev.toLowerCase())) return next;
  return `${prev}\n${next}`;
}

// Once a request has reached ready_to_submit, the canonical summary is frozen.
// Any further detail the tenant provides is preserved as an append-only addendum
// (additionalNotes) instead of being allowed to overwrite the original summary.
function applySummaryLock(triage = {}, context = {}) {
  triage.additionalNotes = String(triage.additionalNotes || "").trim();
  const previous = context.previousTriage;
  const locked = Boolean(previous && previous.readyToSubmit && previous.summary);
  if (!locked) {
    triage.additionalNotes = mergeAdditionalNotes(previous?.additionalNotes, triage.additionalNotes);
    return triage;
  }

  // If the model wrote a fresh summary instead of repeating the locked one,
  // treat that text as new addendum material rather than discarding it.
  const newSummaryAsNote =
    triage.summary && jaccard(triage.summary, previous.summary) < 0.7
      ? triage.summary
      : "";

  let notes = String(previous.additionalNotes || "").trim();
  notes = mergeAdditionalNotes(notes, triage.additionalNotes);
  notes = mergeAdditionalNotes(notes, newSummaryAsNote);

  triage.additionalNotes = notes;
  triage.summary = previous.summary; // freeze the canonical summary verbatim
  return triage;
}

function addIntakeMetadata(triage = {}, context = {}, message = "") {
  triage.confidence = confidenceLabel(buildIncidentRecord({ triage }).confidence.overall);
  return selectQuestion(triage, context, message);
}

// Deterministic safety gate. When a hard hazard rule fires, escalate the triage to
// emergency and stamp authoritative safety guidance — it only ever escalates, never
// downgrades. The verdict is also recorded on triage.safetyGate for the workflow
// (escalation + manager notification + troubleshooting suppression).
function applySafetyGate(triage = {}, context = {}, message = "") {
  const gate = evaluateSafetyGate({
    message,
    conversationHistory: context.conversationHistory,
    category: triage.category,
  });

  if (gate.triggered) {
    triage.urgency = "emergency";
    triage.severity = severityForUrgency("emergency");
    triage.emergencyServicesRecommended = true;
    triage.safetyWarning = gate.guidance;
    triage.safety = {
      safetyRisk: true,
      riskType: gate.riskType,
      activeDamage: gate.activeDamage || Boolean(triage.safety?.activeDamage),
      lifeSafetyConcern: gate.lifeSafetyConcern,
    };
  }

  triage.safetyGate = {
    triggered: gate.triggered,
    hazards: gate.hazards,
    action: gate.action,
    notifyManager: gate.notifyManager,
    suppressTroubleshooting: gate.suppressTroubleshooting,
  };
  return triage;
}

// Marks the triage as resolved when the tenant's latest message says the issue is
// fixed. Safety always wins — a gate-escalated emergency is never treated as
// resolved on the strength of a "it's ok now".
function applyResolution(triage = {}, message = "", context = {}) {
  const isEmergency =
    triage.urgency === "emergency" || Boolean(triage.emergencyServicesRecommended);
  triage.resolved = !isEmergency && detectIssueResolved(message, context);
  return triage;
}

function buildTenantResponse(triage = {}) {
  const isEmergency =
    triage.urgency === "emergency" || Boolean(triage.emergencyServicesRecommended);
  const readyToSubmit =
    Boolean(triage.readyToSubmit) || triage.intakeStatus === "ready_to_submit";
  const followUps = Array.isArray(triage.followUpQuestions)
    ? triage.followUpQuestions.filter((q) => String(q || "").trim().length > 0)
    : [];
  const missingFields = Array.isArray(triage.missingFields)
    ? triage.missingFields.filter((q) => String(q || "").trim().length > 0)
    : [];
  const prompt = followUps[0] || missingFields[0] || "";

  if (isEmergency) {
    return {
      nextAction: "emergency_guidance",
      message:
        triage.safetyWarning ||
        "This appears to be an emergency. Prioritize immediate safety and contact emergency services if there is active danger.",
    };
  }

  if (triage.resolved) {
    return {
      nextAction: "issue_resolved",
      message:
        "I'm glad this issue is resolved! This chat will close shortly and take you back to your requests.",
    };
  }

  if (readyToSubmit) {
    return {
      nextAction: "submit_request",
      message: `You can submit this ${triage.category || "maintenance"} request now.`,
    };
  }

  if (prompt) {
    return {
      nextAction: "ask_follow_up",
      message: prompt,
    };
  }

  return {
    nextAction: "needs_more_info",
    message: "I need one more detail to route this correctly. What changed most recently?",
  };
}

function buildWorkflow(triage = {}) {
  const isEmergency =
    triage.urgency === "emergency" || Boolean(triage.emergencyServicesRecommended);
  const readyToSubmit =
    Boolean(triage.readyToSubmit) || triage.intakeStatus === "ready_to_submit";

  if (isEmergency) {
    const gate = triage.safetyGate || {};
    return {
      actionType: "emergency_guidance",
      shouldCreateTicket: true,
      shouldSearchVendor: false,
      shouldEscalateEmergency: true,
      // A deterministic-gate emergency notifies the manager and suppresses the
      // troubleshooting flow; a model-only emergency keeps the prior behavior.
      notifyManager: Boolean(gate.triggered),
      suppressTroubleshooting: Boolean(gate.suppressTroubleshooting),
      hazards: Array.isArray(gate.hazards) ? gate.hazards : [],
      vendorCategory: triage.suggestedVendorType || null,
    };
  }

  // Resolved via troubleshooting — close the chat without creating a request.
  if (triage.resolved) {
    return {
      actionType: "resolved_closed",
      shouldCreateTicket: false,
      shouldSearchVendor: false,
      shouldEscalateEmergency: false,
      vendorCategory: null,
    };
  }

  if (readyToSubmit) {
    return {
      actionType: "submit_request",
      shouldCreateTicket: true,
      shouldSearchVendor: true,
      shouldEscalateEmergency: false,
      vendorCategory: triage.suggestedVendorType || null,
    };
  }

  return {
    actionType: "ask_follow_up",
    shouldCreateTicket: false,
    shouldSearchVendor: false,
    shouldEscalateEmergency: false,
    vendorCategory: triage.suggestedVendorType || null,
  };
}

function buildTriageResult(triage = {}, options = {}) {
  const tenantResponse = buildTenantResponse(triage);
  if (!TENANT_NEXT_ACTIONS.includes(tenantResponse.nextAction)) {
    tenantResponse.nextAction = "needs_more_info";
  }
  const workflow = buildWorkflow(triage);
  const incidentRecord = buildIncidentRecord({
    triage,
    message: options.message || "",
    photos: options.photos || [],
    source: options.source || "form",
  });
  // Safe troubleshooting protocol for this issue (null when safety-gated/emergency).
  const troubleshooting = buildTroubleshooting(triage);
  // Agent/landlord-facing routing readiness — what should happen next with the request.
  const routingReadiness = deriveRoutingReadiness({ incidentRecord, triage });
  return {
    triage,
    incidentRecord,
    tenantResponse,
    workflow,
    troubleshooting,
    routingReadiness,
  };
}

// Whitespace-normalized text capped at a word boundary (keeps sentence punctuation).
function capAtWordBoundary(text = "", maxLength) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  const cut = compact.slice(0, maxLength + 1);
  const lastSpace = cut.lastIndexOf(" ");
  const sliced = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : compact.slice(0, maxLength);
  return sliced.replace(/[\s,;:-]+$/, "");
}

// Compact card-heading title: single line, capped at a word boundary, no trailing punctuation.
function compactTitle(text = "", maxLength = SHORT_TITLE_MAX_CHARS) {
  return capAtWordBoundary(text, maxLength).replace(/[\s.,;:!?-]+$/, "");
}

/**
 * Cap prose at a SENTENCE boundary, keeping only whole sentences.
 *
 * capAtWordBoundary is right for titles and wrong for summaries: it respects
 * words but not clauses, so a long recap ends "...and the tenant has already
 * tried" — grammatically mid-air, and indistinguishable from the model having
 * stopped early. A summary should always read as finished.
 *
 * Falls back to a word-boundary cut only when the very first sentence is itself
 * over budget, which is the one case where there is no whole sentence to keep.
 * That fallback gets an explicit ellipsis: a bare word-boundary cut is
 * indistinguishable from the model having stopped early, which is the exact
 * complaint this function exists to fix. Better to look deliberately shortened
 * than accidentally broken.
 *
 * Mirrors condenseSummary in the frontend's requestDetailSelectors.ts.
 */
function capAtSentenceBoundary(text = "", maxLength) {
  const compact = String(text).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;

  const sentences = compact.split(/(?<=[.!?])\s+/);
  let result = "";
  for (const sentence of sentences) {
    const next = result ? `${result} ${sentence}` : sentence;
    if (next.length > maxLength) break;
    result = next;
  }
  if (result) return result;

  // One sentence, longer than the whole budget. Reserve room for the ellipsis so
  // the returned string still respects maxLength.
  const truncated = capAtWordBoundary(compact, Math.max(1, maxLength - 1));
  return `${truncated.replace(/[\s.,;:!?-]+$/, "")}…`;
}

function firstSentence(text = "") {
  return String(text).split(/(?<=[.!?])\s+/)[0] || "";
}

function deterministicTriage({ message = "", category, photos = [], context = {} }) {
  const text = [context.previousTriage?.summary, ...normalizeConversationHistory(context.conversationHistory, 0).filter((m) => m.role === "user").map((m) => m.content), message].filter(Boolean).join(" ").toLowerCase();
  let chosen = { category: "Other", urgency: "medium" };
  let bestHits = 0;

  for (const rule of KEYWORD_RULES) {
    const hits = rule.words.filter((w) => text.includes(w)).length;
    if (hits > bestHits) {
      bestHits = hits;
      chosen = { category: rule.category, urgency: rule.urgency };
    }
  }

  if (category || context.previousTriage?.category) chosen.category = category || context.previousTriage.category;

  const isEmergency = evaluateSafetyGate({ message, conversationHistory: context.conversationHistory }).triggered;
  if (!isEmergency && chosen.urgency === "emergency") chosen.urgency = "high";

  // A follow-up such as "No pets" is not a replacement incident narrative.
  // Keep actual tenant turns in order; assistant questions are not facts.
  const tenantMessages = normalizeConversationHistory(context.conversationHistory, 0)
    .filter(turn => turn.role === 'user').map(turn => turn.content.trim());
  if (!tenantMessages.length && context.previousTriage?.summary) tenantMessages.push(context.previousTriage.summary);
  if (message.trim() && !tenantMessages.includes(message.trim())) tenantMessages.push(message.trim());
  const summary = capAtSentenceBoundary(tenantMessages.join(' '), SUMMARY_MAX_CHARS) || "Maintenance request submitted.";

  const triage = {
    // mergeFacts can include undefined scalar placeholders. Apply extracted
    // fields first so they cannot erase this fallback's narrative or heading.
    ...extractFacts(message, context),
    summary,
    shortTitle:
      compactTitle(firstSentence(summary), FALLBACK_TITLE_MAX_CHARS) || "Maintenance request",
    additionalNotes: message,
    category: chosen.category,
    urgency: isEmergency ? "emergency" : chosen.urgency,
    severity: severityForUrgency(isEmergency ? "emergency" : chosen.urgency),
    suggestedResponsibility: "unknown",
    suggestedVendorType: resolveVendorServiceNeeded({
      suggestedVendorType: chosen.category,
      category: chosen.category,
      message,
    }),
    followUpQuestions: [],
    safetyWarning: isEmergency
      ? "Potential safety hazard detected. Consider contacting emergency services if there is immediate danger."
      : "",
    emergencyServicesRecommended: isEmergency,
    source: "deterministic_fallback",
    raw: { method: "keyword_match", hits: bestHits, photoCount: photos.length },
  };

  return normalizeTriageOutput(triage, message, chosen.category, context);
}

function normalizeTriageOutput(input = {}, fallbackMessage = "", fallbackCategory = "Other", context = {}) {
  const triage = mergeFacts(context.previousTriage || {}, input || {});
  triage.access.permissionToEnter = explicitEntryConsent(fallbackMessage, context.conversationHistory || []);
  // Prior denial remains conservative. A previous client snapshot alone cannot
  // establish affirmative consent; the full tenant history supplies that evidence.
  if (triage.access.permissionToEnter === null && context.previousTriage?.access?.permissionToEnter === false) {
    triage.access.permissionToEnter = false;
  }
  delete triage.acknowledgment;
  delete triage.acknowledgement;
  if (/\b(?:possibly|maybe|might|could|not sure)\b[^.!?]*\b(?:worse|worsening|widening)\b/i.test(fallbackMessage) &&
      triage.timeline.trend === "Worsening" && context.previousTriage?.timeline?.trend !== "Worsening") {
    triage.timeline.trend = "Unknown";
    triage.additionalNotes = mergeAdditionalNotes(triage.additionalNotes, fallbackMessage);
  }
  // Normalize whitespace but do NOT cap yet — the summary may still be replaced
  // by synthesizeSummary below, and capping twice at two budgets is the bug.
  triage.summary = String(
    triage.summary || fallbackMessage || "Maintenance request submitted."
  )
    .replace(/\s+/g, " ")
    .trim();
  triage.additionalNotes = capAtSentenceBoundary(triage.additionalNotes || "", NOTES_MAX_CHARS);
  triage.category = CATEGORIES.includes(triage.category) ? triage.category : (fallbackCategory || "Other");
  triage.urgency = URGENCIES.includes(triage.urgency) ? triage.urgency : "medium";
  triage.severity = severityForUrgency(triage.urgency);
  triage.suggestedResponsibility = RESPONSIBILITIES.includes(triage.suggestedResponsibility)
    ? triage.suggestedResponsibility
    : "unknown";
  triage.suggestedVendorType = resolveVendorServiceNeeded({
    suggestedVendorType: triage.suggestedVendorType,
    category: triage.category,
    message: fallbackMessage,
  });
  // Deterministic safety gate runs before the emergency-only follow-up filtering so
  // a gate-escalated request also drops scheduling questions.
  applySafetyGate(triage, context, fallbackMessage);
  applyResolution(triage, fallbackMessage, context);
  triage.followUpQuestions = Array.isArray(triage.followUpQuestions)
    ? triage.followUpQuestions.slice(0, 5).map((q) => String(q))
    : [];
  if (triage.urgency === "emergency") {
    const nonEmergencySchedulingPattern =
      /when can|best time|availability|available|access the property|schedule|appointment|calendar/i;
    triage.followUpQuestions = triage.followUpQuestions.filter(
      (q) => !nonEmergencySchedulingPattern.test(q)
    );
  }
  triage.safetyWarning = (triage.safetyWarning || "").toString();
  triage.emergencyServicesRecommended = Boolean(triage.emergencyServicesRecommended);
  // The model's summary is just an echo of the tenant's words. Replace it with a
  // synthesized recap ONLY when we have structured detail to build from; otherwise
  // keep the model's text (the tenant's own description) rather than a dry generic
  // line. A deterministic fallback intentionally keeps the original narrative:
  // its conservative extraction is incomplete and cannot replace tenant facts
  // such as worsening damage or containment. Check this input's provenance,
  // not the merged previous turn's source, so model output keeps its behavior.
  if (input?.source !== "deterministic_fallback" &&
      jaccard(triage.summary, fallbackMessage) >= 0.7 && hasStructuredDetail(triage)) {
    triage.summary = synthesizeSummary(triage);
  }
  // THE single summary cap, applied once, after every path that can produce or
  // replace the text — and before applySummaryLock, which freezes whatever is
  // here verbatim for the rest of the request's life.
  triage.summary = capAtSentenceBoundary(triage.summary, SUMMARY_MAX_CHARS);
  triage.shortTitle =
    compactTitle(triage.shortTitle || firstSentence(triage.summary), SHORT_TITLE_MAX_CHARS) ||
    "Maintenance request";
  applySummaryLock(triage, context);
  return addIntakeMetadata(triage, context, fallbackMessage);
}

const TRIAGE_SCHEMA = {
  name: "maintenance_triage",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        // Was "1-2 sentence summary of the issue", which contradicted the system
        // prompt's demand for a cumulative recap and pushed the model to write
        // short. The prompt is the intent; this description now matches it.
        description:
          "Operational recap of the issue, typically 3-6 sentences. Weaves together the issue and its subcategory, where it is, when it started and the trend, the impact on the tenant, and anything already tried. Grows richer as the tenant answers follow-up questions.",
      },
      shortTitle: {
        type: "string",
        description:
          "Compact noun-phrase title of the issue, max 8 words, no trailing punctuation, e.g. 'Oven not receiving power'.",
      },
      additionalNotes: {
        type: "string",
        description:
          "Cumulative operational notes from the FIRST turn: scheduling flexibility, containment, access constraints, concerns, uncertainty, and useful details outside structured fields. Preserve earlier notes; record corrections explicitly.",
      },
      topicAnswers: {
        type: "array", items: { type: "object", additionalProperties: false,
          properties: { topicId: { type: "string", enum: TOPIC_IDS }, state: { type: "string", enum: ANSWER_STATES } },
          required: ["topicId", "state"] },
      },
      questionCandidates: {
        type: "array", maxItems: 4,
        items: { type: "object", additionalProperties: false,
          properties: { topicId: { type: "string", enum: TOPIC_IDS }, question: { type: "string" } },
          required: ["topicId", "question"] },
      },
      troubleshootingState: { type: "array", items: { type: "object", additionalProperties: false,
        properties: { stepId: { type: "string", enum: ALL_STEP_IDS }, state: { type: "string", enum: ["attempted", "unsuccessful", "declined", "irrelevant"] } },
        required: ["stepId", "state"] } },
      correctedFields: { type: "array", items: { type: "string", enum: CORRECTABLE_FIELDS }, description: "Only list fields explicitly corrected or withdrawn by the tenant. Their new values replace earlier facts, including an empty/null value when the tenant withdraws an assertion." },
      category: { type: "string", enum: CATEGORIES },
      subcategory: {
        type: ["string", "null"],
        description:
          "Specific issue type within the category (e.g. 'Leaking pipe', 'No heat'). Null if not yet determinable.",
      },
      impact: {
        type: "string",
        description:
          "How the issue affects the tenant's use of the unit (e.g. 'Kitchen sink unusable'). Empty string if unknown.",
      },
      location: {
        type: "object",
        additionalProperties: false,
        description: "Where in the unit the issue is. Empty strings if unknown.",
        properties: {
          room: { type: "string" },
          area: { type: "string" },
        },
        required: ["room", "area"],
      },
      timeline: {
        type: "object",
        additionalProperties: false,
        description: "When the issue started and whether it is changing.",
        properties: {
          started: {
            type: "string",
            description: "Relative or absolute start time (e.g. '2 hours ago'). Empty if unknown.",
          },
          trend: { type: "string", enum: TIMELINE_TRENDS },
        },
        required: ["started", "trend"],
      },
      attemptedFixes: {
        type: "array",
        description: "Things the tenant has already tried. Empty array if none.",
        items: { type: "string" },
        maxItems: 8,
      },
      safety: {
        type: "object",
        additionalProperties: false,
        description: "Structured safety checklist.",
        properties: {
          safetyRisk: { type: ["boolean", "null"] },
          riskType: { type: ["string", "null"], enum: [...RISK_TYPES, null] },
          activeDamage: { type: ["boolean", "null"] },
          lifeSafetyConcern: { type: ["boolean", "null"] },
        },
        required: ["safetyRisk", "riskType", "activeDamage", "lifeSafetyConcern"],
      },
      access: {
        type: "object",
        additionalProperties: false,
        description: "Structured access details for scheduling a vendor visit.",
        properties: {
          permissionToEnter: { type: ["boolean", "null"] },
          pets: { type: ["boolean", "null"] },
          preferredTimes: { type: "array", items: { type: "string" }, maxItems: 5 },
        },
        required: ["permissionToEnter", "pets", "preferredTimes"],
      },
      costTier: { type: "string", enum: COST_TIERS },
      urgency: { type: "string", enum: URGENCIES },
      severity: { type: "integer", minimum: 1, maximum: 5 },
      suggestedResponsibility: { type: "string", enum: RESPONSIBILITIES },
      suggestedVendorType: {
        type: ["string", "null"],
        enum: [...SUPPORTED_VENDOR_SERVICES, null],
      },
      followUpQuestions: {
        type: "array",
        items: { type: "string" },
        maxItems: 5,
      },
      safetyWarning: { type: "string" },
      emergencyServicesRecommended: { type: "boolean" },
      readyToSubmit: { type: "boolean" },
      intakeStatus: { type: "string", enum: INTAKE_STATUSES },
      missingFields: {
        type: "array",
        items: { type: "string" },
        maxItems: 3,
      },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
    },
    required: [
      "summary",
      "topicAnswers",
      "questionCandidates",
      "correctedFields",
      "troubleshootingState",
      "shortTitle",
      "additionalNotes",
      "category",
      "subcategory",
      "impact",
      "location",
      "timeline",
      "attemptedFixes",
      "safety",
      "access",
      "costTier",
      "urgency",
      "severity",
      "suggestedResponsibility",
      "suggestedVendorType",
      "followUpQuestions",
      "safetyWarning",
      "emergencyServicesRecommended",
      "readyToSubmit",
      "intakeStatus",
      "missingFields",
      "confidence",
    ],
  },
  strict: true,
};

async function aiTriage({ message, category, photos = [], context = {} }) {
  const incidentOptions = { message, photos, source: context.source };
  const systemPrompt = `You are Iris, an expert property maintenance triage assistant.
You receive a tenant's description of a maintenance issue and return STRICTLY structured JSON.

Rules:
- Pick the best category from this fixed list: ${CATEGORIES.join(", ")}.
- Urgency must be one of: ${URGENCIES.join(", ")}.
- Severity is a normalized operational score and must match urgency exactly: low=1, medium=3, high=4, emergency=5.
- Set emergencyServicesRecommended=true ONLY when there is immediate risk to life or property (active fire, gas leak, severe flooding, electrical shock risk, carbon monoxide).
- Be concise. Questions contain only the question, with no acknowledgements, empathy, thanks, apologies, or conversational preamble. Never claim a manager was alerted or a repair arranged before submission.
- FIRST extract ALL useful information from the ENTIRE conversation, including details volunteered while answering another topic. THEN propose questions only for useful unanswered topics.
- topicAnswers records answered, unknown, or declined for each established topic. "I don't know", "I haven't tried anything", explicit negatives, and refusals are meaningful answers. Never re-ask them.
- questionCandidates must target stable topicId values. Ask ONE part at a time: availability, entryPermission, and pets are separate. Any day/anytime answers availability ONLY; entry requires explicit consent. Do not infer consent from availability.
- Prefer unresolved safety concerns, then essential diagnosis/routing gaps, then access. Aim for 2-4 follow-ups for detailed reports. Optional details must never block submission; the server enforces a six-follow-up maximum for essentials.
- Do not demand measurements or specialist knowledge. For structural change accept descriptions; photos are optional and must be safe to take.
- troubleshootingState records the stable stepId and state (attempted, unsuccessful, declined, irrelevant) for approved steps. Never repeat a failed, attempted, declined, irrelevant, or unsuccessful step. A repeatedly tripping breaker must NOT be reset again.
- Record supported contextual inference, but preserve uncertainty in additionalNotes: "possibly worsening" is not confirmed Worsening. Use null for unestablished safety booleans.
- Tenant corrections replace the affected facts. correctedFields lists only explicitly corrected or withdrawn fields; supply the new value, including empty/null when a fact is withdrawn. Keep unrelated earlier facts.
- Summary must be a synthesized operational recap that weaves together the issue (and its specific subcategory), where it is (room/area), when it started and the trend, the impact on the tenant, and anything they have already tried — written in clear operational language, NOT a direct quote or close paraphrase of the tenant's last message. As the tenant answers follow-up questions, fold those answers into the summary so it grows richer each turn.
- The summary is cumulative while gathering info: preserve every previously established critical fact (the hazard, what the tenant did to mitigate it, and access notes) and integrate new details rather than replacing earlier ones.
- A previousSummary may be supplied. When 'locked' is true, the request is already ready to submit and the summary is FINAL: copy previousSummary verbatim into summary, never reword, reorder, shorten, or drop any of it. Put any genuinely new, operationally useful detail in additionalNotes instead, and discard incidental or low-value remarks.
- additionalNotes captures useful nuances from the FIRST turn and accumulates across turns, including availability flexibility, containment, concerns and uncertainty. Preserve earlier notes. Record corrections clearly.
- shortTitle is a compact noun-phrase heading for the issue (max 8 words, no trailing punctuation), e.g. "Oven not receiving power" — suitable as a card title. Keep it stable across turns unless the understanding of the issue changes materially.
- Populate the structured incident fields whenever the tenant gives you the information:
  - subcategory: the specific issue type within the category (e.g. "Leaking pipe", "No heat", "Dead outlet").
  - impact: how the issue affects use of the unit (e.g. "Kitchen sink unusable"); empty string if unknown.
  - location.room / location.area: where the issue is (e.g. room "Kitchen", area "Under sink"); empty strings if unknown.
  - timeline.started: when it began (relative is fine, e.g. "2 hours ago"); empty if unknown. timeline.trend: one of ${TIMELINE_TRENDS.join(", ")} (use "Unknown" if unclear).
  - attemptedFixes: array of things the tenant already tried; empty array if none/unknown.
  - safety: safetyRisk (any hazard present), riskType (one of ${RISK_TYPES.join(", ")} or null), activeDamage (ongoing damage like water spreading), lifeSafetyConcern (immediate risk to a person). Be conservative: only set true when supported by the description.
  - access: permissionToEnter (true/false/null), pets (true/false/null), preferredTimes (array; empty for emergencies).
  - costTier: rough magnitude, one of ${COST_TIERS.join(", ")} ("Unknown" if unclear).
- questionCandidates contains at most four useful unanswered questions with stable topic identifiers. Respect previousIntakeState, skip any answered/unknown/declined or previously asked topic. followUpQuestions is a legacy projection; the server selects the displayed question. If useful details are already supplied, do not ask again. Do not force questions for optional details. Safety clarification comes first; do not confuse a hypothetical fire hazard with an active fire.
- suggestedVendorType must be either one supported vendor service or null.
- Use only these supported vendor services: ${SUPPORTED_VENDOR_SERVICES.join(", ")}.
- If the issue category is Safety/Emergency or Other, suggestedVendorType must still be the best supported vendor service when confidently known, otherwise null.
- readyToSubmit=true only when enough detail exists to create a useful maintenance request or when the issue is an emergency.
- missingFields should contain the most important unanswered questions when readyToSubmit=false.
- For emergency urgency, prioritize safety/containment questions first and DO NOT ask scheduling or access-time coordination questions yet.
- Stop optional questions after four follow-ups and all questions after six. Remaining uncertainty can be submitted for manager review.`;

  // Inject the approved troubleshooting script for this category, but only when the
  // safety gate is not tripped — no troubleshooting during a hazard.
  const preGate = evaluateSafetyGate({
    message,
    conversationHistory: context.conversationHistory,
    category,
  });
  const protocol = preGate.triggered
    ? null
    : buildTroubleshooting({ ...context.previousTriage, category, additionalNotes: [context.previousTriage?.additionalNotes, message, ...normalizeConversationHistory(context.conversationHistory).filter((m) => m.role === "user").map((m) => m.content)].filter(Boolean).join(" ") });
  const fullSystemPrompt = protocol
    ? `${systemPrompt}\n\n${formatProtocolForPrompt(protocol)}`
    : systemPrompt;

  const history = normalizeConversationHistory(context.conversationHistory);

  const previousTriage = context.previousTriage || null;
  const userPayload = {
    tenantMessage: message,
    providedCategory: category || null,
    photosCount: photos.length,
    previousSummary: previousTriage?.summary || null,
    previousIntakeState: previousTriage?.intakeState || null,
    previousTroubleshootingState: previousTriage?.troubleshootingState || [],
    previousAdditionalNotes: previousTriage?.additionalNotes || null,
    // Carry forward already-established structured fields so the model keeps them
    // and only fills the gaps instead of re-deriving (and possibly dropping) them.
    previousStructured: previousTriage
      ? {
          subcategory: previousTriage.subcategory || null,
          impact: previousTriage.impact || "",
          location: previousTriage.location || null,
          timeline: previousTriage.timeline || null,
          attemptedFixes: previousTriage.attemptedFixes || [],
          safety: previousTriage.safety || null,
          access: previousTriage.access || null,
          costTier: previousTriage.costTier || null,
        }
      : null,
    locked: Boolean(previousTriage?.readyToSubmit && previousTriage?.summary),
    context: {
      property: context.property || null,
      unit: context.unit || null,
    },
  };

  const result = await runTriage({
      messages: [
        { role: "system", content: fullSystemPrompt },
        ...history,
        {
          role: "user",
          content: `Current triage input:\n${JSON.stringify(userPayload)}\n\nUse conversation context to avoid repeating already answered questions. Preserve every non-empty field in 'previousStructured' and only fill gaps or refine with new detail — never blank out a field you previously established unless the tenant explicitly withdraws it and you list it in correctedFields. If 'locked' is true, keep 'summary' identical to 'previousSummary' and place any new useful detail in 'additionalNotes'.`,
        },
      ],
      schema: TRIAGE_SCHEMA,
    });

  const triage = result.parsed
    ? normalizeTriageOutput(result.parsed, message, category || "Other", context)
    : deterministicTriage({ message, category, photos, context });
  triage.source = result.telemetry.provider;
  triage.raw = result.telemetry;
  return buildTriageResult(triage, incidentOptions);
}

module.exports = {
  aiTriage,
  deterministicTriage,
  normalizeTriageOutput,
  buildTenantResponse,
  buildWorkflow,
  buildTriageResult,
  detectIssueResolved,
  // Exported for scripts/backfill_summaries.js, which repairs summaries that
  // were truncated and then frozen under the old caps.
  synthesizeSummary,
  hasStructuredDetail,
  capAtSentenceBoundary,
  SUMMARY_MAX_CHARS,
  CATEGORIES,
  URGENCIES,
  RESPONSIBILITIES,
  TRIAGE_SCHEMA,
};

