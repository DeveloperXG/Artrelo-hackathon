const mongoose = require("mongoose");
const { createHash } = require("node:crypto");
const Outreach = require("../../models/VendorOutreach");
const Request = require("../../models/MaintenanceRequest");
const Policy = require("../../models/LandlordPolicy");
const Checkpoint = require("../../models/PolicyCheckpoint");
const { resolveQuotaLimit } = require("../vendor/routingDecision.service");
const { dollarToMinor } = require("./itemization.service");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const mapValue = (map, key) => typeof map?.get === "function" ? map.get(String(key)) : map?.[String(key)];
const stopped = () => Object.assign(new Error("The quote changed before its policy checkpoint."), { statusCode: 409, code: "quote_checkpoint_changed" });

function quoteBasis(outreach) {
  const snapshot = outreach.quoteRevisions?.find(row => row.revision === outreach.currentQuoteRevision);
  if (!snapshot) throw stopped();
  const confirmed = outreach.counterOffer?.status === "confirmed";
  const highMinor = confirmed ? dollarToMinor(outreach.counterOffer.amount, "agreed") : snapshot.itemization.totals.highMinor;
  return { snapshot, highMinor, basisHash: hash({ quoteHash: snapshot.hash, revision: snapshot.revision,
    authorizedCeiling: outreach.authorizedCeiling ?? null,
    negotiated: confirmed ? { amountMinor: highMinor, respondedAt: outreach.counterOffer.respondedAt || null } : null }) };
}
function quotaSource(policy, request) {
  if (Number(request.quotaOverride) > 0) return "request";
  if (Number(mapValue(policy.unitQuotas, request.unitId)) > 0) return "unit";
  if (Number(mapValue(policy.propertyQuotas, request.propertyId)) > 0) return "property";
  if (Number(mapValue(policy.categoryQuotas, request.category)) > 0) return "category";
  return Number(policy.defaultQuota) > 0 ? "default" : "unset";
}
function toQuotaCheck(record) {
  return { limit: record.effectiveLimit, quoteHigh: record.quoteHighMinor / 100,
    overQuota: record.state !== "passed", evaluatedAt: record.evaluatedAt };
}

/**
 * The policy and request fences serialize this claim with global policy saves
 * and request-specific quota writes. No provider work is inside the transaction.
 * Passed evidence is keyed to the quote/explicit negotiated authority, never to
 * a request's lifetime policy. A different quote/vendor crosses a new checkpoint.
 */
async function claimQuoteCheckpoint({ outreachId, landlordId }) {
  return mongoose.connection.transaction(async session => {
    const outreach = await Outreach.findOne({ _id: outreachId, landlordId, status: "accepted", appointmentId: null }).session(session).lean();
    if (!outreach || outreach.quoteContractVersion !== 2) throw stopped();
    const basis = quoteBasis(outreach);
    const scope = { landlordId, requestId: outreach.requestId, subjectId: outreach._id, stage: "vendor_quote", basisHash: basis.basisHash };
    const passed = await Checkpoint.findOne({ ...scope, state: "passed" }).session(session).lean();
    if (passed) return { record: passed, quotaCheck: toQuotaCheck(passed), reused: true };
    const locked = await Request.updateOne({ _id: outreach.requestId, landlordId,
      status: { $nin: ["completed", "cancelled", "rejected"] }, archivedAt: null },
    { $inc: { policyCheckpointFence: 1 } }, { session });
    if (!locked.matchedCount) throw stopped();
    const request = await Request.findOne({ _id: outreach.requestId, landlordId }).session(session).lean();
    const policy = await Policy.findOneAndUpdate({ landlordId }, { $inc: { checkpointFence: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true, session, lean: true });
    const limit = resolveQuotaLimit(policy, request);
    const source = quotaSource(policy, request);
    const policyRevision = policy.policyRevision || 0;
    const policyHash = hash({ policyRevision, limit, source });
    const existing = await Checkpoint.findOne({ ...scope, policyHash }).session(session).lean();
    if (existing) return { record: existing, quotaCheck: toQuotaCheck(existing), reused: true };
    const now = new Date();
    const approved = limit !== null && basis.highMinor / 100 <= limit;
    const [record] = await Checkpoint.create([{ ...scope, policyHash, policyRevision,
      quoteRevision: basis.snapshot.revision, quoteHash: basis.snapshot.hash, quoteHighMinor: basis.highMinor,
      effectiveLimit: limit, quotaSource: source, state: approved ? "passed" : "review_required",
      submittedAt: outreach.response?.submittedAt || outreach.respondedAt || now,
      evaluatedAt: now, passedAt: approved ? now : null }], { session });
    const changed = await Outreach.updateOne({ _id: outreach._id, landlordId, status: "accepted", appointmentId: null,
      currentQuoteRevision: basis.snapshot.revision,
      quoteRevisions: { $elemMatch: { revision: basis.snapshot.revision, hash: basis.snapshot.hash } } },
    { $set: { quoteCheckpointId: record._id, quotaCheck: toQuotaCheck(record) } }, { session });
    if (!changed.matchedCount) throw stopped();
    return { record, quotaCheck: toQuotaCheck(record), reused: false };
  });
}

/** Legacy evidence is not backfilled with a fabricated policy revision. */
function passedLegacyCheck(outreach) {
  const check = outreach.quotaCheck;
  if (outreach.quoteContractVersion === 2 || check?.overQuota !== false || !check.evaluatedAt ||
      typeof check.limit !== "number" || !Number.isFinite(check.limit) || Number(check.quoteHigh) > check.limit ||
      Number(check.quoteHigh) !== Number(outreach.response?.quoteHigh) ||
      (outreach.authorizedCeilingAt && new Date(outreach.authorizedCeilingAt) > new Date(check.evaluatedAt))) return null;
  return { limit: check.limit ?? null, quoteHigh: check.quoteHigh, overQuota: false, evaluatedAt: check.evaluatedAt };
}
function itemizedBookingMatches(current, expected) {
  if (expected.quoteContractVersion !== 2) return true;
  try {
    const now = quoteBasis(current), then = quoteBasis(expected);
    return current.quoteContractVersion === 2 && now.basisHash === then.basisHash &&
      current.quoteReview?.state === "cleared" && current.quoteReview.quoteHash === now.snapshot.hash &&
      current.approvedQuoteSnapshot?.hash === now.snapshot.hash && current.approvedQuoteSnapshot.revision === now.snapshot.revision;
  } catch (_) { return false; }
}
module.exports = { quoteBasis, quotaSource, toQuotaCheck, claimQuoteCheckpoint, passedLegacyCheck, itemizedBookingMatches };
