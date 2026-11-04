// Keeps an outreach's offered time windows bookable as time passes.
//
// Windows are generated when the email goes out (deliverOutreach) and stored.
// A vendor can open the link hours later -- a normal-tier email sent at 3 PM
// has a deadline around 9 AM the next day, when its first window (8-12) is
// already running -- and used to be offered, and allowed to book, an arrival
// that had already passed. So whenever the page is read or submitted:
//
//   drop    a fixed window with too little time left to turn up in
//   clamp   a window already under way to start now (rounded up), keeping its
//           slotId so a vendor mid-form can still submit it
//   top up  when fewer than MIN_BOOKABLE fixed windows remain, append fresh
//           ones from buildOfferedWindows as of now, the tier's usual shape
//
// The flexible slot (low tier) has no times and is always kept.
//
// Slot ids come from start times (buildWindow), and top-up generates from now
// floored to the minute, so refreshing the same list twice gives the same
// result. Persisting still goes through a version check: two page loads at
// the same moment must not leave the vendor holding a slot id that the other
// write replaced.

const VendorOutreach = require("../../models/VendorOutreach");
const env = require("../../config/env");
const { buildOfferedWindows, formatWindowLabel } = require("./vendorOutreachPolicy.service");
const { resolveCandidateContact } = require("./vendorOutreach.service");

const MINUTE_MS = 60 * 1000;
// Less than this left in a window and there's no realistic arrival in it.
const MIN_REMAINING_MS = 30 * MINUTE_MS;
// Arrivals are offered on the quarter hour.
const STEP_MS = 15 * MINUTE_MS;
const MIN_BOOKABLE = 2;
// Matches the .slice(0, n) of each tier in buildOfferedWindows.
const TIER_MAX = { emergency: 3, urgent: 4, normal: 6, low: 6 };
// Only while the vendor can still answer.
const OPEN_STATUSES = ["sent", "viewed"];

const ceilToStep = (time) => Math.ceil(time / STEP_MS) * STEP_MS;
const isFixed = (window) => window?.kind !== "flexible" && window?.start && window?.end;

function plain(window) {
  const value = typeof window?.toObject === "function" ? window.toObject() : window;
  return {
    slotId: value.slotId,
    start: value.start ? new Date(value.start) : null,
    end: value.end ? new Date(value.end) : null,
    label: value.label,
    timeZone: value.timeZone,
    kind: value.kind || "window",
  };
}

function relabel(window, timeZone) {
  const label = formatWindowLabel(window.start, window.end, timeZone);
  return window.kind === "asap" ? `ASAP — ${label}` : label;
}

/**
 * Pure. Drops and clamps; does not top up. Returns the kept windows, whether
 * anything changed, and how many fixed windows are still bookable.
 */
function pruneWindows(windows, now = new Date(), timeZone = env.outreach_timezone) {
  const earliest = ceilToStep(now.getTime());
  let changed = false;
  const kept = [];
  for (const raw of windows || []) {
    const window = plain(raw);
    if (!isFixed(window)) {
      kept.push(window);
      continue;
    }
    const end = window.end.getTime();
    if (end - earliest < MIN_REMAINING_MS) {
      changed = true;
      continue;
    }
    if (window.start.getTime() < earliest) {
      window.start = new Date(earliest);
      window.label = relabel(window, window.timeZone || timeZone);
      changed = true;
    }
    kept.push(window);
  }
  return { windows: kept, changed, bookable: kept.filter(isFixed).length };
}

/** Pure. Appends fresh fixed windows that don't collide with the kept ones. */
function topUpWindows(kept, fresh, tier) {
  const max = TIER_MAX[tier] || 6;
  const ids = new Set(kept.map((window) => window.slotId));
  const fixed = kept.filter(isFixed);
  const overlaps = (candidate) =>
    fixed.some((window) => candidate.start < window.end && window.start < candidate.end);

  const additions = [];
  for (const raw of fresh || []) {
    const candidate = plain(raw);
    if (!isFixed(candidate) || ids.has(candidate.slotId) || overlaps(candidate)) continue;
    if (kept.length + additions.length >= max) break;
    additions.push(candidate);
    ids.add(candidate.slotId);
    fixed.push(candidate);
  }
  if (!additions.length) return { windows: kept, added: 0 };

  // Fixed windows in time order, the flexible slot (if any) last, as generated.
  const flexible = kept.filter((window) => !isFixed(window));
  const ordered = [...kept.filter(isFixed), ...additions].sort((a, b) => a.start - b.start);
  return { windows: [...ordered, ...flexible], added: additions.length };
}

