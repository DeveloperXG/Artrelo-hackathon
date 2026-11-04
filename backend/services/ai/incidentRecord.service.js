// Incident Record — the canonical, structured operational truth for a maintenance
// request. The tenant's free-text description is evidence; this object is what
// powers troubleshooting, routing, scheduling, approval, and (later) learning.
//
// buildIncidentRecord() assembles the record from the AI triage output plus
// deterministic fallbacks, so the record is always well-formed even when the
// model omits fields or the deterministic keyword path is used. computeConfidence()
// scores how complete/actionable the record is and lists the structured fields
// still missing — this drives the "ready to route" gating downstream.

const {
  resolveVendorServiceNeeded,
} = require("../vendor/vendorServices.service");

const COST_TIERS = ["Low", "Medium", "High", "Unknown"];
const TIMELINE_TRENDS = ["Improving", "Stable", "Worsening", "Unknown"];
// Coarse classification of the active hazard, kept null when there is no risk.
const RISK_TYPES = [
  "gas",
  "fire",
  "smoke",
  "flooding",
  "electrical",
  "structural",
  "sewage",
  "carbon_monoxide",
  "injury",
  "other",
];

// Deterministic subcategory inference. Used as a fallback when the model does not
// supply a subcategory (e.g. the keyword path). The first matching rule wins.
const SUBCATEGORY_RULES = {
  Plumbing: [
    { name: "Burst pipe", words: ["burst", "pipe burst"] },
    { name: "Leaking pipe", words: ["leak", "leaking", "drip", "under sink", "water under"] },
    { name: "Clogged drain", words: ["clog", "clogged", "backed up", "draining slow", "slow drain", "won't drain"] },
    { name: "Running/overflowing toilet", words: ["toilet", "overflow", "running water"] },
    { name: "No water", words: ["no water", "lost water", "water pressure"] },
    { name: "No hot water", words: ["no hot water", "hot water"] },
  ],
  Electrical: [
    { name: "Sparking/burning outlet", words: ["spark", "burning", "smell of burning", "smoke"] },
    { name: "No power", words: ["no power", "power out", "lost power"] },
    { name: "Tripped breaker", words: ["breaker", "fuse", "tripped"] },
    { name: "Dead outlet", words: ["outlet", "socket", "plug"] },
    { name: "Lighting issue", words: ["light", "bulb", "flicker"] },
  ],
  HVAC: [
    { name: "No heat", words: ["no heat", "heater", "furnace", "cold", "heating"] },
    { name: "No cooling", words: ["no ac", "air condition", "ac not", "hot", "cooling"] },
    { name: "Thermostat issue", words: ["thermostat"] },
    { name: "Airflow/filter", words: ["filter", "airflow", "vent"] },
  ],
  Appliance: [
    { name: "Refrigerator", words: ["fridge", "refrigerator", "freezer"] },
    { name: "Oven/Stove", words: ["oven", "stove", "range", "cooktop"] },
    { name: "Dishwasher", words: ["dishwasher"] },
    { name: "Washer/Dryer", words: ["washer", "dryer", "laundry"] },
  ],
  Structural: [
    { name: "Roof/Ceiling", words: ["roof", "ceiling"] },
    { name: "Wall/Floor", words: ["wall", "floor", "crack"] },
    { name: "Mold/Moisture", words: ["mold", "mould", "damp", "moisture"] },
    { name: "Door/Window", words: ["door", "window"] },
  ],
  Pest: [
    { name: "Rodents", words: ["mouse", "mice", "rat", "rodent"] },
    { name: "Insects", words: ["roach", "cockroach", "ant", "bug", "insect", "bed bug"] },
  ],
  "Locks/Hardware": [
    { name: "Lock/Key", words: ["lock", "key", "deadbolt"] },
    { name: "Handle/Knob", words: ["handle", "knob", "hinge"] },
  ],
};

function normalizeText(value) {
  return String(value || "").trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function inferSubcategory(category, text) {
  const rules = SUBCATEGORY_RULES[category];
  if (!rules) return null;
  const haystack = lower(text);
  if (!haystack) return null;
  for (const rule of rules) {
    if (rule.words.some((word) => haystack.includes(word))) return rule.name;
  }
  return null;
}

// Cost magnitude tier — a rough operational signal (not a quote). Derived from
// severity + category so it is available before any vendor pricing exists. The
// model may override via triage.costTier when it is confident.
function deriveCostTier({ category, severity }) {
  const sev = Number(severity) || 0;
  if (sev >= 5) return "High";
  const expensiveTrades = ["Plumbing", "Electrical", "HVAC", "Structural"];
  if (sev >= 4 && expensiveTrades.includes(category)) return "High";
  if (sev >= 3) return "Medium";
  if (sev >= 1) return "Low";
  return "Unknown";
}

function clampUnit(value) {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// Structured-completeness scoring. Each field carries a weight; the overall score
// is the fraction of weight present. missingFields lists the absent keys so the
// intake can ask for exactly what would raise confidence. Photo absence does not
// block submission but is recorded as a penalty signal for routing.
const CONFIDENCE_FIELDS = [
  { key: "category", weight: 0.12, present: (r) => Boolean(r.category) && r.category !== "Other" },
  { key: "subcategory", weight: 0.1, present: (r) => Boolean(r.subcategory) },
  { key: "impact", weight: 0.12, present: (r) => normalizeText(r.impact).length > 0 },
  { key: "location", weight: 0.12, present: (r) => normalizeText(r.location?.room).length > 0 },
  { key: "timeline", weight: 0.12, present: (r) => normalizeText(r.timeline?.started).length > 0 },
  { key: "evidence", weight: 0.15, present: (r) => Number(r.evidence?.photos) > 0 || Boolean(r.evidence?.video) },
  { key: "responsibility", weight: 0.12, present: (r) => Boolean(r.responsibility) && r.responsibility !== "unknown" },
  { key: "access", weight: 0.05, present: (r) => typeof r.access?.permissionToEnter === "boolean" },
  { key: "attemptedFixes", weight: 0.05, present: (r) => Array.isArray(r.attemptedFixes) && r.attemptedFixes.length > 0 },
  { key: "trade", weight: 0.05, present: (r) => Boolean(r.trade) },
];

function computeConfidence(record = {}) {
  let earned = 0;
  const missingFields = [];
  for (const field of CONFIDENCE_FIELDS) {
    if (field.present(record)) {
      earned += field.weight;
    } else {
      missingFields.push(field.key);
    }
  }
  let overall = clampUnit(earned);
  // Emergencies are routed on safety, not completeness — never gate them low.
  if (record.emergency) overall = Math.max(overall, 0.9);
  return {
    overall: Math.round(overall * 100) / 100,
    missingFields,
  };
}

function normalizeStringArray(value, max = 10) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeText(entry))
    .filter((entry) => entry.length > 0)
    .slice(0, max);
}

