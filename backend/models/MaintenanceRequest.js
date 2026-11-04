const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const STATUS_ENUM = [
  "pending",
  "queued",
  "approved",
  "assigned",
  "in_progress",
  "completed",
  "rejected",
  "cancelled",
];

const URGENCY_ENUM = ["low", "medium", "high", "emergency"];

const RESPONSIBILITY_ENUM = [
  "landlord",
  "tenant",
  "shared",
  "insurance",
  "unknown",
];

const StatusEventSchema = new Schema(
  {
    status: { type: String, enum: STATUS_ENUM, required: true },
    note: { type: String },
    actorRole: { type: String },
    actorId: { type: Schema.Types.ObjectId },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const CommentSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, required: true },
    authorRole: {
      type: String,
      enum: ["tenant", "landlord", "vendor", "system"],
      required: true,
    },
    body: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AITriageSchema = new Schema(
  {
    summary: { type: String },
    shortTitle: { type: String },
    additionalNotes: { type: String, default: "" },
    subcategory: { type: String, default: null },
    impact: { type: String, default: "" },
    location: { room: { type: String, default: "" }, area: { type: String, default: "" } },
    timeline: { started: { type: String, default: "" }, trend: { type: String, default: "Unknown" } },
    attemptedFixes: { type: [String], default: [] },
    access: {
      permissionToEnter: { type: Boolean, default: null }, pets: { type: Boolean, default: null },
      preferredTimes: { type: [String], default: [] },
    },
    safety: {
      safetyRisk: { type: Boolean, default: null }, riskType: { type: String, default: null },
      activeDamage: { type: Boolean, default: null }, lifeSafetyConcern: { type: Boolean, default: null },
    },
    costTier: { type: String, default: "Unknown" },
    resolved: { type: Boolean, default: false },
    safetyGate: { type: Schema.Types.Mixed },
    troubleshootingState: { type: [{ _id: false, stepId: String, state: { type: String, enum: ["attempted", "unsuccessful", "declined", "irrelevant"] } }], default: [] },
    intakeState: {
      type: new Schema({
        version: { type: Number, default: 1 }, askedIds: { type: [String], default: [] },
        answers: { type: [{ _id: false, topicId: String, state: { type: String, enum: ["answered", "unknown", "declined"] } }], default: [] },
        selectedQuestion: { type: new Schema({ id: String, topicId: String, question: String }, { _id: false }), default: null },
        followUpCount: { type: Number, default: 0 }, needsManagerReview: { type: Boolean, default: false },
      }, { _id: false }),
      default: () => ({}),
    },
    category: { type: String },
    urgency: { type: String, enum: URGENCY_ENUM },
    severity: { type: Number, min: 1, max: 5 },
    suggestedResponsibility: { type: String, enum: RESPONSIBILITY_ENUM },
    suggestedVendorType: { type: String },
    followUpQuestions: [{ type: String }],
    safetyWarning: { type: String },
    emergencyServicesRecommended: { type: Boolean, default: false },
    readyToSubmit: { type: Boolean, default: false },
    intakeStatus: {
      type: String,
      enum: ["needs_more_info", "ready_to_submit"],
      default: "needs_more_info",
    },
    missingFields: [{ type: String }],
    confidence: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "low",
    },
    source: {
      type: String,
      enum: ["openai", "meta", "deterministic_fallback", "voice"],
      default: "deterministic_fallback",
    },
    raw: { type: Schema.Types.Mixed },
    generatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// A hosted evidence asset (photo / short video). The binary lives in Cloudinary;
// only this metadata is stored. `label` ties the asset to a guided-capture prompt
// (e.g. "Shutoff valve", "Brand/model label").
const EvidenceAssetSchema = new Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String },
    type: { type: String, enum: ["image", "video"], default: "image" },
    label: { type: String, default: null },
    format: { type: String },
    bytes: { type: Number },
    width: { type: Number },
    height: { type: Number },
  },
  { _id: false }
);

const IntakeMessageSchema = new Schema(
  {
    role: {
      type: String,
      enum: ["ai", "user"],
      required: true,
    },
    content: { type: String, required: true },
    attachments: { type: [EvidenceAssetSchema], default: [] },
  },
  { _id: false }
);

const COST_TIER_ENUM = ["Low", "Medium", "High", "Unknown"];
const TIMELINE_TREND_ENUM = ["Improving", "Stable", "Worsening", "Unknown"];
const RISK_TYPE_ENUM = [
  "gas",
  "fire",
  "smoke",
  "flooding",
  "electrical",
  "structural",
  "sewage",
  "carbon_monoxide",
  "injury",
  "other",
];

