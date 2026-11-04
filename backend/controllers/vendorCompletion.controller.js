// The vendor's post-visit surface. Unauthenticated: the job-scoped magic-link
// token IS the authorization, exactly as on the offer surface.
//
// Nothing here accepts a requestId, appointmentId, vendorId, or asset URL from
// the client. Every identifier comes from the token via requireJobToken, and
// photos are appended server-side to a draft rather than round-tripped through
// the browser — so the submit body carries no URLs at all and there is nothing
// client-supplied to validate into a landlord's record.

const Appointment = require("../models/Appointment");
const JobCompletion = require("../models/JobCompletion");
const MaintenanceRequest = require("../models/MaintenanceRequest");
const Property = require("../models/Property");
const VendorOutreach = require("../models/VendorOutreach");
const cloudinary = require("../services/upload/cloudinary.service");
const { logAgentAction } = require("../services/audit/agentAction.service");
const { notifyUser } = require("../services/notification/notify.service");
const { isDirectAppointment } = require("../services/ledger/paymentMode");
const { hashOpaque } = require("../services/vendor/vendorOutreach.service");
const { resolveBookedAmount } = require("../services/vendor/vendorCounterOffer.service");
const { evaluateCompletionEvidence } = require("../services/completion/evidenceCheck.service");
const LandlordPolicy = require("../models/LandlordPolicy");
const VendorIdentity = require("../models/VendorIdentity");
const env = require("../config/env");
const {
  syncConnectStatus,
  isConfigured: payoutsConfigured,
} = require("../services/ledger/payoutProvider.service");
const isConfigured = payoutsConfigured;
const {
  isOverCeiling,
  resolveApprovedCeiling,
  ensureCompletionOverageApproval,
  // ensureCompletionReviewApproval is deliberately NOT imported any more. The
  // evidence review is no longer raised at submit — completionSweeper raises it,
  // and only for a completion the tenant left unanswered.
} = require("../services/completion/jobCompletion.service");

const MAX_COMPLETION_PHOTOS = 8;
// 10MB, not the 25MB the authenticated intake route allows. The only
// unauthenticated upload surface in the API should not also carry the largest
// limit.
const MAX_BYTES = 10 * 1024 * 1024;

// Time the tenant has to answer before silence is treated as acceptance.
const AUTO_CONFIRM_MS = 48 * 60 * 60 * 1000;
const { finalStatement } = require("../services/quotes/submissionContract.service");

function badRequest(res, message) {
  return res.status(400).json({ success: false, message });
}

/**
 * Find-or-create the draft. The unique index on appointmentId is the real
 * guard; a concurrent first upload loses the create and re-reads the winner.
 */
async function ensureDraftCompletion({ appointment, jobToken }) {
  const existing = await JobCompletion.findOne({ appointmentId: appointment._id });
  if (existing) return existing;

  // Snapshotted, never read live: the outreach carrying the quote can be
  // superseded out from under a finished job.
  //
  // MUST go through resolveBookedAmount rather than reading response.quoteHigh.
  // A job booked via a confirmed counter-offer was agreed at counterOffer.amount,
  // and measuring the final invoice against the vendor's original (higher) quote
  // would mean the overage gate never fires on exactly the jobs a manager
  // negotiated down.
  let approvedCeiling = null;
  let approvedQuoteSnapshot = null;
  let quoteContractVersion;
  let outreachId = jobToken.outreachId || null;
  if (outreachId) {
    const outreach = await VendorOutreach.findById(outreachId)
      .select("response counterOffer quoteContractVersion currentQuoteRevision quoteRevisions approvedQuoteSnapshot")
      .lean();
    approvedCeiling = resolveBookedAmount(outreach);
    if (outreach?.quoteContractVersion === 2) {
      quoteContractVersion = 2;
      approvedQuoteSnapshot = outreach.approvedQuoteSnapshot ||
        outreach.quoteRevisions?.find(row => row.revision === outreach.currentQuoteRevision) || null;
    }
  }
  if (approvedCeiling === null) {
    const request = await MaintenanceRequest.findById(appointment.requestId)
      .select("estimatedCost")
      .lean();
    approvedCeiling = request?.estimatedCost ?? null;
  }

  try {
    return await JobCompletion.create({
      appointmentId: appointment._id,
      requestId: appointment.requestId,
      landlordId: appointment.landlordId,
      tenantId: appointment.tenantId,
      vendorId: appointment.vendorId || null,
      identityId: jobToken.identityId || null,
      outreachId,
      source: "vendor_portal",
      status: "draft",
      approvedCeiling,
      ...(quoteContractVersion === 2 ? { quoteContractVersion, approvedQuoteSnapshot } : {}),
    });
  } catch (err) {
    if (err?.code === 11000) return JobCompletion.findOne({ appointmentId: appointment._id });
    throw err;
  }
}

