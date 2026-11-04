// Read-only domain occurrence projection. Never rewrite historical audit rows.
// Owned record linkage, rather than the action title or client data, establishes
// occurrence time and the ordering of equal-time review/close causes.
const asId = input => ({ $convert: { input, to: "objectId", onError: null, onNull: null } });
const validDate = value => ({ $eq: [{ $type: value }, "date"] });
function activityTimeStages({ owner, approvals, completions }) {
  return [
    { $set: { _decisionRef: asId({ $cond: [{ $eq: ["$actionType", "cost_review_reopened"] }, "$output.approvalRequestId", "$input.approvalRequestId"] }),
      _completionRef: asId("$input.completionId") } },
    { $lookup: { from: approvals, let: { ref: "$_decisionRef", request: "$requestId" }, pipeline: [
      { $match: { landlordId: owner, $expr: { $and: [{ $eq: ["$_id", "$$ref"] }, { $eq: ["$requestId", "$$request"] }] } } },
      { $project: { status: 1, type: 1, decidedAt: 1, createdAt: 1, "payload.reopenedFromApprovalId": 1, "payload.stage": 1, "payload.subjectId": 1 } },
    ], as: "_linkedDecisions" } },
    { $lookup: { from: completions, let: { ref: "$_completionRef", request: "$requestId" }, pipeline: [
      { $match: { landlordId: owner, $expr: { $and: [{ $eq: ["$_id", "$$ref"] }, { $eq: ["$requestId", "$$request"] }] } } },
      { $project: { closedAt: 1, "invoiceReview.approvalId": 1 } },
    ], as: "_linkedCompletions" } },
    { $set: { _linkedDecision: { $arrayElemAt: ["$_linkedDecisions", 0] }, _linkedCompletion: { $arrayElemAt: ["$_linkedCompletions", 0] } } },
    { $lookup: { from: approvals, let: { ref: "$_linkedCompletion.invoiceReview.approvalId", request: "$requestId", completion: "$_linkedCompletion._id" }, pipeline: [
      { $match: { landlordId: owner, type: "cost_review", status: "approved", "payload.stage": "invoice", $expr: { $and: [
        { $eq: ["$_id", "$$ref"] }, { $eq: ["$requestId", "$$request"] }, { $eq: [asId("$payload.subjectId"), "$$completion"] },
      ] } } }, { $project: { _id: 1 } },
    ], as: "_closeCauses" } },
    { $set: {
      _validDecision: { $and: [{ $eq: ["$actor", "landlord"] }, { $ne: [{ $ifNull: ["$_linkedDecision._id", null] }, null] },
        { $eq: ["$input.approvalType", "$_linkedDecision.type"] }, { $eq: ["$output.status", "$_linkedDecision.status"] },
        { $in: ["$_linkedDecision.status", ["approved", "rejected", "expired"]] },
        { $eq: ["$actionType", { $concat: [{ $cond: [{ $eq: ["$_linkedDecision.type", "vendor_contact_approval"] }, "vendor_contact", { $ifNull: ["$_linkedDecision.type", ""] }] }, "_", { $ifNull: ["$_linkedDecision.status", ""] }] }] }] },
      _validReopen: { $and: [{ $eq: ["$actor", "landlord"] }, { $eq: ["$actionType", "cost_review_reopened"] },
        { $eq: ["$_linkedDecision.type", "cost_review"] }, { $eq: ["$_linkedDecision.payload.stage", "$input.stage"] },
        { $eq: [asId("$_linkedDecision.payload.subjectId"), asId("$input.subjectId")] },
        { $ne: [asId("$input.subjectId"), null] }, { $eq: [asId("$_linkedDecision.payload.reopenedFromApprovalId"), asId("$input.declinedApprovalId")] },
        { $ne: [asId("$input.declinedApprovalId"), null] }] },
      _validClose: { $and: [{ $eq: ["$actionType", "job_completion_closed"] }, validDate("$_linkedCompletion.closedAt")] },
    } },
    { $set: { _domainAt: { $switch: { branches: [
      { case: "$_validDecision", then: "$_linkedDecision.decidedAt" },
      { case: "$_validReopen", then: "$_linkedDecision.createdAt" },
      { case: "$_validClose", then: "$_linkedCompletion.closedAt" },
    ], default: null } } } },
    { $set: { _domainKnown: { $and: [validDate("$_domainAt"), { $or: [{ $not: [validDate("$createdAt")] }, { $lte: ["$_domainAt", "$createdAt"] }] }] } } },
    { $set: { _eventAt: { $cond: ["$_domainKnown", "$_domainAt", { $cond: [validDate("$createdAt"), "$createdAt", null] }] },
      _timeBasis: { $cond: ["$_domainKnown", "domain", { $cond: [validDate("$createdAt"), "recorded", "unknown"] }] },
      _eventOrder: { $concat: ["audit:",
        { $toString: { $cond: [{ $and: ["$_domainKnown", { $or: ["$_validDecision", "$_validReopen"] }] }, "$_linkedDecision._id",
          { $cond: [{ $and: ["$_domainKnown", "$_validClose", { $gt: [{ $size: "$_closeCauses" }, 0] }] }, "$_linkedCompletion.invoiceReview.approvalId", "$_id"] }] } },
        { $cond: [{ $and: ["$_domainKnown", "$_validClose", { $gt: [{ $size: "$_closeCauses" }, 0] }] }, ":2:",
          { $cond: [{ $and: ["$_domainKnown", "$_validDecision"] }, ":1:", ":0:"] }] }, { $toString: "$_id" },
      ] },
    } },
  ];
}
module.exports = { activityTimeStages };
