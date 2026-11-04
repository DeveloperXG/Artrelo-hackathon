// Routing readiness gate. Maps a finished incident record (+ safety verdict) onto
// a single decision about what should happen next with the request. This is the
// agent/landlord-facing signal that lets Arcus know WHEN automation is reliable
// enough — distinct from the tenant-facing intake loop (which decides when to stop
// asking the tenant) and from the vendor routing decision (which picks a vendor).
//
// It only ever reads already-computed fields; it never changes the intake loop.

const READINESS_STATES = [
  "ready_to_route",
  "need_one_more_answer",
  "need_photo_evidence",
  "needs_manager_review",
  "emergency_escalation",
  "manual_assignment_required",
];

// Confidence at/above this is "complete enough" to route without more intake.
const ROUTE_CONFIDENCE_BAR = 0.7;
// Structured fields whose absence is best closed with one more tenant answer.
const HIGH_VALUE_FIELDS = ["impact", "location", "timeline"];

function verdict(state, reason, recommendedAction, blocking) {
  return { state, reason, recommendedAction, blocking };
}

function isEmergency(incidentRecord = {}, triage = {}) {
  return Boolean(
    incidentRecord.emergency ||
      triage.emergencyServicesRecommended ||
      triage.urgency === "emergency" ||
      triage.safetyGate?.triggered
  );
}

// Reasons a request should pause for a human before any vendor is contacted.
function managerReviewReason(incidentRecord = {}) {
  if (incidentRecord.costTier === "High") {
    return "High estimated cost tier — manager approval recommended before spend.";
  }
  if (["tenant", "shared"].includes(incidentRecord.responsibility)) {
    return "Responsibility may fall partly on the tenant — manager review for the cost split.";
  }
  return null;
}

// Most categories benefit from a photo; this is a hook for tuning later.
function photosHelp(/* category */) {
  return true;
}

function deriveRoutingReadiness({ incidentRecord = {}, triage = {} } = {}) {
  const confidence = Number(incidentRecord.confidence?.overall) || 0;
  const missing = Array.isArray(incidentRecord.confidence?.missingFields)
    ? incidentRecord.confidence.missingFields
    : [];

  // 1) Safety always wins.
  if (isEmergency(incidentRecord, triage)) {
    return verdict(
      "emergency_escalation",
      "A safety hazard was detected; this needs immediate escalation, not standard routing.",
      "Escalate to emergency handling and notify the manager.",
      true
    );
  }

  // 2) No resolvable vendor service — nothing to auto-match against.
  if (!incidentRecord.trade) {
    return verdict(
      "manual_assignment_required",
      "No supported vendor service could be resolved for this issue.",
      "A manager should manually assign a vendor or clarify the trade needed.",
      true
    );
  }

  if (triage.intakeState?.needsManagerReview) {
    return verdict("needs_manager_review", "Intake is complete with unanswered or uncertain essential details.",
      "Review the known facts and remaining uncertainty before routing.", true);
  }

  // 3) Spend/responsibility calls that a human should sign off on.
  const reviewReason = managerReviewReason(incidentRecord);
  if (reviewReason) {
    return verdict(
      "needs_manager_review",
      reviewReason,
      "Hold for manager review before contacting a vendor.",
      true
    );
  }

  // 4 & 5) Below the confidence bar — close the highest-leverage gap first.
  if (confidence < ROUTE_CONFIDENCE_BAR) {
    const missingHighValue = HIGH_VALUE_FIELDS.filter((field) => missing.includes(field));
    if (missingHighValue.length >= 1) {
      return verdict(
        "need_one_more_answer",
        `Confidence is below the routing threshold; still missing: ${missingHighValue.join(", ")}.`,
        "Ask one more targeted question before routing.",
        true
      );
    }
    if (incidentRecord.evidence?.confidencePenalty && photosHelp(incidentRecord.category)) {
      return verdict(
        "need_photo_evidence",
        "Confidence is below the routing threshold and no photo or video was provided.",
        "Ask the tenant for a photo of the issue before routing.",
        true
      );
    }
    return verdict(
      "needs_manager_review",
      "Confidence is below the routing threshold and the gap is not a single clear field.",
      "Hold for manager review.",
      true
    );
  }

  // 6) Safe, trade known, confident — go.
  return verdict(
    "ready_to_route",
    "Safe, vendor service resolved, and confidence is sufficient.",
    "Proceed to vendor matching.",
    false
  );
}

module.exports = {
  READINESS_STATES,
  ROUTE_CONFIDENCE_BAR,
  HIGH_VALUE_FIELDS,
  deriveRoutingReadiness,
};
