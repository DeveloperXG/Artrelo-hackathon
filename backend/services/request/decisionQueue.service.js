// Routing decisions a manager owes, derived from live request state.
//
// Decisions Needed used to list ApprovalRequest rows only, so the most common
// decision of all -- "Approve contact" for the vendor the system recommended --
// never appeared there, and neither did a request paused because every vendor
// declined. Both are decisions; neither creates an ApprovalRequest.
//
// Derived rather than stored, on purpose: a stored "pending decision" row is a
// second copy of state the request already holds, and copies drift (approve
// from the request page and the row lingers). This reads the request itself,
// so the page and the sidebar badge (getBadgeCounts) can never disagree with
// what the request shows.

const MaintenanceRequest = require("../../models/MaintenanceRequest");
const ApprovalRequest = require("../../models/ApprovalRequest");
const Appointment = require("../../models/Appointment");
const VendorOutreach = require("../../models/VendorOutreach");
const { getActiveCandidate } = require("../vendor/vendorSnapshot.service");
const { TENANT_CONFIRM_MS, tenantConfirmDeadline } = require("../completion/appointmentFailure.service");

const ROUTABLE_STATUSES = ["queued", "approved"];
const OPEN_STATUSES = [...ROUTABLE_STATUSES,"assigned","in_progress"];
// Mirrors the frontend's getVendorContactActionState "available" rule.
const CONTACTABLE_STATES = ["recommended", "pending", undefined, null];

/**
 * The candidate a request is waiting to have contacted, or null.
 * Pure -- exported for tests.
 */
function getContactCandidate(snapshot) {
  if (!snapshot || getActiveCandidate(snapshot)) return null;
  const notContacted = (candidate) => (candidate?.outreach?.status || "not_sent") === "not_sent";
  return (
    (snapshot.recommendations || []).find(
      (candidate) => CONTACTABLE_STATES.includes(candidate.state) && notContacted(candidate)
    ) || null
  );
}

// Outcome codes for a search that found nobody able to take the job.
const NO_ELIGIBLE_OUTCOMES = [
  "no_candidates_discovered",
  "no_service_matches",
  "no_location_matches",
  "all_candidates_excluded",
  "vendor_service_unresolved",
];

/**
 * Why routing paused, so the card can say something true. Every pause used to
 * read "No vendor is left in line" -- wrong for an empty network, where no
 * vendor was ever in line, and for a manager who turned the recommendation
 * down. When both a closed round and a manager rejection are on the snapshot,
 * the later one is the reason. Pure -- exported for tests.
 */
function getPauseKind(snapshot) {
  const exhaustedAt = snapshot?.lastRound?.resolution === "exhausted" ? Date.parse(snapshot.lastRound.at || 0) || 0 : null;
  const rejectedAt =
    snapshot?.lastManagerAction?.type === "reject_recommendation"
      ? Date.parse(snapshot.lastManagerAction.at || 0) || 0
      : null;
  if (exhaustedAt !== null && (rejectedAt === null || exhaustedAt >= rejectedAt)) return "vendors_exhausted";
  if (rejectedAt !== null) return "manager_rejected";
  // A fresh search after everyone declined has no lastRound of its own, but
  // it is the same situation: every vendor in line has been tried.
  if (snapshot?.diagnostics?.outcomeCode === "all_vendors_contacted") return "vendors_exhausted";
  if (NO_ELIGIBLE_OUTCOMES.includes(snapshot?.diagnostics?.outcomeCode)) return "no_eligible_vendors";
  return "paused";
}

/**
 * Classify one request. Pure -- exported for tests.
 * Returns { type, candidate? } or null when nothing is owed.
 */
function classifyRequest(request) {
  if (!OPEN_STATUSES.includes(request?.status) || request.archivedAt) return null;
  const workflow = require('./requestWorkflow.service');
  if (workflow.unresolvedSafety(request)) return {type:'safety_review',reason:'Urgent safety concern requires human review.'};
  if (!ROUTABLE_STATUSES.includes(request.status)) return null;
  const follow = workflow.deriveFollowUp(request);
  if (follow && follow.state !== 'reviewed') return {type:'intake_review',reason:follow.state==='ready_for_review'
    ? 'Tenant supplied additional details. Review before vendor contact.' : 'Essential details are outstanding; waiting for the tenant or explicit uncertainty review.'};
  const snapshot = request.vendorRecommendationSnapshot;
  if (!snapshot) return null;
  if (getActiveCandidate(snapshot)) return null; // waiting on a vendor, not on the manager

  if (request.routingStatus === "paused") {
    return {
      type: "routing_paused",
      reason: snapshot.lastRound?.reasonLabel || snapshot.decision?.managerSummary || null,
      pauseKind: getPauseKind(snapshot),
    };
  }
  const candidate = getContactCandidate(snapshot);
  if (candidate) return { type: "contact_approval", candidate };
  return null;
}

const projectRequest = (request) => ({
  requestId: String(request._id),
  title: request.ai?.shortTitle || request.issueTitle || "Maintenance request",
  urgency: request.urgency || null,
  propertyName: request.propertyId?.name || null,
  unitNumber: request.unitId?.unitNumber || null,
  createdAt: request.createdAt || null,
});

