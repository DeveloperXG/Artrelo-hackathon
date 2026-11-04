// Daily and weekly limits on the requests a tenant sends.
//
// One slot per request SENT, counted the moment it is submitted -- not when the
// landlord acts on it. That keeps the number a tenant sees predictable (it only
// ever moves because of something they did) and it closes the hole a
// count-on-approval rule leaves: spam is exactly what gets rejected, so a rule
// that never counts rejected requests never limits a spammer.
//
//   * A validated emergency is never blocked and never counted.
//   * A request reopened by the landlord (rejection withdrawn, appeal accepted)
//     is the same request and spends no new slot.
//   * Deleting a request does not refund its slot -- the ledger is a separate
//     collection (models/RequestSubmission.js) for exactly that reason.
//
// Both windows roll (the last 24 hours, the last 7 days) rather than resetting
// at midnight, so there is no "whose midnight?" question; the UI shows the
// local time the next slot frees instead.

const RequestSubmission = require("../../models/RequestSubmission");

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const positiveInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Read on every call so a test runner can raise them through the environment
// without the integration suite throttling itself.
const getLimits = () => ({
  daily: positiveInt(process.env.REQUEST_DAILY_LIMIT, 3),
  weekly: positiveInt(process.env.REQUEST_WEEKLY_LIMIT, 7),
});

// When the window next frees a slot. `times` is ascending; with `used` at or
// over `limit`, the slot frees once the (used - limit + 1)th oldest row ages out.
const windowSummary = (times, limit, windowMs) => {
  const used = times.length;
  const oldest = times[0];
  const freeingIndex = Math.max(0, used - limit);
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    // When the oldest counted request stops counting, or null when none count.
    resetsAt: oldest ? new Date(oldest.getTime() + windowMs) : null,
    blockedUntil: used >= limit && times[freeingIndex] ? new Date(times[freeingIndex].getTime() + windowMs) : null,
  };
};

/**
 * Pure: the quota picture from submission times (any order).
 */
function summarizeQuota(submissionTimes, now = new Date(), limits = getLimits()) {
  const nowMs = new Date(now).getTime();
  const times = submissionTimes
    .map((t) => new Date(t))
    .filter((t) => nowMs - t.getTime() < WEEK_MS)
    .sort((a, b) => a - b);
  const dailyTimes = times.filter((t) => nowMs - t.getTime() < DAY_MS);

  const daily = windowSummary(dailyTimes, limits.daily, DAY_MS);
  const weekly = windowSummary(times, limits.weekly, WEEK_MS);
  const candidates = [daily.blockedUntil, weekly.blockedUntil].filter(Boolean);
  const nextAvailableAt = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;

  const strip = ({ blockedUntil, ...rest }) => rest;
  return {
    daily: strip(daily),
    weekly: strip(weekly),
    blocked: Boolean(nextAvailableAt),
    // Which window is the binding one, for the copy ("today" vs "this week").
    blockedBy: weekly.blockedUntil && (!daily.blockedUntil || weekly.blockedUntil >= daily.blockedUntil)
      ? "weekly"
      : daily.blockedUntil
        ? "daily"
        : null,
    nextAvailableAt,
  };
}

async function getQuotaUsage(tenantId, now = new Date()) {
  const rows = await RequestSubmission.find({
    tenantId,
    at: { $gt: new Date(new Date(now).getTime() - WEEK_MS) },
  })
    .select("at")
    .lean();
  return summarizeQuota(
    rows.map((row) => row.at),
    now
  );
}

/**
 * Spend one slot, or refuse. Insert-then-verify: the row goes in first, then
 * the rows at or before it are counted, and an over-limit row is removed again.
 * Ordering by _id means two submits racing for the last slot cannot both win --
 * the later ObjectId sees the earlier one and backs out.
 *
 * @returns {{ allowed: true, slotId } | { allowed: false, quota }}
 */
async function reserveSlot({ tenantId, unitId = null, landlordId = null, now = new Date() }) {
  const limits = getLimits();
  const at = new Date(now);
  const slot = await RequestSubmission.create({ tenantId, unitId, landlordId, at });

  const count = (windowMs) =>
    RequestSubmission.countDocuments({
      tenantId,
      at: { $gt: new Date(at.getTime() - windowMs) },
      _id: { $lte: slot._id },
    });
  const [dailyUsed, weeklyUsed] = await Promise.all([count(DAY_MS), count(WEEK_MS)]);

  if (dailyUsed > limits.daily || weeklyUsed > limits.weekly) {
    await RequestSubmission.deleteOne({ _id: slot._id });
    return { allowed: false, quota: await getQuotaUsage(tenantId, now) };
  }
  return { allowed: true, slotId: slot._id };
}

async function attachRequest(slotId, requestId) {
  if (!slotId) return;
  await RequestSubmission.updateOne({ _id: slotId }, { $set: { requestId } });
}

// Hands a slot back when the request it was reserved for was never created.
async function releaseSlot(slotId) {
  if (!slotId) return;
  await RequestSubmission.deleteOne({ _id: slotId });
}

module.exports = {
  DAY_MS,
  WEEK_MS,
  getLimits,
  summarizeQuota,
  getQuotaUsage,
  reserveSlot,
  attachRequest,
  releaseSlot,
};
