// Immediate intake work with a small durable recovery loop. Mongo owns the
// claim; the timer is only a nudge, just like the other sweepers in this app.
const crypto = require("crypto");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const LandlordPolicy = require("../../models/LandlordPolicy");
const Vendor = require("../../models/Vendor");
const VendorOutreach = require("../../models/VendorOutreach");
const Appointment = require("../../models/Appointment");
const { generateVendorRecommendations } = require("../vendor/vendorRecommendation.service");
const { evaluateAutopilot } = require("../vendor/autopilotPolicy.service");
const { evaluateHardConstraints } = require("../vendor/vendorScoring.service");
const { buildRequestContext, routableVendorFilter } = require("../vendor/vendorRecommendation.service");
const { rebuildSnapshotSections, cloneSnapshot, findLedgerEntry } = require("../vendor/vendorSnapshot.service");
const { notifyUser } = require("../notification/notify.service");
const { publish } = require("../realtime/liveEvents.service");
const { logAgentAction } = require("../audit/agentAction.service");

const INTERVAL_MS = 60_000;
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;
const RETRY_MS = [60_000, 300_000];
const ROUTABLE = ["queued", "approved"];
const pendingInitialRouting = (now = new Date()) => ({
  $or: [
    { "initialRouting.status": "pending", "initialRouting.nextAttemptAt": { $lte: now } },
    { "initialRouting.status": "processing", "initialRouting.leaseUntil": { $lte: now } },
  ],
});
const load = (id) => MaintenanceRequest.findById(id)
  .populate("propertyId", "name address").populate("unitId", "unitNumber")
  .populate("tenantId", "firstName lastName email");
const nudge = request => {
  for (const userId of [request.landlordId, request.tenantId?._id || request.tenantId]) {
    publish(userId, `request:${request._id}`); publish(userId, "requests");
  }
};
const contactAttention = (request) => notifyUser({ userId: request.landlordId, type: "decision_needed",
  title: "Vendor contact needs your attention",
  message: "Vendor delivery could not be confirmed. Review routing before resending or choosing another vendor.",
  metadata: { workOrderId: String(request._id), actionUrl: `/dashboard/requests/${request._id}?tab=routing` } });

function leaseFilter(request, token) {
  return { _id: request._id, status: { $in: ROUTABLE }, archivedAt: null,
    vendorId: null, selectedVendorId: null,
    "initialRouting.status": "processing", "initialRouting.leaseToken": token,
    "initialRouting.leaseUntil": { $gt: new Date() }, updatedAt: request.updatedAt };
}
async function write(request, token, fields) {
  const result = await MaintenanceRequest.updateOne(leaseFilter(request, token), { $set: fields });
  if (!result.matchedCount) {
    const err = new Error("Routing changed while initial work was running");
    err.code = "initial_routing_superseded";
    throw err;
  }
  nudge(request);
}
async function failClaim(request, token) {
  const failed = request.initialRouting.attempts >= MAX_ATTEMPTS;
  const fields = {
    "initialRouting.status": failed ? "failed" : "pending",
    "initialRouting.lastErrorCode": "initial_routing_failed",
    "initialRouting.attempts": Math.min(request.initialRouting.attempts, MAX_ATTEMPTS),
    "initialRouting.nextAttemptAt": new Date(Date.now() + (RETRY_MS[request.initialRouting.attempts - 1] || 0)),
    "initialRouting.leaseUntil": new Date(0),
  };
  if (failed) {
    fields.routingStatus = "paused";
    // Keep an already-prepared snapshot. Only create a failure result when
    // there is no search to review; Decisions must never be an empty dead end.
    fields.vendorRecommendationSnapshot = request.vendorRecommendationSnapshot || {
      version: new Date().toISOString(), candidateLedger: [], recommendations: [],
      decision: { actionType: "manual_vendor_assignment_required", approvalRequired: true,
        managerSummary: "Automatic vendor search could not finish. Search again or choose a vendor manually." },
      diagnostics: { outcomeCode: "initial_routing_failed" },
    };
  }
  await write(request, token, fields);
  if (failed) await notifyUser({ userId: request.landlordId, type: "decision_needed",
    title: "Vendor search needs your attention",
    message: "Automatic vendor search could not finish. Open the request to search again or choose a vendor.",
    metadata: { workOrderId: String(request._id) } });
}

