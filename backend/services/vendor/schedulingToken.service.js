const crypto = require("crypto");
const env = require("../../config/env");
const JobToken = require("../../models/JobToken");
const BookingPreparation = require("../../models/BookingPreparation");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const hash = raw => crypto.createHash("sha256").update(raw).digest("hex");
async function issueSchedulingLink(preparation) {
  const raw = crypto.randomBytes(32).toString("base64url");
  await JobToken.findOneAndUpdate({ preparationId: preparation._id, scope: "scheduling" }, {
    $set: { tokenHash: hash(raw), requestId: preparation.requestId, appointmentId: preparation.appointmentId,
      identityId: preparation.identityId, landlordId: preparation.landlordId, vendorId: preparation.vendorId,
      expiresAt: new Date(Math.max(Date.now() + 3600_000, new Date(preparation.deadlineAt).getTime())), revokedAt: null },
  }, { upsert: true });
  return `${String(env.app_public_url).replace(/\/$/, "")}/vendor-scheduling/${raw}`;
}
async function resolveSchedulingLink(raw) {
  if (!raw || !/^[A-Za-z0-9_-]{40,100}$/.test(raw)) return null;
  const token = await JobToken.findOne({ tokenHash: hash(raw), scope: "scheduling", revokedAt: null,
    expiresAt: { $gt: new Date() } });
  if (!token) return null;
  const preparation = await BookingPreparation.findOne({ _id: token.preparationId, active: true });
  if (!preparation || !["awaiting_vendor", "awaiting_tenant", "scheduled"].includes(preparation.phase)) return null;
  const request = await MaintenanceRequest.findById(preparation.requestId).select("status").lean();
  if (!request || ["cancelled", "rejected", "completed"].includes(request.status)) return null;
  return preparation;
}
async function revokeSchedulingLink(preparationId, session = null) {
  return JobToken.updateMany({ preparationId, scope: "scheduling" },
    { $unset: { tokenHash: 1 }, $set: { revokedAt: new Date() } }, { session });
}
module.exports = { issueSchedulingLink, resolveSchedulingLink, revokeSchedulingLink };
