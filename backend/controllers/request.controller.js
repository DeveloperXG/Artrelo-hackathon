const mongoose = require("mongoose");
const { randomUUID } = require("crypto");
const { getEligibility, createAdmittedRequest, replaySubmission } = require('../services/request/creationEligibility.service');
const workflow = require('../services/request/requestWorkflow.service');
const { loadSummaries } = require('../services/request/outreachSummary.service');
const { digest: submissionHash } = require('../services/ai/triageReceipt.service');
const env = require("../config/env");
const { currentQuote } = require("../services/quotes/currentQuote.service");
const MaintenanceRequest = require("../models/MaintenanceRequest");
const Tenant = require("../models/Tenant");
const Unit = require("../models/Unit");
const Property = require("../models/Property");
const Vendor = require("../models/Vendor");
const LandlordPolicy = require("../models/LandlordPolicy");
const ApprovalRequest = require("../models/ApprovalRequest");
const AgentActionLog = require("../models/AgentActionLog");
const { touchLandlordActivity } = require("../services/metrics/activity.service");
const Appointment = require("../models/Appointment");
const { aiTriage, normalizeTriageOutput } = require("../services/ai/categorization.service");
const { buildIncidentRecord } = require("../services/ai/incidentRecord.service");
const { deriveRoutingReadiness } = require("../services/ai/routingReadiness.service");
const { evaluateSafetyGate } = require("../services/ai/safetyGate.service");
const { defaultResponsibility } = require("../services/ai/costRouting.service");
const { notifyUser } = require("../services/notification/notify.service");
const { notifyThreadMessage } = require("../services/notification/threadMessage.service");
const { failAppointment, reportNoShow, dismissNoShow, noShowReportableAt, isArrivalPassed } = require("../services/completion/appointmentFailure.service");
const {
  deleteRequestsWithCascade,
  expiredRejectedRequestFilter,
} = require("../services/request/rejectedRequestCleanup.service");
const {
  APPEAL_WINDOW_HOURS,
  AppealError,
  buildAppealState,
  notifyTenantRejected,
  submitAppeal,
  reopenRejectedRequest,
  finalizeRejection,
  declineAppeal,
} = require("../services/request/appeal.service");
const { precheckIntake } = require("../services/request/intakePrecheck.service");
const { tenantUnitProblem } = require("../services/portfolio/deletionGuard.service");
const {
  resolveVendorServiceNeeded,
  getReasonLabel,
} = require("../services/vendor/vendorServices.service");
const {
  generateVendorRecommendations,
} = require("../services/vendor/vendorRecommendation.service");
const VendorOutreach = require("../models/VendorOutreach");
const {
  ACTIVE_CANDIDATE_STATES,
  applyQuotaLimitToSnapshot,
  cloneSnapshot,
  findLedgerEntry,
  getSnapshotCandidates,
  getActiveCandidate,
  requeueCandidatesForNextRound,
  rebuildSnapshotSections,
  carryOverEditedDrafts,
} = require("../services/vendor/vendorSnapshot.service");
const { assertRoutingSetupReady } = require("../services/vendor/routingSetup.service");
const {
  CLOSED_OUTREACH_STATUSES,
  activeCandidateLockMessage,
  buildRoutingGuidance,
  getRegenerateBlockReason,
  hasEngagedContactCandidate,
} = require("../services/request/routingGuidance.service");
const { deriveRequestLifecycleStatus } = require("../services/request/requestLifecycle.service");
const {
  dismissVendorQuote,
  expireOrphanedQuoteApprovals,
} = require("../services/vendor/vendorQuoteDismissal.service");
const {
  MAX_ATTEMPTS: MAX_OUTREACH_ATTEMPTS,
  sendVendorOutreach,
  supersedeOutreach,
  projectOutreachOntoSnapshot,
  maskEmail,
} = require("../services/vendor/vendorOutreach.service");
const {
  finalizeVendorAcceptance,
  sendVendorBookingConfirmation,
} = require("../services/vendor/vendorAcceptance.service");
const { raiseCounterOffer } = require("../services/vendor/vendorCounterOffer.service");
const { buildVendorMessageDraft } = require("../services/vendor/vendorMessageDraft.service");
const { decorateSendTiming } = require("../services/vendor/sendTiming.service");
const { getTenantFacingVendorContact } = require("../services/comms/relay.service");
const { fanOutTenantMessage } = require("../services/comms/relayMessaging.service");
const { closeProxySessionsForRequest } = require("../services/comms/proxySession.service");
const JobCompletion = require("../models/JobCompletion");
const {
  buildTenantCompletionView,
} = require("../services/completion/completionViews.service");
const {
  closeJobCompletion,
  resolveCompletionOverage,
  resolveCompletionReview,
  TRAILING_DISPUTE_MS,
} = require("../services/completion/jobCompletion.service");
const { settleManualCompletion } = require("../services/completion/manualCompletion.service");
const { revokeJobToken } = require("../services/vendor/jobToken.service");
const LedgerEntry = require("../models/LedgerEntry");
const { alertLandlordOfNewRequest } = require("../services/notification/newRequestAlert.service");
const { verifyTriageReceipt, routingDigest } = require("../services/ai/triageReceipt.service");
const { processInitialRouting, takeOverInitialRouting } = require("../services/request/initialRouting.service");
const { publish } = require("../services/realtime/liveEvents.service");
const { resolveOutreachTier } = require("../services/vendor/vendorOutreachPolicy.service");
const { loadRequestDirectPayment } = require("../services/ledger/directPayment.service");
const { voidHold, getBalance } = require("../services/ledger/ledger.service");
const { advanceOutreach } = require("../services/vendor/vendorOutreachSweeper.service");

const sanitizeTenantAI = (ai) => {
  if (!ai) return ai;
  const tenantVisibleAIFields = [
    "summary",
    "shortTitle",
    "category",
    "safetyWarning",
    "followUpQuestions",
    "readyToSubmit",
    "intakeStatus",
    "missingFields",
    "generatedAt",
  ];

  return tenantVisibleAIFields.reduce((sanitized, field) => {
    if (ai[field] !== undefined) sanitized[field] = ai[field];
    return sanitized;
  }, {});
};

const sanitizeTenantRequestPayload = (request) => {
  if (!request) return request;
  const tenantVisibleFields = [
    "bookingVersion",
    "_id",
    "tenantId",
    "propertyId",
    "unitId",
    "issueTitle",
    "issueDescription",
    "category",
    "urgency",
    "photos",
    "accessPermission",
    "preferredTime",
    "status",
    "vendorId",
    "eta",
    // estimatedCost / finalCost are deliberately NOT tenant-visible: since
    // vendor outreach shipped, estimatedCost holds the vendor's quote, which is
    // commercial information between the vendor and the landlord. The tenant
    // notification in vendorAcceptance.service.js already withholds it.
    "responsibility",
    "rejectionReason",
    "rejectedAt",
    "appealWindowExpiresAt",
    "isAppealed",
    "appealNote",
    "appealedAt",
    "reopenedAt",
    "completedAt",
    "completionNotes",
    "cancelledAt",
    "archivedAt",
    "appointmentStatus",
    "source",
    "timeline",
    "comments",
    "ai",
    "createdAt",
    "updatedAt",
  ];

  const sanitized = tenantVisibleFields.reduce((result, field) => {
    if (request[field] !== undefined) result[field] = request[field];
    return result;
  }, {});
  if (sanitized.ai) sanitized.ai = sanitizeTenantAI(sanitized.ai);
  // Canonical stage so the tenant view matches the landlord's lifecycle even
  // though the underlying vendor snapshot is intentionally not exposed.
  Object.assign(sanitized, workflow.tenantWorkflow(request));
  sanitized.lifecycleStatus = deriveRequestLifecycleStatus(request);
  // What the rejection card may offer, decided on the server (clock skew).
  sanitized.appeal = buildAppealState(request);
  return sanitized;
};

const sanitizeEvidenceAssets = (assets = []) =>
  Array.isArray(assets)
    ? assets
        .filter((a) => a && typeof a.url === "string" && a.url.trim())
        .slice(0, 12)
        .map((a) => ({
          url: String(a.url).trim(),
          publicId: a.publicId ? String(a.publicId) : undefined,
          type: a.type === "video" ? "video" : "image",
          label: a.label ? String(a.label).slice(0, 80) : null,
          format: a.format ? String(a.format) : undefined,
          bytes: Number(a.bytes) || undefined,
          width: Number(a.width) || undefined,
          height: Number(a.height) || undefined,
        }))
    : [];

const sanitizeIntakeMessages = (messages = []) =>
  Array.isArray(messages)
    ? messages
        .slice(-20)
        .map((m) => ({
          role: m.role === "ai" || m.role === "assistant" ? "ai" : "user",
          content: String(m.content || "").trim(),
          attachments: sanitizeEvidenceAssets(m.attachments),
        }))
        .filter((m) => m.content.length > 0)
    : [];

const logAgentAction = async ({
  requestId,
  landlordId,
  actor,
  actionType,
  summary,
  input,
  output,
  metadata,
}) => {
  try {
    if (!requestId || !landlordId || !actor || !actionType || !summary) return;
    await AgentActionLog.create({
      requestId,
      landlordId,
      actor,
      actionType,
      summary,
      input,
      output,
      metadata,
    });
    if (actor === "landlord") void touchLandlordActivity(landlordId);
  } catch (err) {
    console.error("[logAgentAction] failed", err?.message || err);
  }
};

const ROUTING_APPROVAL_TYPES = ["quota_increase", "first_time_vendor", "vendor_contact_approval"];
const REQUEST_ROUTEABLE_ERROR_CODE = "request_not_routeable";

const getSnapshotLedger = (request) =>
  Array.isArray(request?.vendorRecommendationSnapshot?.candidateLedger)
    ? request.vendorRecommendationSnapshot.candidateLedger
    : [];

const findSnapshotCandidate = (request, candidateId) => {
  const candidates = getSnapshotCandidates(request?.vendorRecommendationSnapshot);
  return candidates.find(
    (candidate) =>
      candidate.candidateKey === candidateId ||
      candidate.vendorId?.toString?.() === candidateId ||
      candidate.providerVendorId === candidateId
  );
};

// Candidate states that still represent a routable vendor. Mirrors
// ELIGIBLE_VENDOR_STATES in the frontend's requestDetailSelectors.
const ELIGIBLE_LEDGER_STATES = new Set([
  "recommended",
  "pending",
  "held",
  "approved_for_contact",
  "selected",
]);

// How many vendors a snapshot still considers routable. Prefers the count the
// generator recorded; falls back to the ledger for snapshots predating it.
const getSnapshotEligibleCount = (snapshot) => {
  if (!snapshot) return 0;
  const recorded = Number(snapshot.diagnostics?.eligibleCount);
  if (Number.isFinite(recorded)) return recorded;
  return getSnapshotCandidates(snapshot).filter((candidate) =>
    ELIGIBLE_LEDGER_STATES.has(candidate.state || "")
  ).length;
};

const APPROVAL_TYPE_LABELS = {
  external_vendor_search: "External vendor search",
  quota_increase: "Quota increase",
  first_time_vendor: "First-time vendor",
  vendor_contact_approval: "Vendor contact",
  high_severity: "High-severity request",
  tenant_caused_cost: "Tenant-caused cost",
  other: "Approval",
};

const APPROVAL_ACTION_PREFIXES = {
  vendor_contact_approval: "vendor_contact",
};

const buildApprovalDecisionAudit = ({ approval, request, status }) => {
  const candidateKey = approval.payload?.candidateKey;
  const candidate = candidateKey ? findSnapshotCandidate(request, candidateKey) : null;
  const label = APPROVAL_TYPE_LABELS[approval.type] || "Approval";
  const candidateSuffix = candidate?.name ? ` for ${candidate.name}` : "";
  const actionType = `${APPROVAL_ACTION_PREFIXES[approval.type] || approval.type}_${status}`;
  const summary =
    approval.type === "vendor_contact_approval" && status === "approved"
      ? `Vendor contact approved${candidateSuffix || " for selected vendor candidate"}`
      : `${label} ${status}${candidateSuffix}`;

  return {
    actionType,
    summary,
    input: {
      approvalRequestId: approval._id,
      approvalType: approval.type,
      candidateKey: candidateKey || null,
    },
    output: {
      status: approval.status,
      candidateName: candidate?.name || null,
    },
    metadata: {
      approvalRequestId: approval._id,
      approvalType: approval.type,
      decisionStatus: status,
      occurredAt: approval.decidedAt || null,
      occurrenceSource: "approval.decidedAt",
      cause: { kind: "approval", id: approval._id },
    },
  };
};

const loadLandlordRequestForRecommendations = async (requestId, landlordId, { readOnly = false, session } = {}) => {
  const query = MaintenanceRequest.findOne({
    _id: requestId,
    landlordId,
  })
    .populate("propertyId", "name address")
    .populate("unitId", "unitNumber")
    .populate("tenantId", "firstName lastName email")
    .populate("vendorId", "name phone company")
    .populate("selectedVendorId", "name phone company");
  if (session) query.session(session);
  const request = await query;
  if (request && !readOnly) await takeOverInitialRouting(request);
  return request;
};

const mapDecisionToRoutingStatus = (decision) => {
  if (!decision) return "pending";
  if (decision.actionType === "manual_vendor_assignment_required") return "paused";
  if (decision.approvalRequired) return "approval_needed";
  return "routed";
};

// Appointment statuses that mean a booking is still live. The inverse of
// FINISHED_APPOINTMENT_STATUSES further down, spelled out because that const is
// declared after the functions that need this.
const LIVE_APPOINTMENT_STATUSES = [
  "proposed",
  "awaiting_vendor",
  "awaiting_tenant",
  "scheduled",
  "work_verifying",
  "in_review",
  "disputed",
];

/**
 * Release a vendor selection that no longer has a booking behind it.
 *
 * selectedVendorId is set when a vendor accepts and their appointment is made.
 * Some paths retire that vendor without clearing it -- a decline recorded
 * after the round moved on, an appointment cancelled through updateAppointment
 * -- and assertRequestRouteableForRecommendations then refused every
 * regeneration with "a selected vendor candidate exists" while the routing
 * panel showed no vendor at all. A selection only means something while its
 * booking is live, so that is what is asked.
 *
 * Also settles a request-level appointmentStatus left at a live value (the
 * workflow bar read "Assigned or scheduled" from it) onto the latest booking's
 * real status. Saves and audits only when something changed. Exported for tests.
 */
const releaseStaleVendorSelection = async (request, { actor = "system" } = {}) => {
  if (!request) return false;
  const liveStatus = LIVE_APPOINTMENT_STATUSES.includes(request.appointmentStatus);
  if (!request.selectedVendorId && !liveStatus) return false;

  const live = await Appointment.exists({
    requestId: request._id,
    status: { $in: LIVE_APPOINTMENT_STATUSES },
  });
  if (live) return false;

  const releasedVendorId = request.selectedVendorId ? String(request.selectedVendorId?._id || request.selectedVendorId) : null;
  request.selectedVendorId = null;
  if (liveStatus) {
    const latest = await Appointment.findOne({ requestId: request._id })
      .sort({ createdAt: -1 })
      .select("status")
      .lean();
    request.appointmentStatus = latest?.status || "none";
  }
  await request.save();

  await logAgentAction({
    requestId: request._id,
    landlordId: request.landlordId,
    actor,
    actionType: "vendor_selection_released",
    summary: "Released a vendor selection with no live booking behind it",
    input: { selectedVendorId: releasedVendorId },
    output: { appointmentStatus: request.appointmentStatus },
  });
  return true;
};

const createRouteableError = (message) => {
  const err = new Error(message);
  err.statusCode = 409;
  err.code = REQUEST_ROUTEABLE_ERROR_CODE;
  return err;
};

const buildApprovalTypeForDecision = (actionType) => {
  if (actionType === "request_quota_increase") return "quota_increase";
  if (actionType === "request_first_time_vendor_approval") return "first_time_vendor";
  if (actionType === "request_vendor_contact_approval") return "vendor_contact_approval";
  return null;
};

// The rule lives in routingGuidance.service, which the request page's
// payload also reads, so the guard and the page cannot disagree.
const assertRequestRouteableForRecommendations = (request) => {
  const reason = getRegenerateBlockReason(request);
  if (reason) throw createRouteableError(reason);
};

const expirePendingRoutingApprovals = async (requestId, landlordId, session) => {
  await ApprovalRequest.updateMany(
    {
      requestId,
      landlordId,
      type: { $in: ROUTING_APPROVAL_TYPES },
      status: "pending",
    },
    {
      $set: {
        status: "expired",
        decidedAt: new Date(),
      },
    },
    ...(session ? [{ session }] : [])
  );
};

const ensureApprovalRequestForSnapshot = async ({ request, snapshot, reasonCode, session }) => {
  const approvalType = buildApprovalTypeForDecision(snapshot?.decision?.actionType);
  const topCandidate = Array.isArray(snapshot?.recommendations) ? snapshot.recommendations[0] : null;

  if (!snapshot?.decision?.approvalRequired || !approvalType || !topCandidate) {
    await expirePendingRoutingApprovals(request._id, request.landlordId, session);
    snapshot.approvalRequest = null;
    return null;
  }

  const payload = {
    requestId: request._id.toString(),
    priority: resolveOutreachTier(request),
    candidateKey: topCandidate.candidateKey,
    vendorName: topCandidate.name,
    routingDecision: snapshot.decision.actionType,
    reason: reasonCode || snapshot.decision.reasonCode,
    draftMessage: topCandidate.draftMessage,
    quota: {
      limit: snapshot.decision.quotaLimit,
      estimatedAmountHigh: topCandidate.priceEstimate?.amountHigh || 0,
      suggestedQuota: snapshot.decision.suggestedQuota,
      lowestEligibleCost: snapshot.decision.lowestEligibleCost,

    },
    recommendationSnapshotVersion: snapshot.version,
  };



  const amountRequested =
    snapshot.decision.actionType === "request_quota_increase"
      ? snapshot.decision.suggestedQuota
      : Number(topCandidate.priceEstimate?.amountHigh) > 0 ? Number(topCandidate.priceEstimate.amountHigh) : undefined;

  const pendingQuery = ApprovalRequest.findOne({
      requestId: request._id,
      landlordId: request.landlordId,
      type: { $in: ROUTING_APPROVAL_TYPES },
      status: "pending",
    });
  if (session) pendingQuery.session(session);
  const approval = (await pendingQuery) ||
    new ApprovalRequest({
      requestId: request._id,
      landlordId: request.landlordId,
      type: approvalType,
    });

  approval.type = approvalType;
  approval.expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  approval.amountRequested = amountRequested;
  approval.reason = snapshot.decision.managerSummary;
  approval.payload = payload;
  approval.status = "pending";
  approval.decidedAt = undefined;
  if (session) approval.$locals.deferPolicyEffects = true;
  await approval.save(...(session ? [{ session }] : []));

  snapshot.approvalRequest = {
    approvalRequestId: approval._id.toString(),
    type: approval.type,
    status: approval.status,
    candidateKey: topCandidate.candidateKey,
  };
  if (!session) {
    publish(request.landlordId, `request:${request._id}`);
    publish(request.landlordId, "requests");
  }

  return approval;
};

const applyHoldStateToRemainingCandidates = (snapshot, chosenCandidate, chosenState) => {
  const holdReason = `On hold while ${chosenCandidate.name} is the active vendor candidate.`;
  snapshot.candidateLedger = (snapshot.candidateLedger || []).map((candidate) => {
    if (candidate.candidateKey === chosenCandidate.candidateKey) {
      return candidate;
    }

    if (["recommended", "pending", "held"].includes(candidate.state)) {
      return {
        ...candidate,
        state: "held",
        displayGroup: "held",
        holdReason,
      };
    }

    if (candidate.state === chosenState) {
      return {
        ...candidate,
        state: "held",
        displayGroup: "held",
        holdReason,
      };
    }

    return candidate;
  });

  return holdReason;
};

