const Outreach = require("../../models/VendorOutreach");

// A projection must use recorded time, never the time the page was opened.
function recordedTime(...values) {
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

function summarizeOutreach(row) {
  if (!row) return null;
  const status = row.status;
  const state = row.deliveryUnconfirmed
    ? "unconfirmed"
    : status === "scheduled"
      ? "scheduled"
      : status === "queued"
        ? "preparing"
        : status === "delivery_failed"
          ? "failed"
          : ["sent", "viewed"].includes(status)
            ? "sent"
            : ["accepted", "declined"].includes(status)
              ? "responded"
              : "closed";
  const eventAt =
    state === "preparing" || state === "scheduled"
      ? recordedTime(row.createdAt, row.updatedAt)
      : state === "sent"
        ? recordedTime(row.sentAt, row.updatedAt, row.createdAt)
        : state === "responded"
          ? recordedTime(row.respondedAt, row.updatedAt, row.createdAt)
          : recordedTime(row.updatedAt, row.createdAt);
  return {
    outreachId: String(row._id),
    vendorName: row.vendorNameSnapshot || "Vendor",
    initiation: row.initiation || "unknown",
    state,
    scheduledFor: row.scheduledFor || null,
    sentAt: row.sentAt || null,
    updatedAt: row.updatedAt || row.createdAt || null,
    eventAt,
    respondedAt: recordedTime(row.respondedAt),
    responseStatus: ["responded", "closed"].includes(state) ? status || null : null,
  };
}
async function loadSummaries(requestIds) {
  if (!requestIds.length) return new Map();
  const rows = await Outreach.find({ requestId: { $in: requestIds } })
    .sort({ createdAt: -1, _id: -1 })
    .select(
      "requestId vendorNameSnapshot initiation status deliveryUnconfirmed scheduledFor sentAt respondedAt updatedAt createdAt",
    )
    .lean();
  const result = new Map();
  for (const row of rows)
    if (!result.has(String(row.requestId)))
      result.set(String(row.requestId), summarizeOutreach(row));
  return result;
}
module.exports = { summarizeOutreach, loadSummaries };