/** What the vendor sees about their own completion. */
function buildVendorCompletionView(completion) {
  // The no-completion-yet case must return the SAME SHAPE as the populated one.
  // Returning a short object here rendered "Photos (0/)" in the portal, because
  // there is no tsconfig in the frontend and a missing key is undefined at
  // runtime rather than a compile error.
  if (!completion) {
    return {
      status: "draft",
      photos: [],
      photoCount: 0,
      maxPhotos: MAX_COMPLETION_PHOTOS,
      checkedIn: false,
      report: null,
      awaitingTenant: false,
      autoConfirmAt: null,
      costReview: null,
    };
  }
  return {
    status: completion.status,
    ...(completion.quoteContractVersion === 2 ? { quoteContractVersion: 2 } : {}),
    photos: (completion.photos || []).map((photo) => ({
      url: photo.url,
      label: photo.label || null,
      stage: photo.stage || "after",
    })),
    photoCount: (completion.photos || []).length,
    maxPhotos: MAX_COMPLETION_PHOTOS,
    checkedIn: Boolean(completion.checkIn),
    report: completion.report?.submittedAt
      ? {
          workPerformed: completion.report.workPerformed || "",
          partsUsed: completion.report.partsUsed || "",
          actualCost: completion.report.actualCost ?? null,
          currency: completion.report.currency || "CAD",
          submittedAt: completion.report.submittedAt,
          ...(completion.quoteContractVersion === 2 ? {
            itemization: completion.report.finalStatement?.itemization || null,
            invoiceReference: completion.report.invoiceReference || null,
          } : {}),
        }
      : null,
    // The vendor is told the tenant is reviewing, but never what the evidence
    // check concluded — that would be a roadmap for the next submission.
    awaitingTenant: completion.status === "awaiting_tenant",
    autoConfirmAt: completion.autoConfirmAt || null,
    // A cost above the approved amount holds the close. Without this the vendor
    // sees "awaiting tenant" forever with a stale autoConfirmAt in the past,
    // which is indistinguishable from the system having lost their submission.
    //
    // PRIVACY: never the ceiling, and never the delta. `overage.amount` is the
    // DELTA over the ceiling — a vendor who knows their own actualCost and the
    // delta can subtract to recover approvedCeiling exactly. That the limit
    // exists is fine to say; what it is, is not.
    //
    // `approvedAmount` is the exception, and only once a decision exists: it is
    // what THIS vendor is being paid, which is their own invoice and no
    // reservation price of the manager's. Withholding it meant a vendor
    // approved at less than they invoiced saw "Cost approved" beside their
    // original figure and had no way to know the payout would differ.
    costReview: completion.overage?.isOver
      ? {
          status: completion.overage.decision || "pending",
          // Key OMITTED unless approved. While a decision is pending there is
          // no payout figure to disclose, and inventing one there would be a
          // pure leak with nothing gained.
          ...(completion.overage.decision === "approved"
            ? {
                approvedAmount:
                  completion.overage.approvedAmount ?? completion.report?.actualCost ?? null,
              }
            : {}),
        }
      : null,
  };
}