// Canonical, structured incident record — the operating truth for a request.
// Assembled from AI triage by services/ai/incidentRecord.service.js. The raw
// tenant description and the `ai` blob remain as evidence/model-debug; this is
// what routing, scheduling, approval, and (later) outcome learning read.
const IncidentRecordSchema = new Schema(
  {
    category: { type: String },
    subcategory: { type: String, default: null },
    trade: { type: String, default: null },
    summary: { type: String, default: "" },
    impact: { type: String, default: "" },
    severity: { type: Number, min: 1, max: 5 },
    emergency: { type: Boolean, default: false },
    safety: {
      safetyRisk: { type: Boolean, default: false },
      riskType: { type: String, enum: [...RISK_TYPE_ENUM, null], default: null },
      activeDamage: { type: Boolean, default: false },
      lifeSafetyConcern: { type: Boolean, default: false },
    },
    location: {
      room: { type: String, default: "" },
      area: { type: String, default: "" },
    },
    timeline: {
      started: { type: String, default: "" },
      trend: { type: String, enum: TIMELINE_TREND_ENUM, default: "Unknown" },
    },
    evidence: {
      photos: { type: Number, default: 0 },
      video: { type: Boolean, default: false },
      voice: { type: Boolean, default: false },
      confidencePenalty: { type: Boolean, default: false },
      assets: { type: [EvidenceAssetSchema], default: [] },
    },
    attemptedFixes: { type: [String], default: [] },
    access: {
      permissionToEnter: { type: Boolean, default: null },
      pets: { type: Boolean, default: null },
      preferredTimes: { type: [String], default: [] },
    },
    responsibility: { type: String, enum: RESPONSIBILITY_ENUM, default: "unknown" },
    costTier: { type: String, enum: COST_TIER_ENUM, default: "Unknown" },
    confidence: {
      overall: { type: Number, min: 0, max: 1, default: 0 },
      missingFields: { type: [String], default: [] },
    },
    generatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const VENDOR_RECOMMENDATION_DECISIONS = [
  "use_preset_vendor",
  "request_external_vendor_approval",
  "request_quota_increase",
  "queue_until_business_hours",
  "escalate_emergency",
  "manual_review_required",
  "recommend_preset_vendor",
  "request_vendor_contact_approval",
  "request_first_time_vendor_approval",
  "queue_for_manager_review",
  "manual_vendor_assignment_required",
];

const ROUTING_READINESS_STATES = [
  "ready_to_route",
  "need_one_more_answer",
  "need_photo_evidence",
  "needs_manager_review",
  "emergency_escalation",
  "manual_assignment_required",
];

// AI's recommendation for what should happen next with the request (distinct from
// routingStatus, which tracks the actual routing lifecycle). Computed at triage by
// services/ai/routingReadiness.service.js.
const RoutingReadinessSchema = new Schema(
  {
    state: { type: String, enum: ROUTING_READINESS_STATES },
    reason: { type: String, default: "" },
    recommendedAction: { type: String, default: "" },
    blocking: { type: Boolean, default: false },
    generatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const maintenanceRequestSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    landlordId: { type: Schema.Types.ObjectId, ref: "Landlord", index: true },
    propertyId: { type: Schema.Types.ObjectId, ref: "Property", index: true },
    unitId: { type: Schema.Types.ObjectId, ref: "Unit", index: true },

    issueTitle: { type: String, required: true, trim: true },
    issueDescription: { type: String, required: true },
    category: { type: String, default: "Other" },
    urgency: { type: String, enum: URGENCY_ENUM, default: "medium" },

    photos: [{ type: String }],

    accessPermission: { type: Boolean, default: null },
    preferredTime: { type: String },

    status: { type: String, enum: STATUS_ENUM, default: "queued", index: true },

    // Vendor / cost
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor" },
    selectedVendorId: { type: Schema.Types.ObjectId, ref: "Vendor", index: true },
    vendorTypeNeeded: { type: String, trim: true },
    bookingVersion: { type: Number },
    bookingActionToken: { type: String, select: false },
    bookingActionUntil: { type: Date, select: false },
    eta: { type: Date },
    estimatedCost: { type: Number, default: 0 },
    finalCost: { type: Number, default: 0 },
    responsibility: {
      type: String,
      enum: RESPONSIBILITY_ENUM,
      default: "unknown",
    },

    // Rejection / appeal (services/request/appeal.service.js owns the rules).
    rejectionReason: { type: String },
    rejectedAt: { type: Date },
    appealWindowExpiresAt: { type: Date },
    // "An appeal is waiting on the landlord" -- cleared when it is decided.
    isAppealed: { type: Boolean, default: false },
    appealNote: { type: String },
    appealedAt: { type: Date },
    // "This request has had its one appeal" -- survives a reopen, so a second
    // rejection of a reopened request is final instead of opening another round.
    appealUsed: { type: Boolean, default: false },
    // Set when a landlord withdraws a rejection or accepts the appeal.
    reopenedAt: { type: Date },

    completedAt: { type: Date },
    completionNotes: { type: String },
    // Set by tenant cancellation. Before it existed a cancelled request had no
    // record of WHEN, so the archive sweeper falls back to updatedAt for those.
    cancelledAt: { type: Date },
    // Set by services/request/archiveSweeper once a completed or cancelled
    // request has sat finished for ARCHIVE_AFTER_DAYS. Archiving only moves a
    // request out of the working lists -- nothing is deleted, and it stays
    // reachable by id and under the property/unit history.
    archivedAt: { type: Date, default: null },

    // AI triage (model output + debug) and the canonical structured incident record
    ai: AITriageSchema,
    incidentRecord: { type: IncidentRecordSchema, default: null },
    routingReadiness: { type: RoutingReadinessSchema, default: null },
    submissionId: { type: String },
    submissionDigest: { type: String },
    intakeFollowUp: { type: Schema.Types.Mixed, default: null },
    safetyAssessment: { type: Schema.Types.Mixed, default: null },
    workflowOperations: { type: [Schema.Types.Mixed], default: [], select: false },
    workflowAlertPending: { type: Boolean, default: false },
    safetyAlert: { type: Schema.Types.Mixed, default: null },
    // Present only on new submissions. No default/backfill: deploying autopilot
    // must never start old requests the landlord has already handled.
    routingAuthority: { digest: String },
    initialRouting: {
      type: new Schema({
        status: { type: String, enum: ["pending", "processing", "done", "failed"], required: true },
        attempts: { type: Number, default: 0 },
        nextAttemptAt: Date,
        leaseToken: String,
        leaseUntil: Date,
        lastErrorCode: String,
          // Explicit reopen enrolment, not a backfill of historical requests.
          cleanupBefore: Date,
          requiresContactReview: Boolean,
      }, { _id: false }),
      default: undefined,
    },
    intakeMessages: { type: [IntakeMessageSchema], default: [] },
    quotaOverride: {type: Number, default: null, min: 0},
    policyCheckpointFence: { type: Number, default: 0, select: false },
    rescheduleState: {
      proposalId: Schema.Types.ObjectId, revision: Number, active: Boolean,
      status: String, expiresAt: Date,
    },
    quoteClarificationCount: { type: Number, default: 0, select: false },
    routingStatus: {
      type: String,
      enum: ["pending", "routed", "approval_needed", "paused", "failed"],
      default: "pending",
      index: true,
    },
    // KEEP IN LOCKSTEP with Appointment.status — see the comment there. This is
    // the field the frontend actually reads.
    appointmentStatus: {
      type: String,
      enum: [
        "none",
        "proposed",
        "awaiting_vendor",
        "awaiting_tenant",
        "scheduled",
        "work_verifying",
        "in_review",
        "disputed",
        "cancelled",
        "completed",
        "failed",
      ],
      default: "none",
      index: true,
    },
    routingDecision: {
      type: String,
      enum: VENDOR_RECOMMENDATION_DECISIONS,
    },
    vendorRecommendationSnapshot: { type: Schema.Types.Mixed, default: null },
    quotaSnapshot: { type: Schema.Types.Mixed },
    vendorRecommendation: { type: Schema.Types.Mixed, default: null },
    duplicateGroupId: { type: String, index: true },
    severityOverride: { type: Number, min: 1, max: 5 },
    agentPaused: { type: Boolean, default: false, index: true },

    // Source
    source: {
      type: String,
      enum: ["form", "chat", "voice", "image"],
      default: "form",
    },

    // History
    timeline: { type: [StatusEventSchema], default: [] },
    comments: { type: [CommentSchema], default: [] },
  },
  { timestamps: true }
);

maintenanceRequestSchema.pre("save", function (next) {
  if (this.isNew) {
    this.timeline.push({
      status: this.status,
      note: "Request created",
      actorRole: "tenant",
      actorId: this.tenantId,
    });
  }
  next();
});

// The working lists filter on archivedAt: null; the history views read one
// property or unit at a time, newest archive first.
maintenanceRequestSchema.index({ landlordId: 1, archivedAt: -1, propertyId: 1, unitId: 1 });
maintenanceRequestSchema.index({ tenantId: 1, archivedAt: -1 });
maintenanceRequestSchema.index({ tenantId: 1, submissionId: 1 }, { unique: true, partialFilterExpression: { submissionId: { $type: 'string' } } });
maintenanceRequestSchema.index({ "initialRouting.status": 1, "initialRouting.nextAttemptAt": 1, "initialRouting.leaseUntil": 1 });

module.exports = mongoose.model("MaintenanceRequest", maintenanceRequestSchema);
module.exports.STATUS_ENUM = STATUS_ENUM;
module.exports.URGENCY_ENUM = URGENCY_ENUM;
module.exports.RESPONSIBILITY_ENUM = RESPONSIBILITY_ENUM;
module.exports.VENDOR_RECOMMENDATION_DECISIONS = VENDOR_RECOMMENDATION_DECISIONS;
module.exports.ROUTING_READINESS_STATES = ROUTING_READINESS_STATES;
module.exports.COST_TIER_ENUM = COST_TIER_ENUM;
module.exports.TIMELINE_TREND_ENUM = TIMELINE_TREND_ENUM;
module.exports.RISK_TYPE_ENUM = RISK_TYPE_ENUM;
