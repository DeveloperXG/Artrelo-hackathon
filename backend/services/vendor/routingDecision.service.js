function getMapValue(mapLike, key) {
  if (!mapLike || !key) return null;
  if (typeof mapLike.get === "function") return mapLike.get(key) ?? null;
  return Object.prototype.hasOwnProperty.call(mapLike, key) ? mapLike[key] : null;
}

/**
 * The spending limit for one request, most specific first. NULL when the
 * landlord has set none at all.
 *
 * Every caller must handle null explicitly. JavaScript compares `x > null` as
 * `x > 0`, so a null that slipped into a comparison would silently mark every
 * quote as over quota and print "$null" to the manager. There used to be a
 * `|| 300` here, which meant a landlord who never chose a limit had one anyway.
 */
function resolveQuotaLimit(policy = {}, request = {}) {
  const override = Number(request.quotaOverride);
  if (Number.isFinite(override) && override > 0) return override;

  return (
    Number(getMapValue(policy.unitQuotas, String(request.unitId?._id || request.unitId || ""))) ||
    Number(getMapValue(policy.propertyQuotas, String(request.propertyId?._id || request.propertyId || ""))) ||
    Number(getMapValue(policy.categoryQuotas, request.category)) ||
    Number(policy.defaultQuota) ||
    null
  );
}

const QUOTA_NOT_SET_SUMMARY =
  "You haven't set a spending quota yet, so Artrelo won't contact a vendor on its own. " +
  "Set one in Policy & Quotas, or approve this job yourself.";

function buildRoutingDecision({
  request,
  bestCandidate,
  policy,
  priceEstimate,
  eligibleCount,
  vendorTypeNeeded,
  alreadyContactedCount = 0,
  lowestEligibleCost,
  passedCheckpoints = {}
}) {
  if (!vendorTypeNeeded) {
    return {
      actionType: "manual_vendor_assignment_required",
      approvalRequired: true,
      reasonCode: "vendor_service_unresolved",
      managerSummary:
        "The issue could not be mapped confidently to a supported vendor service. Manual assignment is required.",
      quotaLimit: resolveQuotaLimit(policy, request),
      eligibleCount: eligibleCount || 0,
    };
  }

  // Vendors passed the constraints but every one was already contacted on this
  // request. Not an emergency escalation of "nobody qualifies", and not the
  // "no eligible vendors passed the constraints" message, which was false.
  if (!bestCandidate && alreadyContactedCount > 0 && request?.urgency !== "emergency") {
    return {
      actionType: "manual_vendor_assignment_required",
      approvalRequired: true,
      reasonCode: "all_vendors_contacted",
      managerSummary:
        "Every vendor who can take this job has already been contacted. Add a vendor to your network, then search again.",
      quotaLimit: resolveQuotaLimit(policy, request),
      eligibleCount: 0,
    };
  }

  if (!bestCandidate) {
    return {
      actionType: request?.urgency === "emergency" ? "escalate_emergency" : "manual_vendor_assignment_required",
      approvalRequired: true,
      reasonCode: "no_valid_vendors",
      managerSummary:
        request?.urgency === "emergency"
          ? "Emergency request needs immediate manager attention because no eligible vendors passed the constraints."
          : "No eligible vendors passed the constraints. Manual assignment is required.",
      quotaLimit: resolveQuotaLimit(policy, request),
      eligibleCount: eligibleCount || 0,
    };
  }

  const quotaLimit = passedCheckpoints.estimate?.state === "passed"
    ? passedCheckpoints.estimate.effectiveLimit : resolveQuotaLimit(policy, request);

  // No limit means no autopilot: nothing is "within policy" when there is no
  // policy. Reuses the contact-approval flow, so the manager can still approve
  // this one job by hand from Decisions.
  if (quotaLimit === null) {
    return {
      actionType: "request_vendor_contact_approval",
      approvalRequired: true,
      reasonCode: "quota_not_set",
      managerSummary: QUOTA_NOT_SET_SUMMARY,
      quotaLimit: null,
      eligibleCount,
    };
  }

  const estimateHigh = Number(priceEstimate?.amountHigh || 0);
  const overQuota = estimateHigh > quotaLimit;
  const isPreset = bestCandidate.source === "preset";
  const isTrustedPreset = isPreset && bestCandidate.verificationStatus === "trusted";
  const suggestedQuota = (Math.ceil(lowestEligibleCost * 1.05 / 25) * 25);
  const isFirstTimeVendor = ! isPreset || bestCandidate.verificationStatus !== "trusted";

  if (!passedCheckpoints.estimate && overQuota && policy?.requireApprovalOverQuota !== false) {
    return {
      actionType: "request_quota_increase",
      approvalRequired: true,
      reasonCode: "estimate_over_quota",
      managerSummary: `The estimated cost exceeds your current quota limit of $${quotaLimit}. The lowest eligible vendor cost available is $${lowestEligibleCost}. 
      To proceed, please increase the quota to approximately $${suggestedQuota}.`,
      quotaLimit,
      eligibleCount,
      suggestedQuota,
      lowestEligibleCost,
    };
  }

  if (isTrustedPreset) {
    return {
      actionType: "recommend_preset_vendor",
      approvalRequired: false,
      reasonCode: "trusted_preset_match",
      managerSummary: "Trusted preset vendor is the best fit and remains within policy guardrails.",
      quotaLimit,
      eligibleCount,
    };
  }

  if (!passedCheckpoints.first_time && isFirstTimeVendor && policy?.requireApprovalForFirstTimeVendor !== false) {
    return {
      actionType: "request_first_time_vendor_approval",
      approvalRequired: true,
      reasonCode: "first_time_vendor",
      managerSummary: "This candidate is not yet a landlord-trusted vendor and needs approval before outreach.",
      quotaLimit,
      eligibleCount,
    };
  }

  return {
    actionType: "request_vendor_contact_approval",
    approvalRequired: true,
    reasonCode: "manager_contact_approval_required",
    managerSummary: "Manager approval is required before any vendor outreach can begin.",
    quotaLimit,
    eligibleCount,
  };
}

module.exports = {
  QUOTA_NOT_SET_SUMMARY,
  resolveQuotaLimit,
  buildRoutingDecision,
};
