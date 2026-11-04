// An explicit landlord-only projection. Never return raw completion, outreach,
// ledger or appointment documents: they contain credentials and private hashes.
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const Appointment = require("../../models/Appointment");
const JobCompletion = require("../../models/JobCompletion");
const LedgerEntry = require("../../models/LedgerEntry");
const VendorOutreach = require("../../models/VendorOutreach");
const Vendor = require("../../models/Vendor");
const { authorizedPayable } = require("./completionRecovery.service");

const id = value => String(value?._id || value || "");
const stamp = value => value ? {
  source: value.source, at: value.at || null,
  lat: value.lat ?? null, lng: value.lng ?? null, accuracyMeters: value.accuracyMeters ?? null,
  distanceMeters: value.distanceMeters ?? null, verdict: value.verdict || null,
} : null;
const mediaUrl = value => /^https?:\/\//i.test(String(value || "")) ? value : null;

function buildVisit({ appointment, completion, payouts = [], vendorName }) {
  const direct = appointment.paymentMode === "direct";
  return {
    id: id(appointment), status: appointment.status, vendorName: vendorName || "Vendor", vendorId: id(appointment.vendorId) || null,
    scheduledStart: appointment.confirmedStart || null, scheduledEnd: appointment.confirmedEnd || null,
    createdAt: appointment.createdAt || null, completedAt: appointment.completedAt || null,
    failureReason: appointment.failureReason || null,
    noShow: appointment.noShowReport?.status ? {
      status: appointment.noShowReport.status, reportedAt: appointment.noShowReport.reportedAt || null,
      note: appointment.noShowReport.note || null, resolvedAt: appointment.noShowReport.resolvedAt || null,
    } : null,
    payment: { mode: direct ? "direct" : "platform",
      status: direct ? appointment.directPayment?.status || "not_recorded" : payouts.length ? "recorded" : "not_recorded",
      amountCents: direct ? appointment.directPayment?.amountCents ?? null : null,
      paidAt: direct ? appointment.directPayment?.paidAt || null : null,
      // A transfer's paid status is not bank-receipt verification.
      payouts: direct ? [] : payouts.map(entry => ({ id: id(entry), amountCents: entry.amountCents,
        status: entry.providerStatus, clearsOn: entry.clearsOn || null })),
    },
    report: completion ? {
      id: id(completion), status: completion.status, source: completion.source,
      submittedAt: completion.report?.submittedAt || null, completedAt: completion.report?.completedAt || null,
      workPerformed: completion.report?.workPerformed || "", partsUsed: completion.report?.partsUsed || "",
      followUpNeeded: Boolean(completion.report?.followUpNeeded), followUpNotes: completion.report?.followUpNotes || "",
      reportedCost: completion.report?.actualCost ?? null, currency: completion.report?.currency || "CAD",
      ...(completion.quoteContractVersion === 2 ? {
        itemization: completion.report?.finalStatement?.itemization || null,
        originalQuote: completion.approvedQuoteSnapshot?.itemization || null,
        invoiceReference: completion.report?.invoiceReference || null,
        invoiceReviewState: completion.invoiceReview?.state || "pending",
      } : {}),
      finalCost: completion.status === "closed" && completion.closedAt
        ? completion.closeRecovery?.payableCents != null ? completion.closeRecovery.payableCents / 100
          : typeof completion.report?.actualCost === "number" ? authorizedPayable(completion) : null
        : null,
      approvedCeiling: completion.approvedCeiling ?? null,
      approvedOverage: completion.overage?.decision === "approved" ? completion.overage.approvedAmount ?? null : null,
      closedAt: completion.closedAt || null, closeReason: completion.closeReason || null,
      needsReview: Boolean(completion.closeRecovery?.attentionClaimedAt),
      checkIn: stamp(completion.checkIn), checkOut: stamp(completion.checkOut),
      evidenceVerdict: completion.evidenceVerdict || "review", evidenceReasons: completion.evidenceReasons || [],
      evidenceReviewedAt: completion.evidenceReviewedAt || null,
      photos: (completion.photos || []).filter(photo => mediaUrl(photo.url)).map(photo => ({
        url: photo.url, type: photo.type || "image", stage: photo.stage || "after", label: photo.label || null,
        receivedAt: photo.receivedAt || null, exifTakenAt: photo.exifTakenAt || null,
      })),
      confirmation: completion.tenantConfirmation?.respondedAt ? {
        outcome: completion.tenantConfirmation.outcome, rating: completion.tenantConfirmation.rating ?? null,
        comment: completion.tenantConfirmation.comment || null, respondedAt: completion.tenantConfirmation.respondedAt,
        autoConfirmed: Boolean(completion.tenantConfirmation.autoConfirmed),
      } : null,
    } : null,
  };
}

async function getWorkRecord({ requestId, landlordId }) {
  // Archived requests remain accessible. Check ownership before any related reads.
  const request = await MaintenanceRequest.findOne({ _id: requestId, landlordId })
    .select("_id landlordId status archivedAt finalCost completedAt").lean();
  if (!request) return null;
  const scope = { requestId: request._id, landlordId };
  const [appointments, completions, payouts, outreach] = await Promise.all([
    Appointment.find(scope).select("_id vendorId vendorNameSnapshot status confirmedStart confirmedEnd createdAt completedAt paymentMode directPayment failureReason noShowReport").sort({ createdAt: 1, _id: 1 }).lean(),
    JobCompletion.find(scope).lean(),
    LedgerEntry.find({ ...scope, type: "payout" }).select("_id appointmentId amountCents providerStatus clearsOn").lean(),
    VendorOutreach.find(scope).select("appointmentId vendorNameSnapshot").lean(),
  ]);
  const vendors = await Vendor.find({ _id: { $in: appointments.map(row => row.vendorId).filter(Boolean) } })
    .select("_id name").lean();
  return { requestId: id(request), status: request.status, archivedAt: request.archivedAt || null,
    finalCost: request.status === "completed" ? request.finalCost ?? null : null,
    visits: appointments.map(appointment => buildVisit({ appointment,
      completion: completions.find(row => id(row.appointmentId) === id(appointment)),
      payouts: payouts.filter(row => id(row.appointmentId) === id(appointment)),
      vendorName: appointment.vendorNameSnapshot || outreach.find(row => id(row.appointmentId) === id(appointment))?.vendorNameSnapshot ||
        vendors.find(row => id(row) === id(appointment.vendorId))?.name,
    })),
  };
}
module.exports = { getWorkRecord, buildVisit };