// Assemble the canonical incident record from a normalized triage object. The
// triage object may or may not carry the richer guided-intake fields (impact,
// location, timeline, ...) depending on whether the expanded schema produced
// them; everything is defaulted so the record is always complete in shape.
function normalizeEvidenceAssets(assets = []) {
  if (!Array.isArray(assets)) return [];
  return assets
    .filter((asset) => asset && asset.url)
    .map((asset) => ({
      url: normalizeText(asset.url),
      publicId: normalizeText(asset.publicId) || undefined,
      type: asset.type === "video" ? "video" : "image",
      label: normalizeText(asset.label) || null,
      format: normalizeText(asset.format) || undefined,
      bytes: Number(asset.bytes) || undefined,
      width: Number(asset.width) || undefined,
      height: Number(asset.height) || undefined,
    }));
}

function buildIncidentRecord({
  triage = {},
  message = "",
  photos = [],
  evidence = [],
  source = "form",
} = {}) {
  const category = triage.category || "Other";
  const emergency =
    Boolean(triage.emergencyServicesRecommended) || triage.urgency === "emergency";
  const trade =
    resolveVendorServiceNeeded({
      suggestedVendorType: triage.suggestedVendorType,
      category,
      message,
    }) || null;

  const subcategory =
    normalizeText(triage.subcategory) ||
    inferSubcategory(category, `${triage.summary || ""} ${message}`);

  const safetyInput = triage.safety || {};
  const safety = {
    safetyRisk: Boolean(safetyInput.safetyRisk ?? Boolean(triage.safetyWarning) ?? false),
    riskType: RISK_TYPES.includes(safetyInput.riskType) ? safetyInput.riskType : null,
    activeDamage: Boolean(safetyInput.activeDamage),
    lifeSafetyConcern: Boolean(safetyInput.lifeSafetyConcern ?? emergency),
  };

  const locationInput = triage.location || {};
  const location = {
    room: normalizeText(locationInput.room),
    area: normalizeText(locationInput.area),
  };

  const timelineInput = triage.timeline || {};
  const timeline = {
    started: normalizeText(timelineInput.started),
    trend: TIMELINE_TRENDS.includes(timelineInput.trend) ? timelineInput.trend : "Unknown",
  };

  // Prefer structured evidence assets when present; otherwise fall back to the
  // legacy photo-url/count input. Counts and type flags are derived, never trusted
  // from the model.
  const assets = normalizeEvidenceAssets(
    evidence.length ? evidence : triage.evidence?.assets
  );
  const evidenceInput = triage.evidence || {};
  const photoCount = assets.length
    ? assets.filter((asset) => asset.type === "image").length
    : Array.isArray(photos)
    ? photos.length
    : Number(photos) || 0;
  const hasVideo = assets.some((asset) => asset.type === "video") || Boolean(evidenceInput.video);
  const evidenceRecord = {
    photos: photoCount,
    video: hasVideo,
    voice: Boolean(evidenceInput.voice) || source === "voice",
    confidencePenalty: photoCount === 0 && !hasVideo,
    assets,
  };

  const accessInput = triage.access || {};
  const access = {
    permissionToEnter:
      typeof accessInput.permissionToEnter === "boolean"
        ? accessInput.permissionToEnter
        : null,
    pets: typeof accessInput.pets === "boolean" ? accessInput.pets : null,
    preferredTimes: normalizeStringArray(accessInput.preferredTimes, 5),
  };

  const costTier = COST_TIERS.includes(triage.costTier)
    ? triage.costTier
    : deriveCostTier({ category, severity: triage.severity });

  const record = {
    category,
    subcategory: subcategory || null,
    trade,
    summary: normalizeText(triage.summary),
    impact: normalizeText(triage.impact),
    severity: Number(triage.severity) || 3,
    emergency,
    safety,
    location,
    timeline,
    evidence: evidenceRecord,
    attemptedFixes: normalizeStringArray(triage.attemptedFixes),
    access,
    responsibility: triage.suggestedResponsibility || "unknown",
    costTier,
  };

  record.confidence = computeConfidence(record);
  return record;
}

module.exports = {
  COST_TIERS,
  TIMELINE_TRENDS,
  RISK_TYPES,
  SUBCATEGORY_RULES,
  inferSubcategory,
  deriveCostTier,
  computeConfidence,
  buildIncidentRecord,
};