const activateCandidateState = ({
  snapshot,
  candidateKey,
  actorUserId,
  activationType,
  overrideReason = null,
  selectionMethod = null,
  actor = "landlord",
}) => {
  // A manual pick is an approve-contact for a candidate the manager chose
  // themselves -- possibly one the constraints excluded, which needs a reason.
  const manual = selectionMethod === "manual";
  rebuildSnapshotSections(snapshot);
  const activeCandidate = getActiveCandidate(snapshot);
  if (activeCandidate && activeCandidate.candidateKey !== candidateKey) {
    throw createRouteableError(activeCandidateLockMessage(activeCandidate, "Another vendor can't be contacted"));
  }

  const candidate = findSnapshotCandidate({ vendorRecommendationSnapshot: snapshot }, candidateKey);
  if (!candidate) {
    const err = new Error("Recommendation candidate not found");
    err.statusCode = 404;
    throw err;
  }

  if (candidate.state === "held") {
    throw createRouteableError("Held candidates cannot be activated until the active candidate is released.");
  }

  if (candidate.state === "manager_rejected") {
    throw createRouteableError("Rejected candidates cannot be activated.");
  }

  if (
    (activationType === "selected" || manual) &&
    candidate.state === "excluded" &&
    !String(overrideReason || "").trim()
  ) {
    const err = new Error("Override reason is required when assigning an excluded vendor.");
    err.statusCode = 400;
    throw err;
  }

  const holdReason = applyHoldStateToRemainingCandidates(snapshot, candidate, activationType);
  snapshot.candidateLedger = (snapshot.candidateLedger || []).map((entry) => {
    if (entry.candidateKey !== candidate.candidateKey) return entry;

    const nextEntry = {
      ...entry,
      state: activationType,
      displayGroup: "active",
      holdReason: null,
    };

    if (activationType === "approved_for_contact") {
      nextEntry.contactApproval = {
        status: "approved",
        approvedAt: new Date().toISOString(),
        approvedBy: actorUserId,
      };
      nextEntry.managerDecision = {
        status: "approved",
        actedAt: new Date().toISOString(),
        actedBy: actorUserId,
      };
      if (manual) {
        nextEntry.manualSelection = {
          status: "selected",
          selectedAt: new Date().toISOString(),
          selectedBy: actorUserId,
          selectionMethod: "manual",
          overrideReason: overrideReason || null,
          overriddenConstraints: entry.state === "excluded" ? entry.reasonCodes || [] : [],
        };
      }
    }

    if (activationType === "selected") {
      nextEntry.manualSelection = {
        status: "selected",
        selectedAt: new Date().toISOString(),
        selectedBy: actorUserId,
        selectionMethod: selectionMethod || "manual",
        overrideReason: overrideReason || null,
        overriddenConstraints: entry.state === "excluded" ? entry.reasonCodes || [] : [],
      };
      nextEntry.managerDecision = {
        status: "approved",
        actedAt: new Date().toISOString(),
        actedBy: actorUserId,
      };
    }

    return nextEntry;
  });

  snapshot.lastManagerAction = {
    type: actor === "system" ? "policy_approve_contact" : activationType === "selected" || manual ? "manual_select_candidate" : "approve_contact",
    candidateKey,
    at: new Date().toISOString(),
    by: actorUserId,
    holdReason,
  };

  rebuildSnapshotSections(snapshot);
  return candidate;
};

const rejectCandidateState = ({ snapshot, candidateKey, actorUserId }) => {
  const candidate = findSnapshotCandidate({ vendorRecommendationSnapshot: snapshot }, candidateKey);
  if (!candidate) {
    const err = new Error("Recommendation candidate not found");
    err.statusCode = 404;
    throw err;
  }
  if (candidate.state === "held") {
    throw createRouteableError("Held candidates cannot be rejected while another candidate is active.");
  }
  if (ACTIVE_CANDIDATE_STATES.includes(candidate.state)) {
    throw createRouteableError("Active candidates cannot be rejected through this action.");
  }

  snapshot.candidateLedger = (snapshot.candidateLedger || []).map((entry) =>
    entry.candidateKey === candidate.candidateKey
      ? {
          ...entry,
          state: "manager_rejected",
          displayGroup: "excluded",
          managerDecision: {
            status: "rejected",
            actedAt: new Date().toISOString(),
            actedBy: actorUserId,
          },
          humanReadableReasons: [
            ...(entry.humanReadableReasons || []),
            "Rejected by manager",
          ],
        }
      : entry
  );

  snapshot.lastManagerAction = {
    type: "reject_recommendation",
    candidateKey,
    at: new Date().toISOString(),
    by: actorUserId,
  };

  rebuildSnapshotSections(snapshot);
  return candidate;
};

const promoteRequestForApprovedContact = (request, actorUserId) => {
  if (!["pending", "queued"].includes(request.status)) return false;

  request.status = "approved";
  request.timeline.push({
    status: "approved",
    note: "Vendor contact approved by landlord",
    actorRole: "landlord",
    actorId: actorUserId,
  });
  return true;
};

const applyRoutingApprovalDecision = async ({ approval, request, status, actorUserId }) => {
  if (status === "approved" && (!["queued", "approved"].includes(request.status) || request.archivedAt)) {
    throw createRouteableError("This request is no longer waiting for vendor routing.");
  }
  const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
  const candidateKey = approval.payload?.candidateKey;
  if (!snapshot || !candidateKey) {
    request.routingStatus = status === "approved" ? "routed" : "paused";
    await request.save();
    return request;
  }

  if (status === "approved") {
    workflow.assertContactAllowed(request);
    // Approving contact sends an email; with the cap at 0 that is outreach the
    // policy forbids. Thrown before anything is touched, and the caller hands
    // the approval back as pending.
    await assertRoutingSetupReady(request.landlordId);
    await require("../services/billing/billingAccount.service").bookingSnapshot({ landlordId: request.landlordId, request });

    // The fallback approval advanceOutreach raises names the next vendor in
    // line. On snapshots written before that path requeued the ledger, that
    // vendor is still parked in `held` — and activateCandidateState refuses
    // held candidates outright, throwing AFTER the approval was marked decided.
    // Release it first so the decision the manager just made can be applied.
    const parked = findLedgerEntry(snapshot, candidateKey);
    if (parked?.state === "held") {
      parked.state = "recommended";
      parked.displayGroup = "recommended";
      parked.holdReason = null;
    }

    activateCandidateState({
      snapshot,
      candidateKey,
      actorUserId,
      activationType: "approved_for_contact",
    });
    request.routingStatus = "routed";
    promoteRequestForApprovedContact(request, actorUserId);
  } else {
    rejectCandidateState({
      snapshot,
      candidateKey,
      actorUserId,
    });
    request.routingStatus = "paused";
  }

  request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
  request.routingDecision = snapshot.decision?.actionType || request.routingDecision;
  await request.save();

  // "Approve contacting X next?" means contact X. This used to activate the
  // candidate and stop, leaving the manager to find a second button.
  //
  // Non-fatal, and outside the caller's error path on purpose: the decision is
  // applied and saved above, so a failure here must never hand the approval
  // back (the caller re-pends on throw). A failed send shows on the candidate
  // as "approved but not sent", with a Send action.
  if (status === "approved") {
    try {
      const populated = (await loadLandlordRequestForRecommendations(request._id, actorUserId)) || request;
      const entry = findLedgerEntry(populated.vendorRecommendationSnapshot, candidateKey);
      if (entry) {
        const draftMessage =
          String(approval.payload?.draftMessage || "").trim() || draftForCandidate(populated, entry);
        await startActivatedOutreach({ request: populated, candidate: entry, draftMessage, actorUserId });
      }
    } catch (err) {
      console.error("[applyRoutingApprovalDecision] outreach after approval failed", err);
    }
  }
  return request;
};

// ------------- TENANT --------------

// Free pre-screen run before the AI triage chat opens. Decides whether the
// tenant may start a (paid) triage conversation, redirects likely duplicates to
// the existing request, and always lets emergencies through.
exports.precheckRequest = async (req, res) => {
  try {
    const { description, category, override = null, intakeMode = 'routine' } = req.body;
    if (!description || typeof description !== "string" || !description.trim()) {
      return res.status(400).json({
        success: false,
        message: "description is required",
      });
    }
    if (!['routine','safety'].includes(intakeMode)) return res.status(400).json({success:false,code:'invalid_intake_mode',message:'Invalid intake mode.'});
    const allowedOverrides = [null, "duplicate", "emergency"];
    if (!allowedOverrides.includes(override)) {
      return res.status(400).json({ success: false, message: "Invalid override" });
    }

    const tenant = await Tenant.findById(req.user.id).populate("unit");
    if (!tenant) {
      return res.status(404).json({ success: false, message: "Tenant not found" });
    }
    const unitProblem = tenantUnitProblem(tenant);
    if (unitProblem) {
      const { status, ...rest } = unitProblem;
      return res.status(status).json({ success: false, ...rest });
    }

    const result = await precheckIntake({
      tenant,
      description,
      category,
      override,
      intakeMode,
    });

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error("[precheckRequest] error", err);
    return res.status(500).json({
      success: false,
      message: "Server error: Failed to pre-screen request",
    });
  }
};

exports.postNewRequest = async (req, res) => {
  try {
    const {
      issueTitle,
      issueDescription,
      category,
      photos = [],
      evidence = [],
      urgency,
      accessPermission,
      preferredTime,
      source = "form",
      runTriage = true,
      triageSnapshot,
      triageReceipt,
      conversationHistory = [],
      emergencyOverride = false,
      intakeMode = 'routine',
      submissionId,

    } = req.body;

    if (!issueTitle || !issueDescription) {
      return res.status(400).json({
        success: false,
        message: "issueTitle and issueDescription are required",
      });
    }

    const tenant = await Tenant.findById(req.user.id).populate("unit");
    if (!tenant) {
      return res.status(404).json({ success: false, message: "Tenant not found" });
    }
    // Without a live unit the request would carry no unit and no property:
    // unroutable, and invisible under every property. A moved-out tenant, or
    // one whose unit was retired, gets told why instead.
    const unitProblem = tenantUnitProblem(tenant);
    if (unitProblem) {
      const { status, ...rest } = unitProblem;
      return res.status(status).json({ success: false, ...rest });
    }

    if (!['routine', 'safety'].includes(intakeMode)) return res.status(400).json({success:false,code:'invalid_intake_mode',message:'Invalid intake mode.'});
    const submissionDigest = submissionHash({ issueTitle, issueDescription, category, intakeMode, emergencyOverride, source });
    const previousSubmission = await replaySubmission(tenant._id, submissionId, submissionDigest);
    if (previousSubmission) return res.status(200).json({success:true,data:sanitizeTenantRequestPayload(previousSubmission.toObject()),message:'Maintenance request already submitted'});
    const unit = tenant.unit;
    const propertyId = unit?.propertyId;
    const intakeMessages = sanitizeIntakeMessages(conversationHistory);
    const initialSafety = workflow.assessSafety({message:`${issueTitle}. ${issueDescription}`,conversationHistory:intakeMessages,
      tenantReported:intakeMode==='safety'||Boolean(emergencyOverride)});
    if(initialSafety.state==='none') {
      const eligibility = await getEligibility(tenant);
      if(!eligibility.creationEligibility.allowed) return res.status(429).json({success:false,
        code:eligibility.creationEligibility.reasons.includes('open_cap')?'request_open_cap_reached':'request_quota_reached',
        message:'Normal request creation is unavailable at your current limit.',data:eligibility});
    }
    const evidenceAssets = sanitizeEvidenceAssets(evidence);
    // Derive the persisted photo URLs from structured evidence when provided so
    // the legacy `photos` field stays in sync with the captured assets.
    const photoUrls = evidenceAssets.length
      ? evidenceAssets.filter((a) => a.type === "image").map((a) => a.url)
      : Array.isArray(photos)
      ? photos
      : [];

    let ai = null;
    // Only true when triage was actually run server-side this request — never when
    // `ai` is rehydrated from a client-supplied snapshot (which can be forged).
    let triageRanServerSide = false;
    const hasTriageSnapshot =
      triageSnapshot && typeof triageSnapshot === "object" && !Array.isArray(triageSnapshot);
    const triageSnapshotPayload =
      hasTriageSnapshot && triageSnapshot.triage ? triageSnapshot.triage : triageSnapshot;
    const receiptVerified = source === "chat" && hasTriageSnapshot && verifyTriageReceipt({
      receipt: triageReceipt, tenantId: tenant._id, triage: triageSnapshotPayload,
      issueDescription, conversationHistory, photos: photoUrls,
    });

    if (source === "chat" && hasTriageSnapshot) {
      ai = normalizeTriageOutput(
        triageSnapshotPayload,
        issueDescription,
        category || "Other",
        { conversationHistory: intakeMessages, ...(receiptVerified ? { previousTriage: triageSnapshotPayload } : {}) }
      );
    } else if (runTriage) {
      const triageResult = await aiTriage({
        message: `${issueTitle}. ${issueDescription}`,
        category,
        photos: photoUrls,
        context: {
          property: propertyId?.toString(),
          unit: unit?._id?.toString(),
          conversationHistory: intakeMessages,
        },
      });
      ai = triageResult?.triage || null;
      triageRanServerSide = true;
    }

    const resolvedCategory = ai?.category || category || "Other";
    let resolvedUrgency =
      source === "chat" && ai ? ai.urgency : urgency || ai?.urgency || "medium";
    const responsibility = defaultResponsibility(
      resolvedCategory,
      ai?.suggestedResponsibility
    );
    const resolvedVendorTypeNeeded = resolveVendorServiceNeeded({
      suggestedVendorType: ai?.suggestedVendorType,
      category: resolvedCategory,
      message: `${issueTitle}. ${issueDescription}`,
    });
    // Tenant concerns bypass normal limits and require human review. Only
    // deterministic rules confirm a hazard; a model cannot dismiss a concern.
    const claimedEmergency = intakeMode === 'safety' || Boolean(emergencyOverride);
    const serverSafetyGate = evaluateSafetyGate({ message: `${issueTitle}. ${issueDescription}`, conversationHistory: intakeMessages });
    // Model concern can raise human review; its absence can never disprove a tenant report.
    const safetyAssessment = workflow.assessSafety({ message: `${issueTitle}. ${issueDescription}`,
      conversationHistory: intakeMessages, tenantReported: claimedEmergency,
      triage: triageRanServerSide || receiptVerified ? ai || {} : {} });
    const validatedEmergency = safetyAssessment.state !== 'none';
    if (validatedEmergency) resolvedUrgency = 'emergency';
    else if (resolvedUrgency === 'emergency') resolvedUrgency = 'high';
    if (serverSafetyGate.triggered && !ai) {
      // The no-model safety form still carries the same rule-specific guidance.
      ai = normalizeTriageOutput({category:resolvedCategory,urgency:'emergency',severity:5},issueDescription,resolvedCategory,
        {conversationHistory:intakeMessages});
    }
    const duplicateGroupId = null;

    const verifiedEntryPermission = receiptVerified ? triageSnapshotPayload?.access?.permissionToEnter :
      triageRanServerSide ? ai?.access?.permissionToEnter : null;
    const resolvedEntryPermission = typeof accessPermission === "boolean" ? accessPermission :
      typeof verifiedEntryPermission === "boolean" ? verifiedEntryPermission : null;
    if (ai) ai.access = { ...(ai.access || {}), permissionToEnter: resolvedEntryPermission };

    // Canonical structured incident record — built from the resolved triage plus
    // the responsibility/access/evidence the request controller already knows.
    const incidentRecord = ai
      ? buildIncidentRecord({
          triage: {
            ...ai,
            suggestedResponsibility: responsibility,
            access: {
              ...(ai.access || {}),
              permissionToEnter: resolvedEntryPermission,
              preferredTimes: preferredTime
                ? [preferredTime]
                : ai.access?.preferredTimes,
            },
          },
          message: `${issueTitle}. ${issueDescription}`,
          photos: photoUrls,
          evidence: evidenceAssets,
          source,
        })
      : null;

    // Agent-facing routing readiness — what should happen next with the request.
    const routingReadiness = incidentRecord
      ? deriveRoutingReadiness({ incidentRecord, triage: ai })
      : null;
    if (serverSafetyGate.triggered && incidentRecord) {
      incidentRecord.emergency = true;
      incidentRecord.safety = { ...incidentRecord.safety, safetyRisk: true,
        lifeSafetyConcern: serverSafetyGate.lifeSafetyConcern, activeDamage: serverSafetyGate.activeDamage,
        riskType: serverSafetyGate.riskType };
      Object.assign(routingReadiness, { state: "emergency_escalation", blocking: true,
        reason: "A server-detected safety hazard requires immediate manager review." });
    }
    const routingAuthority = triageRanServerSide || receiptVerified ? { digest: routingDigest({
      issueTitle, issueDescription, category: resolvedCategory, urgency: resolvedUrgency,
      vendorTypeNeeded: resolvedVendorTypeNeeded, responsibility, photos: photoUrls, ai, incidentRecord, routingReadiness,
    }) } : undefined;

    const payload = {
      tenantId: tenant._id, landlordId: tenant.landlord, propertyId, unitId: unit._id,
      issueTitle, issueDescription, category: resolvedCategory, urgency: resolvedUrgency,
      photos: photoUrls, accessPermission: resolvedEntryPermission, preferredTime,
      vendorTypeNeeded: resolvedVendorTypeNeeded, routingStatus:'pending', duplicateGroupId,
      ai, incidentRecord, routingReadiness, routingAuthority, safetyAssessment,
      ...(submissionId ? {submissionId,submissionDigest} : {}), workflowAlertPending:true,
      initialRouting:{status:'pending',attempts:0,nextAttemptAt:new Date()}, intakeMessages,responsibility,source,
    };
    payload.intakeFollowUp = workflow.deriveFollowUp({...payload,status:'queued'});
    const admitted = await createAdmittedRequest(payload,{exempt:validatedEmergency});
    const newRequest = admitted.request;
    if (admitted.replayed) return res.status(200).json({success:true,data:sanitizeTenantRequestPayload(newRequest.toObject())});
    if (newRequest.intakeFollowUp?.state==='awaiting_answers') await notifyUser({userId:tenant._id,type:'intake_details_needed',
      title:'Add details to your request',message:'A few essential details will help your property manager review this request.',
      eventKey:`intake_details:${newRequest._id}:1`,metadata:{workOrderId:String(newRequest._id),actionUrl:`/portal/requests/${newRequest._id}`}});
    await logAgentAction({
      requestId: newRequest._id,
      landlordId: newRequest.landlordId,
      actor: "ai_agent",
      actionType: "request_triaged",
      summary: "Request created and triaged",
      input: { issueTitle, issueDescription, category, urgency },
      output: {
        category: resolvedCategory,
        urgency: resolvedUrgency,
        responsibility,
        vendorTypeNeeded: resolvedVendorTypeNeeded,
        triageSource: ai?.source || "none",
        triageVerified: triageRanServerSide || receiptVerified,
        intakeStatus: ai?.intakeStatus,
        routingReadiness: routingReadiness?.state || null,
      },
      metadata: {
        source,
        duplicateGroupId,
        emergencyBypass: validatedEmergency,
        claimedEmergency,
        safetyAssessment: safetyAssessment.state,
        preservedTriageSnapshot: source === "chat" && hasTriageSnapshot,
      },
    });

    // Notify landlord: bell + email, and for an emergency a phone call too.
    // Not awaited, so the tenant's confirmation isn't held up by a call.
    if (tenant.landlord) {
      void alertLandlordOfNewRequest({ request: newRequest, tenant, unitNumber: unit?.unitNumber || null });
    }

    res.status(201).json({
      success: true,
      data: sanitizeTenantRequestPayload(newRequest.toObject ? newRequest.toObject() : newRequest),
      message: "Maintenance request submitted",
    });
    setImmediate(() => processInitialRouting(newRequest._id).catch(() =>
      console.error("[postNewRequest] background routing start failed")));
    return undefined;
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({success:false,code:err.code,message:err.message,...(err.data?{data:err.data}:{})});
    console.error("[postNewRequest] error", {code:err.code||err.name});
    return res.status(500).json({
      success: false,
      message: "Server error: Failed to create request",
    });
  }
};

