const assert = require("assert");
const { buildRoutingDecision } = require("../../../services/vendor/routingDecision.service");

assert.strictEqual(
  buildRoutingDecision({ request: { urgency: "emergency" }, scoredVendors: [] }).decision,
  "escalate_emergency"
);
assert.strictEqual(
  buildRoutingDecision({ request: { urgency: "medium" }, scoredVendors: [], managerReviewRequired: true }).decision,
  "queue_for_manager_review"
);
assert.strictEqual(
  buildRoutingDecision({ request: { urgency: "medium" }, scoredVendors: [] }).decision,
  "manual_vendor_assignment_required"
);
assert.strictEqual(
  buildRoutingDecision({
    request: { urgency: "medium" },
    scoredVendors: [{ vendorId: "1", quotaImpact: { exceedsQuota: true }, approvalReasons: [] }],
  }).decision,
  "request_quota_increase"
);
assert.strictEqual(
  buildRoutingDecision({
    request: { urgency: "medium" },
    scoredVendors: [{ vendorId: "1", quotaImpact: { exceedsQuota: false }, approvalReasons: ["first_time_vendor"] }],
  }).decision,
  "request_first_time_vendor_approval"
);
assert.strictEqual(
  buildRoutingDecision({
    request: { urgency: "medium" },
    scoredVendors: [{ vendorId: "1", quotaImpact: { exceedsQuota: false }, approvalReasons: [] }],
  }).decision,
  "recommend_preset_vendor"
);

console.log("routing decision tests passed");
