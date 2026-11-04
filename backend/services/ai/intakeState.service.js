// Topic identifiers are shared by extraction, selection, and persisted intake.
// The provider proposes questions; only this policy chooses what is displayed.
const TOPICS = {
  safety: "Is there any immediate danger right now, such as smoke, a burning smell, or water near electricity?",
  impact: "How is this affecting your use of the space right now?",
  location: "Where exactly is this happening — which room and spot?",
  timeline: "When did you first notice it, and how has it changed?",
  attemptedFixes: "Have you tried anything to fix or contain it so far?",
  availability: "What days or times work best for a visit?",
  entryPermission: "Is it okay for a technician to enter if you're not home?",
  pets: "Are there any pets the technician should know about?",
  thermostat: "What is the thermostat mode and setting?",
  indoorTemperature: "How warm or cold does it feel indoors? A temperature reading is optional.",
  filter: "Do you know when the air filter was last changed?",
  breaker: "Is the breaker for that area switched off or tripped?",
  gfci: "Is there a GFCI outlet nearby?",
  extent: "Are other rooms or fixtures affected too?",
  errorCode: "Is there an error code or blinking light visible?",
  applianceModel: "Do you know the appliance brand or model?",
  power: "Is it getting power or turning on at all?",
  waterSupply: "Is the water supply turned on?",
  structuralChange: "What changes have you noticed in the cracks or doors? A photo taken safely is optional.",
  pestEvidence: "Where have you noticed pests or signs of them?",
  disposal: "If there is a garbage disposal, does it run?",
  drainBackup: "Does water back up when you use the drain?",
  toiletOverflow: "Is the toilet overflowing now or just running?",
  toiletFlow: "Does the toilet run constantly or only after a flush?",
};
const TOPIC_IDS = Object.keys(TOPICS);
const ANSWER_STATES = ["answered", "unknown", "declined"];
const CORRECTABLE_FIELDS = ["subcategory", "impact", "location.room", "location.area", "timeline.started", "timeline.trend",
  "attemptedFixes", "safety.safetyRisk", "safety.riskType", "safety.activeDamage", "safety.lifeSafetyConcern",
  "access.permissionToEnter", "access.pets", "access.preferredTimes", "costTier"];