exports.getAllRequests = async (req, res) => {
  try {
    // The working list hides archived requests; ?archived=1 is the history.
    // `archivedAt: null` also matches requests from before the field existed.
    const archived = req.query?.archived === "1" || req.query?.archived === "true";
    let query = MaintenanceRequest.find({
      tenantId: req.user.id,
      archivedAt: archived ? { $ne: null } : null,
      $nor: [expiredRejectedRequestFilter()],
    }).sort(archived ? { archivedAt: -1, createdAt: -1 } : { createdAt: -1 });
    // The history is grouped by home, so it carries the names to group by.
    if (archived) query = query.populate("propertyId", "name").populate("unitId", "unitNumber");
    const requests = await query.lean();

    return res.json({
      success: true,
      data: requests.map(sanitizeTenantRequestPayload),
      message: requests.length ? "Requests retrieved" : "No requests yet",
    });
  } catch (err) {
    console.error("[getAllRequests] error", err);
    return res.status(500).json({
      success: false,
      message: "Server error: Failed to fetch requests",
    });
  }
};

exports.getRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await MaintenanceRequest.findById(id)
      .populate("unitId", "unitNumber")
      .populate("propertyId", "name address")
      .populate("vendorId", "name phone company")
      .lean();

    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }

    // Access control: tenant owns it, or landlord owns it
    const role = req.user.role;
    const userId = req.user.id;
    const isOwnerTenant = role === "tenant" && request.tenantId.toString() === userId;
    const isOwnerLandlord =
      ["landlord", "property_manager", "admin"].includes(role) &&
      request.landlordId?.toString() === userId;

    if (!isOwnerTenant && !isOwnerLandlord) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    if (isOwnerTenant) {
      return res.json({ success: true, data: sanitizeTenantRequestPayload(request) });
    }

    // Read-path repair, same as getVendorRecommendations. The snapshot's `outreach`
    // blocks are a derived cache on a Mixed field and can be clobbered by a
    // concurrent read-modify-write, so re-derive them from the VendorOutreach rows.
    // This is the surface the landlord request-detail page actually reads, so
    // without it a stale ledger (e.g. a missing quotaCheck) is what they see.
    if (request.vendorRecommendationSnapshot) {
      request.vendorRecommendationSnapshot = await projectOutreachOntoSnapshot(
        cloneSnapshot(request.vendorRecommendationSnapshot),
        request._id
      );
      // Live "send now or at their next opening?" per candidate. Non-fatal: the
      // page works without it, and the click itself decides authoritatively.
      await decorateSendTiming(request.vendorRecommendationSnapshot, request).catch((err) =>
        console.error("[getRequest] send timing failed", err.message)
      );
    }

    // What the page may offer, decided by the same rules the endpoints enforce.
    // A selected vendor only blocks a search while their booking is live; a
    // stale selection is released when the search runs.
    const selectionIsLive = request.selectedVendorId
      ? Boolean(
          await Appointment.exists({ requestId: request._id, status: { $in: LIVE_APPOINTMENT_STATUSES } })
        )
      : false;
    request.outreachSummary = (await loadSummaries([request._id])).get(String(request._id)) || null;
    request.intakeFollowUp = workflow.deriveFollowUp(request);
    request.routingGuidance = buildRoutingGuidance(request, { selectionIsLive });
    request.lifecycleStatus = deriveRequestLifecycleStatus(request, { audience: "landlord" });
    request.appeal = buildAppealState(request);
    // Direct pay: what the landlord owes, or paid, the vendor for this job.
    // Landlord only -- the tenant branch returned above, and a tenant never
    // receives a cost. Best-effort: the page works without it.
    request.directPayment = await loadRequestDirectPayment(request._id)
      .then((payment) => (payment ? { ...payment, amount: payment.amountCents / 100 } : null))
      .catch((err) => {
        console.error("[getRequest] direct payment lookup failed", err.message);
        return null;
      });

    return res.json({ success: true, data: request });
  } catch (err) {
    console.error("[getRequest] error", err);
    return res.status(500).json({
      success: false,
      message: "Server error: Failed to retrieve request",
    });
  }
};

/**
 * Return any escrow held against a request that will never be completed.
 *
 * Idempotent through voidHold's `hold_void:<appointmentId>` key, so calling it
 * twice on the same appointment releases once. Only voids appointments that
 * never reached `completed` — a closed job's hold was already settled by
 * closeJobCompletion or settleManualCompletion, and voiding it again would
 * credit the landlord twice.
 */
async function releaseHoldsForCancelledRequest(request) {
  const appointments = await Appointment.find({
    requestId: request._id,
    status: { $nin: ["completed"] },
  })
    .select("_id")
    .lean();
  if (!appointments.length) return;

  for (const appointment of appointments) {
    const hold = await LedgerEntry.findOne({
      appointmentId: appointment._id,
      type: "hold",
    }).lean();
    if (!hold) continue;

    await voidHold({
      landlordId: request.landlordId,
      appointmentId: appointment._id,
      amountCents: hold.amountCents,
      requestId: request._id,
      memo: `Request ${request.status}`,
    });
  }
}

exports.cancelRequest = async (req, res) => {
  try {
    const request = await MaintenanceRequest.findOne({
      _id: req.params.id,
      tenantId: req.user.id,
    });
    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    if (["completed", "rejected", "cancelled"].includes(request.status)) {
      return res.status(400).json({ success: false, message: `Cannot cancel a ${request.status} request` });
    }
    request.status = "cancelled";
    request.cancelledAt = new Date();
    if (request.initialRouting) request.initialRouting.status = "done";
    request.timeline.push({
      status: "cancelled",
      note: "Cancelled by tenant",
      actorRole: "tenant",
      actorId: req.user.id,
    });
    await request.save();

    await require("../services/vendor/bookingCoordination.service").closeRequestPreparations(request);
    // Escrow must come back. Without this a cancelled job leaves money held
    // against work that will never happen, and `held` drifts permanently away
    // from committedCost.
    await expirePendingRoutingApprovals(request._id, request.landlordId).catch((err) =>
      console.error("[cancelRequest] routing approval cleanup failed", err.message)
    );
    await releaseHoldsForCancelledRequest(request).catch((err) =>
      console.error("[cancelRequest] hold void failed", err.message)
    );

    // The masked channel must come back too, for the same shape of reason the
    // escrow does: a cancelled job that keeps an open ProxySession leaves a
    // live line into this tenant's request thread for a vendor who is no longer
    // coming, and pins a pool number to that vendor indefinitely.
    //
    // closeJobCompletion handles the normal path; this is the one terminal
    // route that never reaches it. (The landlord reject path does not need a
    // hook — it refuses outright once vendor contact has been approved, so no
    // session can exist by then.)
    await closeProxySessionsForRequest({
      requestId: request._id,
      reason: "job_cancelled",
    }).catch((err) => console.error("[cancelRequest] relay close failed", err.message));

    // A send scheduled for the vendor's opening must not go out for a job the
    // tenant just called off. (The release sweep re-checks too; this keeps the
    // vendor from ever being emailed in the window before it runs.)
    await VendorOutreach.updateMany(
      { requestId: request._id, status: "scheduled" },
      { $set: { status: "revoked" }, $unset: { tokenHash: 1 } }
    ).catch((err) => console.error("[cancelRequest] scheduled outreach revoke failed", err.message));

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      // Was `actor: "landlord"` / `request_approved` / "Landlord approved
      // request" — wrong on all three counts for a tenant cancelling their own
      // request, and actively misleading in an audit trail the money path reads.
      actor: "tenant",
      actionType: "request_cancelled",
      summary: "Tenant cancelled the request",
      input: { requestId: request._id.toString() },
      output: { status: request.status, estimatedCost: request.estimatedCost },
    });
    return res.json({ success: true, data: sanitizeTenantRequestPayload(request.toObject ? request.toObject() : request), message: "Request cancelled" });
  } catch (err) {
    console.error("[cancelRequest] error", err);
    return res.status(500).json({ success: false, message: "Server error: Failed to cancel" });
  }
};

exports.deletePendingRequest = async (req, res) => {
  try {
    const request = await MaintenanceRequest.findOne({
      _id: req.params.id,
      tenantId: req.user.id,
    });
    if (!request) {
      return res.status(404).json({ success: false, message: "Request not found" });
    }
    if (deriveRequestLifecycleStatus(request) !== "queued") {
      return res.status(400).json({
        success: false,
        message: "Only queued requests can be deleted. Cancel or contact the landlord for requests already in progress.",
      });
    }

    // The shared cascade, so a deleted request never leaves vendor outreach
    // (live magic links) behind. Deleting does not refund the request's slot
    // of the tenant's daily / weekly limits.
    await deleteRequestsWithCascade([request._id], { label: "deletePendingRequest" });

    return res.json({
      success: true,
      data: { id: request._id.toString(), deleted: true },
      message: "Pending request deleted",
    });
  } catch (err) {
    console.error("[deletePendingRequest] error", err);
    return res.status(500).json({ success: false, message: "Server error: Failed to delete request" });
  }
};

const sendAppealError = (res, err, label) => {
  if (err instanceof AppealError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message });
  }
  console.error(`[${label}] error`, err);
  return res.status(500).json({ success: false, message: "Server error" });
};

exports.appealRequest = async (req, res) => {
  try {
    const request = await submitAppeal({
      requestId: req.params.id,
      tenantId: req.user.id,
      note: req.body?.note,
    });
    return res.json({ success: true, data: sanitizeTenantRequestPayload(request.toObject()), message: "Appeal submitted" });
  } catch (err) {
    return sendAppealError(res, err, "appealRequest");
  }
};

