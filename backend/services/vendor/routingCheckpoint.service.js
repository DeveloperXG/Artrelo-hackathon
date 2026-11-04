const { createHash } = require("node:crypto");
const { buildRoutingDecision, resolveQuotaLimit } = require("./routingDecision.service");
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = value => String(value?._id || value || "");
const ESTIMATE_FIELDS = ["defaultQuota", "categoryQuotas", "propertyQuotas", "unitQuotas", "requireApprovalOverQuota"];
const CONTACT_FIELDS = ["maxOutreachAttempts", "allowAutopilotForLowSeverity", "allowAutopilotForMediumSeverity"];
const ALL_FIELDS = [...ESTIMATE_FIELDS, "requireApprovalForFirstTimeVendor", ...CONTACT_FIELDS];

function candidateKey(candidate) {
  return candidate?.candidateKey || (candidate ? `${candidate.providerName || "manual"}__${candidate.providerVendorId || candidate.vendorId || "unknown"}` : null);
}
function checkpointBasis(request, candidate, priceEstimate) {
  const scope = { candidateKey: candidateKey(candidate), vendorId: id(candidate?.vendorId),
    category: request.category || null, propertyId: id(request.propertyId), unitId: id(request.unitId) };
  return { estimate: digest({ ...scope, low: priceEstimate?.amountLow ?? null, high: priceEstimate?.amountHigh ?? null,
    currency: priceEstimate?.currency || "CAD", basis: priceEstimate?.basis || null }),
  first_time: digest(scope) };
}

// A legacy decision can prove a stage was reached/passed, but cannot tell us a
// historical global policy revision. Unknown history is never invented.
function legacyEvidence(snapshot, request, candidate, priceEstimate) {
  if (Array.isArray(snapshot?.routingCheckpoints)) return [];
  const decision = snapshot?.decision;
  const top = snapshot?.candidateLedger?.find(row => row.candidateKey === decision?.candidateKey) || snapshot?.recommendations?.[0];
  if (!decision || !top || candidateKey(top) !== candidateKey(candidate) || !snapshot.generatedAt) return [];
  const currentBasis = checkpointBasis(request, candidate, priceEstimate);
  const oldBasis = checkpointBasis(request, top, top.priceEstimate);
  if (currentBasis.estimate !== oldBasis.estimate) return [];
  const afterEstimate = ["first_time_vendor", "trusted_preset_match", "manager_contact_approval_required",
    "autopilot_disabled", "emergency_approval_required", "high_severity_approval_required", "triage_review_required",
    "intake_review_required", "agent_paused", "reopened_request_review_required", "vendor_not_contactable"];
  if (!afterEstimate.includes(decision.reasonCode) || !(Number(decision.quotaLimit) > 0)) return [];
  const row = stage => ({ stage, candidateKey: candidateKey(candidate), basisHash: oldBasis[stage], state: "passed",
    policyRevision: null, effectiveLimit: decision.quotaLimit, evaluatedAt: snapshot.generatedAt,
    passedAt: snapshot.generatedAt, evidence: "legacy_decision", policyValues: null });
  const result = [row("estimate")];
  if (decision.reasonCode !== "first_time_vendor") result.push(row("first_time"));
  return result;
}

/** Pure server-only screen. Passed rows survive policy edits for this exact
 * candidate/estimate basis; unrelated candidates and changed estimates do not.
 * These records never authorize contact, a quote, booking or expenditure. */
function screenCandidate({ request, policy = {}, candidate, priceEstimate = candidate?.priceEstimate,
  previousSnapshot, now = new Date(), ...options }) {
  const key = candidateKey(candidate), basis = checkpointBasis(request, candidate, priceEstimate);
  const history = structuredClone(previousSnapshot?.routingCheckpoints || legacyEvidence(previousSnapshot, request, candidate, priceEstimate));
  const passed = Object.fromEntries(["estimate", "first_time"].map(stage => [stage,
    history.find(row => row.stage === stage && row.candidateKey === key && row.basisHash === basis[stage] && row.state === "passed")]));
  const decision = buildRoutingDecision({ request, policy, bestCandidate: candidate, priceEstimate,
    ...options, passedCheckpoints: passed });
  decision.candidateKey = key;
  if (!candidate || !options.vendorTypeNeeded) return { decision, routingCheckpoints: history };
  const limit = resolveQuotaLimit(policy, request);
  const estimatePassed = Boolean(passed.estimate) || (limit !== null &&
    (Number(priceEstimate?.amountHigh || 0) <= limit || policy.requireApprovalOverQuota === false));
  const add = (stage, state) => {
    if (passed[stage]) return;
    const policyValues = stage === "estimate" ? { effectiveLimit: limit,
      requireApprovalOverQuota: policy.requireApprovalOverQuota !== false } :
      { requireApprovalForFirstTimeVendor: policy.requireApprovalForFirstTimeVendor !== false };
    const policyHash = digest(policyValues);
    if (history.some(row => row.stage === stage && row.candidateKey === key && row.basisHash === basis[stage] &&
      row.policyHash === policyHash && row.state === state)) return;
    history.push({ stage, candidateKey: key, basisHash: basis[stage], state, policyHash,
      policyRevision: policy.policyRevision ?? 0, policyValues, effectiveLimit: stage === "estimate" ? limit : null,
      evaluatedAt: now.toISOString(), passedAt: state === "passed" ? now.toISOString() : null, evidence: "server_screen" });
  };
  add("estimate", estimatePassed ? "passed" : "review_required");
  if (estimatePassed) {
    const firstTimePassed = candidate.source === "preset" && candidate.verificationStatus === "trusted" ||
      policy.requireApprovalForFirstTimeVendor === false;
    add("first_time", firstTimePassed ? "passed" : "review_required");
  }
  return { decision, routingCheckpoints: history };
}

function affectedCheckpointStages({ snapshot, request, changedFields = ALL_FIELDS }) {
  const candidate = snapshot?.candidateLedger?.find(row => row.candidateKey === snapshot.decision?.candidateKey) || snapshot?.recommendations?.[0];
  if (!candidate) return [];
  const basis = checkpointBasis(request, candidate, candidate.priceEstimate), key = candidateKey(candidate);
  const rows = snapshot.routingCheckpoints || legacyEvidence(snapshot, request, candidate, candidate.priceEstimate);
  const passed = stage => rows.some(row => row.stage === stage && row.candidateKey === key && row.basisHash === basis[stage] && row.state === "passed");
  // No evidence of passage is not proof of failure. Preserve unknown legacy
  // plans during a global save; the next explicit screening uses current policy.
  if (!snapshot.routingCheckpoints && !rows.length && !["quota_not_set", "estimate_over_quota", "first_time_vendor"].includes(snapshot.decision?.reasonCode)) return [];
  const stages = [];
  if (changedFields.some(field => ESTIMATE_FIELDS.includes(field)) && !passed("estimate")) stages.push("estimate");
  if (changedFields.includes("requireApprovalForFirstTimeVendor") && !passed("first_time")) stages.push("first_time");
  if (changedFields.some(field => CONTACT_FIELDS.includes(field))) stages.push("contact");
  return stages;
}
module.exports = { screenCandidate, checkpointBasis, legacyEvidence, affectedCheckpointStages, ALL_FIELDS };
