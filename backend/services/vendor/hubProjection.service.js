// What a vendor sees in the hub.
//
// THIS IS A PRIVACY BOUNDARY, in the same sense as vendorBrief.service.js, and
// it inherits that file's rule rather than reimplementing it:
//
//   an offer the vendor has NOT accepted shows the PUBLIC brief — city, trade,
//   urgency, no street address, no tenant identity
//
// The hub is the one surface where a vendor sees several jobs at once, which
// makes it the easiest place to accidentally widen that boundary: it would be
// very natural to join everything and render it. So every row goes through
// buildPublicBrief, and the address only ever comes from the accepted branch.
//
// The second rule, inherited from the completion work: a vendor never learns
// approvedCeiling. It can hold the amount a manager authorised after a
// counter-offer, and a vendor who knows the manager's ceiling anchors every
// future quote to it.

const VendorOutreach = require("../../models/VendorOutreach");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const Appointment = require("../../models/Appointment");
const JobCompletion = require("../../models/JobCompletion");
const LedgerEntry = require("../../models/LedgerEntry");
const Landlord = require("../../models/Landlord");
const Property = require("../../models/Property");
const { buildPublicBrief } = require("./vendorBrief.service");

const OPEN_OFFER_STATUSES = ["sent", "viewed"];

/**
 * An opaque row reference, for React keys and support conversations.
 *
 * NOT the raw ObjectId. buildPublicBrief established the rule — a vendor never
 * learns an identifier that addresses anything else in the system — and the hub
 * has no reason to be the exception. Same six-character scheme, so a reference
 * a vendor reads out over the phone matches the one in the emailed brief.
 */
const opaqueRef = (prefix, id) => `${prefix}-${String(id).slice(-6).toUpperCase()}`;

/**
 * Offers still awaiting an answer.
 *
 * Public brief only — by definition the vendor has not accepted these, so
 * there is no address to show and no tenant to name.
 */
async function buildOpenOffers(identityId) {
  const outreaches = await VendorOutreach.find({
    identityId,
    status: { $in: OPEN_OFFER_STATUSES },
    responseDeadlineAt: { $gt: new Date() },
  })
    .sort({ responseDeadlineAt: 1 })
    .limit(25)
    .lean();

  if (!outreaches.length) return [];

  const requests = await MaintenanceRequest.find({
    _id: { $in: outreaches.map((o) => o.requestId) },
  }).lean();
  const requestById = new Map(requests.map((r) => [String(r._id), r]));

  const landlords = await Landlord.find({
    _id: { $in: [...new Set(outreaches.map((o) => String(o.landlordId)))] },
  })
    .select("firstName lastName companyName")
    .lean();
  const landlordById = new Map(landlords.map((l) => [String(l._id), l]));

  const properties = await Property.find({
    _id: { $in: requests.map((r) => r.propertyId).filter(Boolean) },
  })
    .select("name address")
    .lean();
  const propertyById = new Map(properties.map((p) => [String(p._id), p]));

  return outreaches
    .map((outreach) => {
      const request = requestById.get(String(outreach.requestId));
      if (!request) return null;

      // The SAME projection the emailed link uses. Not a hub-specific one —
      // a second implementation is a second thing to get wrong.
      const brief = buildPublicBrief({
        request,
        outreach,
        landlord: landlordById.get(String(outreach.landlordId)),
        property: propertyById.get(String(request.propertyId)),
      });

      return {
        kind: "offer",
        ref: brief.jobReference,
        jobReference: brief.jobReference,
        title: brief.shortTitle,
        trade: brief.trade,
        city: brief.city,
        urgencyLabel: brief.urgencyLabel,
        manager: brief.manager,
        respondBy: outreach.responseDeadlineAt,
        offeredWindows: brief.offeredWindows,
        // No token here. Answering an offer needs the emailed OFFER token, and
        // minting a fresh one from the hub would let a hub session bypass the
        // single-use guarantee the offer flow depends on.
        needsEmailLink: true,
      };
    })
    .filter(Boolean);
}

/**
 * Jobs the vendor has accepted and not yet finished.
 *
 * These DO carry a job link, minted fresh, because the vendor already accepted
 * and the job-scoped token is exactly what the completion surface expects.
 */