// The tenant's standing against the daily / weekly limits and the unit's
// open-request cap -- the numbers the portal shows before they start a request.
exports.getRequestQuota = async (req, res) => {
  try {
    const tenant = await Tenant.findById(req.user.id).select('unit status').populate('unit').lean();
    if (!tenant) return res.status(404).json({ success: false, message: "Tenant not found" });
    return res.json({success:true,data:await getEligibility(tenant)});
  } catch (err) {
    console.error("[getRequestQuota] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.postComment = async (req, res) => {
  try {
    const { body } = req.body;
    if (!body) return res.status(400).json({ success: false, message: "body is required" });
    const request = await MaintenanceRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    const role = req.user.role;
    const normalizedRole =
      role === "co-tenant" || role === "primary_tenant" ? "tenant" : role;
    const isParticipant =
      (["tenant", "co-tenant", "primary_tenant"].includes(role) &&
        request.tenantId.toString() === req.user.id) ||
      (["landlord", "property_manager", "admin"].includes(role) &&
        request.landlordId?.toString() === req.user.id);
    if (!isParticipant) return res.status(403).json({ success: false, message: "Access denied" });

    request.comments.push({
      authorId: req.user.id,
      authorRole: normalizedRole,
      body,
    });
    const commentSafety = normalizedRole === 'tenant' ? workflow.assessSafety({message:body}) : null;
    if (commentSafety?.state !== 'none' && commentSafety && !CLOSED_REQUEST_STATUSES.includes(request.status)) {
      request.safetyAssessment = {...commentSafety,revision:(request.safetyAssessment?.revision||0)+1};
      request.urgency = 'emergency'; request.agentPaused = true; request.workflowAlertPending = true; request.routingAuthority = null;
    }
    await request.save();
    if (commentSafety?.state !== 'none' && commentSafety && request.workflowAlertPending) {
      void alertLandlordOfNewRequest({request,tenant:{_id:request.tenantId}});
      for (const id of [request.tenantId,request.landlordId]) {publish(id,`request:${request._id}`);publish(id,'requests');}
    }

    // Fan the tenant's message out to the vendor as SMS, if a masked channel is
    // open for this request.
    //
    // AFTER save and deliberately non-fatal: the comment is already in the
    // thread and visible in-app, so a Twilio outage costs the vendor a buzz
    // rather than the tenant their message. Nothing about the response changes
    // on failure, because from the tenant's point of view nothing did.
    //
    // TENANT-AUTHORED ONLY. A landlord's comment does not relay: the landlord
    // holds the vendor's real number already (it is on their own roster), so
    // there is nothing to mask between those two, and billing ourselves to
    // duplicate a conversation they can have directly is not a feature. The
    // masked channel exists for the one pair that must stay anonymous.
    if (normalizedRole === "tenant") {
      try {
        // The tenant's display name is resolved inside the fan-out, not here:
        // userAuth sets req.user = { id, role } and NOTHING else, so a name
        // read off it would be undefined and every vendor would receive
        // "The tenant: ..." forever — silently, since it has a fallback.
        await fanOutTenantMessage({ requestId: request._id, body });
      } catch (err) {
        console.error("[postComment] relay fan-out failed", err.message);
      }
    }

    // Bell the other party. Non-fatal for the same reason as the relay: the
    // message is already in the thread.
    try {
      await notifyThreadMessage({
        request,
        authorId: req.user.id,
        authorRole: normalizedRole === "tenant" ? "tenant" : "landlord",
        body,
      });
    } catch (err) {
      console.error("[postComment] thread notification failed", err.message);
    }

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: normalizedRole === "tenant" ? "tenant" : "landlord",
      actionType: "comment_added",
      summary: "Comment added to request",
      input: { body },
      output: { status: request.status },
    });
    return res.json({ success: true, data: normalizedRole === 'tenant' ? sanitizeTenantRequestPayload(request.toObject ? request.toObject() : request) : request });
  } catch (err) {
    console.error("[postComment] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ------------- LANDLORD --------------

exports.landlordGetRequests = async (req, res) => {
  try {
    const { status, urgency, propertyId, category } = req.query;
    const filter = { landlordId: req.user.id };
    if (status) filter.status = status;
    if (urgency) filter.urgency = urgency;
    if (propertyId) filter.propertyId = propertyId;
    if (category) filter.category = category;
    filter.$nor = [expiredRejectedRequestFilter()];
    // Archived requests live under Property -> Unit history (getLandlordArchive).
    filter.archivedAt = null;

    const requests = await MaintenanceRequest.find(filter)
      .sort({ createdAt: -1 })
      .populate("unitId", "unitNumber")
      .populate("propertyId", "name address")
      .populate("tenantId", "firstName lastName email")
      .populate("vendorId", "name phone company")
      .lean();

    // Reject buttons on the list read this rather than re-deriving the rule.
    const outreachSummaries = await loadSummaries(requests.map(r=>r._id));
    for (const request of requests) {
      request.outreachSummary = outreachSummaries.get(String(request._id)) || null;
      request.intakeFollowUp = workflow.deriveFollowUp(request);
      request.routingGuidance = buildRoutingGuidance(request, { includeRegenerate: false });
      request.lifecycleStatus = deriveRequestLifecycleStatus(request, { audience: "landlord" });
      request.appeal = buildAppealState(request);
    }

    return res.json({ success: true, data: requests });
  } catch (err) {
    console.error("[landlordGetRequests] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const CLOSED_REQUEST_STATUSES = ["rejected", "cancelled", "completed"];

exports.putMarkRequestApproved = async (req, res) => {
  try {
    const { estimatedCost, responsibility } = req.body;
    const request = await MaintenanceRequest.findOne({
      _id: req.params.id,
      landlordId: req.user.id,
    });
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    // A closed request moves only through its own flows (the appeal, a reopen);
    // these generic setters must not resurrect it.
    if (CLOSED_REQUEST_STATUSES.includes(request.status)) {
      return res.status(409).json({
        success: false,
        code: "request_closed",
        message: `A ${request.status} request can't be changed this way.`,
      });
    }

    request.status = "approved";
    if (typeof estimatedCost === "number") request.estimatedCost = estimatedCost;
    if (responsibility) request.responsibility = responsibility;
    request.timeline.push({
      status: "approved",
      note: "Approved by landlord",
      actorRole: "landlord",
      actorId: req.user.id,
    });
    await request.save();
    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "landlord",
      actionType: "request_approved",
      summary: "Request approved by landlord",
      output: { status: request.status },
    });

    notifyUser({
      userId: request.tenantId,
      type: "maintenance_scheduled",
      title: "Your request was approved",
      message: `Your request "${request.issueTitle}" was approved.`,
      metadata: { workOrderId: request._id.toString() },
    });
    return res.json({ success: true, data: request });
  } catch (err) {
    console.error("[approve] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.putMarkRequestRejected = async (req, res) => {
  try {
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ success: false, message: "Rejection reason is required" });
    if (reason.length > 1000) {
      return res.status(400).json({ success: false, message: "Rejection reason must be 1000 characters or fewer" });
    }
    const request = await MaintenanceRequest.findOne({
      _id: req.params.id,
      landlordId: req.user.id,
    });
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (hasEngagedContactCandidate(request.vendorRecommendationSnapshot)) {
      return res.status(409).json({
        success: false,
        code: "request_not_rejectable",
        message: "A request cannot be rejected after vendor contact has been approved.",
      });
    }
    if (!["pending", "queued", "approved"].includes(request.status)) {
      return res.status(409).json({
        success: false,
        code: "request_not_rejectable",
        message: `A ${request.status} request cannot be rejected.`,
      });
    }

    // The request already had its one appeal: this rejection is final.
    if (request.appealUsed) {
      await expirePendingRoutingApprovals(request._id, req.user.id);
      const deleted = await finalizeRejection({
        filter: { _id: request._id, landlordId: req.user.id, status: request.status },
        reason,
        kind: "rejected_after_appeal",
        actorId: req.user.id,
      });
      if (!deleted) {
        return res.status(409).json({
          success: false,
          code: "request_not_rejectable",
          message: "This request changed while you were looking at it. Refresh and try again.",
        });
      }
      return res.json({ success: true, data: { id: String(deleted._id), deleted: true, final: true } });
    }

    request.status = "rejected";
    request.rejectionReason = reason;
    request.rejectedAt = new Date();
    request.routingStatus = "paused";
    request.selectedVendorId = null;
    request.appealWindowExpiresAt = new Date(Date.now() + APPEAL_WINDOW_HOURS * 3600 * 1000);
    request.timeline.push({
      status: "rejected",
      note: `Rejected: ${reason}`,
      actorRole: "landlord",
      actorId: req.user.id,
    });
    if (request.vendorRecommendationSnapshot) {
      const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
      snapshot.lastManagerAction = {
        type: "reject_request",
        at: new Date().toISOString(),
        by: req.user.id,
        reason,
      };
      request.vendorRecommendationSnapshot = snapshot;
    }
    await expirePendingRoutingApprovals(request._id, req.user.id);
    await request.save();
    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "landlord",
      actionType: "request_rejected",
      summary: "Landlord rejected request",
      input: { reason },
      output: { status: request.status, appealWindowExpiresAt: request.appealWindowExpiresAt },
    });

    notifyTenantRejected(request).catch((err) =>
      console.error("[reject] tenant notification failed", err.message)
    );
    return res.json({ success: true, data: request });
  } catch (err) {
    console.error("[reject] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Withdraw a rejection (window still open, no appeal) or accept the tenant's
// appeal. Either way the request goes back to queued with fresh routing.
exports.reopenRejectedRequest = async (req, res) => {
  try {
    const { request, wasAppeal } = await reopenRejectedRequest({
      requestId: req.params.id,
      landlordId: req.user.id,
      actorId: req.user.id,
      note: req.body?.note,
    });
    return res.json({
      success: true,
      data: request,
      message: wasAppeal ? "Appeal accepted. The request is back in the queue." : "Rejection withdrawn.",
    });
  } catch (err) {
    return sendAppealError(res, err, "reopenRejectedRequest");
  }
};

// Decline the tenant's appeal: final. The request is removed for both sides.
exports.declineRequestAppeal = async (req, res) => {
  try {
    const deleted = await declineAppeal({
      requestId: req.params.id,
      landlordId: req.user.id,
      actorId: req.user.id,
      reason: req.body?.reason,
    });
    return res.json({ success: true, data: { id: String(deleted._id), deleted: true, final: true } });
  } catch (err) {
    return sendAppealError(res, err, "declineRequestAppeal");
  }
};

// ------------- PHASE 1: APPROVAL REQUESTS --------------
exports.createApprovalRequest = async (req, res) => {
  try {
    const { requestId, type, expiresAt, amountRequested, reason, payload } = req.body;
    if (type === "other" && (typeof reason !== "string" || !reason.trim() || reason.length > 240)) {
      return res.status(400).json({ success: false, message: "Describe the coordination step being permitted (up to 240 characters)." });
    }
    if (type === "cost_review") return res.status(400).json({ success: false,
      code: "server_owned_review", message: "Cost reviews are created from the current quote or final charges." });
    if (!requestId || !type || !expiresAt) {
      return res.status(400).json({
        success: false,
        message: "requestId, type, and expiresAt are required",
      });
    }
    const request = await MaintenanceRequest.findOne({
      _id: requestId,
      landlordId: req.user.id,
    });
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    const approval = await ApprovalRequest.create({
      landlordId: req.user.id,
      requestId,
      type,
      expiresAt: new Date(expiresAt),
      amountRequested,
      reason,
      payload: type === "other" ? { actionScope: "coordination_step", stepId: "review_coordination", question: reason.trim() } : payload,
    });

    request.routingStatus = "approval_needed";
    await request.save();

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "ai_agent",
      actionType: "approval_requested",
      summary: `Approval requested: ${type}`,
      input: req.body,
      output: { approvalRequestId: approval._id, status: approval.status },
    });

    return res.status(201).json({ success: true, data: approval });
  } catch (err) {
    console.error("[createApprovalRequest] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.listApprovalRequests = async (req, res) => {
  try {
    const { status, requestId } = req.query;
    // A quote approval for a vendor who has since been turned down or has
    // declined is not a decision any more. Non-fatal: worst case the page
    // shows a stale row, which deciding would then refuse.
    await expireOrphanedQuoteApprovals(req.user.id).catch((err) =>
      console.error("[listApprovalRequests] orphan sweep failed", err.message)
    );
    const filter = { landlordId: req.user.id };
    if (status) filter.status = status;
    if (requestId) filter.requestId = requestId;
    const rows = await ApprovalRequest.find(filter).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[listApprovalRequests] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.decideApprovalRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, approvedAmount } = req.body;
    if (!["approved", "rejected", "expired"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }
    const approval = await ApprovalRequest.findOne({ _id: id, landlordId: req.user.id });
    if (!approval) return res.status(404).json({ success: false, message: "Approval request not found" });
    if (approval.status !== "pending") {
      return res.status(400).json({ success: false, message: "Approval request already decided" });
    }
    if (!approval.expiresAt || new Date(approval.expiresAt) <= new Date()) {
      return res.status(409).json({ success: false, code: "approval_expired", message: "This approval has expired. Reload the current decisions." });
    }
    let request = await MaintenanceRequest.findOne({ _id: approval.requestId, landlordId: req.user.id });
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (approval.type === "other" && (Object.hasOwn(req.body, "approvedAmount") || request.archivedAt ||
      ["completed", "rejected", "cancelled"].includes(request.status))) {
      return res.status(409).json({ success: false, code: "step_context_required", message: "Review the current coordination step; it cannot authorize an amount or change a closed request." });
    }
    if (approval.type === "other" && request.status === "queued" &&
      (approval.payload?.actionScope !== "coordination_step" || approval.payload?.stepId !== "review_coordination")) {
      return res.status(409).json({ success: false, code: "step_context_required",
        message: "Open the request to review intake or routing. This older decision does not identify a coordination step." });
    }

    if (approval.type === "cost_review") {
      if (!["approved", "rejected"].includes(status)) return res.status(400).json({ success: false, message: "Choose approve or reject." });
      try { await require("../services/quotes/review.service").validateDecision({ approval, body: req.body, landlordId: req.user.id }); }
      catch (err) { return res.status(err.statusCode || 409).json({ success: false, code: err.code || "stale_cost_review", message: err.message }); }
    }
    if (approval.type === "quota_increase" && approval.payload?.source === "completion_overage") {
      const completion = await JobCompletion.findOne({ _id: approval.payload.completionId, landlordId: req.user.id,
        requestId: request._id }).select("quoteContractVersion report.finalStatement").lean();
      if (!completion) return res.status(409).json({ success: false, code: "completion_changed", message: "This completion is no longer available for this request." });
      try { require("../services/quotes/financialReview.service").validateFinalChargeDecision({ completion, approval, body: req.body }); }
      catch (err) { return res.status(err.statusCode || 409).json({ success: false, code: err.code, message: err.message }); }
    }

    // Vendor-quote preconditions. This block MUST run before the approval is
    // marked decided below: the guard above rejects any retry of a decided
    // approval, so a 400 emitted after that point would strand it permanently
    // — no way to approve it, no way to reject it, no way to re-raise it.
    let vendorQuoteOutreach = null;
    let vendorQuoteCeiling = null;
    if (
      approval.type === "quota_increase" &&
      status === "approved" &&
      approval.payload?.source === "vendor_quote"
    ) {
      vendorQuoteOutreach = await VendorOutreach.findById(approval.payload.outreachId);
      if (!vendorQuoteOutreach || String(vendorQuoteOutreach.landlordId) !== String(req.user.id) ||
          String(vendorQuoteOutreach.requestId) !== String(request._id)) {
        return res.status(409).json({
          success: false,
          code: "outreach_missing",
          message: "The vendor response this approval refers to is no longer available for this request.",
        });
      }

      // Identical semantics to the previous derivation, so approving without an
      // explicit amount still means "approve as requested".
      const requestedAmount = Number(approvedAmount);
      vendorQuoteCeiling =
        Number.isFinite(requestedAmount) && requestedAmount > 0
          ? requestedAmount
          : Number(approval.amountRequested) || 0;

      const current = currentQuote(vendorQuoteOutreach);
      if (vendorQuoteOutreach.quoteContractVersion === 2) {
        if (req.body.expectedQuoteRevision !== current.revision || req.body.expectedQuoteHash !== current.hash ||
            approval.payload.quoteRevision !== current.revision || approval.payload.quoteHash !== current.hash) {
          return res.status(409).json({ success: false, code: "quote_revision_conflict", message: "Review the current itemized quote." });
        }
        try { require("../services/quotes/itemization.service").dollarToMinor(Object.hasOwn(req.body, "approvedAmount") ? req.body.approvedAmount : vendorQuoteCeiling, "approvedAmount"); }
        catch (_) { return res.status(400).json({ success: false, message: "Use a valid amount with at most two decimal places." }); }
      }
      const quoteLow = Number(current.low ?? 0);
      if (vendorQuoteCeiling < quoteLow) {
        return res.status(400).json({
          success: false,
          code: "ceiling_below_vendor_floor",
          message: `${vendorQuoteOutreach.vendorNameSnapshot} will not go below $${quoteLow}. Authorize at least $${quoteLow}, or reject to try another vendor.`,
          data: {
            minimum: quoteLow,
            quotedHigh: Number(current.high ?? 0),
          },
        });
      }
    }

    // Validate routing policy and the named candidate without persisting anything.
    // The execution helper rechecks the same gates after the claim on a fresh row.
    if (status === "approved" && ROUTING_APPROVAL_TYPES.includes(approval.type) &&
        approval.type !== "quota_increase" && approval.payload?.candidateKey) {
      try {
        if (!["queued", "approved"].includes(request.status) || request.archivedAt) throw createRouteableError("This request is no longer waiting for vendor routing.");
        workflow.assertContactAllowed(request);
        await assertRoutingSetupReady(request.landlordId);
        await require("../services/billing/billingAccount.service").bookingSnapshot({ landlordId: request.landlordId, request });
        const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
        if (snapshot) {
          const candidate = findLedgerEntry(snapshot, approval.payload.candidateKey);
          if (candidate?.state === "held") { candidate.state = "recommended"; candidate.displayGroup = "recommended"; candidate.holdReason = null; }
          activateCandidateState({ snapshot, candidateKey: approval.payload.candidateKey, actorUserId: req.user.id, activationType: "approved_for_contact" });
        }
      } catch (err) {
        return res.status(err.statusCode || 409).json({ success: false, code: err.code || "routing_approval_failed", message: err.message || "Could not apply this decision." });
      }
    }
    const decisionClaimToken = randomUUID();
    const decidedAt = new Date();
    const claimed = await ApprovalRequest.findOneAndUpdate({ _id: approval._id, landlordId: req.user.id,
      requestId: approval.requestId, status: "pending", expiresAt: { $gt: decidedAt },
      ...(approval.updatedAt ? { updatedAt: approval.updatedAt } : {}),
    }, { $set: { status, decidedAt, decisionClaimToken } }, { new: true, projection: { _id: 1 } });
    if (!claimed) return res.status(409).json({ success: false, code: "approval_already_decided", message: "This approval was already decided or changed. Reload the current decisions." });
    approval.status = status;
    approval.decidedAt = decidedAt;
    const invalidate = () => { publish(approval.landlordId, "requests"); publish(approval.landlordId, `request:${approval.requestId}`); };
    invalidate();
    const rollback = async () => {
      const restored = await ApprovalRequest.updateOne({ _id: approval._id, landlordId: req.user.id,
        requestId: approval.requestId, status, decisionClaimToken,
      }, { $set: { status: "pending" }, $unset: { decidedAt: 1, decisionClaimToken: 1 } });
      if (restored.modifiedCount) { approval.status = "pending"; approval.decidedAt = undefined; invalidate(); }
      return Boolean(restored.modifiedCount);
    };
    request = await MaintenanceRequest.findOne({ _id: approval.requestId, landlordId: req.user.id });
    if (approval.type === "other" && (!request || request.archivedAt || ["completed", "rejected", "cancelled"].includes(request.status))) {
      await rollback();
      return res.status(409).json({ success: false, code: "step_context_required", message: "The coordination step changed. Reload the request." });
    }
    if (!request && approval.type === "cost_review") {
      await rollback();
      return res.status(409).json({ success: false, code: "review_request_changed", message: "This request changed. Reload its current review." });
    }
    if (request) {
      const isQuotaIncreaseApproval = approval.type === "quota_increase" && status === "approved";
      // A quota increase raised by a vendor's quote must NOT regenerate the
      // recommendation snapshot: regeneration replaces the whole Mixed field,
      // which would wipe the candidate ledger, the approved_for_contact state,
      // and every outreach record attached to it.
      const isVendorQuoteApproval = approval.payload?.source === "vendor_quote";
      // Same trick, different stage of the job: an overage raised AFTER the work
      // is done. It must not re-enter the routing pipeline either.
      const isCompletionOverage = approval.payload?.source === "completion_overage";

      if (approval.type === "cost_review") {
        try { await require("../services/quotes/review.service").applyDecision({ approval, body: req.body,
          landlordId: req.user.id, status }); }
        catch (err) {
          await rollback();
          return res.status(err.statusCode || 409).json({ success: false, code: err.code || "stale_cost_review", message: err.message });
        }
      } else if (isQuotaIncreaseApproval && isVendorQuoteApproval) {
        // Validated above, before the approval was marked decided.
        const newLimit = vendorQuoteCeiling;
        const previousLimit = Number(approval.payload?.quota?.limit) || null;
        const quotedHigh = Number(currentQuote(vendorQuoteOutreach).high ?? 0);

        // At or above the vendor's own ceiling, there is nothing to negotiate:
        // they already said they'd do it for at most that, so book it. Below it,
        // we have no right to impose the lower number — the vendor has to agree.
        if (newLimit >= quotedHigh) {
          request.quotaOverride = newLimit;
          // Keep every consumer of the snapshot agreeing with the override. We
          // skip regeneration here on purpose (it would wipe the ledger), so the
          // decision block has to be corrected in place or it keeps reporting the
          // pre-approval limit.
          if (request.vendorRecommendationSnapshot) {
            request.vendorRecommendationSnapshot = applyQuotaLimitToSnapshot(
              cloneSnapshot(request.vendorRecommendationSnapshot),
              newLimit
            );
          }
          request.quotaSnapshot = {
            limit: newLimit,
            generatedAt: new Date().toISOString(),
          };
          await request.save();

          await logAgentAction({
            requestId: request._id,
            landlordId: request.landlordId,
            actor: "landlord",
            actionType: "quota_change",
            summary: `Quota override applied for vendor quote: $${previousLimit ?? "?"} → $${newLimit}`,
            input: {
              approvalRequestId: approval._id.toString(),
              approvedAmount: approvedAmount ?? null,
              source: "vendor_quote",
            },
            output: { previousLimit, newLimit },
          });

          // Resume the acceptance that was paused pending this decision.
          try {
            await finalizeVendorAcceptance({
              outreachId: approval.payload.outreachId,
              actorUserId: req.user.id,
            });
          } catch (err) {
            console.error("[decideApprovalRequest] finalize after quota approval failed", err);
          }
        } else {
          // quoteLow <= newLimit < quoteHigh. Ask the vendor to accept it.
          //
          // request.quotaOverride is deliberately NOT raised here. It is a
          // standing per-request limit: raising it now would mean that if this
          // vendor declines and advanceOutreach contacts the next one, THEIR
          // quote at this figure books silently with no approval at all. The
          // authorization is recorded on the outreach instead, and promoted to
          // the request only once a vendor has actually committed to it.
          try {
            await raiseCounterOffer({
              request,
              outreach: vendorQuoteOutreach,
              ceiling: newLimit,
              actorUserId: req.user.id,
            });
          } catch (err) {
            console.error("[decideApprovalRequest] counter-offer failed", err);
          }

          // In flight with a vendor and nothing for the manager to do —
          // `approval_needed` would put a phantom task on their dashboard.
          request.routingStatus = "routed";
          await request.save();

          await logAgentAction({
            requestId: request._id,
            landlordId: request.landlordId,
            actor: "landlord",
            actionType: "quota_change",
            summary: `Authorized $${newLimit} for ${vendorQuoteOutreach.vendorNameSnapshot} (quoted up to $${quotedHigh}) — awaiting their confirmation`,
            input: {
              approvalRequestId: approval._id.toString(),
              approvedAmount: approvedAmount ?? null,
              source: "vendor_quote",
              outcome: "counter_offer",
            },
            output: { previousLimit, authorizedCeiling: newLimit, quotedHigh },
          });
        }
      } else if (
        approval.type === "quota_increase" &&
        status === "rejected" &&
        isVendorQuoteApproval
      ) {
        // Manager refused the price: the same dismissal as "Dismiss this
        // quote" -- the response is marked declined, the vendor is told, and
        // routing moves on. It used to only move routing on.
        try {
          const outreach = await VendorOutreach.findById(approval.payload.outreachId);
          if (outreach) {
            await dismissVendorQuote({
              request,
              outreach,
              reason: req.body?.reason,
              actorUserId: req.user.id,
              source: "approval",
            });
          }
        } catch (err) {
          console.error("[decideApprovalRequest] dismissal after quota rejection failed", err);
        }
      } else if (approval.type === "completion_review") {
        // Approving hands the job back to the TENANT rather than paying the
        // vendor: the manager is vouching that the evidence gap is acceptable,
        // not that the work is done. The tenant is still the real signal.
        try {
          // resolveCompletionReview filters on `status: "in_review"` and returns
          // null when it misses. Discarding that reported success for a decision
          // that did nothing — and the approval is already marked decided above,
          // so the manager had no way to raise it again.
          const resolved = await resolveCompletionReview({
            completionId: approval.payload.completionId,
            decision: status === "approved" ? "approved" : "rejected",
            actorUserId: req.user.id,
          });
          if (!resolved) {
            await rollback();
            return res.status(409).json({
              success: false,
              code: "completion_not_in_review",
              message:
                "This completion is no longer awaiting review — it may have been resolved already. Reload the page.",
            });
          }
        } catch (err) {
          console.error("[decideApprovalRequest] completion review failed", err);
        }
      } else if (approval.type === "quota_increase" && isCompletionOverage) {
        // MUST be ordered BEFORE the bare `else if (isQuotaIncreaseApproval)`.
        //
        // A completion overage is TYPED quota_increase (deliberately — it needs
        // no new ApprovalRequest.type enum value), so without this branch it
        // falls through to the generic one below and calls
        // regenerateVendorRecommendationsForRequest, regenerating the vendor
        // snapshot for a job that is already finished. That is exactly the
        // failure the vendor_quote discriminator above was invented to prevent.
        //
        // Note there is no applyQuotaLimitToSnapshot call here either: the
        // snapshot's decision block describes ROUTING, and the routing is over.
        const requestedAmount = Number(approvedAmount);
        const newLimit =
          Number.isFinite(requestedAmount) && requestedAmount > 0
            ? requestedAmount
            : Number(approval.amountRequested) || 0;

        if (status === "approved") {
          // Kept for continuity with the routing quota, but note it is NOT what
          // makes the money move — resolveApprovedCeiling short-circuits on the
          // completion's own ceiling and never reads this. The authorized figure
          // is handed to resolveCompletionOverage below, which records it where
          // the payout can see it.
          request.quotaOverride = newLimit;
          await request.save();
        }

        await logAgentAction({
          requestId: request._id,
          landlordId: request.landlordId,
          actor: "landlord",
          actionType: "completion_overage_decided",
          summary:
            status === "approved"
              ? `Approved the completion overage at $${newLimit}`
              : "Rejected the completion overage — job moved to disputed",
          input: {
            approvalRequestId: approval._id.toString(),
            completionId: approval.payload?.completionId || null,
          },
          output: { decision: status, approvedAmount: newLimit },
        });

        try {
          await resolveCompletionOverage({
            completionId: approval.payload.completionId,
            decision: status === "approved" ? "approved" : "rejected",
            // The figure the manager actually authorized. Without this the
            // amount they typed reached nothing: the invoice, request.finalCost
            // and the Stripe transfer all read report.actualCost, which is
            // written once at submit and never again.
            approvedAmount: status === "approved" ? newLimit : null,
            actorUserId: req.user.id,
          });
        } catch (err) {
          console.error("[decideApprovalRequest] completion overage resolution failed", err);
        }
      } else if (isQuotaIncreaseApproval) {
        // Per-request quota override: the landlord may approve the suggested amount
        // or type their own. Applies only to this request, not the standing policy.
        const requestedAmount = Number(approvedAmount);
        const newLimit =
          Number.isFinite(requestedAmount) && requestedAmount > 0
            ? requestedAmount
            : Number(approval.amountRequested) || 0;
        const previousLimit = Number(approval.payload?.quota?.limit) || null;

        request.quotaOverride = newLimit;
        await request.save();

        await logAgentAction({
          requestId: request._id,
          landlordId: request.landlordId,
          actor: "landlord",
          actionType: "quota_change",
          summary: `Quota override applied: $${previousLimit ?? "?"} → $${newLimit}`,
          input: {
            approvalRequestId: approval._id.toString(),
            approvedAmount: approvedAmount ?? null,
          },
          output: { previousLimit, newLimit },
        });

        // Re-run routing with the override in place so the landlord immediately gets
        // the follow-up decision (e.g. first-time-vendor approval now within quota).
        //
        // A re-run must reproduce the original search, not a narrower one. The
        // search is now always the landlord's own network, so there are no
        // inputs left to inherit; the narrowing check below still guards it.
        const previousSnapshot = request.vendorRecommendationSnapshot || null;
        const previousEligible = getSnapshotEligibleCount(previousSnapshot);
        const populated = await loadLandlordRequestForRecommendations(request._id, req.user.id);
        if (populated) {
          try {
            const nextSnapshot = await regenerateVendorRecommendationsForRequest({
              request: populated,
              landlordId: req.user.id,
              auditInput: { trigger: "quota_increase_approved" },
            });

            // A re-run that finds strictly fewer vendors than the snapshot it just
            // destroyed is the signature of the bug above. Never fail silently on it.
            const nextEligible = getSnapshotEligibleCount(nextSnapshot);
            if (previousEligible > 0 && nextEligible < previousEligible) {
              await logAgentAction({
                requestId: request._id,
                landlordId: request.landlordId,
                actor: "system",
                actionType: "vendor_recommendations_narrowed",
                summary: `Re-run after the quota increase found ${nextEligible} eligible vendors, down from ${previousEligible}`,
                input: { trigger: "quota_increase_approved" },
                output: { previousEligible, nextEligible },
              });
            }
          } catch (err) {
            // The approval is already saved as decided and the override is already
            // applied; a regeneration failure must not 500 that away.
            console.error("[decideApprovalRequest] regeneration after quota approval failed", err);
          }
        }
      } else if (
        ROUTING_APPROVAL_TYPES.includes(approval.type) &&
        approval.payload?.candidateKey
      ) {
        try {
          await applyRoutingApprovalDecision({
            approval,
            request,
            status,
            actorUserId: req.user.id,
          });
        } catch (err) {
          // Same hazard the vendor-quote preconditions above are ordered to
          // avoid: the approval is already saved as decided, and the guard at
          // the top rejects any retry of a decided approval. Failing here
          // without handing it back would leave the manager holding a consumed
          // approval, an unchanged request, and no way to raise either again.
          await rollback();
          return res.status(err.statusCode || 409).json({
            success: false,
            code: err.code || "routing_approval_failed",
            message: err.message || "Could not apply this decision.",
          });
        }
      } else {
        request.routingStatus = status === "approved" ? "routed" : "paused";
        await request.save();
      }
      const decisionAudit = buildApprovalDecisionAudit({ approval, request, status });
      await logAgentAction({
        requestId: request._id,
        landlordId: request.landlordId,
        actor: "landlord",
        ...decisionAudit,
      });
    }

    invalidate();
    return res.json({ success: true, data: approval });
  } catch (err) {
    console.error("[decideApprovalRequest] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ------------- PHASE 1: AGENT LOGS --------------
exports.listAgentActionLogs = async (req, res) => {
  try {
    const { requestId, actor, actionType, limit = 100 } = req.query;
    const filter = { landlordId: req.user.id };
    if (requestId) filter.requestId = requestId;
    if (actor) filter.actor = actor;
    if (actionType) filter.actionType = actionType;

    const rows = await AgentActionLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(Number(limit) || 100, 500))
      .lean();
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[listAgentActionLogs] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ------------- PHASE 1: APPOINTMENTS --------------
exports.createAppointment = async (req, res) => {
  try {
    const { requestId, vendorId, proposedWindows = [], accessNotes } = req.body;
    if (!requestId || !vendorId) {
      return res.status(400).json({ success: false, message: "requestId and vendorId are required" });
    }
    const request = await MaintenanceRequest.findOne({
      _id: requestId,
      landlordId: req.user.id,
    });
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.bookingVersion === 2 || request.initialRouting) return res.status(409).json({ success: false,
      code: "vendor_confirmation_required", message: "Contact the vendor from this request. Their confirmed quote and time are required before booking." });
    // No visit can be booked for a closed request.
    if (CLOSED_REQUEST_STATUSES.includes(request.status)) {
      return res.status(409).json({
        success: false,
        code: "request_closed",
        message: `A ${request.status} request can't be booked.`,
      });
    }

    const vendor = await Vendor.findOne({ _id: vendorId, landlordId: req.user.id });
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found" });

    const serviceBilling = await require("../services/billing/billingAccount.service").bookingSnapshot({ landlordId: req.user.id, request });
    const appointment = await Appointment.create({
      serviceBilling,
      requestId,
      vendorId,
      vendorNameSnapshot: vendor.name,
      tenantId: request.tenantId,
      landlordId: req.user.id,
      proposedWindows,
      accessNotes,
      status: "proposed",
    });

    request.appointmentStatus = "proposed";
    request.selectedVendorId = vendor._id;
    await request.save();

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "ai_agent",
      actionType: "appointment_proposed",
      summary: "Appointment proposed",
      input: req.body,
      output: { appointmentId: appointment._id, status: appointment.status },
    });

    return res.status(201).json({ success: true, data: appointment });
  } catch (err) {
    console.error("[createAppointment] error", err);
    if (err.code?.startsWith("billing_")) return res.status(err.statusCode || 409).json({ success: false, code: err.code, message: err.message });
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* ---------------- Schedule and history ---------------- */

const FINISHED_APPOINTMENT_STATUSES = ["completed", "cancelled", "failed"];
const FINISHED_REQUEST_STATUSES = ["completed", "cancelled", "rejected"];

// A visit belongs on the schedule while both it and its request are live. The
// request check matters on its own: a request closed some other way (a
// landlord's manual "Mark complete", a cancellation) can leave its appointment
// in a non-terminal status, and it must not sit in "Upcoming" forever.
const isLiveScheduleRow = (row) => !FINISHED_REQUEST_STATUSES.includes(row.requestId?.status);

const ARCHIVE_PAGE_SIZE = 50;

// Property -> Unit history: a landlord's archived requests, newest archive
// first, optionally narrowed to one property or one unit. Paginated by a
// (archivedAt, _id) cursor: one sweep archives a whole batch with the SAME
// archivedAt, so a cursor on the timestamp alone would skip the rest of a
// batch that straddles a page boundary.
exports.getLandlordArchive = async (req, res) => {
  try {
    const { propertyId, unitId, before } = req.query;
    const filter = { landlordId: req.user.id, archivedAt: { $ne: null } };
    for (const [key, value] of [["propertyId", propertyId], ["unitId", unitId]]) {
      if (value === undefined || value === "") continue;
      // "none" is the bucket for requests that carry no unit (legacy tenants).
      if (key === "unitId" && value === "none") {
        filter.unitId = null;
        continue;
      }
      if (!mongoose.isValidObjectId(value)) {
        return res.status(400).json({ success: false, message: `Invalid ${key}` });
      }
      filter[key] = value;
    }
    if (before) {
      const [iso, lastId] = String(before).split("_");
      const at = new Date(iso);
      if (Number.isNaN(at.getTime()) || !mongoose.isValidObjectId(lastId)) {
        return res.status(400).json({ success: false, message: "Invalid cursor" });
      }
      filter.$or = [{ archivedAt: { $lt: at } }, { archivedAt: at, _id: { $lt: lastId } }];
    }

    const rows = await MaintenanceRequest.find(filter)
      .select(
        "issueTitle ai.shortTitle category urgency status completedAt cancelledAt archivedAt finalCost propertyId unitId tenantId vendorId createdAt"
      )
      .sort({ archivedAt: -1, _id: -1 })
      .limit(ARCHIVE_PAGE_SIZE + 1)
      .populate("propertyId", "name address")
      .populate("unitId", "unitNumber")
      .populate("tenantId", "firstName lastName")
      .populate("vendorId", "name company")
      .lean();

    const hasMore = rows.length > ARCHIVE_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, ARCHIVE_PAGE_SIZE) : rows;
    return res.json({
      success: true,
      data: page,
      nextCursor: hasMore
        ? `${new Date(page[page.length - 1].archivedAt).toISOString()}_${page[page.length - 1]._id}`
        : null,
    });
  } catch (err) {
    console.error("[getLandlordArchive] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.listAppointments = async (req, res) => {
  try {
    const { requestId, status } = req.query;
    const filter = { landlordId: req.user.id };
    if (requestId) filter.requestId = requestId;
    if (status) filter.status = status;
    // The schedule is what is coming up and what still needs action. Finished
    // visits are hidden here -- never deleted: completions, ledger holds, the
    // vendor hub and the relay all reference them -- and stay readable under
    // the request and the property history. A query about ONE request or an
    // explicit status is a history question, so it is left unfiltered.
    const scheduleView = !requestId && !status;
    if (scheduleView) filter.status = { $nin: FINISHED_APPOINTMENT_STATUSES };
    // Populated: a bare ObjectId list is unusable for a schedule view. The
    // request carries the property and unit, which the calendar labels every
    // visit with ("Maple Court · Unit 4B") — the appointment itself has neither.
    const rows = await Appointment.find(filter)
      .populate("vendorId", "name company phone email")
      .populate({
        path: "requestId",
        select: "issueTitle category urgency ai.shortTitle status propertyId unitId",
        populate: [
          { path: "propertyId", select: "name" },
          { path: "unitId", select: "unitNumber" },
        ],
      })
      .populate("tenantId", "firstName lastName phone")
      .sort({ confirmedStart: 1, createdAt: -1 })
      .lean();
    return res.json({ success: true, data: await require("../services/vendor/bookingPreparation.service")
      .withBookingRevisions(scheduleView ? rows.filter(isLiveScheduleRow) : rows) });
  } catch (err) {
    console.error("[listAppointments] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/* ---------------- Tenant-facing appointment surface ---------------- *
 * The tenant confirms ACCESS at the time the vendor committed to. That is the
 * third leg of "booked" (vendor time + tenant access + quota approval) and the
 * awaiting_tenant -> scheduled transition that completes it.
 * Scoped by tenantId exactly like the other tenant request handlers.        */

exports.listTenantAppointments = async (req, res) => {
  try {
    // Live visits only -- see listAppointments. Visits awaiting the tenant's
    // review (work_verifying / in_review / disputed) are live: they still need
    // the tenant.
    const rows = (
      await Appointment.find({ tenantId: req.user.id, status: { $nin: FINISHED_APPOINTMENT_STATUSES } })
        // `phone` is deliberately NOT selected. Masking is two-directional: a
        // tenant must no more learn the vendor's real number than the vendor
        // learns theirs. They reach each other through the relay instead.
        .populate("vendorId", "name company")
        .populate("requestId", "issueTitle category urgency ai.shortTitle status")
        .sort({ confirmedStart: 1, createdAt: -1 })
        .lean()
    ).filter(isLiveScheduleRow);

    // One query for every completion rather than one per row.
    const completions = await JobCompletion.find({
      appointmentId: { $in: rows.map((row) => row._id) },
    }).lean();
    const completionByAppointment = new Map(
      completions.map((row) => [String(row.appointmentId), row])
    );

    // The tenant never sees vendor pricing, so drop the vendor's quote note —
    // and buildTenantCompletionView keeps actualCost out of the completion too.
    const sanitized = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        vendorContact: await getTenantFacingVendorContact({
          requestId: row.requestId?._id || row.requestId,
          appointmentId: row._id,
        }),
        completion: buildTenantCompletionView(completionByAppointment.get(String(row._id))),
        vendorConfirmation: {
          accepted: Boolean(row.vendorConfirmation?.accepted),
          respondedAt: row.vendorConfirmation?.respondedAt || null,
        },
        // Drives the "Vendor didn't arrive" button. Same rules reportNoShow
        // enforces, so the button never offers what the server would refuse.
        noShowReportableAt: noShowReportableAt(row),
        canReportNoShow:
          row.status === "scheduled" &&
          Boolean(noShowReportableAt(row)) &&
          noShowReportableAt(row) <= new Date() &&
          !completionByAppointment.get(String(row._id))?.checkIn?.at &&
          row.noShowReport?.status !== "reported",
      }))
    );

    return res.json({ success: true, data: await require("../services/vendor/bookingPreparation.service").withBookingRevisions(sanitized) });
  } catch (err) {
    console.error("[listTenantAppointments] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * "Was this actually fixed?" — the tenant's verdict on a submitted completion.
 *
 * The tenant is the real satisfaction signal; everything else (photos, geo,
 * timers) is corroboration. Confirming here releases payment on the next
 * sweeper tick; disputing holds it and pulls the landlord in.
 */
/**
 * Counts behind the tenant sidebar badge.
 *
 * Only work the TENANT owes an answer on:
 *  - `awaiting_tenant` — a vendor committed to a time and access needs confirming.
 *  - `proposed` with no response yet — the first pitch, still unanswered. A
 *    `proposed` appointment the tenant ALREADY declined belongs to the manager,
 *    and respondedAt is the only field that tells the two apart.
 *  - a submitted completion sitting at `awaiting_tenant` — "was this actually
 *    fixed?". Counted off JobCompletion rather than the appointment, because
 *    that status is exactly what needsVerification is derived from in
 *    buildTenantCompletionView.
 */
exports.getTenantBadgeCounts = async (req, res) => {
  try {
    const tenantId = req.user.id;

    const [appointments, completions] = await Promise.all([
      Appointment.countDocuments({
        tenantId,
        $or: [
          { status: "awaiting_tenant" },
          { status: "proposed", "tenantConfirmation.respondedAt": null },
        ],
      }),
      JobCompletion.countDocuments({ tenantId, status: "awaiting_tenant" }),
    ]);

    // A completion always follows the visit, so an appointment can never be
    // counted by both halves at once.
    return res.json({ success: true, data: { schedule: appointments + completions } });
  } catch (err) {
    console.error("[getTenantBadgeCounts]", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.verifyTenantJobCompletion = async (req, res) => {
  try {
    const { resolved, rating, comment } = req.body || {};
    if (typeof resolved !== "boolean") {
      return res.status(400).json({ success: false, message: "resolved must be true or false." });
    }

    let cleanRating = null;
    if (rating !== undefined && rating !== null && String(rating).trim() !== "") {
      cleanRating = Number(rating);
      if (!Number.isInteger(cleanRating) || cleanRating < 1 || cleanRating > 5) {
        return res.status(400).json({ success: false, message: "Rating must be a whole number from 1 to 5." });
      }
    }
    const cleanComment = String(comment || "").trim().slice(0, 500);

    // Scoped by tenantId exactly like every other tenant handler.
    const appointment = await Appointment.findOne({ _id: req.params.id, tenantId: req.user.id });
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }

    const now = new Date();

    // A CONDITIONAL update, not load-mutate-save: the auto-confirm sweeper
    // contends on this exact predicate, so exactly one of {tenant answers,
    // sweeper auto-confirms} can win. Load-mutate-save would let both land.
    const updated = await JobCompletion.findOneAndUpdate(
      { appointmentId: appointment._id, status: "awaiting_tenant" },
      {
        $set: {
          status: resolved ? "confirmed" : "disputed",
          "tenantConfirmation.outcome": resolved ? "confirmed" : "disputed",
          "tenantConfirmation.rating": cleanRating,
          "tenantConfirmation.comment": cleanComment,
          "tenantConfirmation.respondedAt": now,
          "tenantConfirmation.autoConfirmed": false,
          // No trailing window: the tenant has spoken, so there is nothing to
          // reverse. The sweeper picks this up on its next tick.
          ...(resolved ? { payoutReleaseAt: now } : { payoutReleaseAt: null }),
        },
      },
      { new: true }
    );

    if (!updated) {
      // Lost the race, or nothing was awaiting them. Echo what landed rather
      // than erroring, same as the vendor surfaces do.
      const current = await JobCompletion.findOne({ appointmentId: appointment._id });
      return res.status(409).json({
        success: false,
        code: current?.tenantConfirmation?.respondedAt ? "already_answered" : "not_awaiting_review",
        message: current?.tenantConfirmation?.autoConfirmed
          ? "This job was automatically confirmed. Contact your property manager if something is still wrong."
          : "This job is not currently awaiting your review.",
        data: buildTenantCompletionView(current),
      });
    }

    await Appointment.updateOne(
      { _id: appointment._id, status: "work_verifying" },
      { $set: { status: resolved ? "work_verifying" : "disputed" } }
    );

    if (!resolved) {
      await MaintenanceRequest.updateOne(
        { _id: appointment.requestId },
        { $set: { appointmentStatus: "disputed", routingStatus: "approval_needed" } }
      );
      await notifyUser({
        userId: appointment.landlordId,
        type: "maintenance_verification_disputed",
        title: "Tenant says the work isn't done",
        message: cleanComment || "The tenant reported that the job is not resolved.",
        metadata: { workOrderId: appointment.requestId.toString() },
      });
    }

    await logAgentAction({
      requestId: appointment.requestId,
      landlordId: appointment.landlordId,
      actor: "tenant",
      actionType: resolved ? "completion_tenant_confirmed" : "completion_tenant_disputed",
      summary: resolved
        ? `Tenant confirmed the work${cleanRating ? ` (${cleanRating}/5)` : ""}`
        : `Tenant disputed the work: ${cleanComment || "no reason given"}`,
      input: { appointmentId: appointment._id.toString() },
      output: { rating: cleanRating, resolved },
    });

    // Close immediately on confirmation rather than waiting for a tick — the
    // tenant is watching, and closeJobCompletion is idempotent so the sweeper
    // finding it later is harmless.
    if (resolved) {
      try {
        await closeJobCompletion({
          completionId: updated._id,
          reason: "tenant_confirmed",
          actorUserId: req.user.id,
        });
      } catch (err) {
        console.error("[verifyTenantJobCompletion] close failed", err.message);
      }
    }

    const fresh = await JobCompletion.findById(updated._id);
    return res.json({ success: true, data: buildTenantCompletionView(fresh || updated) });
  } catch (err) {
    console.error("[verifyTenantJobCompletion] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// The tenant answering "does this arrival time work?" -- or the manager
// answering for them once the tenant has gone quiet past the deadline. One
// path so the booking email, timeline and audit row are identical either way.
async function applyAppointmentConfirmation({ appointment, accepted, note = "", actorRole, actorId, revision }) {
  if (appointment.bookingVersion === 2) {
    if (!appointment.preparationId) {
      const error = new Error("The vendor must confirm a quote and time before this visit can be booked.");
      error.code = "vendor_confirmation_required"; error.status = 409; throw error;
    }
    const coordination = require("../services/vendor/bookingCoordination.service");
    if (accepted) await coordination.confirmTime({ preparationId: appointment.preparationId, revision,
      actor: actorRole, actorId });
    else await coordination.declineTime({ preparationId: appointment.preparationId, revision, actor: actorRole });
    return Appointment.findById(appointment._id);
  }
  const onBehalf = actorRole === "landlord";
  if (appointment.status === "scheduled") {
    throw Object.assign(new Error("Use a revisioned visit change request. The original confirmed visit remains in place."), { status: 409, code: "confirmed_visit_requires_reschedule" });
  }
  appointment.tenantConfirmation = {
    accepted,
    respondedAt: new Date(),
    note,
    confirmedBy: actorRole,
  };
  // Accepting completes the booking. Declining hands it back for the manager
  // to re-coordinate a new arrival time with the vendor.
  appointment.status = accepted ? "scheduled" : "proposed";
  await appointment.save();

  const request = await MaintenanceRequest.findById(appointment.requestId);
  if (request) {
    request.appointmentStatus = appointment.status;
    if (accepted) {
      request.timeline.push({
        status: "assigned",
        note: onBehalf
          ? "Manager confirmed the appointment time for the tenant"
          : "Tenant confirmed the appointment time",
        actorRole,
        actorId,
      });
    }
    await request.save();

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: actorRole,
      actionType: accepted ? "appointment_tenant_confirmed" : "appointment_tenant_declined",
      summary: accepted
        ? onBehalf
          ? "Manager confirmed the vendor's arrival time on the tenant's behalf — appointment scheduled"
          : "Tenant confirmed the vendor's arrival time — appointment scheduled"
        : `Tenant cannot make the proposed time${note ? `: ${note}` : ""}`,
      input: { appointmentId: appointment._id.toString(), accepted, confirmedBy: actorRole },
      output: { status: appointment.status },
    });
  }

  // NOW the vendor is told, and not before. Their job link only resolves once
  // the appointment is `scheduled` (jobToken.middleware), so telling them at
  // acceptance handed them a dead page and a claim that was not yet true.
  //
  // Non-fatal on purpose: the confirmation is already committed and a mail
  // outage must not roll it back. The send claims `vendorBookingNotifiedAt`
  // itself, so this cannot double-send.
  if (accepted) {
    try {
      await sendVendorBookingConfirmation({ appointmentId: appointment._id });
    } catch (err) {
      console.error("[applyAppointmentConfirmation] vendor booking email failed", err.message);
    }
  }
  return appointment;
}

exports.confirmTenantAppointment = async (req, res) => {
  try {
    const { accepted, note } = req.body || {};
    if (typeof accepted !== "boolean") {
      return res.status(400).json({ success: false, message: "accepted must be true or false." });
    }
    const cleanNote = String(note || "").trim().slice(0, 500);

    const appointment = await Appointment.findOne({
      _id: req.params.id,
      tenantId: req.user.id,
    });
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }
    if (!["awaiting_tenant", "proposed"].includes(appointment.status)) {
      return res.status(409).json({
        success: false,
        code: "appointment_not_confirmable",
        message: `This appointment is ${appointment.status} and no longer needs your confirmation.`,
      });
    }

    // Confirming a time that has already gone would book a visit in the past
    // and fire the vendor's job link at once. Declining is still allowed.
    if (accepted && isArrivalPassed(appointment)) {
      return res.status(409).json({
        success: false,
        code: "arrival_passed",
        message: "That arrival time has already passed. Your property manager will arrange a new visit.",
      });
    }

    const confirmedAppointment = await applyAppointmentConfirmation({
      appointment,
      accepted,
      note: cleanNote,
      actorRole: "tenant",
      actorId: req.user.id,
      revision: req.body?.revision,
    });
    return res.json({ success: true, data: confirmedAppointment });
  } catch (err) {
    console.error("[confirmTenantAppointment] error", err);
    return res.status(err.status || 500).json({ success: false, ...(err.code ? { code: err.code } : {}),
      message: err.status ? err.message : "Server error" });
  }
};

// "The vendor never came." Recorded and sent to the manager; it re-routes
// nothing on its own (appointmentFailure.reportNoShow says why).
exports.reportTenantNoShow = async (req, res) => {
  try {
    const result = await reportNoShow({
      appointmentId: req.params.id,
      tenantId: req.user.id,
      note: req.body?.note,
    });
    if (result.error) {
      const { status, ...body } = result.error;
      return res.status(status).json({ success: false, ...body });
    }
    return res.json({ success: true, data: result.appointment, already: Boolean(result.already) });
  } catch (err) {
    console.error("[reportTenantNoShow] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// The manager resolving a booking that went wrong, from Decisions Needed or
// the request page:
//   confirm_time     -- the tenant went quiet; confirm the time for them
//   reroute          -- cancel this booking and find another vendor
//   dismiss_no_show  -- the vendor did come; clear the tenant's report
//
// reroute picks its reason from the appointment: a booked visit is a no-show,
// one still waiting on the tenant is tenant silence. That decides whether the
// vendor's record takes the hit, so it's derived here, never taken from input.
exports.resolveAppointment = async (req, res) => {
  try {
    const action = req.body?.action;
    const appointment = await Appointment.findOne({ _id: req.params.id, landlordId: req.user.id });
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found" });
    }

    if (action === "confirm_time") {
      if (!["awaiting_tenant", "proposed"].includes(appointment.status)) {
        return res.status(409).json({
          success: false,
          code: "appointment_not_confirmable",
          message: `This visit is ${appointment.status} and doesn't need confirming.`,
        });
      }
      if (isArrivalPassed(appointment)) {
        return res.status(409).json({
          success: false,
          code: "arrival_passed",
          message: "This arrival time has already passed, so it can't be confirmed. Find another vendor instead.",
        });
      }
      const confirmed = await applyAppointmentConfirmation({
        appointment,
        accepted: true,
        note: "",
        actorRole: "landlord",
        actorId: req.user.id,
        revision: req.body?.revision,
      });
      await notifyUser({
        userId: appointment.tenantId,
        type: "appointment_confirmed",
        title: "Your visit is booked",
        message: "Your property manager confirmed the vendor's arrival time for you.",
        metadata: { appointmentId: String(appointment._id), workOrderId: String(appointment.requestId) },
      });
      return res.json({ success: true, data: { action, appointment: confirmed || appointment } });
    }

    if (action === "reroute") {
      const reason = appointment.status === "scheduled" ? "no_show" : "tenant_unconfirmed";
      if (reason === "no_show" && appointment.confirmedStart && new Date(appointment.confirmedStart) > new Date()) {
        return res.status(409).json({
          success: false,
          code: "too_early",
          message: "This visit hasn't happened yet, so it can't be a no-show.",
        });
      }
      const result = await failAppointment({
        appointmentId: appointment._id,
        reason,
        actorRole: "landlord",
        actorId: req.user.id,
      });
      if (!result.failed) {
        return res.status(409).json({
          success: false,
          code: "not_reroutable",
          message: `This visit is ${appointment.status} and can't be re-routed.`,
        });
      }
      return res.json({ success: true, data: { action, reason, appointment: result.appointment } });
    }

    if (action === "dismiss_no_show") {
      const result = await dismissNoShow({ appointmentId: appointment._id, landlordId: req.user.id });
      if (result.error) {
        return res.status(result.error.status).json({ success: false, message: result.error.message });
      }
      return res.json({ success: true, data: { action, appointment: result.appointment } });
    }

    return res.status(400).json({
      success: false,
      message: "action must be confirm_time, reroute or dismiss_no_show.",
    });
  } catch (err) {
    console.error("[resolveAppointment] error", err);
    return res.status(err.status || 500).json({ success: false, code: err.code, message: err.status ? err.message : "Server error" });
  }
};

exports.updateAppointment = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, confirmedStart, confirmedEnd, proposedWindows, accessNotes } = req.body;
    const appointment = await Appointment.findOne({ _id: id, landlordId: req.user.id });
    if (!appointment) return res.status(404).json({ success: false, message: "Appointment not found" });
    if (appointment.bookingVersion === 2) {
      const Preparation = require("../models/BookingPreparation");
      const row = await Preparation.findOne({ appointmentId: appointment._id, active: true });
      if (!row) return res.status(409).json({ success: false, message: "This visit is no longer active." });
      const coordination = require("../services/vendor/bookingCoordination.service");
      if (["cancelled", "failed"].includes(status)) {
        await coordination.closePreparation({ preparationId: row._id, revision: req.body.revision, reason: "manager_cancelled" });
      } else if (confirmedStart || confirmedEnd) {
        await coordination.proposeAlternatives({ preparationId: row._id, revision: req.body.revision, actor: "landlord",
          windows: [{ start: confirmedStart, end: confirmedEnd }] });
      } else if (status || Array.isArray(proposedWindows)) {
        return res.status(409).json({ success: false, code: "coordination_required",
          message: "Use visit coordination to confirm access or propose another time. Completion requires the job proof flow." });
      } else if (typeof accessNotes === "string") {
        await coordination.edit(row._id, req.body.revision, async ({ appointment: current, session }) => {
          current.accessNotes = accessNotes.slice(0, 1000); await current.save({ session });
        }, { allowConfirmedChange: true });
      }
      return res.json({ success: true, data: await Appointment.findById(appointment._id) });
    }

    if (appointment.status === "scheduled" && (confirmedStart || confirmedEnd || status === "proposed" || status === "awaiting_tenant")) {
      return res.status(409).json({ success: false, code: "confirmed_visit_requires_reschedule", message: "This legacy visit cannot change its confirmed time without the revisioned consent flow. The original visit remains in place." });
    }
    if (status) appointment.status = status;
    if (confirmedStart) appointment.confirmedStart = new Date(confirmedStart);
    if (confirmedEnd) appointment.confirmedEnd = new Date(confirmedEnd);
    if (Array.isArray(proposedWindows)) appointment.proposedWindows = proposedWindows;
    if (typeof accessNotes === "string") appointment.accessNotes = accessNotes;
    await appointment.save();

    const request = await MaintenanceRequest.findById(appointment.requestId);
    if (request) {
      request.appointmentStatus = appointment.status;
      // A booking ended here leaves no vendor selected. Left set, the next
      // search was refused with "a selected vendor candidate exists" until
      // releaseStaleVendorSelection caught it; clear it where it happens.
      if (
        FINISHED_APPOINTMENT_STATUSES.includes(appointment.status) &&
        appointment.status !== "completed" &&
        request.selectedVendorId &&
        String(request.selectedVendorId) === String(appointment.vendorId)
      ) {
        request.selectedVendorId = null;
      }
      await request.save();
      await logAgentAction({
        requestId: request._id,
        landlordId: request.landlordId,
        actor: "system",
        actionType: "appointment_updated",
        summary: `Appointment updated to ${appointment.status}`,
        input: req.body,
        output: { appointmentId: appointment._id, status: appointment.status },
      });
    }

    return res.json({ success: true, data: appointment });
  } catch (err) {
    console.error("[updateAppointment] error", err);
    return res.status(err.status || 500).json({ success: false, code: err.code, message: err.status ? err.message : "Server error" });
  }
};

exports.putMarkRequestAssigned = async (req, res) => {
  try {
    const { vendorId, eta, estimatedCost } = req.body;
    if (!vendorId) return res.status(400).json({ success: false, message: "vendorId is required" });

    const request = await MaintenanceRequest.findOne({
      _id: req.params.id,
      landlordId: req.user.id,
    });
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    workflow.assertContactAllowed(request);
    if (request.bookingVersion === 2 || request.initialRouting) return res.status(409).json({ success: false,
      code: "vendor_confirmation_required", message: "Contact the vendor from this request to confirm their quote and time before assignment." });
    // A closed request moves only through its own flows (the appeal, a reopen);
    // these generic setters must not resurrect it.
    if (CLOSED_REQUEST_STATUSES.includes(request.status)) {
      return res.status(409).json({
        success: false,
        code: "request_closed",
        message: `A ${request.status} request can't be changed this way.`,
      });
    }

    const vendor = await Vendor.findOne({ _id: vendorId, landlordId: req.user.id });
    if (!vendor) return res.status(404).json({ success: false, message: "Vendor not found" });

    request.vendorId = vendor._id;
    if (eta) request.eta = new Date(eta);
    if (typeof estimatedCost === "number") request.estimatedCost = estimatedCost;
    await require("../services/billing/billingAccount.service").bookingSnapshot({ landlordId: req.user.id, request });
    request.status = "assigned";
    request.timeline.push({
      status: "assigned",
      note: `Assigned to ${vendor.name}`,
      actorRole: "landlord",
      actorId: req.user.id,
    });
    await request.save();

    notifyUser({
      userId: request.tenantId,
      type: "maintenance_scheduled",
      title: "A vendor has been assigned",
      message: `${vendor.name} has been assigned to "${request.issueTitle}".`,
      metadata: { workOrderId: request._id.toString() },
    });
    return res.json({ success: true, data: request });
  } catch (err) {
    console.error("[assign] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.putMarkInProgress = async (req, res) => {
  try {
    const request = await MaintenanceRequest.findOne({
      _id: req.params.id,
      landlordId: req.user.id,
    });
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.bookingVersion === 2 || request.initialRouting) return res.status(409).json({ success: false, code: "job_workflow_required",
      message: "The vendor starts this visit from their job link after the time is confirmed." });
    // A closed request moves only through its own flows (the appeal, a reopen);
    // these generic setters must not resurrect it.
    if (CLOSED_REQUEST_STATUSES.includes(request.status)) {
      return res.status(409).json({
        success: false,
        code: "request_closed",
        message: `A ${request.status} request can't be changed this way.`,
      });
    }
    request.status = "in_progress";
    request.timeline.push({
      status: "in_progress",
      note: "Work in progress",
      actorRole: "landlord",
      actorId: req.user.id,
    });
    await request.save();
    return res.json({ success: true, data: request });
  } catch (err) {
    console.error("[in_progress] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.putMarkRequestCompleted = async (req, res) => {
  try {
    const { finalCost, notes } = req.body;

    // finalCost is the only figure that counts toward reported spend, so it is
    // validated rather than silently coerced.
    let agreedCost = null;
    if (finalCost !== undefined && finalCost !== null && String(finalCost).trim() !== "") {
      agreedCost = Number(finalCost);
      if (!Number.isFinite(agreedCost) || agreedCost < 0 || agreedCost > 1000000) {
        return res.status(400).json({
          success: false,
          message: "Final cost must be a number between 0 and 1,000,000.",
        });
      }
    }

    const request = await MaintenanceRequest.findOne({
      _id: req.params.id,
      landlordId: req.user.id,
    });
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.bookingVersion === 2 || request.initialRouting) return res.status(409).json({ success: false, code: "job_workflow_required",
      message: "Complete this booked job through vendor proof and tenant confirmation, or its review decision." });

    // Both are terminal refusals of the work: the tenant called it off, or the
    // landlord turned it down. Completing either would resurrect a job that was
    // never meant to happen, record spend against it, and tell the tenant it
    // was done. Refused before anything is touched.
    if (["cancelled", "rejected"].includes(request.status)) {
      return res
        .status(400)
        .json({ success: false, message: `Cannot complete a ${request.status} request` });
    }

    // Reconcile with the vendor-driven completion flow rather than running
    // alongside it. Left untouched, this endpoint becomes a COMPETING truth:
    // the landlord completes at $X, and hours later the sweeper auto-confirms
    // and overwrites finalCost with the vendor's figure.
    //
    // A confirmed completion is delegated to (one close path, one audit trail).
    // Anything still open is voided — the landlord is deliberately overriding.
    const openCompletion = await JobCompletion.findOne({
      requestId: request._id,
      closedAt: null,
      status: { $nin: ["closed", "void"] },
    });

    if (openCompletion) {
      if (openCompletion.status === "confirmed" && agreedCost === null) {
        const result = await closeJobCompletion({
          completionId: openCompletion._id,
          reason: "landlord_override",
          actorUserId: req.user.id,
        });
        if (result?.closed) {
          return res.json({ success: true, data: result.request });
        }
        // Fell through (e.g. an overage is pending): the landlord's explicit
        // action still wins, so carry on and void it below.
      }
      await JobCompletion.updateOne(
        { _id: openCompletion._id, closedAt: null },
        { $set: { status: "void", closeReason: "landlord_override", closedAt: new Date() } }
      );
      await revokeJobToken({ appointmentId: openCompletion.appointmentId }).catch(() => {});
    }

    const previousEstimate = request.estimatedCost ?? null;
    request.status = "completed";
    request.completedAt = new Date();
    if (agreedCost !== null) request.finalCost = agreedCost;
    if (notes) request.completionNotes = notes;
    request.timeline.push({
      status: "completed",
      note: notes || "Marked complete",
      actorRole: "landlord",
      actorId: req.user.id,
    });
    await request.save();

    // The appointment, the escrow hold and the relay channel. Without this the
    // request reads completed while money stays held against it and the
    // vendor's job link still accepts a completion. Pays out agreedCost if the
    // landlord gave one, voids the hold if not — reasoning in the service.
    //
    // Non-fatal for the same reason the ledger step in closeJobCompletion is:
    // the landlord's record is already correct, and reconcileLedger surfaces a gap.
    let settlement = null;
    try {
      settlement = await settleManualCompletion({ request, finalCost: agreedCost });
      if (settlement.workedAppointmentId) {
        request.appointmentStatus = "completed";
        await request.save();
      }
      if (settlement.shortfall) {
        notifyUser({
          userId: request.landlordId,
          type: "payment_overdue",
          title: "Your balance didn't cover this payout",
          message: `"${request.issueTitle}" was completed at $${agreedCost}, more than your available balance. Top up to settle it.`,
          metadata: { workOrderId: request._id.toString(), amount: agreedCost },
        });
      }
    } catch (err) {
      console.error("[complete] settlement failed", err.message);
    }

    // Every other money mutation in the routing pipeline logs one; this didn't.
    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "landlord",
      actionType: "request_completed",
      summary:
        agreedCost !== null
          ? `Request completed at a final cost of $${agreedCost}`
          : "Request completed without a recorded final cost",
      input: { finalCost: agreedCost, notes: notes || null },
      output: {
        previousEstimate,
        finalCost: request.finalCost ?? null,
        settlement: settlement?.outcomes || null,
      },
    });

    notifyUser({
      userId: request.tenantId,
      type: "maintenance_completed",
      title: "Your request was completed",
      message: `"${request.issueTitle}" was marked complete.`,
      metadata: { workOrderId: request._id.toString() },
    });
    return res.json({ success: true, data: request });
  } catch (err) {
    console.error("[complete] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ------------- PHASE 3: VENDOR RECOMMENDATIONS --------------

// Shared routing pass: (re)generate the recommendation snapshot, refresh any
// routing approval, persist the snapshot/decision on the request, and audit it.
// Used by the manual generate endpoint and by the quota-increase approval flow.
const regenerateVendorRecommendationsForRequest = async ({
  request,
  landlordId,
  auditActor = "ai_agent",
  auditInput = {},
}) => {
  const policy =
    (await LandlordPolicy.findOne({ landlordId }).lean()) || {
      landlordId,
      // Unset, like a new policy document: no limit the landlord didn't choose.
      defaultQuota: null,
      maxOutreachAttempts: 3,
      requireApprovalForExternalSearch: true,
      requireApprovalOverQuota: true,
      requireApprovalForFirstTimeVendor: true,
    };

  // Vendors who already closed a round on this request must not come back as a
  // fresh recommendation — a decline removes that vendor as an option for this
  // request. See buildClosedOutreachIndex in vendorRecommendation.service.js.
  const priorOutreach = await VendorOutreach.find({ requestId: request._id })
    .select("candidateKey status attempt sentAt respondedAt createdAt response.declineReason")
    .lean();

  const previousSnapshot = request.vendorRecommendationSnapshot || null;
  const snapshot = await generateVendorRecommendations({
    request,
    property: request.propertyId,
    unit: request.unitId,
    policy,
    priorOutreach,
  });
  // A policy save regenerates on its own now; it must not throw away a draft
  // the manager wrote for a vendor who is still recommended.
  carryOverEditedDrafts(previousSnapshot, snapshot);

  await ensureApprovalRequestForSnapshot({
    request,
    snapshot,
    reasonCode: snapshot.diagnostics?.outcomeCode,
  });

  request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
  request.routingDecision = snapshot.decision.actionType;
  request.routingStatus = mapDecisionToRoutingStatus(snapshot.decision);
  request.quotaSnapshot = {
    limit: snapshot.decision.quotaLimit,
    generatedAt: snapshot.generatedAt,
  };
  await request.save();

  await logAgentAction({
    requestId: request._id,
    landlordId: request.landlordId,
    actor: auditActor,
    actionType: "vendor_recommendations_generated",
    summary: "Vendor recommendations generated",
    input: {
      providerName: snapshot.defaultProvider,
      ...auditInput,
    },
    output: {
      routingDecision: snapshot.decision.actionType,
      topCandidate: snapshot.recommendations[0]?.name || null,
      candidateCount: snapshot.candidateLedger.length,
      excludedCount: snapshot.excludedCandidates.length,
      approvalRequestId: snapshot.approvalRequest?.approvalRequestId || null,
    },
  });

  return snapshot;
};

// What the landlord would notice changing on a request: the decision, why,
// whether it needs their approval, the quota it is measured against, and who
// is recommended in what order. Anything else a regeneration touches (scores,
// timestamps) is not a change worth telling them about.
const routingFingerprint = (snapshot) => {
  const decision = snapshot?.decision || {};
  return JSON.stringify([
    decision.actionType || null,
    decision.reasonCode || null,
    Boolean(decision.approvalRequired),
    decision.quotaLimit ?? null,
    (Array.isArray(snapshot?.recommendations) ? snapshot.recommendations : []).map((c) => c.candidateKey),
  ]);
};

// A policy edit only refreshes relevant unpassed screens on the current plan.
// No new vendor search, candidate rerank, draft replacement or bulk quote flag.
const refreshPolicyCheckpoints = async ({ requestId, landlordId, changedFields }) => {
  const { screenCandidate, affectedCheckpointStages } = require("../services/vendor/routingCheckpoint.service");
  return mongoose.connection.transaction(async session => {
    const request = await loadLandlordRequestForRecommendations(requestId, landlordId, { readOnly: true, session });
    if (!request || !["queued", "approved"].includes(request.status) || request.archivedAt ||
      ["pending", "processing"].includes(request.initialRouting?.status) || request.initialRouting?.cleanupBefore ||
      getRegenerateBlockReason(request)) return { kept: true, engaged: true };
    const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
    const stages = affectedCheckpointStages({ snapshot, request, changedFields });
    if (!stages.length) return { kept: true };
    // This write shares the quote-checkpoint/policy-save fence. A concurrent
    // save retries the transaction rather than mixing two policy revisions.
    const policy = await LandlordPolicy.findOneAndUpdate({ landlordId }, { $inc: { checkpointFence: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true, session, lean: true });
    const candidate = findLedgerEntry(snapshot, snapshot.decision?.candidateKey) || snapshot.recommendations?.[0];
    const before = routingFingerprint(snapshot);
    const screening = screenCandidate({ request, policy, candidate, previousSnapshot: snapshot,
      vendorTypeNeeded: snapshot.requestSnapshot?.vendorTypeNeeded || request.vendorTypeNeeded,
      eligibleCount: snapshot.diagnostics?.contactableCount ?? snapshot.recommendations?.length ?? 0,
      lowestEligibleCost: snapshot.decision?.lowestEligibleCost ?? Number(candidate?.priceEstimate?.amountHigh || 0) });
    snapshot.decision = request.initialRouting ? require("../services/vendor/autopilotPolicy.service").guardAutopilotDecision({
      request, policy, candidate, decision: screening.decision }) : screening.decision;
    snapshot.routingCheckpoints = screening.routingCheckpoints;
    // Retain the plan's identity and every edited draft. Only its outstanding
    // question changes, atomically with the request's decision reference.
    const moved = routingFingerprint(snapshot) !== before;
    const approval = moved ? await ensureApprovalRequestForSnapshot({ request, snapshot, session }) : null;
    request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
    request.routingDecision = snapshot.decision.actionType;
    request.routingStatus = mapDecisionToRoutingStatus(snapshot.decision);
    request.quotaSnapshot = { limit: snapshot.decision.quotaLimit, generatedAt: snapshot.generatedAt };
    await request.save({ session });
    return { moved, needsApproval: Boolean(snapshot.decision.approvalRequired), stages, policyRevision: policy.policyRevision || 0,
      createdApprovalId: approval?.$locals.wasNew ? approval._id : null };
  });
};

// One pass over already-routed requests; quotes/engaged plans retain their own
// checkpoints and are never regenerated by a global setting change.
const reevaluateOnce = async (landlordId, trigger, changedFields) => {
  const result = { changed: new Map(), kept: new Set(), engaged: new Set(), evaluated: 0, setupIncomplete: false };
  const open = await MaintenanceRequest.find({
    landlordId,
    // getRegenerateBlockReason allows only these; anything else would be
    // loaded just to be refused.
    status: { $in: ["queued", "approved"] },
    archivedAt: null,
    // Only requests that were routed under the old policy. One that was never
    // searched stays that way: a policy save must not start routing (and
    // raise approvals) the landlord never asked for.
    vendorRecommendationSnapshot: { $ne: null },
  })
    .select("_id")
    .lean();
  if (!open.length) return result;

  // The same for every request, so checked once. With max vendors at 0 nothing
  // may route; the requests keep what they have.
  try {
    await assertRoutingSetupReady(landlordId);
  } catch {
    result.setupIncomplete = true;
    return result;
  }

  for (const { _id } of open) {
    const id = String(_id);
    try {
      const request = await loadLandlordRequestForRecommendations(_id, landlordId, { readOnly: true });
      if (!request) continue;
      if (["pending", "processing"].includes(request.initialRouting?.status) || request.initialRouting?.cleanupBefore) continue;
      await releaseStaleVendorSelection(request);
      // A vendor contacted, scheduled, selected or next in an outreach loop:
      // that request keeps the plan it is already acting on. Same rule as the
      // manual Regenerate button (routingGuidance.service).
      if (getRegenerateBlockReason(request)) {
        result.kept.add(id);
        result.engaged.add(id);
        continue;
      }
      const outcome = await refreshPolicyCheckpoints({ requestId: _id, landlordId, changedFields });
      if (outcome.kept) { result.kept.add(id); if (outcome.engaged) result.engaged.add(id); continue; }
      result.evaluated += 1;
      if (outcome.moved) {
        result.changed.set(id, outcome.needsApproval);
        if (outcome.createdApprovalId) await ApprovalRequest.notifyCreatedAfterCommit(outcome.createdApprovalId);
        publish(landlordId, `request:${id}`); publish(landlordId, "requests");
        await logAgentAction({ requestId: _id, landlordId, actor: "system", actionType: "policy_checkpoints_refreshed",
          summary: "Updated policy applied to pending routing checkpoints", input: { trigger },
          output: { stages: outcome.stages, policyRevision: outcome.policyRevision, approvalRequired: outcome.needsApproval } });
      }
    } catch (err) {
      console.error("[reevaluateRequestsForPolicy] skipped", id, err.message);
      result.failed = (result.failed || 0) + 1;
    }
  }
  return result;
};

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

async function notifyPolicyReevaluation(landlordId, { changed, kept }) {
  if (!changed.size) return;
  const needApproval = [...changed.values()].filter(Boolean).length;
  const parts = [
    `${plural(changed.size, "open request was", "open requests were")} re-evaluated under your updated policy` +
      (needApproval ? ` (${needApproval} now ${needApproval === 1 ? "needs" : "need"} your approval).` : "."),
  ];
  if (kept.size) {
    parts.push(
      `${plural(kept.size, "request")} kept ${kept.size === 1 ? "its" : "their"} passed checkpoints or current vendor plan.`
    );
  }
  await notifyUser({
    userId: landlordId,
    type: "policy_requests_reevaluated",
    title: "Requests updated for your new policy",
    message: parts.join(" "),
    metadata: { count: changed.size, requestIds: [...changed.keys()].slice(0, 50) },
  });
}

// landlordId -> { rerun, promise }
const policyReevaluations = new Map();

/**
 * Refresh only relevant unpassed checkpoints, then tell the landlord what moved.
 *
 * Called after the policy save responds. Saves that land while a pass is
 * running don't start a second, racing pass over the same snapshots: they set
 * `rerun`, and the running pass goes round once more with the newest policy
 * (every checkpoint refresh re-reads it). One notification covers the lot.
 *
 * Single-process coalescing, like the sweepers' in-memory state; across
 * replicas each request/approval update is transactional with the policy fence.
 */
exports.reevaluateRequestsForPolicy = (landlordId, { trigger = "policy_updated", changedFields = require("../services/vendor/routingCheckpoint.service").ALL_FIELDS } = {}) => {
  const key = String(landlordId);
  const running = policyReevaluations.get(key);
  if (running) {
    running.rerun = true;
    for (const field of changedFields) running.fields.add(field);
    return running.promise;
  }

  const state = { rerun: false, fields: new Set(changedFields), promise: null };
  state.promise = (async () => {
    const changed = new Map();
    let kept = new Set();
    let setupIncomplete = false;
    let failed = 0;
    try {
      do {
        state.rerun = false;
        const fields = [...state.fields]; state.fields.clear();
        const pass = await reevaluateOnce(landlordId, trigger, fields);
        for (const [id, needsApproval] of pass.changed) changed.set(id, needsApproval);
        // A request that picked up a vendor between passes counts as kept.
        kept = pass.kept;
        for (const id of pass.engaged) changed.delete(id);
        for (const id of changed.keys()) kept.delete(id);
        setupIncomplete = pass.setupIncomplete;
        failed += pass.failed || 0;
      } while (state.rerun);
    } finally {
      policyReevaluations.delete(key);
    }
    await notifyPolicyReevaluation(landlordId, { changed, kept });
    return { changed: changed.size, kept: kept.size, setupIncomplete, failed };
  })();
  policyReevaluations.set(key, state);
  return state.promise;
};

exports.generateVendorRecommendations = async (req, res) => {
  try {
    const request = await loadLandlordRequestForRecommendations(req.params.id, req.user.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    // Before the guard, which refuses on selectedVendorId: a selection whose
    // booking is gone must not lock the request out of a fresh search.
    await releaseStaleVendorSelection(request, { actor: "landlord" });
    assertRequestRouteableForRecommendations(request);
    // After the status checks: a closed request should say it is closed, not
    // that the landlord needs a vendor.
    await assertRoutingSetupReady(req.user.id);

    const snapshot = await regenerateVendorRecommendationsForRequest({
      request,
      landlordId: req.user.id,
    });

    return res.json({ success: true, data: snapshot });
  } catch (err) {
    console.error("[generateVendorRecommendations] error", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      code: err.code,
      message: err.message || "Server error",
      setup: err.setup,
    });
  }
};

exports.getVendorRecommendations = async (req, res) => {
  try {
    const request = await loadLandlordRequestForRecommendations(req.params.id, req.user.id, { readOnly: true });
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (!request.vendorRecommendationSnapshot) {
      return res.status(404).json({
        success: false,
        message: "No vendor recommendation snapshot found",
      });
    }

    // The snapshot's `outreach` blocks are a derived cache and can be clobbered
    // by a concurrent read-modify-write on this Mixed field. Re-derive them from
    // the VendorOutreach rows, which are the source of truth.
    const snapshot = await projectOutreachOntoSnapshot(
      cloneSnapshot(request.vendorRecommendationSnapshot),
      request._id
    );
    await decorateSendTiming(snapshot, request).catch((err) =>
      console.error("[getVendorRecommendations] send timing failed", err.message)
    );

    return res.json({ success: true, data: snapshot });
  } catch (err) {
    console.error("[getVendorRecommendations] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// Public shape of an outreach row. Strips the token fields entirely and masks
// the vendor's real address — neither may leave the server.
const sanitizeOutreachForLandlord = (outreach) => ({
  _id: outreach._id,
  candidateKey: outreach.candidateKey,
  vendorName: outreach.vendorNameSnapshot,
  toEmailMasked: maskEmail(outreach.toEmail),
  status: outreach.status,
  tier: outreach.tier,
  attempt: outreach.attempt,
  channel: outreach.channel,
  sentAt: outreach.sentAt || null,
  firstViewedAt: outreach.firstViewedAt || null,
  viewCount: outreach.viewCount || 0,
  respondedAt: outreach.respondedAt || null,
  responseDeadlineAt: outreach.responseDeadlineAt || null,
  expiresAt: outreach.expiresAt || null,
  deliveryProvider: outreach.deliveryProvider || null,
  deliveryError: outreach.deliveryError || null,
  offeredWindows: outreach.offeredWindows || [],
  response: outreach.response?.outcome
    ? {
        outcome: outreach.response.outcome,
        quoteLow: currentQuote(outreach).low,
        quoteHigh: currentQuote(outreach).high,
        quoteCurrency: outreach.response.quoteCurrency || "CAD",
        quoteNotes: outreach.response.quoteNotes || null,
        declineReason: outreach.response.declineReason || null,
        selectedWindow: outreach.response.selectedWindow || null,
        submittedAt: outreach.response.submittedAt || null,
      }
    : null,
  quotaCheck: outreach.quotaCheck?.evaluatedAt ? outreach.quotaCheck : null,
  appointmentId: outreach.appointmentId || null,
  approvalRequestId: outreach.approvalRequestId || null,
  createdAt: outreach.createdAt,
});

exports.listVendorOutreach = async (req, res) => {
  try {
    const request = await MaintenanceRequest.findOne({
      _id: req.params.id,
      landlordId: req.user.id,
    }).select("_id");
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    const rows = await VendorOutreach.find({ requestId: request._id })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, data: rows.map(sanitizeOutreachForLandlord) });
  } catch (err) {
    console.error("[listVendorOutreach] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * Cancel a send that is waiting for the vendor's opening.
 *
 * The row is DELETED, not revoked. It was never sent -- no link, no email, no
 * response clock -- and a `revoked` row reads as a closed round, which would
 * bar this vendor from ever being approved again. The audit log keeps the
 * record. The candidate goes back into the queue untouched, and the request
 * back to awaiting a contact decision.
 */
exports.cancelScheduledOutreach = async (req, res) => {
  try {
    const request = await loadLandlordRequestForRecommendations(req.params.id, req.user.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });

    const removed = await VendorOutreach.findOneAndDelete({
      _id: req.params.outreachId,
      requestId: request._id,
      status: "scheduled",
    });
    if (!removed) {
      return res.status(409).json({
        success: false,
        code: "outreach_not_scheduled",
        message: "That outreach is no longer scheduled — it may already have been sent.",
      });
    }

    const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
    const entry = findLedgerEntry(snapshot, removed.candidateKey);
    if (entry) {
      entry.state = "pending"; // requeue re-deals it by score alongside the rest
      entry.holdReason = null;
      entry.contactApproval = { status: "pending", approvedAt: null, approvedBy: null };
      entry.outreach = { ...(entry.outreach || {}), status: "not_sent", outreachId: null, attempt: 0, scheduledFor: null };
    }
    requeueCandidatesForNextRound(snapshot);
    request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
    request.routingStatus = "pending";
    await request.save();

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "landlord",
      actionType: "vendor_outreach_schedule_cancelled",
      summary: `Manager cancelled the scheduled outreach to ${removed.vendorNameSnapshot}`,
      input: { outreachId: String(removed._id), candidateKey: removed.candidateKey },
      output: { scheduledFor: removed.scheduledFor || null },
    });

    return res.json({ success: true, data: request.vendorRecommendationSnapshot });
  } catch (err) {
    console.error("[cancelScheduledOutreach] error", err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || "Server error" });
  }
};

// Manager turns down a vendor's accepted quote (within quota or over it -- an
// over-quota quote's pending approval is settled too), or moves on from an
// email that couldn't be delivered. Same downstream path as a vendor decline.
exports.dismissVendorResponse = async (req, res) => {
  try {
    const request = await MaintenanceRequest.findOne({
      _id: req.params.id,
      landlordId: req.user.id,
    }).select("_id landlordId status category propertyId");
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    // A finished request has nothing left to route; turning a quote down now
    // would email a vendor about a job that is already done or closed.
    if (["completed", "rejected", "cancelled"].includes(request.status)) {
      return res.status(409).json({
        success: false,
        code: "request_closed",
        message: `This request is ${request.status}, so its quotes can no longer be dismissed.`,
      });
    }

    const outreach = await VendorOutreach.findOne({
      _id: req.params.outreachId,
      requestId: request._id,
    });
    if (!outreach) {
      return res.status(404).json({ success: false, message: "Outreach not found" });
    }
    // A delivery that failed is skippable too. Without this, three failed
    // attempts left the request with no way forward: Resend refused (attempts
    // exhausted), and Regenerate and manual assignment stayed locked behind a
    // vendor still counted as "being contacted". The sweeper never closes a
    // delivery_failed row -- it only expires sent/viewed ones.
    if (outreach.status === "delivery_failed") {
      await VendorOutreach.updateOne({ _id: outreach._id }, { $unset: { tokenHash: 1 } });
      await logAgentAction({
        requestId: request._id,
        landlordId: request.landlordId,
        actor: "landlord",
        actionType: "vendor_outreach_skipped",
        summary: `Manager moved on from ${outreach.vendorNameSnapshot} after the email couldn't be delivered`,
        input: { outreachId: outreach._id.toString(), deliveryError: outreach.deliveryError || null },
        output: { candidateKey: outreach.candidateKey },
      });
      await advanceOutreach({ outreach, reason: "delivery_failed" });
      const saved = await MaintenanceRequest.findById(request._id).select("vendorRecommendationSnapshot");
      return res.json({ success: true, data: saved?.vendorRecommendationSnapshot || null });
    }

    if (outreach.status !== "accepted") {
      return res.status(409).json({
        success: false,
        code: "outreach_not_dismissable",
        message: `Only an accepted vendor response, or an email that couldn't be delivered, can be dismissed (this one is ${outreach.status}).`,
      });
    }
    if (outreach.appointmentId) {
      return res.status(409).json({
        success: false,
        code: "appointment_already_created",
        message: "An appointment has already been created. Cancel the appointment instead.",
      });
    }

    const result = await dismissVendorQuote({
      request,
      outreach,
      reason: req.body?.reason,
      actorUserId: req.user.id,
      source: "dismiss",
    });
    if (!result.dismissed) {
      return res.status(409).json({
        success: false,
        code: "outreach_not_dismissable",
        message: "This response has already been dealt with.",
      });
    }

    const saved = await MaintenanceRequest.findById(request._id).select(
      "vendorRecommendationSnapshot"
    );
    return res.json({ success: true, data: saved?.vendorRecommendationSnapshot || null });
  } catch (err) {
    console.error("[dismissVendorResponse] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.resendVendorOutreach = async (req, res) => {
  try {
    const request = await loadLandlordRequestForRecommendations(req.params.id, req.user.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    workflow.assertContactAllowed(request);

    const candidate = findSnapshotCandidate(request, req.params.vendorId);
    if (!candidate) {
      return res.status(404).json({ success: false, message: "Recommendation candidate not found" });
    }

    const current = await VendorOutreach.findOne({
      requestId: request._id,
      candidateKey: candidate.candidateKey,
    }).sort({ attempt: -1 });

    // No prior attempt: the approval landed but the send never did. Bootstrap
    // attempt 1 rather than refusing — otherwise the request is unrecoverable
    // (see the fall-through note in approveVendorRecommendationContact).
    if (!current) {
      if (!["approved_for_contact", "selected"].includes(candidate.state)) {
        return res.status(409).json({
          success: false,
          code: "contact_not_approved",
          message: "Approve vendor contact before sending outreach.",
        });
      }

      // `selected` with no outreach is a manual pick from before manual
      // assignment contacted the vendor -- the stranded state. Promote it to an
      // approved contact so it joins the normal outreach lifecycle.
      let toContact = candidate;
      if (candidate.state === "selected") {
        const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
        const entry = findLedgerEntry(snapshot, candidate.candidateKey);
        if (entry) {
          entry.state = "approved_for_contact";
          entry.contactApproval = {
            status: "approved",
            approvedAt: new Date().toISOString(),
            approvedBy: req.user.id,
          };
          entry.draftMessage = draftForCandidate(request, entry);
          toContact = entry;
        }
        request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
        request.routingStatus = "routed";
        promoteRequestForApprovedContact(request, req.user.id);
        await request.save();
      }

      const bootstrap = await sendVendorOutreach({
        request,
        candidate: toContact,
        draftMessage: toContact.draftMessage || draftForCandidate(request, toContact),
        actorUserId: req.user.id,
        attempt: 1,
      });

      await logAgentAction({
        requestId: request._id,
        landlordId: request.landlordId,
        actor: "landlord",
        actionType: "vendor_outreach_resent",
        summary: `Manager sent the first outreach to ${candidate.name} after an earlier failure`,
        input: { candidateKey: candidate.candidateKey, bootstrap: true },
        output: { outreachId: bootstrap.outreach._id.toString(), delivered: bootstrap.delivered },
      });

      const savedBootstrap = await MaintenanceRequest.findById(request._id).select(
        "vendorRecommendationSnapshot"
      );
      return res.json({ success: true, data: savedBootstrap?.vendorRecommendationSnapshot || null });
    }

    const RESENDABLE = ["sent", "viewed", "delivery_failed", "expired"];
    if (!RESENDABLE.includes(current.status)) {
      return res.status(409).json({
        success: false,
        code: "outreach_not_resendable",
        message: `Outreach cannot be resent while it is ${current.status}.`,
      });
    }

    if (current.attempt >= MAX_OUTREACH_ATTEMPTS) {
      return res.status(409).json({
        success: false,
        code: "outreach_attempts_exhausted",
        message: `This vendor has already been contacted ${current.attempt} times.`,
      });
    }

    // Retire the previous attempt first so its magic link stops resolving.
    await supersedeOutreach(current);

    const { outreach, delivered } = await sendVendorOutreach({
      request,
      candidate,
      draftMessage: current.messageBody,
      actorUserId: req.user.id,
      attempt: current.attempt + 1,
    });

    await VendorOutreach.updateOne({ _id: current._id }, { $set: { supersededBy: outreach._id } });

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "landlord",
      actionType: "vendor_outreach_resent",
      summary: `Manager resent outreach to ${candidate.name} (attempt ${outreach.attempt})`,
      input: { candidateKey: candidate.candidateKey, previousOutreachId: current._id.toString() },
      output: { outreachId: outreach._id.toString(), delivered },
    });

    const saved = await MaintenanceRequest.findById(request._id).select(
      "vendorRecommendationSnapshot"
    );
    return res.json({ success: true, data: saved?.vendorRecommendationSnapshot || null });
  } catch (err) {
    console.error("[resendVendorOutreach] error", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      code: err.code,
      message: err.message || "Server error",
    });
  }
};

// Undoes an approved_for_contact activation, including the holds it placed on
// every other candidate, and re-deals the queue so the routing panel is usable
// again. The released vendor is retired rather than restored: this only runs
// when they already had a closed round, so they are not a live option.
const releaseCandidateActivation = async (request, candidateKey) => {
  const fresh = await MaintenanceRequest.findById(request._id);
  if (!fresh?.vendorRecommendationSnapshot) return;

  const snapshot = cloneSnapshot(fresh.vendorRecommendationSnapshot);
  const entry = findLedgerEntry(snapshot, candidateKey);
  if (entry) {
    entry.state = "excluded";
    entry.displayGroup = "excluded";
    entry.holdReason = null;
    entry.contactApproval = { status: "pending", approvedAt: null, approvedBy: null };
  }
  requeueCandidatesForNextRound(snapshot);

  fresh.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
  fresh.routingStatus = "approval_needed";
  await fresh.save();
};

// The draft a candidate is contacted with. An excluded candidate the manager
// picks by hand never had one generated (buildExcludedLedgerEntry stores
// null), so build it the same way generation would.
const draftForCandidate = (request, candidate) =>
  String(candidate?.draftMessage || "").trim() ||
  buildVendorMessageDraft({
    request,
    priceEstimate: candidate?.priceEstimate || null,
    trade: request?.vendorRecommendationSnapshot?.requestSnapshot?.vendorTypeNeeded || request?.vendorTypeNeeded,
  });

/**
 * Contact a candidate that has just been activated. Every way into "this
 * vendor should hear about the job" ends here: Approve contact, a manual
 * assignment, and an approved routing decision from Decisions Needed.
 *
 * Manual assignment and the routing decision used to activate the candidate
 * and stop -- the vendor was never contacted, the request read "assigned", and
 * the outreach-loop lock then named that same vendor as "next in line". Nothing
 * could move it.
 *
 * Deliberately non-fatal: the activation is already committed, and a mail
 * outage must not undo it. A failure lands as `delivery_failed` on the
 * candidate, which the UI renders with a Resend action.
 */
const startActivatedOutreach = async ({ request, candidate, draftMessage, actorUserId, actor = "landlord", initialRoutingToken }) => {
  workflow.assertContactAllowed(request);
  await require("../services/billing/billingAccount.service").bookingSnapshot({ landlordId: request.landlordId, request });
  try {
    const result = await sendVendorOutreach({
      request,
      candidate,
      draftMessage,
      actorUserId,
      initialRoutingToken,
      initiation: actorUserId ? 'landlord' : actor === 'system' ? 'policy_auto_start' : 'unknown',
      attempt: 1,
    });
    return {
      sent: !result?.scheduled && result?.delivered !== false,
      scheduled: Boolean(result?.scheduled),
      scheduledFor: result?.outreach?.scheduledFor || null,
    };
  } catch (err) {
    // A duplicate-attempt collision means the activation was never valid: the
    // vendor already has a round on this request. Unlike a mail outage there
    // is nothing to resend and nothing to wait for, so leaving the candidate
    // active would deadlock the request. Put the ledger back.
    if (err.code === "outreach_already_sent") {
      const existing = await VendorOutreach.findOne({ requestId: request._id, candidateKey: candidate.candidateKey })
        .sort({ attempt: -1 });
      if (existing && ["queued", "scheduled", "sent", "viewed", "accepted", "delivery_failed"].includes(existing.status)) {
        return { sent: existing.status === "sent" || existing.status === "viewed",
          scheduled: existing.status === "scheduled", scheduledFor: existing.scheduledFor || null };
      }
      await releaseCandidateActivation(request, candidate.candidateKey);
    }
    console.error("[startActivatedOutreach] outreach send failed", err);

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor,
      actionType: "vendor_outreach_send_failed",
      summary: `Outreach to ${candidate.name} could not be started: ${err.message}`,
      input: { candidateKey: candidate.candidateKey },
      output: { code: err.code || null },
    });
    return { sent: false, scheduled: false, code: err.code || "outreach_failed", message: err.message };
  }
};

// Shared refusal for re-contacting a vendor who already has a round on this
// request. A closed round cannot be reopened by approving again: the send
// would collide with the unique index on { requestId, candidateKey, attempt }.
const priorOutreachRefusal = async (request, candidate) => {
  const prior = await VendorOutreach.findOne({
    requestId: request._id,
    candidateKey: candidate.candidateKey,
  })
    .sort({ attempt: -1 })
    .select("status response.declineReason scheduledFor");
  if (!prior) return null;

  if (CLOSED_OUTREACH_STATUSES.includes(prior.status)) {
    return {
      code: "vendor_outreach_closed",
      message:
        prior.status === "declined"
          ? `${candidate.name} already declined this request${
              prior.response?.declineReason ? ` (${prior.response.declineReason})` : ""
            }. Approve the next vendor in line instead.`
          : `Outreach to ${candidate.name} already closed as ${prior.status}. Resend it to try them again, or approve the next vendor.`,
    };
  }
  return {
    code: "contact_already_approved",
    message: `${candidate.name} has already been contacted for this request.`,
  };
};

exports.approveVendorRecommendationContact = async (req, res) => {
  try {
    const request = await loadLandlordRequestForRecommendations(req.params.id, req.user.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    workflow.assertContactAllowed(request);
    if (!["queued", "approved"].includes(request.status) || request.archivedAt) {
      throw createRouteableError("This request is no longer waiting for vendor routing.");
    }
    if (!request.vendorRecommendationSnapshot) {
      return res.status(404).json({ success: false, message: "Recommendation snapshot not found" });
    }

    const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
    const candidateBeforeApproval = findSnapshotCandidate(
      { vendorRecommendationSnapshot: snapshot },
      req.params.vendorId
    );
    if (!candidateBeforeApproval) {
      return res.status(404).json({ success: false, message: "Recommendation candidate not found" });
    }
    // The guard that matters is "has outreach already gone out?", not "is the
    // candidate already approved". Approval and sending are separate steps, and
    // a send can fail after the approval commits (mail outage, missing address).
    // Refusing here on state alone strands the request: approve returns 409,
    // resend has nothing to resend, and regeneration is blocked by the active
    // candidate. So the question is asked of the outreach record, whatever the
    // candidate's state says -- which is also what lets a candidate stranded in
    // the old `selected` state (a manual pick that was never contacted) through.
    const refusal = await priorOutreachRefusal(request, candidateBeforeApproval);
    if (refusal) {
      return res.status(409).json({ success: false, ...refusal });
    }
    await assertRoutingSetupReady(req.user.id);
    await require("../services/billing/billingAccount.service").bookingSnapshot({ landlordId: req.user.id, request });
    const submittedDraft =
      typeof req.body?.draftMessage === "string" ? req.body.draftMessage.trim() : "";
    const finalDraft = submittedDraft || String(candidateBeforeApproval.draftMessage || "").trim();
    if (!finalDraft) {
      return res.status(400).json({ success: false, message: "draftMessage is required before approving contact" });
    }
    if (finalDraft.length > 4000) {
      return res.status(400).json({ success: false, message: "draftMessage must be 4000 characters or fewer" });
    }
    const draftEdited =
      Boolean(submittedDraft) && submittedDraft !== String(candidateBeforeApproval.draftMessage || "").trim();
    candidateBeforeApproval.draftMessage = finalDraft;

    const candidate = activateCandidateState({
      snapshot,
      candidateKey: req.params.vendorId,
      actorUserId: req.user.id,
      activationType: "approved_for_contact",
    });

    // A manager can pick a different recommendation. The prepared approval
    // for the original pick must not survive and resurface after the round.
    if (snapshot.approvalRequest?.status === "pending" && snapshot.approvalRequest.candidateKey !== candidate.candidateKey) {
      await expirePendingRoutingApprovals(request._id, request.landlordId);
      snapshot.approvalRequest = null;
    }

    const approvalType = buildApprovalTypeForDecision(snapshot.decision?.actionType);
    if (approvalType) {
      const approval = await ApprovalRequest.findOne({
        requestId: request._id,
        landlordId: req.user.id,
        type: approvalType,
        status: "pending",
        "payload.candidateKey": candidate.candidateKey,
      });
      if (approval) {
        approval.status = "approved";
        approval.decidedAt = new Date();
        await approval.save();
        snapshot.approvalRequest = {
          approvalRequestId: approval._id.toString(),
          type: approval.type,
          status: approval.status,
          candidateKey: candidate.candidateKey,
        };
      }
    }

    request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
    request.routingStatus = "routed";
    request.routingDecision = snapshot.decision?.actionType || "request_vendor_contact_approval";
    promoteRequestForApprovedContact(request, req.user.id);
    await request.save();

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "landlord",
      actionType: "vendor_contact_approved",
      summary: `Manager approved vendor contact for ${candidate.name}`,
      input: { candidateKey: candidate.candidateKey, draftEdited },
      output: {
        providerName: candidate.providerName,
        providerVendorId: candidate.providerVendorId,
        source: candidate.candidateSource,
        draftLength: finalDraft.length,
      },
    });

    const outreach = await startActivatedOutreach({
      request,
      candidate,
      draftMessage: finalDraft,
      actorUserId: req.user.id,
      actor: "system",
    });

    // Re-read so the response carries the outreach state the send just wrote.
    const saved = await MaintenanceRequest.findById(request._id).select(
      "vendorRecommendationSnapshot"
    );
    const responseSnapshot = saved?.vendorRecommendationSnapshot || snapshot;

    return res.json({ success: true, data: responseSnapshot, outreach });
  } catch (err) {
    console.error("[approveVendorRecommendationContact] error", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      code: err.code,
      message: err.message || "Server error",
      setup: err.setup,
    });
  }
};

exports.updateVendorRecommendationDraft = async (req, res) => {
  try {
    const request = await loadLandlordRequestForRecommendations(req.params.id, req.user.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (!request.vendorRecommendationSnapshot) {
      return res.status(404).json({ success: false, message: "Recommendation snapshot not found" });
    }
    if (!req.body?.draftMessage || !String(req.body.draftMessage).trim()) {
      return res.status(400).json({ success: false, message: "draftMessage is required" });
    }

    const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
    const candidate = findSnapshotCandidate({ vendorRecommendationSnapshot: snapshot }, req.params.vendorId);
    if (!candidate) {
      return res.status(404).json({ success: false, message: "Recommendation candidate not found" });
    }

    candidate.draftMessage = String(req.body.draftMessage).trim();
    // Marks the draft as the manager's words, so a regeneration keeps it
    // (carryOverEditedDrafts).
    candidate.draftEditedAt = new Date().toISOString();
    snapshot.lastManagerAction = {
      type: "edit_draft",
      candidateKey: candidate.candidateKey,
      at: new Date().toISOString(),
      by: req.user.id,
    };
    request.vendorRecommendationSnapshot = snapshot;
    await request.save();

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "landlord",
      actionType: "vendor_draft_updated",
      summary: `Manager updated draft for ${candidate.name}`,
      input: { candidateKey: candidate.candidateKey },
      output: { providerName: candidate.providerName },
    });

    return res.json({ success: true, data: snapshot });
  } catch (err) {
    console.error("[updateVendorRecommendationDraft] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.rejectVendorRecommendation = async (req, res) => {
  try {
    const request = await loadLandlordRequestForRecommendations(req.params.id, req.user.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (!request.vendorRecommendationSnapshot) {
      return res.status(404).json({ success: false, message: "Recommendation snapshot not found" });
    }

    const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
    const candidate = rejectCandidateState({
      snapshot,
      candidateKey: req.params.vendorId,
      actorUserId: req.user.id,
    });

    const approval = await ApprovalRequest.findOne({
      requestId: request._id,
      landlordId: req.user.id,
      type: { $in: ROUTING_APPROVAL_TYPES },
      status: "pending",
      "payload.candidateKey": candidate.candidateKey,
    });
    if (approval) {
      approval.status = "rejected";
      approval.decidedAt = new Date();
      await approval.save();
      snapshot.approvalRequest = {
        approvalRequestId: approval._id.toString(),
        type: approval.type,
        status: approval.status,
        candidateKey: candidate.candidateKey,
      };
    }

    request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
    request.routingStatus = "paused";
    await request.save();

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "landlord",
      actionType: "vendor_recommendation_rejected",
      summary: `Manager rejected recommendation for ${candidate.name}`,
      input: { candidateKey: candidate.candidateKey },
      output: { providerName: candidate.providerName },
    });

    return res.json({ success: true, data: snapshot });
  } catch (err) {
    console.error("[rejectVendorRecommendation] error", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      code: err.code,
      message: err.message || "Server error",
    });
  }
};

exports.markManualVendorAssignmentRequired = async (req, res) => {
  try {
    const request = await loadLandlordRequestForRecommendations(req.params.id, req.user.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    workflow.assertContactAllowed(request);
    if (!["queued", "approved"].includes(request.status) || request.archivedAt) {
      throw createRouteableError("This request is no longer waiting for vendor routing.");
    }
    if (!request.vendorRecommendationSnapshot) {
      return res.status(404).json({ success: false, message: "Recommendation snapshot not found" });
    }
    // A terminal request (rejected/cancelled/completed) must not be revived by
    // manually selecting a vendor — block the bypass server-side.
    if (["completed", "rejected", "cancelled"].includes(request.status)) {
      return res.status(409).json({
        success: false,
        code: REQUEST_ROUTEABLE_ERROR_CODE,
        message: `Vendor assignment is not allowed for ${request.status} requests.`,
      });
    }

    const { candidateKey, overrideReason } = req.body || {};
    if (!candidateKey) {
      return res.status(400).json({ success: false, message: "candidateKey is required" });
    }

    // A manual assignment IS an approve-contact, for a vendor the manager chose
    // themselves. It used to stop at marking the candidate `selected`: nobody
    // contacted the vendor, the timeline claimed "assigned", and the outreach
    // lock then named that same vendor as next in line -- a request nothing
    // could move. Now it contacts them through the same path as Approve contact
    // (scheduling, SLA, the decline/advance loop all included).
    const target = findSnapshotCandidate(request, candidateKey);
    if (!target) {
      return res.status(404).json({ success: false, message: "Recommendation candidate not found" });
    }
    const refusal = await priorOutreachRefusal(request, target);
    if (refusal) {
      return res.status(409).json({ success: false, ...refusal });
    }
    await assertRoutingSetupReady(req.user.id);
    await require("../services/billing/billingAccount.service").bookingSnapshot({ landlordId: req.user.id, request });

    const snapshot = cloneSnapshot(request.vendorRecommendationSnapshot);
    const wasExcluded = target.state === "excluded";
    const candidate = activateCandidateState({
      snapshot,
      candidateKey,
      actorUserId: req.user.id,
      activationType: "approved_for_contact",
      overrideReason,
      selectionMethod: "manual",
    });

    snapshot.manualAssignment = {
      status: "contacted",
      notedAt: new Date().toISOString(),
      notedBy: req.user.id,
      selectedCandidateKey: candidate.candidateKey,
      overrideReason: overrideReason || null,
      overriddenConstraints: wasExcluded ? candidate.reasonCodes || [] : [],
    };

    // Any outstanding routing approval is moot once the manager has chosen.
    await expirePendingRoutingApprovals(request._id, req.user.id);
    snapshot.approvalRequest = null;

    const draftMessage = draftForCandidate(request, candidate);
    const ledgerEntry = findLedgerEntry(snapshot, candidate.candidateKey);
    if (ledgerEntry) ledgerEntry.draftMessage = draftMessage;

    request.vendorRecommendationSnapshot = rebuildSnapshotSections(snapshot);
    // Must be a VENDOR_RECOMMENDATION_DECISIONS value or the save throws. The
    // manual pick itself is recorded on snapshot.manualAssignment.
    request.routingDecision = "manual_vendor_assignment_required";
    request.routingStatus = "routed";
    promoteRequestForApprovedContact(request, req.user.id);
    await request.save();

    const outreach = await startActivatedOutreach({
      request,
      candidate: ledgerEntry || candidate,
      draftMessage,
      actorUserId: req.user.id,
    });

    await logAgentAction({
      requestId: request._id,
      landlordId: request.landlordId,
      actor: "landlord",
      actionType: "manual_vendor_selected",
      summary: outreach.scheduled
        ? `Manager manually selected ${candidate.name}; outreach scheduled for their next opening`
        : outreach.sent
          ? `Manager manually selected ${candidate.name}; outreach sent`
          : `Manager manually selected ${candidate.name}; outreach could not be sent (${outreach.message})`,
      input: req.body,
      output: {
        candidateKey: candidate.candidateKey,
        overrideReason: overrideReason || null,
        outreach,
      },
    });

    const saved = await MaintenanceRequest.findById(request._id).select("vendorRecommendationSnapshot");
    return res.json({ success: true, data: saved?.vendorRecommendationSnapshot || snapshot, outreach });
  } catch (err) {
    console.error("[markManualVendorAssignmentRequired] error", err);
    return res.status(err.statusCode || 500).json({
      success: false,
      code: err.code,
      message: err.message || "Server error",
      setup: err.setup,
    });
  }
};

// Exported for tests.
exports.releaseStaleVendorSelection = releaseStaleVendorSelection;
// Internal shared state transitions for the durable intake worker.
exports.ensureApprovalRequestForSnapshot = ensureApprovalRequestForSnapshot;
exports.activateCandidateState = activateCandidateState;
exports.startActivatedOutreach = startActivatedOutreach;

exports.sanitizeTenantRequestPayload = sanitizeTenantRequestPayload;
