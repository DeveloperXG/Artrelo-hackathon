const Request = require("../../models/MaintenanceRequest");
const { evaluateSafetyGate } = require("../ai/safetyGate.service");
const { getQuotaUsage } = require("./requestQuota.service");
const { eligibility, OPEN, CAP } = require("./creationEligibility.service");
const { findSimilar } = require("./similarRequests.service");
async function precheckIntake({
  tenant,
  description,
  category,
  override = null,
  intakeMode = "routine",
  getQuota = getQuotaUsage,
}) {
  const text = String(description || "").trim();
  const safety = evaluateSafetyGate({ message: text });
  const emergency =
    override === "emergency" || intakeMode === "safety" || safety.triggered;
  const similarRequests = await findSimilar({
    tenant,
    incoming: { issueDescription: text, category },
  });
  if (emergency)
    return {
      decision: "allow",
      isEmergency: true,
      emergencyOverride: override === "emergency" || intakeMode === "safety",
      cap: CAP,
      similarRequests,
      safetyWarning: safety.guidance,
    };
  const unitId = tenant?.unit?._id || tenant?.unit;
  const [quota, openCount] = await Promise.all([
    getQuota(tenant._id),
    Request.countDocuments({ unitId, status: { $in: OPEN } }),
  ]);
  const creationEligibility = eligibility({
    quota,
    openCount,
    linked: !!unitId,
  });
  return {
    decision:
      openCount >= CAP
        ? "blocked_cap"
        : quota.blocked
          ? "blocked_quota"
          : "allow",
    isEmergency: false,
    cap: CAP,
    openCount,
    quota,
    nextAvailableAt: quota.nextAvailableAt || null,
    creationEligibility,
    similarRequests,
  };
}
module.exports = { precheckIntake, OPEN_REQUEST_CAP: CAP };
