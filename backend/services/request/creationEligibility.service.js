const mongoose = require("mongoose");
const Request = require("../../models/MaintenanceRequest");
const Submission = require("../../models/RequestSubmission");
const {
  getQuotaUsage,
  summarizeQuota,
  WEEK_MS,
} = require("./requestQuota.service");
const Guard =
  mongoose.models.RequestIntakeGuard ||
  mongoose.model(
    "RequestIntakeGuard",
    new mongoose.Schema({
      _id: String,
      version: { type: Number, default: 0 },
    }),
  );
const OPEN = ["queued", "approved", "assigned", "in_progress"];
const CAP = 2;
function eligibility({
  quota,
  openCount = 0,
  linked = true,
  now = new Date(),
}) {
  const reasons = [];
  if (!linked) reasons.push("unit_unlinked");
  if (openCount >= CAP) reasons.push("open_cap");
  if (quota?.daily?.remaining === 0) reasons.push("daily_limit");
  if (quota?.weekly?.remaining === 0) reasons.push("weekly_limit");
  return {
    allowed: !reasons.length,
    reasons,
    openCount,
    openCap: CAP,
    nextAvailableAt: quota?.nextAvailableAt || null,
    evaluatedAt: now.toISOString(),
  };
}
async function getEligibility(tenant, now = new Date()) {
  const unitId = tenant?.unit?._id || tenant?.unit;
  const [quota, openCount] = await Promise.all([
    getQuotaUsage(tenant._id, now),
    unitId ? Request.countDocuments({ unitId, status: { $in: OPEN } }) : 0,
  ]);
  const linked =
    !!unitId && tenant.status !== "inactive" && !tenant.unit?.archivedAt;
  return {
    ...quota,
    openCount,
    openCap: CAP,
    creationEligibility: eligibility({ quota, openCount, linked, now }),
  };
}
function workflowError(code, message, data, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode, data });
}
function validateSubmissionId(id) {
  if (
    id !== undefined &&
    (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(id))
  ) {
    throw workflowError(
      "invalid_submission_id",
      "A valid submissionId is required.",
      null,
      400,
    );
  }
}
async function replaySubmission(tenantId, submissionId, submissionDigest) {
  if (!submissionId) return null;
  validateSubmissionId(submissionId);
  const row = await Request.findOne({ tenantId, submissionId });
  if (row && row.submissionDigest !== submissionDigest)
    throw workflowError(
      "idempotency_conflict",
      "This submission key was already used for different content.",
    );
  return row;
}
// Both tenants sharing a unit and repeated submissions by one tenant serialize
// on common documents. The admission and its immutable ledger row commit together.
async function createAdmittedRequest(payload, { exempt = false } = {}) {
  validateSubmissionId(payload.submissionId);
  const keys = [`tenant:${payload.tenantId}`, `unit:${payload.unitId}`].sort();
  for (const _id of keys) {
    try {
      await Guard.updateOne(
        { _id },
        { $setOnInsert: { version: 0 } },
        { upsert: true },
      );
    } catch (e) {
      if (e.code !== 11000) throw e;
    }
  }
  let result;
  await mongoose.connection.transaction(async (session) => {
    for (const _id of keys)
      await Guard.updateOne({ _id }, { $inc: { version: 1 } }, { session });
    if (payload.submissionId) {
      const previous = await Request.findOne({
        tenantId: payload.tenantId,
        submissionId: payload.submissionId,
      }).session(session);
      if (previous) {
        if (previous.submissionDigest !== payload.submissionDigest)
          throw workflowError(
            "idempotency_conflict",
            "This submission key was already used for different content.",
          );
        result = { request: previous, replayed: true };
        return;
      }
    }
    const now = new Date();
    if (!exempt) {
      const openCount = await Request.countDocuments({
        unitId: payload.unitId,
        status: { $in: OPEN },
      }).session(session);
      const rows = await Submission.find({
        tenantId: payload.tenantId,
        at: { $gt: new Date(now - WEEK_MS) },
      })
        .select("at")
        .session(session)
        .lean();
      const quota = summarizeQuota(
        rows.map((row) => row.at),
        now,
      );
      const gate = eligibility({ quota, openCount, now });
      if (!gate.allowed)
        throw workflowError(
          gate.reasons.includes("open_cap")
            ? "request_open_cap_reached"
            : "request_quota_reached",
          "Your normal request limit has been reached.",
          { quota, creationEligibility: gate },
          429,
        );
    }
    const [request] = await Request.create([payload], { session });
    if (!exempt)
      await Submission.create(
        [
          {
            tenantId: payload.tenantId,
            unitId: payload.unitId,
            landlordId: payload.landlordId,
            requestId: request._id,
            at: now,
          },
        ],
        { session },
      );
    result = { request, replayed: false };
  });
  return result;
}
module.exports = {
  eligibility,
  getEligibility,
  createAdmittedRequest,
  replaySubmission,
  validateSubmissionId,
  workflowError,
  OPEN,
  CAP,
};
