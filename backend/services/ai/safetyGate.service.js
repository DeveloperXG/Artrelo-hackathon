// Deterministic safety gate. The model can *classify* a hazard, but safety must
// not depend on a prompt being followed — these are hard, code-driven rules that
// detect immediate-danger situations from the tenant's own words. When a rule
// fires, the triage is forced to emergency, normal troubleshooting is suppressed,
// and the tenant gets specific safety guidance. This is intentionally SEPARATE
// from severity: a dead dishwasher can be high-severity but is not an emergency.
//
// The gate only ever ESCALATES — it never downgrades an emergency the model or
// keyword path already flagged.

// Rules are ordered most-dangerous first so the primary riskType is the worst one
// present. riskType values map to the incident record's RISK_TYPES enum.
const SAFETY_RULES = [
  {
    code: "gas_leak",
    label: "Suspected gas leak",
    riskType: "gas",
    lifeSafety: true,
    activeDamage: false,
    patterns: [/\bgas\b.*(leak|smell|odou?r)/i, /(smell|odou?r).*\bgas\b/i, /rotten egg/i, /\bgas leak\b/i],
    guidance:
      "Possible gas leak: leave the unit now, don't switch anything on or off, and call your gas utility's emergency line or 911 from outside.",
  },
  {
    code: "fire",
    label: "Active fire",
    riskType: "fire",
    lifeSafety: true,
    activeDamage: true,
    patterns: [/\bon fire\b/i, /\bflames?\b/i, /\b(?:there(?:\x27s| is)|active|spreading) (?:a )?fire\b/i, /\bfire (?:in|is burning|is spreading)\b/i],
    guidance: "If there is an active fire, get everyone out immediately and call 911.",
  },
  {
    code: "carbon_monoxide",
    label: "Carbon monoxide alarm",
    riskType: "carbon_monoxide",
    lifeSafety: true,
    activeDamage: false,
    patterns: [/carbon monoxide/i, /\bco\b\s*(alarm|detector|alert)/i],
    guidance:
      "If a carbon monoxide alarm is sounding, get everyone outside to fresh air immediately and call 911 — do not re-enter until it's cleared.",
  },
  {
    code: "smoke",
    label: "Smoke in the unit",
    riskType: "smoke",
    lifeSafety: true,
    activeDamage: false,
    // Deliberately narrow so a chirping smoke detector (low battery) does not trip it.
    patterns: [
      /smoke (is )?(filling|everywhere|pouring|coming|billowing)/i,
      /(room|unit|house|apartment).*(full of|filling with) smoke/i,
      /smell of smoke/i,
    ],
    guidance: "If smoke is filling the space, leave immediately and call 911.",
  },
  {
    code: "exposed_wiring",
    label: "Exposed or live wiring",
    riskType: "electrical",
    lifeSafety: true,
    activeDamage: false,
    patterns: [/exposed (wire|wiring)/i, /bare wire/i, /live wire/i, /wires?.*(hanging|exposed|sticking out)/i],
    guidance:
      "Stay away from any exposed or hanging wiring and keep others (and pets) clear. If safe, switch off the breaker for that area; otherwise wait for a professional.",
  },
  {
    code: "sparking_outlet",
    label: "Sparking or burning outlet",
    riskType: "electrical",
    lifeSafety: true,
    activeDamage: true,
    patterns: [/\b(?:sparks?|sparking)\b/i, /outlet.*(smoking|burning|on fire|arc)/i, /(smoking|burning|arcing).*(outlet|socket|plug)/i, /\barcing\b/i],
    guidance:
      "Don't touch the outlet. If you can safely reach the breaker, shut off power to that circuit, and keep clear until an electrician inspects it.",
  },
  {
    code: "active_flooding",
    label: "Active flooding",
    riskType: "flooding",
    lifeSafety: false,
    activeDamage: true,
    patterns: [
      /flood(ing)?/i,
      /water (is )?(everywhere|rising|gushing|pouring|spreading)/i,
      /burst pipe/i,
      /ceiling.*(coming down|collapsing|caving)/i,
    ],
    guidance:
      "If water is actively spreading, shut off the water at the nearest valve if you can reach it safely, and keep it away from outlets and electronics.",
  },
  {
    code: "sewage_backup",
    label: "Sewage backup",
    riskType: "sewage",
    lifeSafety: false,
    activeDamage: true,
    patterns: [/sewage/i, /sewer (back|backup|backing)/i, /raw sewage/i, /waste water backing/i],
    guidance:
      "Avoid contact with the contaminated water, keep the area ventilated, and stop using the affected drains/toilets until it's cleared.",
  },
  {
    code: "injury",
    label: "Injury or immediate health risk",
    riskType: "injury",
    lifeSafety: true,
    activeDamage: false,
    patterns: [
      /\binjured\b|\b(?:serious|bad|severe|an) injury\b/i,
      /someone('?s| is)? (hurt|bleeding|unconscious|trapped)/i,
      /(electrocuted|got shocked|got burned)/i,
      /can'?t breathe/i,
    ],
    guidance: "If anyone is hurt or at immediate risk, call 911 first.",
  },
  {
    code: "no_heat_cold",
    label: "No heat in dangerous cold",
    riskType: "other",
    lifeSafety: false,
    activeDamage: false,
    // Requires BOTH a no-heat signal and a cold/dangerous-weather signal.
    patterns: [
      /(no heat|no heating|heat (is )?(not|isn'?t) working|furnace.*(not|isn'?t|won'?t|stopped)|heater.*(not|isn'?t|won'?t|stopped|broke)).*(freezing|frigid|below (zero|freezing)|sub-?zero|snow|winter storm|so cold|very cold|frost)/i,
      /(freezing|frigid|below (zero|freezing)|sub-?zero|snow|winter storm|so cold|very cold|frost).*(no heat|no heating|heat (is )?(not|isn'?t) working|furnace.*(not|isn'?t|won'?t|stopped)|heater.*(not|isn'?t|won'?t|stopped|broke))/i,
    ],
    guidance:
      "No heat in dangerous cold needs urgent attention. Keep warm with extra layers and safe heat sources (never an oven or open flame). If anyone is getting dangerously cold, call 911. Submit this request so your property manager can review it urgently.",
  },
];

// Pull together the tenant's own words across the conversation. We never scan the
// assistant's messages — its questions (e.g. "is there any smoke?") must not
// trip a rule.
function collectTenantText(message = "", conversationHistory = []) {
  const parts = [String(message || "")];
  if (Array.isArray(conversationHistory)) {
    for (const entry of conversationHistory) {
      const role = entry?.role;
      if (role === "user") parts.push(String(entry.content || ""));
    }
  }
  return parts.join("  ").trim();
}

function buildGuidance(matchedRules) {
  const seen = new Set();
  const lines = [];
  for (const rule of matchedRules) {
    if (seen.has(rule.guidance)) continue;
    seen.add(rule.guidance);
    lines.push(rule.guidance);
  }
  return lines.join(" ");
}

function hasCurrentHazard(rule, text) {
  const normalized = text.replace(/’/g, "'");
  // A new subject/current-time assertion starts its own context. Keep negative
  // lists ("no smoke, sparks or gas smell") together, and keep the two parts of
  // no-heat/cold reports together so neither required signal is lost.
  const clauses = rule.code === "no_heat_cold" ? [normalized] : normalized.split(
    /[.!?;\n]+|\bbut\b|\bhowever\b|\band\b(?=\s+(?:I|we|they|there|now|currently|right now)\b|\s*(?:sparks?|smoke|flames?|water|gas|the outlet)\s+(?:is|are|keeps?|continues?)\b)|,(?=\s*(?:I|we|they|there|now|currently|right now)\b|\s*(?:sparks?|smoke|flames?|water|gas|the outlet)\s+(?:is|are|keeps?|continues?)\b)/i
  );
  return clauses.some((clause) => {
    if (!rule.patterns.some((pattern) => pattern.test(clause))) return false;
    const datedPastEvent = /\b(?:was|were|had|smelled|saw|happened|occurred)\b/i.test(clause) &&
      /\b(?:yesterday|last (?:night|week|month)|in (?:19|20)\d{2}|earlier today)\b/i.test(clause);
    if (datedPastEvent && !/\b(?:now|currently|still|continues?|ongoing|keeps?|again)\b/i.test(clause)) return false;
    // A concern about what could happen is not evidence that it is happening.
    // Suspected gas/CO, visible sparks, etc. still count as present hazards.
    if (/(?:^\s*if\b|\b(?:hypothetical|what if|in case|used to|last year|years? ago|previously|in the past)\b)/i.test(clause) &&
        !/\b(now|currently|right now|again today)\b/i.test(clause)) return false;
    if (rule.code === "fire" && /\b(fire (hazard|risk|safety|drill)|risk of (a )?fire|could (?:cause|start|be) (?:a )?fire|worried.*fire)\b/i.test(clause) &&
        !/\b(on fire|flames?|fire (?:is )?(?:burning|spreading))\b/i.test(clause)) return false;
    if (rule.code === "carbon_monoxide" && /\b(battery|batteries|chirp|test(?:ing)?|expir|replace)/i.test(clause) &&
        !/\b(sounding|going off|detect(?:ed|ing)|suspect|symptoms)\b/i.test(clause)) return false;
    if (rule.code === "no_heat_cold") return !/\b(no longer|not) (?:freezing|cold)\b/i.test(clause);
    return rule.patterns.some((pattern) => {
      // A negated first mention must not hide a later affirmative one. Advance
      // from the match start to include occurrences inside greedy match spans.
      const occurrences = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, "")}g`);
      let match;
      while ((match = occurrences.exec(clause))) {
        occurrences.lastIndex = match.index + 1;
        const before = clause.slice(0, match.index);
        const span = match[0];
        const after = clause.slice(match.index + span.length);
        if (/\b(?:don't|do not|can't|cannot)\s*$/i.test(before)) continue;
        // Negative lists share their nearest negation, including repeated
        // negatives such as "no smoke and no sparks or gas smell".
        const negative = [...before.matchAll(/\b(?:no longer|no|without|neither|never|not any|don't|do not|doesn't|does not|haven't|have not|isn't|is not|aren't|are not)\b/gi)].at(-1);
        if (negative) {
          // Do not reach across an unrelated fact: "no power and I smell gas"
          // reports a hazard, whereas a negative list does not.
          const between = before.slice(negative.index + negative[0].length);
          const remainder = between.replace(/\bspreading water\b/gi, "").replace(/\b(?:see|seen|smell|have|notice|noticed|detect|detected|any|a|an|the|signs?|of|visible|active|smoke|sparks?|flames?|fire|gas|odou?r|burning|smell|flooding|injuries|injury|wires?|wiring|exposed|bare|live|or|and|nor)\b/gi, "").replace(/[\s,]+/g, "");
          if (!remainder) continue;
        }
        if (/\b(no|not|isn't|aren't|doesn't|don't|do not)\b/i.test(span)) continue;
        if (/^\s*(?:is |are |was |were )?(?:not|absent|no longer)\b/i.test(after)) continue;
        return true;
      }
      return false;
    });
  });
}

// Returns a structured verdict. `triggered` is the single source of truth for the
// deterministic safety gate; callers should escalate to emergency when it is true.
function evaluateSafetyGate({ message = "", conversationHistory = [], category = "" } = {}) {
  const text = collectTenantText(message, conversationHistory);
  const matched = text
    ? SAFETY_RULES.filter((rule) => hasCurrentHazard(rule, text))
    : [];

  if (!matched.length) {
    return {
      triggered: false,
      hazards: [],
      riskType: null,
      lifeSafetyConcern: false,
      activeDamage: false,
      guidance: "",
      action: null,
      notifyManager: false,
      suppressTroubleshooting: false,
    };
  }

  return {
    triggered: true,
    hazards: matched.map((rule) => ({ code: rule.code, label: rule.label })),
    // Rules are severity-ordered, so the first match is the most serious.
    riskType: matched[0].riskType,
    lifeSafetyConcern: matched.some((rule) => rule.lifeSafety),
    activeDamage: matched.some((rule) => rule.activeDamage),
    guidance: buildGuidance(matched),
    action: "emergency_escalation",
    notifyManager: true,
    suppressTroubleshooting: true,
  };
}

module.exports = {
  SAFETY_RULES,
  evaluateSafetyGate,
  collectTenantText,
};
