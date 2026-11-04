// Live "when would outreach go out?" for each candidate on a snapshot.
//
// Computed on every read and never stored: a snapshot can be days old, and
// "open now" stored on Friday is a lie by Saturday. It uses the very helpers
// sendVendorOutreach decides with (resolveSendTiming, isOpenAt), against the
// vendor's live hours, so the Availability pill and the Approve dialog can't
// disagree with what actually happens on click.
//
// Landlord-only: the snapshot this decorates never reaches a vendor or tenant.

const env = require("../../config/env");
const Vendor = require("../../models/Vendor");
const { formatHours } = require("./vendorHours");
const {
  isOpenAt,
  nextOpeningAt,
  resolveOutreachTier,
  resolveSendTiming,
} = require("./vendorOutreachPolicy.service");

const label = (date, timeZone) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

/**
 * Adds `sendTiming` to every candidate on the snapshot's ledger and sections.
 * Mutates and returns the snapshot. One Vendor query per call.
 */
async function decorateSendTiming(snapshot, request, { now = new Date(), vendorRepository = Vendor } = {}) {
  const ledger = Array.isArray(snapshot?.candidateLedger) ? snapshot.candidateLedger : [];
  if (!ledger.length) return snapshot;

  const ids = [...new Set(ledger.map((entry) => entry.vendorId).filter(Boolean).map(String))];
  const vendors = ids.length
    ? await vendorRepository.find({ _id: { $in: ids } }).select("businessHours operatingHours").lean()
    : [];
  const hoursById = new Map(vendors.map((vendor) => [String(vendor._id), vendor]));

  const timeZone = env.outreach_timezone;
  const tier = resolveOutreachTier(request || {});

  const timingFor = (entry) => {
    const vendor = hoursById.get(String(entry.vendorId || ""));
    if (!vendor) return null;
    const profile = { businessHours: vendor.businessHours, operatingHours: vendor.operatingHours };
    const openNow = isOpenAt(profile, now, timeZone);
    const nextOpen = openNow ? null : nextOpeningAt(profile, now, timeZone);
    const timing = resolveSendTiming({ tier, vendor: profile, now, timeZone });
    return {
      openNow,
      nextOpenAt: nextOpen ? nextOpen.toISOString() : null,
      nextOpenLabel: nextOpen ? label(nextOpen, timeZone) : null,
      hoursLabel: formatHours(vendor.operatingHours) || vendor.businessHours || null,
      // What Approve contact would do right now.
      sendNow: timing.sendNow,
      scheduledFor: timing.sendNow ? null : timing.scheduledFor.toISOString(),
      scheduledForLabel: timing.sendNow ? null : label(timing.scheduledFor, timeZone),
    };
  };

  const byKey = new Map(ledger.map((entry) => [entry.candidateKey, timingFor(entry)]));
  const apply = (list) =>
    Array.isArray(list)
      ? list.forEach((entry) => {
          entry.sendTiming = byKey.get(entry.candidateKey) || null;
        })
      : null;
  apply(snapshot.candidateLedger);
  apply(snapshot.recommendations);
  apply(snapshot.eligibleButNotTopCandidates);
  apply(snapshot.heldCandidates);
  apply(snapshot.excludedCandidates);
  return snapshot;
}

module.exports = { decorateSendTiming };
