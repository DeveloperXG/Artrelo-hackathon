// Shared by intake and fallback. Starting and advancing have independent opt-ins;
// neither opt-in is permission to bypass safety, intake, vendor or spend review.
const { resolveOutreachTier } = require("./vendorOutreachPolicy.service");
const { hasRoutingAuthority } = require("../ai/triageReceipt.service");

function evaluateAutopilot({ request, policy = {}, candidate, decision, phase = "start" }) {
  const block = (reasonCode, managerSummary) => ({ allowed: false, reasonCode, managerSummary });
  const tier = resolveOutreachTier(request);
  const workflowHold = require('../request/requestWorkflow.service').holdReason(request);
  if (workflowHold) return block('intake_review_required', workflowHold);
  if (tier === "emergency") return block("emergency_approval_required", "Emergency: approve contacting the recommended vendor, or call a vendor directly.");
  if (tier === "urgent") return block("high_severity_approval_required", "This high-severity request needs your approval before vendor contact.");
  if (phase === "start" && request.initialRouting?.requiresContactReview) {
    return block("reopened_request_review_required", "This request was reopened. Review the fresh recommendations and approve vendor contact.");
  }
  if (decision?.approvalRequired !== false) return block(decision?.reasonCode || "approval_required", decision?.managerSummary || "Vendor contact needs your approval.");
  if (!hasRoutingAuthority(request)) return block("triage_review_required", "The intake could not be verified for automatic contact. Review it and approve contacting this vendor.");
  if (request.routingReadiness?.state !== "ready_to_route" || request.routingReadiness?.blocking) {
    return block("intake_review_required", request.routingReadiness?.reason || "The intake needs your review before vendor contact.");
  }
  if (request.agentPaused) return block("agent_paused", "Automation is paused for this request.");
  if (phase === "start" && !(tier === "low" ? policy.allowAutopilotForLowSeverity !== false : policy.allowAutopilotForMediumSeverity === true)) {
    return block("autopilot_disabled", "Your policy requires approval before starting outreach for this severity.");
  }
  if (phase === "advance" && policy.autoAdvanceOnVendorDecline === false) return block("auto_advance_disabled", "Approve contacting the next vendor.");
  if (Number(policy.maxOutreachAttempts ?? 3) < 1) return block("routing_setup_incomplete", "Vendor contact is disabled. Set a vendor cap of at least one in Policy.");
  if (!candidate || candidate.isDemoVendor || !candidate.contact?.hasEmail) return block("vendor_not_contactable", "The recommended vendor needs a usable email before automatic contact.");
  return { allowed: true, reasonCode: "within_policy", managerSummary: "Vendor contact authorized by the landlord's policy." };
}
function guardAutopilotDecision({ request, policy, candidate, decision }) {
  // Preserve quota/first-time approval semantics. Only turn a previously
  // unguarded recommendation into the existing contact-approval flow.
  const gate = evaluateAutopilot({ request, policy, candidate, decision });
  if (gate.allowed || decision.approvalRequired) return decision;
  return { ...decision, actionType: "request_vendor_contact_approval", approvalRequired: true,
    reasonCode: gate.reasonCode, managerSummary: gate.managerSummary };
}
module.exports = { evaluateAutopilot, guardAutopilotDecision };
