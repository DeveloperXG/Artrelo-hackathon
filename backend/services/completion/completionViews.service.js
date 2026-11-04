// The tenant-facing projection of a job completion.
//
// THIS FILE IS A PRIVACY BOUNDARY, in the same sense as
// services/vendor/vendorBrief.service.js — and for the same reason: hiding a
// field in the UI still ships it in the JSON, and anyone can read the network
// tab. A tenant must never see what the landlord is paying.
//
// The rule already exists elsewhere in the codebase and is inherited here:
// sanitizeTenantRequestPayload omits estimatedCost/finalCost, and
// listTenantAppointments strips the vendor's quote note. This does the same for
// the completion record.
//
//   buildTenantCompletionView(...)   -> safe for the tenant
//   buildLandlordCompletionView(...) -> the full picture, cost included
//
// If you add a field, add it to the correct function and extend
// tests/unit/services/completionViews.service.test.js, which asserts the tenant
// view contains none of the money values.

// The VENDOR is a third reader of this record, projected by
// buildVendorCompletionView in controllers/vendorCompletion.controller.js. It
// omits approvedCeiling, and that omission is now load-bearing rather than
// incidental: approvedCeiling used to be a copy of the vendor's own quoteHigh
// (harmless to echo back), but since counter-offers it can hold the amount the
// manager authorized. A vendor who learns the manager's ceiling anchors every
// future quote upward. Do not add it to the vendor view.

/** Never leaves this module. Everything here is landlord-only. */
const LANDLORD_ONLY_KEYS = [
  "actualCost",
  "approvedCeiling",
  "overage",
  "ledger",
  "evidenceVerdict",
  "evidenceReasons",
];

function buildCompletionPhotos(completion) {
  return (completion?.photos || [])
    .filter((photo) => photo?.url)
    .map((photo) => ({
      url: photo.url,
      label: photo.label || null,
      stage: photo.stage || "after",
    }));
}

/**
 * What the tenant sees when asked "was this actually fixed?".
 *
 * Deliberately excluded: actualCost, approvedCeiling, the overage block, the
 * ledger block, and the evidence verdict. The verdict is excluded on purpose
 * even though it is not money — telling a tenant "our checks flagged this
 * vendor" would bias the one honest signal we are asking them for.
 */
function buildTenantCompletionView(completion) {
  if (!completion) return null;

  return {
    status: completion.status,
    // The only states a tenant is asked to act on.
    needsVerification: completion.status === "awaiting_tenant",
    workPerformed: completion.report?.workPerformed || "",
    partsUsed: completion.report?.partsUsed || "",
    followUpNeeded: Boolean(completion.report?.followUpNeeded),
    followUpNotes: completion.report?.followUpNotes || "",
    completedAt: completion.report?.completedAt || null,
    photos: buildCompletionPhotos(completion),
    // Surfaced so the deadline can be shown in the UI. An auto-close the tenant
    // only discovers after the fact is how you lose their trust.
    autoConfirmAt: completion.autoConfirmAt || null,
    confirmation: completion.tenantConfirmation?.respondedAt
      ? {
          outcome: completion.tenantConfirmation.outcome,
          rating: completion.tenantConfirmation.rating ?? null,
          respondedAt: completion.tenantConfirmation.respondedAt,
          autoConfirmed: Boolean(completion.tenantConfirmation.autoConfirmed),
        }
      : null,
  };
}

/** The landlord's view. Money included — they are the one paying. */
function buildLandlordCompletionView(completion) {
  if (!completion) return null;

  return {
    ...buildTenantCompletionView(completion),
    actualCost: completion.report?.actualCost ?? null,
    ...(completion.quoteContractVersion === 2 ? {
      itemization: completion.report?.finalStatement?.itemization || null,
      invoiceReference: completion.report?.invoiceReference || null,
      invoiceReviewState: completion.invoiceReview?.state || "pending",
    } : {}),
    currency: completion.report?.currency || "CAD",
    approvedCeiling: completion.approvedCeiling ?? null,
    evidenceVerdict: completion.evidenceVerdict,
    evidenceReasons: completion.evidenceReasons || [],
    overage: completion.overage || null,
    checkIn: completion.checkIn || null,
    checkOut: completion.checkOut || null,
    payoutReleaseAt: completion.payoutReleaseAt || null,
    closedAt: completion.closedAt || null,
    closeReason: completion.closeReason || null,
    // Artrelo's fee on this job, as decided at the close. Dollars, like
    // actualCost. Null until the job closes, and null when no fee applies.
    serviceFee: completion.ledger?.serviceFee
      ? {
          amount: completion.ledger.serviceFee.listCents / 100,
          charged: completion.ledger.serviceFee.chargedCents / 100,
          waived: completion.ledger.serviceFee.waivedReason || null,
        }
      : null,
  };
}

module.exports = {
  buildTenantCompletionView,
  buildLandlordCompletionView,
  buildCompletionPhotos,
  LANDLORD_ONLY_KEYS,
};