/**
 * Bookings that need the manager: a tenant who hasn't confirmed the vendor's
 * arrival time by the deadline, and a no-show the tenant reported. Both are
 * derived from the appointment, like everything else here, so resolving one
 * from the request page clears it from this list too.
 */
async function listBookingDecisions(landlordId, now = new Date()) {
  const appointments = await Appointment.find({
    landlordId,
    $or: [
      {
        status: "awaiting_tenant",
        $or: [
          { tenantConfirmBy: { $lte: now } },
          { tenantConfirmBy: null, createdAt: { $lte: new Date(now.getTime() - TENANT_CONFIRM_MS) } },
        ],
      },
      { status: "scheduled", "noShowReport.status": "reported" },
    ],
  })
    .select("requestId status confirmedStart tenantConfirmBy createdAt noShowReport")
    .lean();
  if (!appointments.length) return [];

  const [requests, outreaches] = await Promise.all([
    MaintenanceRequest.find({ _id: { $in: appointments.map((row) => row.requestId) } })
      .select("issueTitle ai.shortTitle urgency propertyId unitId createdAt status")
      .populate("propertyId", "name")
      .populate("unitId", "unitNumber")
      .lean(),
    VendorOutreach.find({ appointmentId: { $in: appointments.map((row) => row._id) } })
      .select("appointmentId vendorNameSnapshot")
      .lean(),
  ]);
  const requestById = new Map(requests.map((row) => [String(row._id), row]));
  const vendorByAppointment = new Map(outreaches.map((row) => [String(row.appointmentId), row.vendorNameSnapshot]));

  const items = [];
  for (const appointment of appointments) {
    const request = requestById.get(String(appointment.requestId));
    if (!request || ["completed", "cancelled", "rejected"].includes(request.status)) continue;
    const noShow = appointment.status === "scheduled";
    items.push({
      type: noShow ? "vendor_no_show" : "tenant_time_unconfirmed",
      ...projectRequest(request),
      appointmentId: String(appointment._id),
      vendorName: vendorByAppointment.get(String(appointment._id)) || null,
      arrivalAt: appointment.confirmedStart || null,
      deadline: noShow ? null : tenantConfirmDeadline(appointment),
      reportedAt: noShow ? appointment.noShowReport?.reportedAt || null : null,
      note: noShow ? appointment.noShowReport?.note || null : null,
      reason: null,
      candidate: null,
    });
  }
  return items;
}

/**
 * Appeals waiting on the landlord. A rejected request the tenant appealed sits
 * here until it is accepted (reopened) or declined (deleted) -- nothing else
 * moves it, so without this row it could wait forever.
 */
async function listAppealDecisions(landlordId) {
  const requests = await MaintenanceRequest.find({ landlordId, status: "rejected", isAppealed: true })
    .select("issueTitle ai.shortTitle urgency propertyId unitId createdAt rejectionReason appealNote appealedAt")
    .populate("propertyId", "name")
    .populate("unitId", "unitNumber")
    .lean();
  return requests.map((request) => ({
    type: "appeal_review",
    ...projectRequest(request),
    reason: request.rejectionReason || null,
    note: request.appealNote || null,
    reportedAt: request.appealedAt || null,
    candidate: null,
  }));
}

/**
 * Every routing decision this landlord owes. Requests with a pending
 * ApprovalRequest are left out: that row already puts them on the page.
 */
async function listRoutingDecisions(landlordId) {
  const [requests, pendingApprovalRequestIds, appeals] = await Promise.all([
    MaintenanceRequest.find({
      landlordId,
      status: { $in: OPEN_STATUSES },
    })
      .select("issueTitle ai urgency status routingStatus vendorRecommendationSnapshot propertyId unitId createdAt intakeFollowUp safetyAssessment incidentRecord vendorId selectedVendorId appointmentStatus archivedAt")
      .populate("propertyId", "name")
      .populate("unitId", "unitNumber")
      .lean(),
    ApprovalRequest.distinct("requestId", { landlordId, status: "pending" }),
    listAppealDecisions(landlordId),
  ]);

  const withApproval = new Set(pendingApprovalRequestIds.map(String));
  const items = [...appeals, ...(await listBookingDecisions(landlordId))];
  for (const request of requests) {
    const decision = classifyRequest(request);
    if (!decision) continue;
    if (withApproval.has(String(request._id)) && !['intake_review','safety_review'].includes(decision.type)) continue;
    items.push({
      type: decision.type,
      ...projectRequest(request),
      reason: decision.reason || null,
      pauseKind: decision.pauseKind || null,
      candidate: decision.candidate
        ? { candidateKey: decision.candidate.candidateKey, name: decision.candidate.name }
        : null,
    });
  }
  return items.sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
}

module.exports = {
  getContactCandidate,
  getPauseKind,
  classifyRequest,
  listAppealDecisions,
  listBookingDecisions,
  listRoutingDecisions,
};
