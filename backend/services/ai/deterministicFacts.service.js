const { topicOf, mergeFacts } = require("./intakeState.service");

// Conservative extraction of volunteered facts. Unknown/declined responses are
// answers, never evidence of safety, successful repair or affirmative consent.
function extractFacts(message = "", context = {}) {
  const history = Array.isArray(context.conversationHistory) ? [...context.conversationHistory] : [];
  if (history.at(-1)?.content !== message || history.at(-1)?.role !== "user") history.push({ role: "user", content: message });
  let facts = {};
  const answers = new Map();
  const corrections = new Set();
  let question = null;
  for (const turn of history) {
    if (["assistant", "ai"].includes(turn.role)) {
      question = topicOf(String(turn.content).match(/[^.?!\n]*\?/g)?.at(-1) || "");
      continue;
    }
    if (turn.role !== "user") continue;
    const text = String(turn.content || "").replace(/’/g, "'");
    const next = { location: {}, timeline: {}, access: {}, correctedFields: [] };
    const unknown = /don't know|do not know|not sure|no idea|can't tell|cannot tell/i.test(text);
    const declined = /prefer not|rather not|won't answer|decline|don't want to answer/i.test(text);
    const volunteeredTopic = unknown || declined ? topicOf(text) : null;
    if (volunteeredTopic) answers.set(volunteeredTopic, declined ? "declined" : "unknown");
    if (question) {
      answers.set(question, declined ? "declined" : unknown ? "unknown" : "answered");
      if (!unknown && !declined) {
        if (question === "impact") next.impact = text;
        if (question === "timeline") next.timeline.started = text;
        if (question === "location") next.location.area = text;
        if (question === "attemptedFixes" && !/^(no|nothing|none)\b/i.test(text)) next.attemptedFixes = [text];
        if (question === "availability") next.access.preferredTimes = [text];
        if (question === "pets" && /^(yes|no|none|nope)\b/i.test(text)) next.access.pets = /^yes\b/i.test(text);
      }
    }
    const clauses = text.split(/(?<=[.!?])\s+|\n/);
    for (const clause of clauses) {
      const room = [...clause.matchAll(/\b(kitchen|bathroom|bedroom|living room|laundry room|basement|garage|hallway|balcony)\b/ig)]
        .filter((match) => !/\bnot (?:the )?$/i.test(clause.slice(0, match.index))).at(-1)?.[0];
      if (room) next.location.room = room;
      const area = clause.match(/\b(?:under|behind|beside|above|inside|near) (?:the )?[a-z]+(?: (?:sink|cabinet|toilet|window|door|outlet|wall))?/i)?.[0];
      if (area) next.location.area = area;
      const onset = clause.match(/\b(?:for|since|started|began)\s+(?:about\s+)?(?:\d+|one|two|three|four|a few|several|an?|yesterday|today|last)[^.!?;]*/i)?.[0];
      const visitAvailability = /\b(?:visit|appointment|technician|available|can be home|free for|works? for me)\b/i.test(clause);
      if (onset && !visitAvailability && !unknown && /\b(?:hours?|days?|weeks?|minutes?|yesterday|today|night|morning|evening)\b/i.test(onset)) next.timeline.started = onset;
      if (/\b(?:unusable|can't use|cannot use|unable to use|not working|won't (?:turn|start)|no (?:heat|water|power)|affecting|prevents? me|still (?:usable|works)|not affect|can still use)\b/i.test(clause)) next.impact = clause.trim();
      if (/\b(?:already|have|I)\s+(?:already\s+)?(?:tried|tightened|reset|checked|cleaned|unplugged|replaced|turned|shut)|\btried\b/i.test(clause) && !/haven't tried|have not tried|not tried/i.test(clause)) (next.attemptedFixes ||= []).push(clause.trim());
      const availability = clause.match(/\b(?:weekday|weekend|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|anytime|any time)[^.!?]*/i)?.[0];
      if (availability && /work|available|morning|afternoon|evening|any ?time/i.test(availability)) next.access.preferredTimes = [availability];
      if (/\bno pets\b|\bdon't have (?:any )?pets\b/i.test(clause)) next.access.pets = false;
      else if (/\b(?:have|own) (?:a |two |\d+ )?(?:dog|cat|pets?)\b/i.test(clause)) next.access.pets = true;
    }
    if (/haven't tried|have not tried|not tried anything|tried nothing|nothing (?:yet|so far)/i.test(text)) answers.set("attemptedFixes", "answered");
    if (/\b(?:actually|correction|I meant|not the)\b/i.test(text)) {
      if (next.location.room) next.correctedFields.push("location.room");
      if (next.location.area) next.correctedFields.push("location.area");
      if (/don't know where|do not know where|not sure where/i.test(text)) {
        next.location = { room: "", area: "" };
        next.correctedFields.push("location.room", "location.area");
        answers.set("location", "unknown");
      }
      if (next.timeline.started) next.correctedFields.push("timeline.started");
      if (unknown && /\b(?:when|how long|onset|start(?:ed)?)\b/i.test(text)) {
        next.timeline.started = "";
        next.correctedFields.push("timeline.started");
        answers.set("timeline", "unknown");
      }
      if (next.impact) next.correctedFields.push("impact");
      if (next.access.preferredTimes) next.correctedFields.push("access.preferredTimes");
    }
    next.correctedFields.forEach((field) => corrections.add(field));
    facts = mergeFacts(facts, next);
    // Keep explicit withdrawals when merged with the previous persisted snapshot.
    facts.correctedFields = [...corrections];
    question = null;
  }
  facts.topicAnswers = [...answers].map(([topicId, state]) => ({ topicId, state }));
  return facts;
}
module.exports = { extractFacts };
