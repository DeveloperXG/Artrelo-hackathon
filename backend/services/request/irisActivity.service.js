const mongoose = require("mongoose");
const Request = require("../../models/MaintenanceRequest");
const Log = require("../../models/AgentActionLog");
const Preparation = require("../../models/BookingPreparation");
const Outreach = require("../../models/VendorOutreach");
const Property = require("../../models/Property");
const Unit = require("../../models/Unit");
const Completion = require("../../models/JobCompletion");
const Approval = require("../../models/ApprovalRequest");
const APPROVAL_SELECT = "landlordId requestId type status expiresAt createdAt";
const LOG_PROJECT = { requestId: 1, actionType: 1, actor: 1, createdAt: 1, _eventAt: 1, _eventOrder: 1, _timeBasis: 1,
  "output.candidateCount": 1, "output.excludedCount": 1, "output.approvalRequired": 1, "output.source": 1, "output.status": 1,
  "input.attempt": 1, "output.responseDeadlineAt": 1, "output.provider": 1, "output.triageSource": 1,
  "output.triageVerified": 1, "metadata.origin": 1, "metadata.judgeSimulation": 1 };
const { activityTimeStages } = require("./activityTime.service");
const { date, compareEvents, lifecycleEvents, auditEvent, projectRequest } = require("./irisActivityProjection.service");
const bad = () => Object.assign(new Error("Invalid activity pagination parameters"), { status: 400 });
const objectId = (value) => {
  if (typeof value !== "string" || !/^[a-f\d]{24}$/i.test(value)) throw bad();
  return new mongoose.Types.ObjectId(value);
};
function pagination(query = {}, scope, defaultLimit, version = 1) {
  const limit = query.limit === undefined ? defaultLimit : typeof query.limit === "string" && /^[1-9]\d{0,2}$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad();
  let cursor = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || query.cursor.length > 1024 || !/^[\w-]+$/.test(query.cursor)) throw bad();
    try {
      cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (!cursor || cursor.scope !== scope || cursor.version !== version ||
          !(cursor.at === null || typeof cursor.at === "string" && date(cursor.at) === cursor.at) ||
          typeof cursor.id !== "string" || cursor.id.length > 100 ||
          Object.keys(cursor).sort().join() !== (version === 2 ? "at,id,orderKey,scope,version" : "at,id,scope,version") ||
          version === 2 && (typeof cursor.orderKey !== "string" || !/^(?:audit:[a-f\d]{24}:[012]:[a-f\d]{24}|lifecycle:[a-f\d]{24}:\d+)$/.test(cursor.orderKey))) throw bad();
    } catch (_) { throw bad(); }
  }
  return { limit, cursor };
}
const encode = (scope, at, id, orderKey) => Buffer.from(JSON.stringify(orderKey === undefined ? { version: 1, scope, at, id } : { version: 2, scope, at, id, orderKey })).toString("base64url");
function activeOnly(value) {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw bad();
}
const held = [
  { isAppealed: true }, { appointmentStatus: { $in: ["disputed", "in_review"] } },
  { "safetyAssessment.state": { $in: ["confirmed_hazard", "needs_review"] }, "safetyAssessment.reviewedAt": null },
  { "_completionHolds.0": { $exists: true } },
  { "_pendingApprovals.0": { $exists: true } },
];
const unresolvedCompletion = { status: "closed", "closeRecovery.version": 1,
  $or: [{ "closeRecovery.projectionPending": { $ne: false } }, { "closeRecovery.settlementRecordedAt": null }] };
const COMPLETION_SELECT = "status closedAt closeRecovery.version closeRecovery.projectionPending closeRecovery.settlementRecordedAt";
function lookup(model, alias, owner, extra = {}, sort = { updatedAt: -1, _id: -1 }, occurrence = []) {
  return { $lookup: { from: model.collection.name, let: { request: "$_id" }, pipeline: [
    { $match: { landlordId: owner, ...extra, $expr: { $eq: ["$requestId", "$$request"] } } },
    ...(alias === "_approvalActivity" ? [{ $addFields: { _approvalAt: { $max: ["$createdAt", "$decidedAt"] } } }] : []),
    ...occurrence,
    { $sort: sort }, { $limit: 1 },
    { $project: alias === "_logs" ? LOG_PROJECT : alias === "_preparations" ? { active: 1, phase: 1, leaseUntil: 1, reasonCode: 1 } : alias === "_completionHolds" ? { status: 1, closedAt: 1, "closeRecovery.version": 1, "closeRecovery.projectionPending": 1, "closeRecovery.settlementRecordedAt": 1 } : alias === "_pendingApprovals" ? { landlordId: 1, requestId: 1, type: 1, status: 1, expiresAt: 1, createdAt: 1 } : alias === "_approvalActivity" ? { createdAt: 1, decidedAt: 1, _approvalAt: 1 } : { status: 1, deliveryUnconfirmed: 1, "counterOffer.status": 1 } },
  ], as: alias } };
}

