const Request = require("../models/MaintenanceRequest");
const Outreach = require("../models/VendorOutreach");
const Appointment = require("../models/Appointment");
const {
  buildIncidentRecord,
} = require("../services/ai/incidentRecord.service");
const {
  deriveRoutingReadiness,
} = require("../services/ai/routingReadiness.service");
const { digest } = require("../services/ai/triageReceipt.service");
const { notifyUser } = require("../services/notification/notify.service");
const { publish } = require("../services/realtime/liveEvents.service");
const {
  alertLandlordOfNewRequest,
} = require("../services/notification/newRequestAlert.service");
const { logAgentAction } = require("../services/audit/agentAction.service");
const flow = require("../services/request/requestWorkflow.service");
const {
  workflowError,
  validateSubmissionId,
} = require("../services/request/creationEligibility.service");
const {
  loadSummaries,
} = require("../services/request/outreachSummary.service");
async function view(request, role) {
  const plain = request.toObject ? request.toObject() : request;
  delete plain.workflowOperations;
  delete plain.submissionDigest;
  if (role === "tenant")
    return require("./request.controller").sanitizeTenantRequestPayload(plain);
  return {
    ...plain,
    intakeFollowUp: flow.deriveFollowUp(plain),
    outreachSummary:
      (await loadSummaries([plain._id])).get(String(plain._id)) || null,
  };
}
async function load(req, tenant) {
  const request = await Request.findOne({
    _id: req.params.id,
    [tenant ? "tenantId" : "landlordId"]: req.user.id,
  }).select("+workflowOperations");
  if (!request)
    throw workflowError("request_not_found", "Request not found.", null, 404);
  return request;
}
function operation(request, body, kind) {
  validateSubmissionId(body.submissionId);
  if (!body.submissionId)
    throw workflowError(
      "invalid_submission_id",
      "submissionId is required.",
      null,
      400,
    );
  const hash = digest({ kind, ...body });
  const prior = (request.workflowOperations || []).find(
    (o) => o.key === body.submissionId,
  );
  if (prior && prior.digest !== hash)
    throw workflowError(
      "idempotency_conflict",
      "This operation key was already used for different content.",
    );
  return {
    prior,
    entry: { key: body.submissionId, digest: hash, kind, at: new Date() },
  };
}
async function noExternalProgress(request) {
  if (
    (await Outreach.exists({ requestId: request._id })) ||
    (await Appointment.exists({
      requestId: request._id,
      status: { $nin: ["cancelled", "failed"] },
    }))
  )
    throw workflowError(
      "request_not_editable",
      "Vendor contact or a booking already exists.",
    );
}
async function save(req, request, fields, entry, note) {
  const update = {
    $set: fields,
    $inc: { __v: 1 },
    $push: {
      timeline: {
        status: request.status,
        actorRole: req.user.role,
        actorId: req.user.id,
        note,
        at: new Date(),
      },
    },
  };
  if (entry) update.$push.workflowOperations = entry;
  const result = await Request.findOneAndUpdate(
    { _id: request._id, updatedAt: request.updatedAt, __v: request.__v },
    update,
    { new: true, runValidators: true },
  );
  if (!result)
    throw workflowError(
      "stale_revision",
      "The request changed. Refresh and review the latest details.",
      await Request.findById(request._id).lean(),
    );
  for (const id of [request.tenantId, request.landlordId]) {
    publish(id, `request:${request._id}`);
    publish(id, "requests");
  }
  return result;
}
const endpoint = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (e) {
    if (!e.statusCode) console.error("[requestWorkflow]", e.code || e.name);
    const data = e.data ? await view(e.data, req.user.role) : undefined;
    return res.status(e.statusCode || 500).json({
      success: false,
      code: e.code || "workflow_failed",
      message: e.statusCode ? e.message : "Could not update the request.",
      ...(data ? { data } : {}),
    });
  }
};
exports.putIntakeDetails = endpoint(async (req, res) => {
  const request = await load(req, true);
  const op = operation(request, req.body, "intake_details");
  if (op.prior)
    return res.json({ success: true, data: await view(request, "tenant") });
  flow.assertEditable(request, req.body.revision);
  await noExternalProgress(request);
  const { ai, follow } = flow.mergeAnswers(request, req.body.answers);
  const incidentRecord = buildIncidentRecord({
    triage: ai,
    message: request.issueDescription,
    photos: request.photos || [],
    source: request.source,
  });
  const routingReadiness = deriveRoutingReadiness({
    incidentRecord,
    triage: ai,
  });
  const safety = flow.assessSafety({
    message: req.body.answers
      .filter((a) => a.state === "answered")
      .map((a) => a.value)
      .join("\n"),
  });
  const fields = {
    ai,
    incidentRecord,
    routingReadiness,
    intakeFollowUp: follow,
    routingStatus: "approval_needed",
    routingAuthority: null,
  };
  if (safety.state !== "none") {
    fields.safetyAssessment = {
      ...safety,
      revision: (request.safetyAssessment?.revision || 0) + 1,
    };
    fields.urgency = "emergency";
    fields.workflowAlertPending = true;
  }
  const updated = await save(
    req,
    request,
    fields,
    op.entry,
    "Tenant submitted additional essential details; landlord review required",
  );
  await notifyUser({
    userId: request.landlordId,
    type: "decision_needed",
    title: "Additional request details are ready",
    message: "Review the tenant’s additional details before vendor contact.",
    eventKey: `intake_review:${request._id}:${follow.revision}`,
    metadata: { workOrderId: String(request._id) },
  });
  if (safety.state !== "none")
    void alertLandlordOfNewRequest({
      request: updated,
      tenant: { _id: request.tenantId },
    });
  return res.json({ success: true, data: await view(updated, "tenant") });
});
exports.reviewIntake = endpoint(async (req, res) => {
  const request = await load(req, false);
  const follow = flow.assertEditable(request, req.body.revision);
  await noExternalProgress(request);
  if (flow.unresolvedSafety(request))
    throw workflowError(
      "safety_review_required",
      "Review the safety concern first.",
    );
  if (follow.state === "reviewed")
    return res.json({ success: true, data: await view(request, "landlord") });
  const reason = String(req.body.reason || "").trim();
  if (reason.length > 2000 || (follow.remainingTopics.length && !reason))
    throw workflowError(
      "review_reason_required",
      "Record why vendor contact can proceed despite the missing details.",
      null,
      400,
    );
  follow.state = "reviewed";
  follow.revision++;
  follow.reviewedAt = new Date();
  follow.reviewedBy = req.user.id;
  follow.reviewReason = reason;
  const fields = {
    intakeFollowUp: follow,
    routingStatus: "approval_needed",
    routingAuthority: null,
  };
  const updated = await save(
    req,
    request,
    fields,
    null,
    "Landlord reviewed additional details and remaining uncertainty",
  );
  await logAgentAction({
    requestId: request._id,
    landlordId: request.landlordId,
    actor: "landlord",
    actionType: "intake_reviewed",
    summary: "Reviewed essential details before vendor contact",
    input: { reason, remainingTopics: follow.remainingTopics },
  });
  return res.json({ success: true, data: await view(updated, "landlord") });
});
exports.reviewSafety = endpoint(async (req, res) => {
  const request = await load(req, false);
  const assessment = request.safetyAssessment;
  if (
    !["queued", "approved", "assigned", "in_progress"].includes(
      request.status,
    ) ||
    request.archivedAt
  )
    throw workflowError(
      "request_not_editable",
      "This request is closed or archived.",
    );
  if (!assessment || assessment.revision !== req.body.revision)
    throw workflowError(
      "stale_revision",
      "The safety concern changed. Refresh and review it.",
      request,
    );
  const reason = String(req.body.reason || "").trim();
  const disposition = req.body.disposition;
  if (
    !reason ||
    reason.length > 2000 ||
    !["retain_urgent", "classify_routine"].includes(disposition)
  )
    throw workflowError(
      "invalid_safety_review",
      "A safety disposition and reason are required.",
      null,
      400,
    );
  const safetyAssessment = {
    ...assessment,
    revision: assessment.revision + 1,
    state: disposition === "classify_routine" ? "none" : assessment.state,
    provenance: [...new Set([...(assessment.provenance || []), "landlord"])],
    reviewedAt: new Date(),
    reviewedBy: req.user.id,
    reviewReason: reason,
  };
  const fields = {
    safetyAssessment,
    routingAuthority: null,
    routingStatus: ["assigned", "in_progress"].includes(request.status)
      ? request.routingStatus
      : "approval_needed",
  };
  if (disposition === "classify_routine") {
    fields.urgency = "high";
    const ai = request.ai?.toObject?.() || request.ai || {};
    fields.ai = {
      ...ai,
      urgency: "high",
      severity: 4,
      emergencyServicesRecommended: false,
      safetyGate: { ...ai.safetyGate, triggered: false },
      safety: { ...ai.safety, lifeSafetyConcern: false, safetyRisk: false },
    };
    if (request.incidentRecord)
      fields.incidentRecord = {
        ...(request.incidentRecord.toObject?.() || request.incidentRecord),
        emergency: false,
        safety: {
          ...(request.incidentRecord.safety?.toObject?.() || request.incidentRecord.safety),
          lifeSafetyConcern: false,
          safetyRisk: false,
        },
      };
    fields.routingReadiness = deriveRoutingReadiness({
      incidentRecord: fields.incidentRecord || {},
      triage: fields.ai,
    });
  }
  const updated = await save(
    req,
    request,
    fields,
    null,
    "Landlord reviewed the reported safety concern",
  );
  await logAgentAction({
    requestId: request._id,
    landlordId: request.landlordId,
    actor: "landlord",
    actionType: "safety_reviewed",
    summary: "Human safety assessment recorded",
    input: { disposition, reason },
  });
  return res.json({ success: true, data: await view(updated, "landlord") });
});
exports.postUpdate = endpoint(async (req, res) => {
  const request = await load(req, true);
  const op = operation(request, req.body, "tenant_update");
  if (op.prior)
    return res.json({ success: true, data: await view(request, "tenant") });
  if (
    !["queued", "approved", "assigned", "in_progress"].includes(
      request.status,
    ) ||
    request.archivedAt
  )
    throw workflowError("request_not_editable", "This request is closed.");
  if (
    req.body.revision !== undefined &&
    req.body.revision !== (request.intakeFollowUp?.revision || 1)
  )
    throw workflowError("stale_revision", "The request changed.", request);
  const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  if (!body || body.length > 10000)
    throw workflowError(
      "invalid_update",
      "An update of 1–10000 characters is required.",
      null,
      400,
    );
  const safety = flow.assessSafety({
    message: body,
    tenantReported: req.body.intakeMode === "safety",
  });
  const fields = {
    comments: [
      ...(request.comments || []),
      { authorId: req.user.id, authorRole: "tenant", body, at: new Date() },
    ],
  };
  if (safety.state !== "none") {
    fields.safetyAssessment = {
      ...safety,
      revision: (request.safetyAssessment?.revision || 0) + 1,
    };
    fields.urgency = "emergency";
    fields.agentPaused = true;
    fields.workflowAlertPending = true;
    fields.routingAuthority = null;
  }
  const updated = await save(
    req,
    request,
    fields,
    op.entry,
    "Tenant added an update to the existing request",
  );
  if (safety.state !== "none")
    void alertLandlordOfNewRequest({
      request: updated,
      tenant: { _id: request.tenantId },
    });
  else
    await notifyUser({
      userId: request.landlordId,
      type: "tenant_message",
      title: "Tenant added a request update",
      message: body.slice(0, 250),
      eventKey: `request_update:${request._id}:${req.body.submissionId}`,
      metadata: { workOrderId: String(request._id) },
    });
  return res.json({ success: true, data: await view(updated, "tenant") });
});
