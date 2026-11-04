// Read-only presentation of recorded facts. Never forward free-form audit
// summaries/input/output/metadata: those can contain links, prices or internals.
const { activityActor } = require('./activityActor.service');
const ACTIONS = {
  booking_reschedule_requested: ['Visit change requested', 'A visit change is awaiting responses. The original visit remains confirmed.', 'waiting'],
  booking_reschedule_vendor_confirmed_slot: ['Vendor confirmed replacement time', 'The vendor confirmed the proposed time. Tenant confirmation is still required; the original visit remains confirmed.', 'waiting'],
  booking_reschedule_tenant_confirmed_slot: ['Tenant confirmed replacement time', 'The tenant confirmed the exact proposed time. Backend application is recorded separately.', 'completed'],
  booking_reschedule_committed: ['Visit time changed', 'The backend applied the replacement after vendor and tenant confirmations.', 'completed'],
  booking_reschedule_response_deadline_shortened: ['Visit change deadline updated', 'The backend shortened the response window to keep a two-hour buffer before either visit. The original booking was retained.', 'waiting'],
  booking_reschedule_vendor_declined_change: ['Visit change declined', 'The vendor declined the change. The original visit was retained.', 'completed'],
  booking_reschedule_tenant_declined_change: ['Visit change declined', 'The tenant declined the change. The original visit was retained.', 'completed'],
  booking_reschedule_tenant_declined_slot: ['Replacement time declined', 'The tenant declined the proposed replacement. The original visit was retained.', 'completed'],
  booking_reschedule_landlord_declined_change: ['Visit change withdrawn', 'The manager withdrew the change request. The original visit was retained.', 'completed'],
  booking_reschedule_expired: ['Visit change expired', 'The change request expired without replacing the original visit.', 'completed'],
  booking_reschedule_candidate_unavailable: ['Replacement time unavailable', 'The proposed time could not be reserved. The original visit was retained.', 'needs_attention'],
  booking_reschedule_original_basis_changed: ['Visit change no longer applicable', 'The change was not applied because its original context changed.', 'needs_attention'],
  quote_clarification_prepared: ["Clarification prepared", "A bounded vendor clarification was prepared. This does not confirm delivery or authorize costs.", "waiting"],
  quote_clarification_answered: ["Clarification answered", "The vendor answered a clarification. Itemized costs returned to review.", "waiting"],
  request_triaged: ["Intake assessed", "The maintenance report was assessed.", "completed"],
  request_approved: ["Request approved", "The landlord approved this request.", "completed"],
  request_rejected: ["Request rejected", "The landlord rejected this request.", "completed"],
  request_cancelled: ["Request cancelled", "This request was cancelled.", "completed"],
  request_completed: ["Request completed", "This request was marked completed.", "completed"],
  request_appealed: ["Appeal submitted", "The tenant requested a review of the rejection.", "needs_attention"],
  request_appeal_accepted: ["Appeal accepted", "The landlord reopened the request after review.", "completed"],
  request_rejection_withdrawn: ["Request reopened", "The landlord withdrew the rejection.", "completed"],
  request_finally_rejected: ["Rejection confirmed", "The landlord confirmed the rejection.", "completed"],
  intake_reviewed: ["Intake reviewed", "The landlord reviewed the intake details.", "completed"],
  safety_reviewed: ["Safety concern reviewed", "The landlord reviewed the reported safety concern.", "completed"],
  vendor_recommendations_generated: ["Vendor options prepared", "Vendor recommendations were prepared for review. This does not confirm contact or booking.", "completed"],
  vendor_recommendations_narrowed: ["Vendor options updated", "The available vendor recommendations were updated.", "completed"],
  vendor_autopilot_started: ["Vendor contact authorized", "Policy authorized vendor contact. Delivery is recorded separately.", "completed"],
  initial_contact_authorized: ["Initial vendor contact authorized", "A version-bound initial-contact permission was recorded. Delivery and quote approval are separate actions.", "completed"],
  initial_contact_refused: ["Initial vendor contact needs review", "Automatic initial contact was not authorized under the recorded current Policy. No delivery is claimed.", "needs_attention"],
  vendor_contact_approved: ["Vendor contact approved", "The landlord approved vendor contact. Delivery is recorded separately.", "completed"],
  vendor_outreach_scheduled: ["Vendor contact scheduled", "Vendor outreach was scheduled for a later time.", "waiting"],
  vendor_outreach_sent: ["Vendor outreach delivered to provider", "The delivery service accepted vendor outreach. This does not confirm that the vendor read it.", "completed"],
  vendor_outreach_viewed: ["Vendor opened request", "The vendor opened the maintenance request.", "completed"],
  vendor_outreach_send_failed: ["Vendor outreach not confirmed", "Vendor outreach failed or was not confirmed. No delivery is claimed.", "failed"],
  vendor_outreach_skipped: ["Vendor outreach skipped", "Vendor outreach was skipped. No delivery is claimed.", "completed"],
  vendor_outreach_resent: ["Vendor outreach retried", "A vendor outreach retry was recorded. Check the current delivery state for confirmation.", "unknown"],
  vendor_outreach_schedule_cancelled: ["Scheduled outreach cancelled", "The scheduled vendor contact was cancelled.", "completed"],
  vendor_outreach_expired: ["Vendor response expired", "The vendor response deadline expired.", "completed"],
  vendor_outreach_closed: ["Vendor outreach closed", "This vendor outreach round was closed.", "completed"],
  vendor_outreach_exhausted: ["Vendor options exhausted", "Available vendor outreach options were exhausted; review is required.", "needs_attention"],
  vendor_outreach_escalated: ["Vendor contact needs review", "Vendor outreach was escalated for landlord review.", "needs_attention"],
  vendor_outreach_reapproval_requested: ["Contact approval requested", "Updated vendor contact requires landlord approval.", "needs_attention"],
  vendor_outreach_advanced: ["Next vendor considered", "The workflow advanced to another vendor option.", "completed"],
  vendor_response_accepted: ["Vendor accepted request", "The vendor accepted the request. Booking confirmation is recorded separately.", "completed"],
  vendor_response_declined: ["Vendor declined request", "The vendor declined the request.", "completed"],
  vendor_quote_recorded: ["Vendor quote received", "A vendor quote was recorded for review.", "completed"],
  quote_analysis_recorded: ["Cost review prepared", "Cost information was prepared for landlord review.", "needs_attention"],
  cost_review_approved: ["Cost review step allowed", "The landlord allowed the stated cost-review step. This decision does not authorize spending or payment.", "completed"],
  cost_review_rejected: ["Cost review step declined", "The landlord declined the stated cost-review step. No costs were authorized by this decision.", "needs_attention"],
  cost_review_reopened: ["Scope review reopened", "The landlord reopened the declined scope review. A fresh human Decision is required. Reopening does not authorize spending or payment.", "needs_attention"],
  completion_overage_decided: ["Final charge decision recorded", "A human decision about final charges was recorded. Repair verification and payment have separate requirements.", "completed"],
  quota_increase_approved: ["Spending limit authorized", "The landlord authorized the stated spending limit. Repair verification, funding and payment remain separate.", "completed"],
  quota_increase_rejected: ["Spending limit declined", "The landlord declined the requested spending limit. This records the decision, not a payment.", "completed"],
  vendor_quote_over_quota: ["Quote needs approval", "The vendor quote requires landlord approval.", "needs_attention"],
  vendor_counter_offer_sent: ["Revised offer requested", "A revised offer was recorded for vendor confirmation.", "waiting"],
  vendor_counter_offer_confirmed: ["Revised offer confirmed", "The vendor confirmed the revised offer.", "completed"],
  vendor_counter_offer_declined: ["Revised offer declined", "The vendor declined the revised offer.", "completed"],
  vendor_response_dismissed: ["Vendor response dismissed", "The landlord dismissed the vendor response.", "completed"],
  manual_vendor_selected: ["Vendor selected", "The landlord selected a vendor.", "completed"],
  vendor_appointment_created: ["Appointment prepared", "An appointment was created; tenant confirmation may still be required.", "completed"],
  appointment_proposed: ["Appointment proposed", "An appointment was proposed for confirmation.", "waiting"],
  appointment_tenant_confirmed: ["Tenant confirmed appointment", "The tenant confirmed the proposed appointment.", "completed"],
  appointment_tenant_declined: ["Tenant declined appointment", "The tenant declined the proposed appointment.", "completed"],
  appointment_updated: ["Appointment updated", "The appointment record was updated.", "completed"],
  appointment_no_show: ["Appointment missed", "A missed appointment was recorded.", "needs_attention"],
  appointment_unconfirmed_rerouted: ["Unconfirmed appointment rerouted", "An unconfirmed appointment returned to vendor routing.", "completed"],
  vendor_completion_submitted: ["Completion submitted", "The vendor submitted completion information for review.", "waiting"],
  completion_tenant_confirmed: ["Repair confirmed", "The tenant confirmed the repair outcome.", "completed"],
  completion_tenant_disputed: ["Repair disputed", "The tenant disputed the repair outcome; review is required.", "needs_attention"],
  completion_review_escalated: ["Completion needs review", "The completion requires landlord review.", "needs_attention"],
  completion_over_ceiling: ["Completion cost needs review", "The completion cost requires landlord approval.", "needs_attention"],
  completion_settlement_review_required: ["Settlement needs review", "Recovered completion records require a human review before settlement is retried.", "needs_attention"],
  completion_review_approved: ["Completion review approved", "The landlord approved the completion review.", "completed"],
  completion_review_rejected: ["Completion review rejected", "The landlord rejected the completion review.", "completed"],
  job_completion_closed: ["Completion closed", "The repair completion workflow was closed.", "completed"],
  comment_added: ["Comment added", "A participant added a comment to the request.", "completed"],
  approval_requested: ["Landlord approval requested", "A workflow action requires landlord approval.", "needs_attention"],
  emergency_call_placed: ["Emergency call initiated", "An emergency notification call was initiated. This does not confirm that it was answered.", "completed"],
  emergency_call_skipped: ["Emergency call skipped", "An emergency notification call was not placed.", "unknown"],
};
const TERMINAL = new Set(["completed", "cancelled", "rejected"]);
const ACTORS = { ai_agent: "Iris", system: "System", landlord: "Landlord", tenant: "Tenant", vendor: "Vendor" };
const date = (value) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const clean = (value, max = 180) => typeof value === "string" ? value.replace(/https?:\/\/\S+|\b(?:sk-|token[=:])\S+/gi, "[redacted]").replace(/[\x00-\x1f]/g, " ").slice(0, max) : "";
const eventKey = (event) => `${event.at || ""}|${event.id}`;
function compareEvents(a, b) { return (b.at || "").localeCompare(a.at || "") || (b.orderKey || b.id).localeCompare(a.orderKey || a.id); }
function lifecycleEvents(request) {
  return (request.timeline || []).map((row, index) => {
    // M4's earlier source wrote this server-generated marker in the same
    // transaction as the required canonical booking_reschedule_committed audit.
    // Hide only its duplicate/misattributed presentation; retain raw history
    // and original indexes/cursors. Ordinary assigned events remain visible.
    if (row.status === 'assigned' && row.actorRole === 'tenant' && row.note ===
      'Vendor and tenant confirmed the replacement visit time; the original was retained until this change committed.') return null;
    const status = clean(row.status);
    const state = TERMINAL.has(status) ? "completed" : status === "in_progress" ? "in_progress" : "unknown";
    const title = ({ pending: "Request received", queued: "Request queued", approved: "Request approved", assigned: "Vendor assigned", in_progress: "Work in progress", completed: "Request completed", rejected: "Request rejected", cancelled: "Request cancelled" })[status] || "Request status recorded";
    return { id: `lifecycle:${request._id}:${index}`, requestId: String(request._id), source: "lifecycle", actor: ACTORS[row.actorRole] || null,
      type: `request_${status || "unknown"}`, title, summary: title + ".", at: date(row.at), state, details: [{ label: "Recorded status", value: status || "Unknown" }] };
  }).filter(Boolean);
}
function auditEvent(row) {
  const type = Object.hasOwn(ACTIONS, row.actionType) ? row.actionType : "unclassified_activity";
  let [title, summary, state] = ACTIONS[type] || ["Activity recorded", "A workflow activity was recorded. Its outcome is not classified.", "unknown"];
  const actorInfo = activityActor(row);
  const details = [{ label: "Recorded by", value: actorInfo.actorLabel }];
  if (actorInfo.provenance.kind === 'simulation') {
    title = 'Simulated: ' + title;
    summary = 'Sandbox simulation recorded. No real message, physical repair or payment is verified by this event.';
  }
  if (type === "quote_analysis_recorded") {
    if (row.output?.source === "development_stub") {
      title = "Development cost review prepared";
      summary = "A simulated development response was recorded. Landlord review is still required.";
    } else if (row.output?.status === "unavailable") {
      title = "Cost analysis unavailable";
      summary = "Analysis could not be completed. The landlord must review the itemized costs.";
    }
  }
  if (type === "vendor_recommendations_generated") {
    for (const [key, label] of [["candidateCount", "Vendor candidates"], ["excludedCount", "Excluded candidates"]]) {
      const count = row.output?.[key];
      if (Number.isSafeInteger(count) && count >= 0) details.push({ label, value: String(count) });
    }
    if (typeof row.output?.approvalRequired === "boolean") details.push({ label: "Approval required", value: row.output.approvalRequired ? "Yes" : "No" });
  }
  if (["vendor_outreach_sent", "vendor_outreach_send_failed", "vendor_outreach_scheduled"].includes(type)) {
    if (Number.isSafeInteger(row.input?.attempt) && row.input.attempt > 0) details.push({ label: "Contact attempt", value: String(row.input.attempt) });
    const deadline = date(row.output?.responseDeadlineAt);
    if (deadline) details.push({ label: "Response deadline", value: deadline });
  }
  const event = { id: `audit:${row._id}`, requestId: String(row.requestId), source: "audit", actor: ACTORS[row.actor] || null,
    type, title, summary, at: date(row._eventAt === undefined ? row.createdAt : row._eventAt),
    recordedAt: date(row.createdAt), timeBasis: row._timeBasis || (date(row.createdAt) ? "recorded" : "unknown"), state, details, ...actorInfo };
  // The opaque cursor needs this stable cause/identity key. It is not public
  // evidence or a fabricated global event sequence.
  Object.defineProperty(event, "orderKey", { value: row._eventOrder || event.id, enumerable: false });
  return event;
}
const APPROVAL_TYPES = new Set(["external_vendor_search", "quota_increase", "first_time_vendor", "vendor_contact_approval", "high_severity", "tenant_caused_cost", "completion_review", "cost_review", "other"]);
function pendingApprovalFor(request, approval, now = new Date()) {
  if (!approval?._id || approval.status !== "pending" || !APPROVAL_TYPES.has(approval.type) ||
      !date(approval.expiresAt) || new Date(approval.expiresAt) <= now ||
      String(approval.landlordId) !== String(request.landlordId) || String(approval.requestId) !== String(request._id)) return null;
  return { approvalId: String(approval._id), type: approval.type, status: "pending" };
}
function currentState(request, { preparation, outreach, completionHold, approval, now = new Date() } = {}) {
  const result = (stage, state, summary, waitingFor = null, actionRequired = false) => ({ stage, state, summary, waitingFor, actionRequired });
  if (["confirmed_hazard", "needs_review"].includes(request.safetyAssessment?.state) && !request.safetyAssessment?.reviewedAt)
    return result("review", "needs_attention", "Landlord safety review required before vendor contact.", "Landlord safety review", true);
  if (request.isAppealed) return result("review", "needs_attention", "The tenant appeal needs landlord review.", "Landlord appeal review", true);
  if (["disputed", "in_review"].includes(request.appointmentStatus)) return result("review", "needs_attention", "Repair completion needs landlord review.", "Landlord completion review", true);
  if (completionHold?.status === "closed" && completionHold.closeRecovery?.version === 1 &&
      (completionHold.closeRecovery.projectionPending !== false || !date(completionHold.closeRecovery.settlementRecordedAt)))
    return result("review", "needs_attention", "Completed work has unresolved completion or settlement records requiring landlord review.", "Landlord settlement review", true);
  if (pendingApprovalFor(request, approval, now)) return result("review", "needs_attention", "A landlord decision is required before coordination can continue.", "Landlord decision", true);
  if (TERMINAL.has(request.status)) return result("closed", "completed", ({ completed: "This request is completed.", cancelled: "This request was cancelled.", rejected: "This request was rejected." })[request.status]);
  if (request.intakeFollowUp && request.intakeFollowUp.state !== "reviewed") {
    return request.intakeFollowUp.state === "ready_for_review" ? result("intake", "needs_attention", "The tenant's additional details need landlord review.", "Landlord intake review", true) : result("intake", "waiting", "Waiting for essential details from the tenant.", "Tenant details");
  }
  if (request.agentPaused || request.routingStatus === "paused") return result("review", "needs_attention", "Coordination is paused for landlord review.", "Landlord review", true);
  // A scheduled preparation is retained after the vendor submits completion.
  // The newer completion projection must take precedence over that old phase.
  if (request.appointmentStatus === "work_verifying") return result("review", "waiting", "Waiting for the tenant to confirm the repair outcome.", "Tenant confirmation");
  if (request.rescheduleState?.active && date(request.rescheduleState.expiresAt) && new Date(request.rescheduleState.expiresAt) > now) {
    if (request.rescheduleState.status === 'awaiting_vendor') return result('scheduling', 'waiting', 'A proposed visit change is waiting for the vendor. The original visit remains confirmed.', 'Vendor confirmation');
    if (request.rescheduleState.status === 'awaiting_tenant') return result('scheduling', 'waiting', 'The vendor proposed a replacement time; tenant confirmation is required. The original visit remains confirmed.', 'Tenant confirmation');
  }
  if (preparation?.active) {
    const phase = preparation.phase;
    if (phase === "preparing" && (preparation.reasonCode === "bookings_paused" || /^billing_/.test(preparation.reasonCode || ""))) return result("scheduling", "needs_attention", "Booking is paused and needs landlord review.", "Landlord booking review", true);
    if (["awaiting_approval", "awaiting_funds", "paused"].includes(phase)) return result("scheduling", "needs_attention", phase === "awaiting_funds" ? "Booking is waiting for landlord funding." : "Booking needs landlord review.", phase === "awaiting_funds" ? "Landlord funding" : "Landlord booking review", true);
    if (["awaiting_vendor", "awaiting_tenant"].includes(phase)) return result("scheduling", "waiting", phase === "awaiting_vendor" ? "Waiting for the vendor to confirm the appointment." : "Waiting for the tenant to confirm the appointment.", phase === "awaiting_vendor" ? "Vendor confirmation" : "Tenant confirmation");
    if (phase === "preparing") return date(preparation.leaseUntil) && new Date(preparation.leaseUntil) > now ? result("scheduling", "in_progress", "Booking preparation is processing under an active lease.") : result("scheduling", "waiting", "Booking preparation is pending; no active processing is confirmed.", "Booking preparation");
    if (phase === "expired") return result("scheduling", "needs_attention", "Booking preparation expired and needs review.", "Landlord booking review", true);
    if (phase === "scheduled") return result("work", "waiting", "The appointment is scheduled; waiting for the work update.", "Scheduled work");
  }
  if (request.appointmentStatus === "completed") return result("review", "waiting", "Waiting for repair completion confirmation.", "Completion confirmation");
  if (["in_progress"].includes(request.status)) return result("work", "in_progress", "Work is recorded as in progress.");
  if (request.appointmentStatus === "scheduled" || request.status === "assigned") return result("work", "waiting", "A vendor is assigned; waiting for the appointment or work update.", "Scheduled work");
  if (["awaiting_vendor", "awaiting_tenant", "proposed"].includes(request.appointmentStatus)) return result("scheduling", "waiting", "Waiting for appointment confirmation.", request.appointmentStatus === "awaiting_vendor" ? "Vendor confirmation" : "Tenant confirmation");
  if (request.routingStatus === "approval_needed") return result("routing", "needs_attention", "Vendor routing requires landlord approval.", "Landlord approval", true);
  if (request.routingStatus === "failed" || request.initialRouting?.status === "failed" || request.appointmentStatus === "failed") return result("routing", "failed", "Coordination failed and needs landlord review.", "Landlord review", true);
  if (outreach) {
    if (outreach.deliveryUnconfirmed || outreach.status === "delivery_failed") return result("outreach", "failed", "Vendor outreach delivery is not confirmed; review is required.", "Landlord delivery review", true);
    if (outreach.counterOffer?.status === "pending") return result("scheduling", "waiting", "Waiting for the vendor to respond to the revised offer.", "Vendor response");
    if (["sent", "viewed"].includes(outreach.status)) return result("outreach", "waiting", "Waiting for the vendor's response.", "Vendor response");
    if (["queued", "scheduled"].includes(outreach.status)) return result("outreach", "waiting", "Vendor outreach is queued or scheduled; delivery is not yet confirmed.", "Vendor outreach delivery");
    if (outreach.status === "accepted") return result("scheduling", "waiting", "The vendor accepted; waiting for booking preparation.", "Booking preparation");
    if (["declined", "expired"].includes(outreach.status)) return result("routing", "waiting", "The previous vendor offer ended; waiting for the next routing decision.", "Vendor routing");
  }
  if (request.initialRouting?.status === "processing" && date(request.initialRouting.leaseUntil) && new Date(request.initialRouting.leaseUntil) > now) return result("routing", "in_progress", "Vendor routing is processing under an active lease.");
  if (["pending", "processing"].includes(request.initialRouting?.status)) return result("routing", "waiting", "Vendor routing is pending; no active processing is confirmed.", "Vendor routing");
  return result(request.routingStatus === "routed" ? "routing" : "intake", "unknown", "No current coordination action is confirmed by the stored records.");
}
function automationState(request, current, { preparation, now = new Date() } = {}) {
  if (current.state === "failed") return "failed";
  if (current.actionRequired) {
    return current.stage === "review" && !["Landlord decision", "Landlord approval", "Landlord booking review", "Landlord funding"].includes(current.waitingFor) ? "escalated" : "awaiting_landlord";
  }
  if (current.stage === "closed") return "completed";
  if (current.state === "in_progress" &&
      (current.stage === "routing" && request.initialRouting?.status === "processing" && date(request.initialRouting.leaseUntil) && new Date(request.initialRouting.leaseUntil) > now ||
       current.stage === "scheduling" && preparation?.active && preparation.phase === "preparing" && date(preparation.leaseUntil) && new Date(preparation.leaseUntil) > now)) return "running";
  if (/^Vendor (?:response|confirmation)$/.test(current.waitingFor || "")) return "awaiting_vendor";
  if (/^Tenant (?:details|confirmation)$/.test(current.waitingFor || "")) return "awaiting_tenant";
  if (current.state === "unknown") return "unknown";
  return "idle";
}
function projectRequest(request, { logs = [], preparation, outreach, completionHold, approval, approvalActivity, now = new Date() } = {}) {
  const events = [...lifecycleEvents(request), ...logs.map(auditEvent)].sort(compareEvents);
  const current = currentState(request, { preparation, outreach, completionHold, approval, now });
  let latestEvent = events[0] || null;
  // A historical success must not imply that an outstanding hold is resolved.
  if (current.actionRequired && latestEvent?.state !== current.state) latestEvent = null;
  if (current.stage === "closed" && latestEvent && !["request_completed", "request_cancelled", "request_rejected", "request_finally_rejected", "job_completion_closed"].includes(latestEvent.type)) latestEvent = null;
  const stamps = [date(request._activityAt), ...events.map((event) => event.at),
    ...[request.completedAt, request.cancelledAt, request.rejectedAt, request.appealedAt, request.reopenedAt,
      request.safetyAssessment?.reviewedAt, request.intakeFollowUp?.submittedAt, request.intakeFollowUp?.reviewedAt, completionHold?.closedAt,
      approvalActivity?.createdAt, approvalActivity?.decidedAt, approval?.createdAt].map(date)].filter(Boolean).sort();
  return { requestId: String(request._id), title: clean(request.issueTitle || request.ai?.shortTitle) || "Maintenance request",
    propertyLabel: clean(request.propertyId?.name), unitLabel: clean(request.unitId?.unitNumber), status: clean(request.status) || "unknown",
    ...current, automationState: automationState(request, current, { preparation, now }), pendingApproval: pendingApprovalFor(request, approval, now),
    updatedAt: stamps.at(-1) || date(request.updatedAt), latestEvent };
}
module.exports = { ACTIONS, TERMINAL, date, eventKey, compareEvents, lifecycleEvents, auditEvent, currentState, projectRequest, pendingApprovalFor };