async function buildActiveJobs(identityId) {
  const appointments = await Appointment.find({
    $or: [{ status: { $in: ["awaiting_tenant", "scheduled", "work_verifying", "in_review", "disputed"] } },
      { bookingVersion: 2, status: "proposed" }],
  })
    .sort({ confirmedStart: 1 })
    .limit(50)
    .lean();

  // Appointment has no identityId, so the outreach is what ties a job to this
  // vendor. Filtering after the fact keeps that join in one place.
  const outreaches = await VendorOutreach.find({
    identityId,
    appointmentId: { $in: appointments.map((a) => a._id) },
  }).lean();
  const outreachByAppointment = new Map(
    outreaches.map((o) => [String(o.appointmentId), o])
  );

  const mine = appointments.filter((a) => outreachByAppointment.has(String(a._id)));
  if (!mine.length) return [];

  const requests = await MaintenanceRequest.find({
    _id: { $in: mine.map((a) => a.requestId) },
  })
    .select("issueTitle ai.shortTitle category urgency propertyId")
    .lean();
  const requestById = new Map(requests.map((r) => [String(r._id), r]));

  const properties = await Property.find({
    _id: { $in: requests.map((r) => r.propertyId).filter(Boolean) },
  })
    .select("name address")
    .lean();
  const propertyById = new Map(properties.map((p) => [String(p._id), p]));

  const completions = await JobCompletion.find({
    appointmentId: { $in: mine.map((a) => a._id) },
  })
    .select("appointmentId status report.submittedAt")
    .lean();
  const completionByAppointment = new Map(
    completions.map((c) => [String(c.appointmentId), c])
  );

  const rows = [];
  for (const appointment of mine) {
    const outreach = outreachByAppointment.get(String(appointment._id));
    const request = requestById.get(String(appointment.requestId));
    const property = request ? propertyById.get(String(request.propertyId)) : null;
    const completion = completionByAppointment.get(String(appointment._id));

    // No token minted here. The raw value is unrecoverable after the first
    // mint, so doing it per row returned null every time and the hub could
    // never actually open a job. The link is now issued on demand by
    // POST /vendor-hub/jobs/:ref/link, which rotates it.
    rows.push({
      kind: "active",
      ref: opaqueRef("JOB", outreach._id),
      jobReference: opaqueRef("JOB", outreach._id),
      title: request?.ai?.shortTitle || request?.issueTitle || "Maintenance job",
      address: property?.address || "",
      status: appointment.status,
      scheduledFor: appointment.confirmedStart || null,
      submittedAt: completion?.report?.submittedAt || null,
      completionStatus: completion?.status || null,
      // The client asks for a link when the vendor clicks through, so a fresh
      // one is always available and the old emailed copy is retired.
      //
      // Not while the tenant is still confirming the time: the job page only
      // admits scheduled jobs onward (jobToken.middleware), so "Open job" there
      // led to "That job is closed" -- false, and alarming. The vendor gets
      // their job link by email the moment the tenant confirms.
      canOpen: appointment.status !== "awaiting_tenant",
      canReschedule: appointment.bookingVersion === 2 && ["awaiting_tenant", "scheduled", "proposed"].includes(appointment.status),
    });
  }
  return rows;
}

/**
 * Finished work and what it paid.
 *
 * A vendor sees their OWN payout amounts — it is their invoice — but never the
 * landlord's ceiling, and never another vendor's anything.
 */