function answerState(value) {
  const text = String(value || "").replace(/’/g, "'");
  if (/don't know|do not know|not sure|no idea|unsure|can't tell/i.test(text)) return "unknown";
  if (/prefer not|rather not|don't want|decline|won't|refuse|cannot safely|can't safely/i.test(text)) return "declined";
  return "answered";
}
const SIGNALS = {
  entryPermission: /permission|enter|entry|come in|access (the|your) (unit|home|property)/i,
  availability: /availab|times? work|preferred (time|visit)|schedul|when.*(visit|come)|days or times/i,
  pets: /\bpets?\b|\bdogs?\b|\bcats?\b/i,
  thermostat: /thermostat/i,
  indoorTemperature: /indoors|indoor temperature|room temperature|warm or cold/i,
  filter: /air filter/i,
  breaker: /breaker/i,
  gfci: /gfci/i,
  errorCode: /error code|blinking light/i,
  applianceModel: /brand|model/i,
  waterSupply: /water supply/i,
  power: /getting power|turning on/i,
  structuralChange: /crack|door.*(mov|stick)|measure|width/i,
  pestEvidence: /droppings|sightings|pests|noises/i,
  extent: /other (rooms|outlets|drains|fixtures)|only this/i,
  safety: /smoke|burning smell|immediate danger|any.*(hazard|risk)/i,
  impact: /affect|impact|able to use|unusable|use of (the|your)/i,
  location: /where|which room|what room|location/i,
  timeline: /when did|how long|since when|start(ed)?|getting (worse|better)|trend/i,
  attemptedFixes: /tried|attempt|done (anything|so far)|have you done/i,
};
function topicOf(question = "") {
  return Object.keys(SIGNALS).find((id) => SIGNALS[id].test(question)) || null;
}
const meaningful = (v) => v !== null && v !== undefined && v !== "" && v !== "Unknown" &&
  (!Array.isArray(v) || v.length > 0);
function mergeFacts(previous = {}, incoming = {}) {
  const merged = { ...previous, ...incoming };
  for (const key of ["summary", "category", "urgency", "suggestedVendorType", "subcategory", "impact", "costTier", "shortTitle"]) {
    if (!meaningful(incoming[key])) merged[key] = previous[key] ?? incoming[key];
  }
  for (const key of ["location", "timeline", "safety", "access"]) {
    merged[key] = { ...(previous[key] || {}) };
    for (const [field, value] of Object.entries(incoming[key] || {})) {
      if (meaningful(value)) merged[key][field] = value;
    }
  }
  // Attempts accumulate; an explicit correction replaces the affected array.
  const corrected = incoming.correctedFields || [];
  merged.troubleshootingState = [...new Map([...(previous.troubleshootingState || []),
    ...(incoming.troubleshootingState || [])].map((step) => [step.stepId, step])).values()];
  for (const key of ["attemptedFixes"]) {
    merged[key] = corrected.includes(key) ? incoming[key] || [] :
      [...new Set([...(previous[key] || []), ...(incoming[key] || [])])];
  }
  if (corrected.includes("access.preferredTimes")) {
    merged.access.preferredTimes = incoming.access?.preferredTimes || [];
  }
  // A tenant can also withdraw an earlier assertion (e.g. "not the kitchen;
  // I don't know where"). Explicit corrections may clear the affected fact.
  for (const path of corrected.filter((field) => CORRECTABLE_FIELDS.includes(field))) {
    const [group, leaf] = path.split(".");
    if (leaf && Object.hasOwn(incoming[group] || {}, leaf)) merged[group][leaf] = incoming[group][leaf];
    else if (!leaf && Object.hasOwn(incoming, group)) merged[group] = incoming[group];
  }
  return merged;
}

function tenantTurns(message, history = []) {
  const turns = history.filter((m) => m.role === "user").map((m) => String(m.content || ""));
  if (message && turns.at(-1) !== message) turns.push(message);
  return turns;
}

// Availability is never consent. Even a model's true needs explicit tenant words
// or an unambiguous answer to an entry-only question.
function explicitEntryConsent(message = "", history = []) {
  const turns = [...history];
  if (message && !(turns.at(-1)?.role === "user" && turns.at(-1)?.content === message)) {
    turns.push({ role: "user", content: message });
  }
  let result = null;
  let lastQuestion = "";
  for (const turn of turns) {
    if (["ai", "assistant"].includes(turn.role)) { lastQuestion = turn.content || ""; continue; }
    if (turn.role !== "user") continue;
    const text = String(turn.content || "").replace(/’/g, "'");
    const questions = String(lastQuestion).match(/[^.?!\n]*\?/g) || [];
    const entryOnly = questions.length === 1 && topicOf(questions[0]) === "entryPermission" &&
      !SIGNALS.availability.test(questions[0]) && !SIGNALS.pets.test(questions[0]);
    if (/not sure|don't know|do not know|haven't decided|can't (?:say|confirm)|cannot (?:say|confirm)|maybe|possibly|depends|prefer not to (?:say|answer)/i.test(text) &&
        (entryOnly || /enter|entry|permission|come in/i.test(text))) { result = null; lastQuestion = ""; continue; }
    if (/\bnot (?:okay|ok|fine|permitted|allowed)[^.!?]*\b(?:enter|come in)\b/i.test(text)) { result = false; lastQuestion = ""; continue; }
    const entryReply = entryOnly || /\b(?:enter|entry|permission|come in)\b/i.test(text);
    // The boolean represents permission to enter WITHOUT the tenant. Conditional
    // permission while they are home must never become an unrestricted grant.
    const requiresPresence = entryReply && /\b(?:when|while|if|provided(?: that)?|as long as)\s+(?:I(?:'m| am)|we(?:'re| are))\s+(?:home|here|there|present)\b/i.test(text);
    const pendingApproval = entryReply && /\b(?:after|once|until|if|provided(?: that)?|as long as)\b[^.!?]*\b(?:approv\w*|confirm\w*|agree\w*|consent|permission)\b/i.test(text);
    if (requiresPresence || /\b(don't|do not|cannot|can't|not allowed to)\s+(?:\w+\s+){0,3}(enter|come in)|no (entry|permission)|(?:must|need to|want to|have to) be (home|present)|only (?:enter |come |allowed |permitted )?(?:when|if) I(?:'m| am) (home|there|present)/i.test(text)) result = false;
    else if (pendingApproval) result = null;
    else if (/\b(?:you|they|a technician|the technician|technicians?|a contractor|the contractor) (?:can|may|have permission to) (?:enter|come in)|permission (?:to enter (?:is )?)?(?:is )?granted|\bI (?:give|grant) (?:entry )?permission|(?:okay|ok|fine) (?:for (?:a |the )?(?:technician|contractor) )?to enter/i.test(text)) result = true;
    else {
      if (entryOnly && /^(yes|yeah|yep|sure|that's fine|that is fine|I do|no|nope)\b/i.test(text.trim())) {
        result = !/^(no|nope)\b/i.test(text.trim());
      }
    }
    lastQuestion = "";
  }
  return result;
}

function selectQuestion(triage, context = {}, message = "") {
  const previous = context.previousTriage?.intakeState || {};
  const history = Array.isArray(context.conversationHistory) ? context.conversationHistory : [];
  const answers = Object.fromEntries((previous.answers || []).filter((a) => TOPIC_IDS.includes(a.topicId)).map((a) => [a.topicId, a.state]));
  const asked = new Set(previous.askedIds || []);
  let historyCount = 0;
  let lastTopics = [];
  for (const turn of history) {
    if (["ai", "assistant"].includes(turn.role)) {
      const qs = String(turn.content || "").match(/[^.?!\n]*\?/g) || [];
      // Old clients sometimes bundled availability and entry. An answer to that
      // bundle must not silently satisfy consent; a focused entry question is useful.
      lastTopics = qs.map((q) => SIGNALS.entryPermission.test(q) && SIGNALS.availability.test(q)
        ? "availability" : topicOf(q)).filter(Boolean);
      if (qs.length) historyCount += 1;
      lastTopics.forEach((id) => asked.add(id));
    } else if (turn.role === "user" && lastTopics.length) {
      const state = answerState(turn.content);
      lastTopics.forEach((id) => { answers[id] = state; });
      lastTopics = [];
    }
  }
  for (const a of triage.topicAnswers || []) {
    if (a.topicId === "entryPermission" && a.state === "answered" && typeof triage.access?.permissionToEnter !== "boolean") continue;
    if (TOPIC_IDS.includes(a.topicId) && ANSWER_STATES.includes(a.state)) answers[a.topicId] = a.state;
  }
  if (previous.selectedQuestion && message.trim() && !history.some((m) => m.role === "user" && m.content === message)) {
    const id = previous.selectedQuestion.topicId;
    answers[id] = answerState(message);
  }
  const known = {
    impact: Boolean(triage.impact), location: Boolean(triage.location?.room || triage.location?.area),
    timeline: Boolean(triage.timeline?.started), attemptedFixes: Boolean(triage.attemptedFixes?.length),
    availability: Boolean(triage.access?.preferredTimes?.length),
    entryPermission: typeof triage.access?.permissionToEnter === "boolean", pets: typeof triage.access?.pets === "boolean",
  };
  Object.entries(known).forEach(([id, present]) => { if (present) answers[id] = "answered"; });
  const tenantText = tenantTurns(message, history).join("\n").replace(/’/g, "'");
  if (/haven't tried|have not tried|tried nothing|nothing (?:yet|so far)|not tried anything/i.test(tenantText)) answers.attemptedFixes = "answered";
  // These corroborating signals also keep older clients' legacy questions selective.
  if (/thermostat.*\d|(?:set|setting).*\b\d+\s*(?:degrees?|°|c\b)/i.test(tenantText)) answers.thermostat = "answered";
  if (/\bbreaker\b.*(trip|reset|checked)|reset.*\bbreaker\b/i.test(tenantText)) answers.breaker = "answered";
  if (/air filter.*(check|clean|chang)|(?:check|clean|chang).*air filter/i.test(tenantText)) answers.filter = "answered";
  const count = Math.max(Number(previous.followUpCount) || 0, historyCount,
    Math.max(0, history.filter((m) => m.role === "user").length - 1));
  const candidates = Array.isArray(triage.questionCandidates) && triage.questionCandidates.length ? [...triage.questionCandidates] :
    (triage.followUpQuestions || []).map((question) => ({ topicId: topicOf(question), question }));
  if (triage.category === "Electrical" && triage.safety?.safetyRisk == null &&
      !/\bno\b[^.!?]*(?:smoke|sparks|burning smell)/i.test(tenantText)) {
    candidates.push({ topicId: "safety", question: TOPICS.safety });
  }
  const repeatedBreaker = /breaker.*(?:again|repeat|keeps?|won't stay|twice|multiple|several|trip)|(?:again|repeat|keeps?|twice|multiple).*breaker/i.test(tenantText);
  const defaults = ["impact", "location", "timeline", "attemptedFixes", "availability", "entryPermission", "pets"]
    .map((topicId) => ({ topicId, question: TOPICS[topicId] }));
  const priorityOf = (id) => id === "safety" ? 0 : ["impact", "location", "timeline", "extent", "structuralChange"].includes(id) ? 1 :
    ["availability", "entryPermission", "pets"].includes(id) ? 3 : 2;
  const eligible = [...candidates, ...defaults].filter((q) => {
    if (!TOPIC_IDS.includes(q.topicId) || !q.question?.trim() || answers[q.topicId] || asked.has(q.topicId)) return false;
    if (repeatedBreaker && /reset|back on/i.test(q.question)) return false;
    return count < 6 && (count < 4 || priorityOf(q.topicId) <= 1);
  }).sort((a, b) => priorityOf(a.topicId) - priorityOf(b.topicId));
  const emergency = triage.urgency === "emergency" || triage.emergencyServicesRecommended;
  const ready = Boolean(context.previousTriage?.readyToSubmit) || emergency || (!triage.resolved && !eligible.length);
  const selected = ready || triage.resolved ? null : eligible[0];
  if (selected) asked.add(selected.topicId);
  triage.intakeState = {
    version: 1, askedIds: [...asked],
    answers: Object.entries(answers).map(([topicId, state]) => ({ topicId, state })),
    selectedQuestion: selected ? { id: selected.topicId, topicId: selected.topicId,
      question: ["structuralChange", "availability", "entryPermission", "pets"].includes(selected.topicId)
        ? TOPICS[selected.topicId] : selected.question.trim() } : null,
    followUpCount: count + (selected ? 1 : 0),
    needsManagerReview: Boolean(ready && (["impact", "location", "timeline"].some((id) => !known[id]) ||
      ["safety", "structuralChange"].some((id) => ["unknown", "declined"].includes(answers[id])))),
  };
  triage.readyToSubmit = !triage.resolved && ready;
  triage.intakeStatus = triage.readyToSubmit ? "ready_to_submit" : "needs_more_info";
  triage.followUpQuestions = selected ? [triage.intakeState.selectedQuestion.question] : [];
  triage.missingFields = [...triage.followUpQuestions];
  return triage;
}

module.exports = { TOPICS, TOPIC_IDS, ANSWER_STATES, CORRECTABLE_FIELDS, topicOf, mergeFacts, explicitEntryConsent, selectQuestion };
