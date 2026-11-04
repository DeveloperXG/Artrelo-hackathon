const { evaluateSafetyGate } = require("../ai/safetyGate.service");
const { TOPICS } = require("../ai/intakeState.service");
const { workflowError } = require("./creationEligibility.service");
const QUESTIONS = {
  location: TOPICS.location,
  timeline: TOPICS.timeline,
  impact: TOPICS.impact,
  safety: TOPICS.safety,
};
const editableStatus = (request) =>
  ["pending", "queued", "approved"].includes(request?.status) &&
  !request.archivedAt;
function hasContact(request) {
  const candidates =
    request?.vendorRecommendationSnapshot?.candidateLedger ||
    request?.vendorRecommendationSnapshot?.recommendations ||
    [];
  return !!(
    request?.vendorId ||
    request?.selectedVendorId ||
    !["none", null, undefined, "cancelled", "failed"].includes(
      request?.appointmentStatus,
    ) ||
    candidates.some(
      (c) =>
        c.outreach?.outreachId ||
        ["approved_for_contact", "selected"].includes(c.state),
    )
  );
}
const known = (value) =>
  typeof value === "string" &&
  !!value.trim() &&
  !/^(unknown|not sure|unsure|n\/?a)$/i.test(value.trim());
function assessSafety({
  message = "",
  conversationHistory = [],
  tenantReported = false,
  triage = {},
} = {}) {
  const gate = evaluateSafetyGate({ message, conversationHistory });
  const modelConcern =
    !gate.triggered &&
    (triage.urgency === "emergency" ||
      triage.emergencyServicesRecommended ||
      triage.safety?.lifeSafetyConcern === true);
  return {
    state: gate.triggered
      ? "confirmed_hazard"
      : tenantReported || modelConcern
        ? "needs_review"
        : "none",
    revision: 1,
    provenance: [
      ...(gate.triggered ? ["rules"] : []),
      ...(tenantReported ? ["tenant"] : []),
      ...(modelConcern ? ["model"] : []),
    ],
    ruleCodes: gate.hazards.map((h) => h.code),
  };
}
function unresolvedSafety(request) {
  return (
    ["confirmed_hazard", "needs_review"].includes(
      request?.safetyAssessment?.state,
    ) && !request.safetyAssessment?.reviewedAt
  );
}
function deriveFollowUp(request) {
  if (!editableStatus(request)) return null;
  if (request.intakeFollowUp) return request.intakeFollowUp;
  if (hasContact(request)) return null;
  const ai = request.ai || {},
    record = request.incidentRecord || {};
  const missing = [];
  if (
    !known(
      ai.location?.room ||
        record.location?.room ||
        ai.location?.area ||
        record.location?.area,
    )
  )
    missing.push("location");
  if (!known(ai.timeline?.started || record.timeline?.started))
    missing.push("timeline");
  if (!known(ai.impact || record.impact)) missing.push("impact");
  const answers = ai.intakeState?.answers || [];
  if (
    answers.some(
      (a) =>
        ["safety", "structuralChange"].includes(a.topicId) &&
        ["unknown", "declined"].includes(a.state),
    )
  )
    missing.push("safety");
  if (!missing.length) return null;
  const questions = missing.map((topicId) => ({
    topicId,
    question: QUESTIONS[topicId],
    state: answers.find((a) => a.topicId === topicId)?.state || "missing",
    value: "",
  }));
  return {
    revision: 1,
    state: questions.every((q) => q.state !== "missing")
      ? "ready_for_review"
      : "awaiting_answers",
    questions,
    answers: questions
      .filter((q) => q.state !== "missing")
      .map((q) => ({ topicId: q.topicId, state: q.state, value: "" })),
    submittedAt: null,
    reviewedAt: null,
    remainingTopics: missing,
  };
}
function holdReason(request) {
  if (unresolvedSafety(request))
    return "Review the reported safety concern before vendor contact.";
  const follow = deriveFollowUp(request);
  if (follow && follow.state !== "reviewed")
    return follow.state === "ready_for_review"
      ? "Review the tenant’s additional details before vendor contact."
      : "Essential details are outstanding; review the uncertainty before vendor contact.";
  return "";
}
function assertContactAllowed(request) {
  const reason = holdReason(request);
  if (reason) throw workflowError("intake_review_required", reason);
}
function tenantWorkflow(request) {
  const follow = deriveFollowUp(request);
  const tenantFollow = follow
    ? Object.fromEntries(
        [
          "revision",
          "state",
          "questions",
          "answers",
          "submittedAt",
          "reviewedAt",
          "remainingTopics",
        ].map((key) => [key, follow[key]]),
      )
    : null;
  return {
    intakeFollowUp: tenantFollow,
    ...(request.safetyAssessment
      ? {
          safetyAssessment: {
            state: request.safetyAssessment.state,
            revision: request.safetyAssessment.revision,
            reviewedAt: request.safetyAssessment.reviewedAt || null,
          },
        }
      : {}),
  };
}
function assertEditable(request, revision) {
  if (!editableStatus(request) || hasContact(request))
    throw workflowError(
      "request_not_editable",
      "This request has already progressed or closed.",
    );
  const follow = deriveFollowUp(request);
  if (!follow)
    throw workflowError(
      "request_not_editable",
      "No missing essential details remain.",
    );
  if (!Number.isInteger(revision) || revision !== follow.revision)
    throw workflowError(
      "stale_revision",
      "The request changed. Refresh and review the latest details.",
      request,
    );
  return JSON.parse(JSON.stringify(follow));
}
function mergeAnswers(request, submitted) {
  const follow = deriveFollowUp(request);
  if (!Array.isArray(submitted) || !submitted.length || submitted.length > 4)
    throw workflowError(
      "invalid_answers",
      "Answer the outstanding questions.",
      null,
      400,
    );
  const ids = new Set();
  for (const a of submitted) {
    if (
      !follow.questions.some((q) => q.topicId === a.topicId) ||
      ids.has(a.topicId) ||
      !["answered", "unknown", "declined"].includes(a.state) ||
      (a.state === "answered" && !known(a.value)) ||
      String(a.value || "").length > 2000
    )
      throw workflowError(
        "invalid_answers",
        "Invalid essential-detail answer.",
        null,
        400,
      );
    ids.add(a.topicId);
  }
  if (
    follow.questions.some((q) => q.state === "missing" && !ids.has(q.topicId))
  )
    throw workflowError(
      "invalid_answers",
      "Answer each outstanding question, or choose unknown / unable to check.",
      null,
      400,
    );
  submitted = follow.questions.map(
    (q) =>
      submitted.find((a) => a.topicId === q.topicId) || {
        topicId: q.topicId,
        state: q.state,
        value: q.value || "",
      },
  );
  const ai = JSON.parse(JSON.stringify(request.ai || {}));
  for (const a of submitted.filter((a) => a.state === "answered")) {
    if (a.topicId === "location")
      ai.location = { ...(ai.location || {}), room: a.value.trim() };
    if (a.topicId === "timeline")
      ai.timeline = { ...(ai.timeline || {}), started: a.value.trim() };
    if (a.topicId === "impact") ai.impact = a.value.trim();
  }
  return {
    ai,
    follow: {
      ...JSON.parse(JSON.stringify(follow)),
      revision: follow.revision + 1,
      state: "ready_for_review",
      questions: follow.questions.map((q) => ({
        ...q,
        ...submitted.find((a) => a.topicId === q.topicId),
        value:
          submitted.find((a) => a.topicId === q.topicId)?.state === "answered"
            ? submitted.find((a) => a.topicId === q.topicId).value.trim()
            : "",
      })),
      answers: submitted.map((a) => ({
        topicId: a.topicId,
        state: a.state,
        value: a.state === "answered" ? a.value.trim() : "",
      })),
      remainingTopics: submitted
        .filter((a) => a.state !== "answered")
        .map((a) => a.topicId),
      submittedAt: new Date(),
      reviewedAt: null,
    },
  };
}
module.exports = {
  QUESTIONS,
  deriveFollowUp,
  assessSafety,
  unresolvedSafety,
  holdReason,
  assertContactAllowed,
  tenantWorkflow,
  assertEditable,
  mergeAnswers,
  hasContact,
  editableStatus,
};