function createActivityService({ Requests = Request, Logs = Log, Preparations = Preparation, Outreaches = Outreach, Completions = Completion, Approvals = Approval, Properties = Property, Units = Unit, now = () => new Date() } = {}) {
  const occurrence = owner => activityTimeStages({ owner, approvals: Approvals.collection.name, completions: Completions.collection.name });
  async function labels(rows, owner) {
    if (!rows.length) return rows;
    const properties = await Properties.find({ _id: { $in: rows.map((row) => row.propertyId).filter(Boolean) }, landlordId: owner }).select("name").lean();
    const propertiesById = new Map(properties.map((row) => [String(row._id), row]));
    const units = await Units.find({ _id: { $in: rows.map((row) => row.unitId).filter(Boolean) }, propertyId: { $in: properties.map((row) => row._id) } }).select("unitNumber propertyId").lean();
    const unitsById = new Map(units.map((row) => [String(row._id), row]));
    return rows.map((row) => ({ ...row, propertyId: propertiesById.get(String(row.propertyId)) || null,
      unitId: String(unitsById.get(String(row.unitId))?.propertyId) === String(row.propertyId) ? unitsById.get(String(row.unitId)) : null }));
  }
  async function list(ownerId, query = {}) {
    const owner = objectId(ownerId);
    const observedAt = now();
    const active = activeOnly(query.activeOnly);
    const scope = `list:${ownerId}:${active}:domain2`;
    const { limit, cursor } = pagination(query, scope, 20);
    if (cursor && !/^[a-f\d]{24}$/i.test(cursor.id)) throw bad();
    const pipeline = [
      { $match: { landlordId: owner } },
      lookup(Completions, "_completionHolds", owner, unresolvedCompletion, { closedAt: -1, _id: -1 }),
      lookup(Approvals, "_pendingApprovals", owner, { status: "pending", expiresAt: { $gt: observedAt } }, { createdAt: -1, _id: -1 }),
      ...(active ? [{ $match: { $or: [{ status: { $nin: ["completed", "cancelled", "rejected"] } }, ...held] } }] : []),
      lookup(Logs, "_logs", owner, {}, { _eventAt: -1, _eventOrder: -1 }, occurrence(owner)),
      lookup(Approvals, "_approvalActivity", owner, {}, { _approvalAt: -1, _id: -1 }),
      // Prefer typed lifecycle/audit/state times; unrelated metadata updates must
      // not move an older activity ahead of a genuinely newer request event.
      { $addFields: { _activityAt: { $ifNull: [{ $max: [
        "$completedAt", "$cancelledAt", "$rejectedAt", "$appealedAt", "$reopenedAt", "$safetyAssessment.reviewedAt", "$intakeFollowUp.submittedAt", "$intakeFollowUp.reviewedAt",
        { $ifNull: [{ $max: "$timeline.at" }, null] }, { $ifNull: [{ $arrayElemAt: ["$_logs._eventAt", 0] }, null] },
        { $ifNull: [{ $arrayElemAt: ["$_completionHolds.closedAt", 0] }, null] },
        { $ifNull: [{ $arrayElemAt: ["$_approvalActivity._approvalAt", 0] }, null] },
      ] }, { $ifNull: ["$updatedAt", null] }] } } },
    ];
    if (cursor) pipeline.push({ $match: cursor.at === null ? { _activityAt: null, _id: { $lt: objectId(cursor.id) } } : { $or: [
      { _activityAt: { $lt: new Date(cursor.at) } }, { _activityAt: null }, { _activityAt: new Date(cursor.at), _id: { $lt: objectId(cursor.id) } },
    ] } });
    pipeline.push({ $sort: { _activityAt: -1, _id: -1 } }, { $limit: limit + 1 },
      lookup(Preparations, "_preparations", owner, { active: true }), lookup(Outreaches, "_outreaches", owner),
      { $project: { landlordId: 1, issueTitle: 1, "ai.shortTitle": 1, propertyId: 1, unitId: 1, status: 1, appointmentStatus: 1,
        timeline: 1, updatedAt: 1, safetyAssessment: 1, intakeFollowUp: 1, isAppealed: 1, agentPaused: 1,
        routingStatus: 1, initialRouting: 1, rescheduleState: 1, completedAt: 1, cancelledAt: 1, rejectedAt: 1, appealedAt: 1, reopenedAt: 1,
        _activityAt: 1, _logs: 1, _preparations: 1, _outreaches: 1, _completionHolds: 1, _pendingApprovals: 1, _approvalActivity: 1 } });
    const rows = await Requests.aggregate(pipeline);
    const selected = rows.slice(0, limit);
    const requests = (await labels(selected, owner)).map((row) => projectRequest(row, { logs: row._logs,
      preparation: row._preparations?.[0], outreach: row._outreaches?.[0], completionHold: row._completionHolds?.[0],
      approval: row._pendingApprovals?.[0], approvalActivity: row._approvalActivity?.[0], now: observedAt }));
    const last = selected.at(-1);
    return { version: 1, requests, nextCursor: rows.length > limit ? encode(scope, date(last._activityAt), String(last._id)) : null };
  }
  async function detail(ownerId, requestId, query = {}) {
    const owner = objectId(ownerId), id = objectId(requestId);
    const observedAt = now();
    const scope = `detail:${ownerId}:${requestId}`;
    const { limit, cursor } = pagination(query, scope, 50, 2);
    if (cursor && !new RegExp(`^(?:audit:[a-f\\d]{24}|lifecycle:${requestId}:\\d+)$`, "i").test(cursor.id)) throw bad();
    const request = await Requests.findOne({ _id: id, landlordId: owner }).select("landlordId issueTitle ai.shortTitle propertyId unitId status appointmentStatus timeline updatedAt safetyAssessment intakeFollowUp isAppealed agentPaused routingStatus initialRouting rescheduleState completedAt cancelledAt rejectedAt appealedAt reopenedAt").lean();
    if (!request) throw Object.assign(new Error("Request not found"), { status: 404 });
    // Normalize occurrence before the page boundary, never sort a createdAt page
    // after fetching it. Related equal-time events share a proven causal key.
    const logPipeline = [{ $match: { requestId: id, landlordId: owner } }, ...occurrence(owner)];
    const pageBoundary = !cursor ? [] : [{ $match: { $or: cursor.at === null ? [
      { _eventAt: null, _eventOrder: { $lt: cursor.orderKey } },
    ] : [ { _eventAt: { $lt: new Date(cursor.at) } }, { _eventAt: null },
      { _eventAt: new Date(cursor.at), _eventOrder: { $lt: cursor.orderKey } },
    ] } }];
    const logPage = (boundary, count) => Logs.aggregate([...logPipeline, ...boundary,
      { $sort: { _eventAt: -1, _eventOrder: -1 } }, { $limit: count }, { $project: LOG_PROJECT }]);
    const [logs, latestLogs, preparation, outreach, completionHold, approval, approvalActivity, labeled] = await Promise.all([
      logPage(pageBoundary, limit + 1),
      logPage([], 1),
      Preparations.findOne({ requestId: id, landlordId: owner, active: true }).select("active phase leaseUntil reasonCode").sort({ updatedAt: -1, _id: -1 }).lean(),
      Outreaches.findOne({ requestId: id, landlordId: owner }).select("status deliveryUnconfirmed counterOffer.status").sort({ updatedAt: -1, _id: -1 }).lean(),
      Completions.findOne({ requestId: id, landlordId: owner, ...unresolvedCompletion }).select(COMPLETION_SELECT).sort({ closedAt: -1, _id: -1 }).lean(),
      Approvals.findOne({ requestId: id, landlordId: owner, status: "pending", expiresAt: { $gt: observedAt } }).select(APPROVAL_SELECT).sort({ createdAt: -1, _id: -1 }).lean(),
      Approvals.aggregate([{ $match: { requestId: id, landlordId: owner } },
        { $addFields: { _approvalAt: { $max: ["$createdAt", "$decidedAt"] } } },
        { $sort: { _approvalAt: -1, _id: -1 } }, { $limit: 1 }, { $project: { createdAt: 1, decidedAt: 1 } }]),
      labels([request], owner),
    ]);
    const timeline = lifecycleEvents(request).filter((event) => !cursor || compareEvents(event, cursor) > 0);
    const merged = [...timeline, ...logs.map(auditEvent)].sort(compareEvents);
    const events = merged.slice(0, limit);
    const last = events.at(-1);
    return { version: 1, request: projectRequest(labeled[0], { logs: latestLogs, preparation, outreach, completionHold,
      approval, approvalActivity: approvalActivity[0], now: observedAt }), events,
      nextCursor: merged.length > limit ? encode(scope, last.at, last.id, last.orderKey || last.id) : null };
  }
  return { list, detail };
}
module.exports = { createActivityService, pagination, encode, activeOnly, ...createActivityService() };