async function processInitialRouting(id) {
  const now = new Date();
  const token = crypto.randomUUID();
  const claimed = await MaintenanceRequest.findOneAndUpdate({ _id: id, ...pendingInitialRouting(now) }, {
    $set: { "initialRouting.status": "processing", "initialRouting.leaseToken": token,
      "initialRouting.leaseUntil": new Date(now.getTime() + LEASE_MS) },
    $inc: { "initialRouting.attempts": 1 },
  }, { new: true });
  if (!claimed) return false;
  let request = await load(id);
  if (!request) return false;
  try {
    // A stopped/rejected/assigned request consumes its work without starting
    // anything. Older documents have no initialRouting and are never queried.
    if (!ROUTABLE.includes(request.status) || request.vendorId || request.selectedVendorId || request.archivedAt) {
      await MaintenanceRequest.updateOne({ _id: id, "initialRouting.leaseToken": token },
        { $set: { "initialRouting.status": "done" } });
      return false;
    }
    if (request.initialRouting.cleanupBefore) {
      const retired = { requestId: id, createdAt: { $lt: request.initialRouting.cleanupBefore } };
      const oldVisits = await VendorOutreach.find({ ...retired, appointmentId: { $ne: null } })
        .select("appointmentId vendorNameSnapshot").lean();
      for (const visit of oldVisits) if (visit.vendorNameSnapshot) {
        await Appointment.updateOne({ _id: visit.appointmentId, requestId: id, landlordId: request.landlordId,
          vendorNameSnapshot: null }, { $set: { vendorNameSnapshot: visit.vendorNameSnapshot } });
      }
      await VendorOutreach.deleteMany(retired);
      await write(request, token, { "initialRouting.cleanupBefore": null });
      request = await load(id);
    }
    // An expired third claim may be recovered to report failure, never to do a
    // fourth search. A finished outreach is reconciled before this check below.
    const prior = await VendorOutreach.findOne({ requestId: id }).sort({ createdAt: -1 });
    if (prior) {
      if (prior.status === "queued") {
        // The process could have died after the provider accepted the email.
        // Never resend blindly: expose the existing manual Resend action.
        await VendorOutreach.updateOne({ _id: prior._id, status: "queued" },
        { $set: { status: "delivery_failed", deliveryUnconfirmed: true, deliveryError: "Delivery could not be confirmed after a restart. Review before resending." } });
      }
      await write(request, token, { "initialRouting.status": "done" });
      if (["queued", "delivery_failed"].includes(prior.status)) await contactAttention(request);
      return true;
    }
    // A crash between a committed first-contact permission and outreach row
    // creation must recover that exact permission, not regenerate a new basis
    // or reinterpret a later global opt-out as the old authorization policy.
    const contactService = require('../vendor/firstContact.service');
    const retained = await require('../../models/FirstContactDecision').findOne({ requestId: id, landlordId: request.landlordId, mode: 'policy_auto_start', state: 'permitted' }).sort({ evaluatedAt: -1 }).lean();
    const retainedCandidate = retained ? findLedgerEntry(request.vendorRecommendationSnapshot, retained.candidateKey) : null;
    if (retainedCandidate && contactService.contactBasis(request, retainedCandidate) === retained.basisHash) {
      const currentPolicy = (await LandlordPolicy.findOne({ landlordId: request.landlordId }).lean()) || {};
      const vendor = retainedCandidate.vendorId ? await Vendor.findOne({ ...routableVendorFilter(request.landlordId), _id: retainedCandidate.vendorId }).lean() : null;
      if (!vendor?.email || vendor.verificationStatus !== 'trusted' || !evaluateHardConstraints(buildRequestContext(request, request.propertyId, request.unitId, currentPolicy), vendor).eligible) throw new Error('Vendor changed before contact recovery');
      const started = await require('../../controllers/request.controller').startActivatedOutreach({ request, candidate: retainedCandidate, draftMessage: retainedCandidate.draftMessage, actor: 'system', initialRoutingToken: token });
      if (started.code === 'initial_routing_superseded') return false;
      if (!started.sent && !started.scheduled) await contactAttention(request);
      request = await load(id);
      await write(request, token, { 'initialRouting.status': 'done', 'initialRouting.lastErrorCode': null });
      return true;
    }
    if (request.initialRouting.attempts > MAX_ATTEMPTS) {
      request.initialRouting.attempts = MAX_ATTEMPTS;
      await failClaim(request, token);
      return false;
    }
    const policy = (await LandlordPolicy.findOne({ landlordId: request.landlordId }).lean()) || {};
    const snapshot = await generateVendorRecommendations({
      request, property: request.propertyId, unit: request.unitId, policy,
    });
    await write(request, token, {
      vendorRecommendationSnapshot: rebuildSnapshotSections(snapshot), routingDecision: snapshot.decision.actionType,
      routingStatus: snapshot.decision.actionType === "manual_vendor_assignment_required" || !snapshot.recommendations?.length
        ? "paused" : snapshot.decision.approvalRequired ? "approval_needed" : "routed",
      quotaSnapshot: { limit: snapshot.decision.quotaLimit, generatedAt: snapshot.generatedAt },
    });
    // Record the completed preparation before any downstream approval/send work.
    // Logging it after delivery makes a real generation look newer than its send.
    await logAgentAction({ requestId: id, landlordId: request.landlordId, actor: "system",
      actionType: "vendor_recommendations_generated", summary: "Prepared vendor routing at submission",
      output: { approvalRequired: snapshot.decision.approvalRequired, decision: snapshot.decision.actionType } });
    request = await load(id);
    // Reuse the controller's approval/activation semantics, without inventing
    // fake Express requests or duplicating the candidate state machine.
    const routing = require("../../controllers/request.controller");
    const prepared = cloneSnapshot(request.vendorRecommendationSnapshot);
    await routing.ensureApprovalRequestForSnapshot({ request, snapshot: prepared });
    await write(request, token, { vendorRecommendationSnapshot: prepared });
    request = await load(id);
    const currentPolicy = (await LandlordPolicy.findOne({ landlordId: request.landlordId }).lean()) || {};
    if (JSON.stringify(policy) !== JSON.stringify(currentPolicy)) throw new Error("Policy changed during routing");
    const candidate = findLedgerEntry(prepared, prepared.decision.candidateKey);
    const gate = evaluateAutopilot({ request, policy: currentPolicy, candidate, decision: prepared.decision });
    if (gate.allowed) {
      try { await require("../billing/billingAccount.service").bookingSnapshot({ landlordId: request.landlordId, request }); }
      catch (error) {
        if (!error.code?.startsWith("billing_")) throw error;
        gate.allowed = false; gate.reasonCode = error.code;
        prepared.decision = { ...prepared.decision, approvalRequired: true, reasonCode: error.code, managerSummary: error.message };
        await write(request, token, { vendorRecommendationSnapshot: prepared, routingStatus: "paused" });
        await notifyUser({ userId: request.landlordId, type: "payment_overdue", title: "Billing setup is needed before vendor contact",
          message: error.message, metadata: { workOrderId: String(id), actionUrl: "/dashboard/billing" } });
        request = await load(id);
      }
    }
    if (gate.allowed) {
      const vendor = candidate?.vendorId ? await Vendor.findOne({ ...routableVendorFilter(request.landlordId), _id: candidate.vendorId }).lean() : null;
      const live = await Appointment.exists({ requestId: id, status: { $in: ["proposed", "awaiting_vendor", "awaiting_tenant", "scheduled", "work_verifying", "in_review", "disputed"] } });
      if (!vendor || !vendor.email || vendor.verificationStatus !== "trusted" ||
        !evaluateHardConstraints(buildRequestContext(request, request.propertyId, request.unitId, currentPolicy), vendor).eligible || live) {
        throw new Error("Vendor or booking changed during routing");
      }
      candidate.contact = { email: vendor.email, phone: vendor.phone || null, hasEmail: true };
      routing.activateCandidateState({ snapshot: prepared, candidateKey: candidate.candidateKey,
        actorUserId: null, activationType: "approved_for_contact", actor: "system" });
      const timeline = request.status === "approved" ? request.timeline : [...request.timeline,
        { status: "approved", actorRole: "system", note: "Vendor contact authorized by landlord policy", at: new Date() }];
      await write(request, token, { vendorRecommendationSnapshot: rebuildSnapshotSections(prepared),
        status: "approved", routingStatus: "routed", timeline });
      request = await load(id);
      // The required version-bound authorization audit is written by the
      // shared first-contact claim, before any provider work. Preparation is
      // not itself permission or proof of delivery.
      const started = await routing.startActivatedOutreach({ request, candidate: findLedgerEntry(request.vendorRecommendationSnapshot, candidate.candidateKey),
        draftMessage: candidate.draftMessage, actor: "system", initialRoutingToken: token });
      if (started.code === "initial_routing_superseded") return false;
      if (!started.sent && !started.scheduled) await contactAttention(request);
      // Sending updates the snapshot and updatedAt; reload before finishing.
      request = await load(id);
    }
    await write(request, token, { "initialRouting.status": "done", "initialRouting.lastErrorCode": null });
    return true;
  } catch (err) {
    if (err.code === "initial_routing_superseded") return false;
    console.error("[initialRouting] preparation failed", { requestId: String(id), code: "initial_routing_failed" });
    request = await load(id);
    if (request?.initialRouting?.leaseToken === token) {
      await failClaim(request, token).catch((failure) => {
        if (failure.code !== "initial_routing_superseded") console.error("[initialRouting] recovery write failed", failure.message);
      });
    }
    return false;
  }
}
async function sweepInitialRouting(now = new Date()) {
  const alerts = await MaintenanceRequest.find({workflowAlertPending:true}).limit(20).select('_id');
  for (const row of alerts) {
    const request = await load(row._id);
    if (request) await require('../notification/newRequestAlert.service').alertLandlordOfNewRequest({request,tenant:request.tenantId,unitNumber:request.unitId?.unitNumber});
  }
  const rows = await MaintenanceRequest.find(pendingInitialRouting(now)).sort({ urgency: 1, createdAt: 1 }).limit(20).select("_id").lean();
  for (const row of rows) await processInitialRouting(row._id);
  return rows.length;
}
function startInitialRoutingSweeper() {
  const run = () => sweepInitialRouting().catch((err) => console.error("[initialRouting] sweep failed", err.message));
  void run();
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
  return timer;
}
// Manual mutation wins over pending recovery. A live worker finishes first;
// returning a short retryable 409 is safer than overwriting its Mixed snapshot.
async function takeOverInitialRouting(request) {
  if (!request.initialRouting) return;
  if (request.initialRouting.cleanupBefore) {
    if (request.initialRouting.status === "failed") {
      await MaintenanceRequest.updateOne({ _id: request._id, "initialRouting.status": "failed", updatedAt: request.updatedAt },
        { $set: { "initialRouting.status": "pending", "initialRouting.attempts": 0, "initialRouting.nextAttemptAt": new Date() } });
    }
    const err = new Error("The reopened request is being prepared. Try again in a moment.");
    err.statusCode = 409; err.code = "routing_in_progress"; throw err;
  }
  if (request.initialRouting.status === "processing" && request.initialRouting.leaseUntil > new Date()) {
    const err = new Error("Vendor routing is being prepared. Try again in a moment.");
    err.statusCode = 409; err.code = "routing_in_progress"; throw err;
  }
  const result = await MaintenanceRequest.updateOne({ _id: request._id, updatedAt: request.updatedAt,
    "initialRouting.status": request.initialRouting.status },
  { $set: { "initialRouting.status": "done", "initialRouting.leaseUntil": new Date(0) } });
  if (!result.matchedCount) {
    const err = new Error("Routing changed. Refresh and try again.");
    err.statusCode = 409; err.code = "routing_in_progress"; throw err;
  }
  request.initialRouting.status = "done";
}
module.exports = { processInitialRouting, sweepInitialRouting, startInitialRoutingSweeper,
  pendingInitialRouting, takeOverInitialRouting, LEASE_MS, MAX_ATTEMPTS, RETRY_MS };