async function buildHistory(identityId, { limit = 25 } = {}) {
  const completions = await JobCompletion.find({
    identityId,
    closedAt: { $ne: null },
  })
    .sort({ closedAt: -1 })
    .limit(limit)
    .select("requestId appointmentId closedAt report.actualCost report.currency tenantConfirmation.rating")
    .lean();

  if (!completions.length) return [];

  const requests = await MaintenanceRequest.find({
    _id: { $in: completions.map((c) => c.requestId) },
  })
    .select("issueTitle ai.shortTitle")
    .lean();
  const requestById = new Map(requests.map((r) => [String(r._id), r]));

  const payouts = await LedgerEntry.find({
    identityId,
    type: "payout",
    completionId: { $in: completions.map((c) => c._id) },
  })
    .select("completionId amountCents currency providerStatus clearsOn createdAt")
    .lean();

  // Direct-pay jobs have no payout entry at all: the property manager pays
  // the vendor outside Artrelo and says so. Their state is on the appointment.
  const directAppointments = await Appointment.find({
    _id: { $in: completions.map((c) => c.appointmentId) },
    paymentMode: "direct",
  })
    .select("directPayment")
    .lean();
  const directByAppointment = new Map(directAppointments.map((a) => [String(a._id), a.directPayment || {}]));

  // A job can have TWO payout entries: what the manager's balance covered
  // (sent now) and an awaiting_funds remainder. One row per job: the total, the
  // status of the part that was sent, and how much is still coming.
  const payoutByCompletion = new Map();
  for (const entry of payouts) {
    const key = String(entry.completionId);
    const merged = payoutByCompletion.get(key) || {
      amountCents: 0,
      awaitingCents: 0,
      currency: entry.currency,
      providerStatus: null,
      clearsOn: null,
      createdAt: entry.createdAt,
    };
    merged.amountCents += entry.amountCents;
    if (entry.providerStatus === "awaiting_funds") merged.awaitingCents += entry.amountCents;
    else {
      merged.providerStatus = entry.providerStatus;
      merged.clearsOn = entry.clearsOn || null;
    }
    payoutByCompletion.set(key, merged);
  }

  return completions.map((completion) => {
    const request = requestById.get(String(completion.requestId));
    const payout = payoutByCompletion.get(String(completion._id));
    const direct = directByAppointment.get(String(completion.appointmentId));
    return {
      kind: "history",
      ref: opaqueRef("JOB", completion._id),
      title: request?.ai?.shortTitle || request?.issueTitle || "Maintenance job",
      closedAt: completion.closedAt,
      amount: completion.report?.actualCost ?? null,
      currency: completion.report?.currency || "CAD",
      rating: completion.tenantConfirmation?.rating ?? null,
      payout: direct
        ? {
            amount: (direct.amountCents || 0) / 100,
            currency: completion.report?.currency || "CAD",
            // The manager's word, not a transfer: "paid by your property
            // manager", or still owed by them. Never "sent to your account".
            status: direct.status === "paid" ? "direct_paid" : "direct_due",
            awaitingAmount: 0,
            expectedOn: null,
            at: direct.paidAt || direct.dueSince || null,
          }
        : payout
        ? {
            // Cents live in the ledger; the vendor sees dollars.
            amount: payout.amountCents / 100,
            currency: payout.currency,
            // Nothing sent yet when the whole job is waiting.
            status: payout.providerStatus || "awaiting_funds",
            awaitingAmount: payout.awaitingCents / 100,
            // On an awaiting_clearance payout: the day Stripe is expected to
            // have cleared the money, so the vendor reads a date, not "soon".
            expectedOn: payout.providerStatus === "awaiting_clearance" ? payout.clearsOn : null,
            at: payout.createdAt,
          }
        : null,
    };
  });
}

/** Everything the hub renders, for one identity. */
async function buildHubView(identity) {
  const identityId = identity._id;
  const [offers, active, history] = await Promise.all([
    buildOpenOffers(identityId),
    buildActiveJobs(identityId),
    buildHistory(identityId),
  ]);

  const aggregate = identity.aggregate || {};
  const ratingCount = aggregate.ratingCount || 0;

  return {
    vendor: {
      name: identity.displayName || "Your account",
      email: identity.emailNormalized || null,
      // Status only — a vendor never needs the Connect account id, and it is
      // one more identifier to leak.
      payouts: {
        status: identity.connectStatus || "none",
        onboardedAt: identity.connectOnboardedAt || null,
      },
      completedJobs: aggregate.completedJobs || 0,
      rating: ratingCount ? Math.round((aggregate.ratingSum / ratingCount) * 10) / 10 : null,
      ratingCount,
    },
    offers,
    active,
    history,
  };
}

module.exports = {
  buildHubView,
  buildOpenOffers,
  buildActiveJobs,
  buildHistory,
  OPEN_OFFER_STATUSES,
};