exports.getCompletion = async (req, res) => {
  try {
    const completion = req.jobCompletion || (await JobCompletion.findOne({
      appointmentId: req.appointment._id,
    }));
    const view = buildVendorCompletionView(completion);
    // GET stays read-only. A new job must advertise its server-required
    // contract before an upload/check-in happens to create the draft.
    if (!completion && req.appointment.bookingVersion === 2) {
      const outreach = await VendorOutreach.findOne({ appointmentId: req.appointment._id,
        landlordId: req.appointment.landlordId, requestId: req.appointment.requestId }).select("quoteContractVersion").lean();
      if (outreach?.quoteContractVersion === 2) view.quoteContractVersion = 2;
    }
    return res.json({
      success: true,
      data: {
        jobReference: `JOB-${String(req.jobToken.outreachId || req.jobToken._id).slice(-6).toUpperCase()}`,
        appointmentStatus: req.appointment.status,
        confirmedStart: req.appointment.confirmedStart || null,
        completion: view,
      },
    });
  } catch (err) {
    console.error("[getCompletion] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.uploadCompletionPhoto = async (req, res) => {
  try {
    if (!req.file) return badRequest(res, "No file provided");
    if (!cloudinary.isConfigured()) {
      return res.status(503).json({
        success: false,
        message: "Photo uploads are not available right now.",
      });
    }

    const completion = await ensureDraftCompletion({
      appointment: req.appointment,
      jobToken: req.jobToken,
    });
    if (!completion) return res.status(500).json({ success: false, message: "Server error" });

    if ((completion.photos || []).length >= MAX_COMPLETION_PHOTOS) {
      return res.status(409).json({
        success: false,
        code: "photo_limit_reached",
        message: `You can attach up to ${MAX_COMPLETION_PHOTOS} photos.`,
      });
    }

    const stage = req.body?.stage === "before" ? "before" : "after";
    const label = typeof req.body?.label === "string" ? req.body.label.trim().slice(0, 120) : "";

    // Folder is derived entirely from server state. uploadEvidence uses
    // req.user.id, which does not exist on this surface — and a client-supplied
    // path would let a token holder write into another landlord's namespace.
    const asset = await cloudinary.uploadBuffer(req.file.buffer, {
      folder: `ronarai/completions/${req.appointment.landlordId}/${req.appointment._id}`,
      resourceType: "image",
      filename: req.file.originalname,
      imageMetadata: true,
    });

    const photo = {
      ...asset,
      label: label || null,
      stage,
      exifTakenAt: asset.exifTakenAt || null,
      receivedAt: new Date(),
    };

    // Re-checks the cap inside the update so two concurrent uploads cannot both
    // pass the read above and push the array past the limit.
    const updated = await JobCompletion.findOneAndUpdate(
      {
        _id: completion._id,
        status: "draft",
        [`photos.${MAX_COMPLETION_PHOTOS - 1}`]: { $exists: false },
      },
      { $push: { photos: photo } },
      { new: true }
    );

    if (!updated) {
      return res.status(409).json({
        success: false,
        code: "photo_limit_reached",
        message: `You can attach up to ${MAX_COMPLETION_PHOTOS} photos.`,
      });
    }

    return res.status(201).json({ success: true, data: buildVendorCompletionView(updated) });
  } catch (err) {
    console.error("[uploadCompletionPhoto] error", err?.message || err);
    return res.status(500).json({ success: false, message: "Failed to upload photo" });
  }
};

/**
 * Arrival / departure ping.
 *
 * The coordinates are CLIENT-REPORTED and labelled as such on the way in — the
 * server cannot derive GPS, and storing them as though it could would create a
 * signal that reads like proof of presence in a dispute and isn't. What the
 * server does own is the timestamp and, at submit time, the distance
 * computation. A denied permission is recorded, not rejected: the vendor did
 * the work whether or not their browser let us look.
 */
exports.recordCheckpoint = async (req, res) => {
  try {
    const kind = req.body?.kind === "checkOut" ? "checkOut" : "checkIn";
    const denied = req.body?.denied === true;

    const stamp = { at: new Date(), source: "denied" };
    if (!denied) {
      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return badRequest(res, "Provide coordinates or set denied: true.");
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return badRequest(res, "Coordinates are out of range.");
      }
      stamp.source = "client_reported";
      stamp.lat = lat;
      stamp.lng = lng;
      const accuracy = Number(req.body?.accuracyMeters);
      if (Number.isFinite(accuracy) && accuracy >= 0) stamp.accuracyMeters = accuracy;
    }

    const completion = await ensureDraftCompletion({
      appointment: req.appointment,
      jobToken: req.jobToken,
    });
    if (!completion) return res.status(500).json({ success: false, message: "Server error" });

    if (!(await require("../services/vendor/workMutationFence.service").claim(req.appointment))) {
      return res.status(409).json({ success: false, code: "visit_time_changed", message: "The confirmed visit changed. Refresh the job before recording a work update." });
    }
    const updated = await JobCompletion.findOneAndUpdate(
      { _id: completion._id, status: "draft" },
      { $set: { [kind]: stamp } },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({
        success: false,
        code: "already_submitted",
        message: "You have already submitted your completion report for this job.",
      });
    }

    return res.json({ success: true, data: buildVendorCompletionView(updated) });
  } catch (err) {
    console.error("[recordCheckpoint] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

function validateCompletionSubmission(body) {
  const workPerformed = String(body?.workPerformed || "").trim();
  if (workPerformed.length < 10) {
    return { error: "Describe the work you carried out (at least 10 characters)." };
  }
  if (workPerformed.length > 2000) return { error: "Description must be 2000 characters or fewer." };

  const partsUsed = String(body?.partsUsed || "").trim();
  if (partsUsed.length > 1000) return { error: "Parts list must be 1000 characters or fewer." };

  const followUpNotes = String(body?.followUpNotes || "").trim();
  if (followUpNotes.length > 1000) return { error: "Follow-up notes must be 1000 characters or fewer." };

  // Only REQUIRED when the cost trips the ceiling, which cannot be known here —
  // the ceiling lives on the completion. Shape-checked now, demanded in
  // submitCompletion once the threshold has been evaluated.
  const overageReason = String(body?.overageReason || "").trim();
  if (overageReason.length > 1000) return { error: "Reason must be 1000 characters or fewer." };

  const actualCost = Number(body?.actualCost);
  if (!Number.isFinite(actualCost)) return { error: "Enter the final cost for this job." };
  if (actualCost < 0 || actualCost > 1000000) return { error: "Final cost is out of range." };

  // The vendor's claim about when they finished. Distrusted relative to the
  // server clock, but a wildly wrong value is worth rejecting outright.
  let completedAt = new Date();
  if (body?.completedAt) {
    completedAt = new Date(body.completedAt);
    if (Number.isNaN(completedAt.getTime())) return { error: "Completion time is not a valid date." };
    if (completedAt.getTime() > Date.now() + 60 * 60 * 1000) {
      return { error: "Completion time cannot be in the future." };
    }
    if (completedAt.getTime() < Date.now() - 30 * 24 * 60 * 60 * 1000) {
      return { error: "Completion time is too far in the past." };
    }
  }

  return {
    value: {
      workPerformed,
      partsUsed,
      followUpNeeded: body?.followUpNeeded === true,
      followUpNotes,
      actualCost,
      completedAt,
      overageReason,
    },
  };
}

exports.submitCompletion = async (req, res) => {
  try {
    const validation = validateCompletionSubmission(req.body);
    if (validation.error) return badRequest(res, validation.error);
    const submission = validation.value;

    const completion = await ensureDraftCompletion({
      appointment: req.appointment,
      jobToken: req.jobToken,
    });
    if (!completion) return res.status(500).json({ success: false, message: "Server error" });

    let itemized;
    try { itemized = finalStatement(completion, req.body); }
    catch (error) { return res.status(error.status || 400).json({ success: false,
      code: error.code, field: error.field, message: "Check the itemized final charges and total." }); }
    if (itemized) Object.assign(submission, itemized);

    const now = new Date();

    // Property coordinates are the only thing the distance check can be
    // measured against. Absent ones downgrade to review rather than pass —
    // an unverifiable claim is not a verified one.
    //
    // estimatedCost/landlordId come along for the ceiling resolution below.
    const request = await MaintenanceRequest.findById(req.appointment.requestId)
      .select("propertyId estimatedCost landlordId")
      .lean();

    /* -- The ceiling check, BEFORE anything is written. --------------------
     *
     * This used to happen only in closeJobCompletion, i.e. after the tenant
     * confirmed or 48h of silence elapsed. The vendor's submit succeeded, then
     * the job quietly failed to close days later — and the manager got an
     * approval carrying a number and no explanation, because the one person who
     * knew why it cost more was never asked.
     *
     * Same predicate as the close gate (isOverCeiling), so the two cannot
     * disagree about where the line is.
     */
    const policy = await LandlordPolicy.findOne({ landlordId: req.appointment.landlordId }).lean();
    const ceiling = await resolveApprovedCeiling({ completion, request, policy });
    const overCeiling = isOverCeiling({ actualCost: submission.actualCost, ceiling });

    if (overCeiling && !submission.overageReason) {
      // Deliberately reactive rather than announced up front: telling a vendor
      // the ceiling before they price the job anchors them to it. The response
      // carries no figure and no distance — a per-keystroke check endpoint would
      // let them binary-search the exact ceiling in about fifteen requests.
      return res.status(400).json({
        success: false,
        code: "overage_reason_required",
        message:
          "This is above the amount approved for this job. Add a short note explaining why, and your property manager will review it.",
      });
    }
    const property = request?.propertyId
      ? await Property.findById(request.propertyId).select("geo location coordinates").lean()
      : null;
    const propertyCoords =
      property?.geo?.lat !== undefined && property?.geo?.lng !== undefined ? property.geo : null;

    const evidence = evaluateCompletionEvidence({
      photos: completion.photos || [],
      checkIn: completion.checkIn || null,
      checkOut: completion.checkOut || null,
      propertyCoords,
      now,
      cloudinaryConfigured: cloudinary.isConfigured(),
    });

    // EVERY completion goes to the tenant, whatever the evidence said.
    //
    // They were physically in the room and they can see the actual repair, so on
    // the question this asks — "was it fixed?" — they are a better judge than a
    // manager reading a form. Parking weak evidence in in_review put the least
    // qualified person first and delayed the job for everyone.
    //
    // The verdict is still computed and still recorded: it now gates AUTO-CONFIRM
    // instead (see completionSweeper). Silence must not buy a photo-less job, but
    // a tenant who looks and says yes is a stronger signal than any photo.
    const nextStatus = "awaiting_tenant";

    if (!(await require("../services/vendor/workMutationFence.service").claim(req.appointment, now))) {
      return res.status(409).json({ success: false, code: "visit_time_changed", message: "The confirmed visit changed. Refresh the job before submitting the final statement." });
    }

    const updated = await JobCompletion.findOneAndUpdate(
      { appointmentId: req.appointment._id, status: "draft" },
      {
        $set: {
          status: nextStatus,
          evidenceVerdict: evidence.verdict,
          evidenceReasons: evidence.reasons,
          ...(itemized ? { invoiceReview: { state: "pending", quoteHash: itemized.finalStatement.hash } } : {}),
          ...(evidence.checkIn ? { checkIn: evidence.checkIn } : {}),
          ...(evidence.checkOut ? { checkOut: evidence.checkOut } : {}),
          // Always set now that every completion lands in awaiting_tenant. This
          // doubles as the escalation deadline: weak evidence that reaches it
          // unanswered is what pulls the manager in.
          autoConfirmAt: new Date(now.getTime() + AUTO_CONFIRM_MS),
          report: {
            ...submission,
            currency: "CAD",
            receivedAt: now,
            submittedAt: now,
            submitterIpHash: hashOpaque(req.ip),
            submitterUaHash: hashOpaque(req.get("user-agent")),
          },
        },
      },
      { new: true }
    );

    // Lost the race with a concurrent submit. Echo what landed rather than
    // erroring, exactly as the offer surface does.
    if (!updated) {
      const current = await JobCompletion.findOne({ appointmentId: req.appointment._id });
      return res.status(409).json({
        success: false,
        code: "already_submitted",
        message: "You have already submitted your completion report for this job.",
        data: current ? buildVendorCompletionView(current) : null,
      });
    }

    // Only the submit winner advances the appointment.
    await Appointment.updateOne(
      { _id: req.appointment._id, status: "scheduled" },
      { $set: { status: nextStatus === "awaiting_tenant" ? "work_verifying" : "in_review" } }
    );
    await MaintenanceRequest.updateOne(
      { _id: req.appointment.requestId },
      {
        $set: { appointmentStatus: nextStatus === "awaiting_tenant" ? "work_verifying" : "in_review" },
        // "in_progress", NOT the appointment status: StatusEventSchema.status
        // validates against STATUS_ENUM, which has no work_verifying.
        $push: {
          timeline: {
            status: "in_progress",
            note: "Vendor submitted completion evidence",
            actorRole: "vendor",
          },
        },
      }
    );

    // Tell the TENANT. Nothing did, before this.
    //
    // The only notification on this path went to the landlord, and only on the
    // weak-evidence branch — so a tenant was being asked a question that nothing
    // announced. Leaning the whole flow on their answer while never telling them
    // it was wanted would make silence the norm, and silence is what auto-confirm
    // reads as agreement.
    //
    // Reuses maintenance_verification_requested: the Notification type enum is
    // CLOSED and notifyUser swallows the ValidationError, so an invented type
    // would fail silently. Their Schedule badge counts awaiting_tenant
    // completions, so it lights up alongside this.
    try {
      await notifyUser({
        userId: req.appointment.tenantId,
        type: "maintenance_verification_requested",
        title: "Your repair is done — take a look",
        message: `${
          req.jobToken.vendorNameSnapshot || "The vendor"
        } submitted their completion. Confirm it's fixed, or tell us if it isn't.`,
        metadata: {
          workOrderId: String(req.appointment.requestId),
          appointmentId: String(req.appointment._id),
        },
      });
    } catch (err) {
      // Non-fatal: the submission is durably recorded, and the tenant still sees
      // it in the app whether or not the notification landed.
      console.error("[submitCompletion] tenant notification failed", err.message);
    }

    await logAgentAction({
      requestId: req.appointment.requestId,
      landlordId: req.appointment.landlordId,
      actor: "vendor",
      actionType: "vendor_completion_submitted",
      summary: `${req.jobToken.vendorNameSnapshot || "Vendor"} submitted completion evidence ($${submission.actualCost})`,
      input: { appointmentId: String(req.appointment._id), photoCount: (updated.photos || []).length },
      output: { verdict: evidence.verdict, reasons: evidence.reasons, status: nextStatus },
    });

    // Raise the overage approval NOW rather than waiting for the close attempt,
    // so the manager can rule while the tenant is still confirming instead of
    // after. closeJobCompletion still runs the same gate as a backstop, and
    // ensureCompletionOverageApproval dedups on payload.completionId, so the
    // second call reuses this row rather than raising a duplicate.
    //
    // Non-fatal: the report is already durably recorded, and the close gate
    // catches this regardless. Failing the vendor's submit here would help
    // nobody.
    let overageApproval = null;
    if (overCeiling) {
      try {
        overageApproval = await ensureCompletionOverageApproval({
          request: { _id: req.appointment.requestId, landlordId: req.appointment.landlordId },
          completion: updated,
          ceiling,
          actualCost: submission.actualCost,
          overageReason: submission.overageReason,
        });

        await JobCompletion.updateOne(
          { _id: updated._id },
          {
            $set: {
              "overage.isOver": true,
              "overage.amount": Math.round((submission.actualCost - ceiling) * 100) / 100,
              "overage.approvalRequestId": overageApproval._id,
              "overage.decision": "pending",
            },
          }
        );

        await logAgentAction({
          requestId: req.appointment.requestId,
          landlordId: req.appointment.landlordId,
          actor: "system",
          actionType: "completion_over_ceiling",
          summary: `Job submitted at $${submission.actualCost}, above the approved $${ceiling} — manager approval requested`,
          input: { completionId: updated._id.toString(), raisedAt: "submit" },
          output: {
            approvalRequestId: overageApproval._id.toString(),
            overageReason: submission.overageReason || null,
          },
        });
      } catch (err) {
        console.error("[submitCompletion] overage approval failed", err.message);
      }
    }

    if (updated.quoteContractVersion === 2) {
      try { await require("../services/quotes/review.service").queueRuntimeReview({ subjectId: updated._id,
        stage: "invoice", landlordId: req.appointment.landlordId }); }
      catch (_) { console.error("[submitCompletion] cost review preparation needs recovery"); }
    }

    // Re-read so costReview reflects the overage we just recorded, rather than
    // showing the vendor a clean "awaiting tenant" they'd have to refresh past.
    const fresh = overageApproval
      ? await JobCompletion.findOne({ _id: updated._id })
      : updated;

    return res.json({ success: true, data: buildVendorCompletionView(fresh || updated) });
  } catch (err) {
    console.error("[submitCompletion] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * Payout setup for the vendor holding this job token.
 *
 * Scoped to the VendorIdentity, not the landlord-scoped Vendor row — which is
 * the entire payoff for splitting them: a contractor working for three
 * landlords onboards to Stripe ONCE. Returns `alreadyEnabled` so the portal can
 * skip the whole step for a returning vendor.
 */
const DIRECT_PAY_MESSAGE = "Your property manager pays you directly for this job.";

const refuseDirectPay = (res) =>
  res.status(409).json({ success: false, code: "direct_pay", message: DIRECT_PAY_MESSAGE });

exports.getPayoutStatus = async (req, res) => {
  try {
    // A direct-pay job is paid by the property manager, outside Artrelo. The
    // vendor is not asked to set anything up -- and a job link cannot be used
    // to reach anyone's payout account.
    if (isDirectAppointment(req.appointment)) {
      return res.json({
        success: true,
        data: { supported: false, status: "none", reason: "direct_pay", message: DIRECT_PAY_MESSAGE },
      });
    }

    const identityId = req.jobToken.identityId;
    if (!identityId) {
      return res.json({
        success: true,
        data: { supported: false, status: "none", reason: "no_identity" },
      });
    }

    const identity = await VendorIdentity.findById(identityId);
    if (!identity) {
      return res.json({ success: true, data: { supported: false, status: "none" } });
    }

    // Cheap refresh so a vendor who just finished onboarding in another tab
    // sees it here without waiting for the webhook.
    const status = await syncConnectStatus(identity);
    return res.json({
      success: true,
      data: {
        supported: isConfigured(),
        status,
        alreadyEnabled: status === "enabled",
        // A returning vendor is reminded they're set up and can change it,
        // instead of the section simply disappearing.
        canUpdate: false,
        managementUrl: "/vendor-hub/sign-in",
      },
    });
  } catch (err) {
    console.error("[getPayoutStatus] error", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.MAX_COMPLETION_PHOTOS = MAX_COMPLETION_PHOTOS;
exports.MAX_BYTES = MAX_BYTES;
exports.AUTO_CONFIRM_MS = AUTO_CONFIRM_MS;
exports.buildVendorCompletionView = buildVendorCompletionView;
exports.validateCompletionSubmission = validateCompletionSubmission;