/**
 * Refresh `outreach.offeredWindows` in place (and in the database) if time has
 * moved past any of them. Returns the outreach, with `windowsChanged` set.
 * No-op once the vendor has answered or the outreach has closed.
 */
async function refreshOutreachWindows(outreach, { now = new Date(), resolveContact = resolveCandidateContact } = {}) {
  if (!outreach || !OPEN_STATUSES.includes(outreach.status)) return { outreach, windowsChanged: false };
  // A negotiated proposal is an exact agreement. Never silently replace its
  // price/time with ordinary windows when the vendor opens an older email.
  if (outreach.negotiatedProposal?.start) return { outreach, windowsChanged: false };
  const timeZone = env.outreach_timezone;
  const pruned = pruneWindows(outreach.offeredWindows, now, timeZone);
  let windows = pruned.windows;
  let changed = pruned.changed;

  if (pruned.bookable < MIN_BOOKABLE) {
    // Only now is the vendor's profile worth a lookup: top-up honours their
    // hours exactly as the original generation did.
    const contact = await resolveContact({
      vendorId: outreach.vendorId,
      providerName: outreach.providerName,
      providerVendorId: outreach.providerVendorId,
    }).catch(() => null);
    const fresh = buildOfferedWindows({
      tier: outreach.tier,
      now: new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS),
      vendor: { businessHours: contact?.businessHours || null, operatingHours: contact?.operatingHours || null },
      timeZone,
    });
    const topped = topUpWindows(windows, fresh, outreach.tier);
    windows = topped.windows;
    changed = changed || topped.added > 0;
  }

  if (outreach.bookingVersion === 2 && outreach.identityId) {
    const calendar = require("./vendorCalendar.service");
    const { subtractBusy } = require("./calendarPolicy");
    const identityId = await calendar.canonicalId(outreach.identityId);
    const busy = await calendar.occupied(identityId);
    const fixed = windows.filter(isFixed);
    const free = subtractBusy(fixed, busy).map(window => ({ ...window,
      slotId: `${String(window.slotId).split("~")[0]}~${new Date(window.start).getTime()}`,
      label: relabel(window, window.timeZone || timeZone) }));
    const filtered = [...free, ...windows.filter(window => !isFixed(window))];
    changed = changed || JSON.stringify(filtered) !== JSON.stringify(windows);
    windows = filtered;
  }
  if (!changed) return { outreach, windowsChanged: false };

  const version = outreach.windowsVersion || 0;
  const saved = await VendorOutreach.findOneAndUpdate(
    { _id: outreach._id, windowsVersion: version === 0 ? { $in: [0, null] } : version },
    { $set: { offeredWindows: windows }, $inc: { windowsVersion: 1 } },
    { new: true }
  );
  if (saved) {
    outreach.offeredWindows = saved.offeredWindows;
    outreach.windowsVersion = saved.windowsVersion;
    return { outreach, windowsChanged: true };
  }
  // Another request refreshed first. Its list is the one to show and validate
  // against, so the vendor and the server agree on the slot ids.
  const current = await VendorOutreach.findById(outreach._id).select("offeredWindows windowsVersion").lean();
  if (current) {
    outreach.offeredWindows = current.offeredWindows;
    outreach.windowsVersion = current.windowsVersion;
  }
  return { outreach, windowsChanged: true };
}

/** Whether a stored window can still be booked at `now` (submit-time check). */
function isWindowBookable(window, now = new Date()) {
  if (!isFixed(window)) return true;
  return new Date(window.end).getTime() - ceilToStep(now.getTime()) >= MIN_REMAINING_MS;
}

module.exports = {
  pruneWindows,
  topUpWindows,
  refreshOutreachWindows,
  isWindowBookable,
  MIN_REMAINING_MS,
  MIN_BOOKABLE,
};
