const MaintenanceRequest = require("../../models/MaintenanceRequest");
const AgentActionLog = require("../../models/AgentActionLog");
const ApprovalRequest = require("../../models/ApprovalRequest");
const Appointment = require("../../models/Appointment");
const VendorOutreach = require("../../models/VendorOutreach");
const { Notification } = require("../../models/Notification");

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Rejected requests whose appeal window has closed with no appeal submitted.
// Legacy rejected requests without an appealWindowExpiresAt are never matched.
const expiredRejectedRequestFilter = (now = new Date()) => ({
  status: "rejected",
  isAppealed: { $ne: true },
  appealWindowExpiresAt: { $lte: now },
});

/**
 * Hard-delete requests and everything hanging off them. The one delete path for
 * a request -- the expiry sweep, a declined appeal, a final rejection and a
 * tenant deleting a queued request all use it, so none of them can leave live
 * magic-link tokens or dangling notifications behind.
 *
 * Notifications are matched on metadata.workOrderId, so a notification that
 * must OUTLIVE its request (the tenant's final-rejection notice) is written
 * without one.
 */
async function deleteRequestsWithCascade(ids, { label = "deleteRequestsWithCascade" } = {}) {
  if (!ids.length) return 0;
  const { deletedCount } = await MaintenanceRequest.deleteMany({ _id: { $in: ids } });

  const results = await Promise.allSettled([
    AgentActionLog.deleteMany({ requestId: { $in: ids } }),
    ApprovalRequest.deleteMany({ requestId: { $in: ids } }),
    Appointment.deleteMany({ requestId: { $in: ids } }),
    // Otherwise a deleted request leaves live magic-link tokens behind.
    VendorOutreach.deleteMany({ requestId: { $in: ids } }),
    Notification.deleteMany({
      "metadata.workOrderId": { $in: ids.map((id) => id.toString()) },
    }),
  ]);
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`[${label}] cascade cleanup failed`, {
        index,
        message: result.reason?.message || result.reason,
      });
    }
  });
  return deletedCount;
}

async function cleanupExpiredRejectedRequests() {
  const expired = await MaintenanceRequest.find(expiredRejectedRequestFilter())
    .select("_id")
    .lean();
  if (!expired.length) return 0;

  const ids = expired.map((doc) => doc._id);
  await deleteRequestsWithCascade(ids, { label: "rejectedRequestCleanup" });

  console.log(`[rejectedRequestCleanup] deleted ${ids.length} expired rejected request(s)`);
  return ids.length;
}

function startRejectedRequestCleanup(intervalMs = CLEANUP_INTERVAL_MS) {
  const run = () => {
    cleanupExpiredRejectedRequests().catch((err) => {
      console.error("[rejectedRequestCleanup] run failed", err);
    });
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = {
  deleteRequestsWithCascade,
  expiredRejectedRequestFilter,
  cleanupExpiredRejectedRequests,
  startRejectedRequestCleanup,
};
