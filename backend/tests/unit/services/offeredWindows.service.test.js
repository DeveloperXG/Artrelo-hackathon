// Offered windows stay bookable as time passes: past windows drop, a running
// window starts now, too few left tops up, and a slow vendor isn't punished.

const assert = require("assert");

const VendorOutreach = require("../../../models/VendorOutreach");
const {
  pruneWindows,
  topUpWindows,
  refreshOutreachWindows,
  isWindowBookable,
} = require("../../../services/vendor/offeredWindows.service");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const TZ = "America/Regina"; // UTC-6, no DST
// Tue Oct 13 2026, 9:07 a.m. Regina.
const NOW = new Date("2026-10-13T15:07:00Z");
const at = (iso) => new Date(iso);
const win = (slotId, startIso, endIso, kind = "window") => ({
  slotId,
  start: at(startIso),
  end: at(endIso),
  label: slotId,
  timeZone: TZ,
  kind,
});
const flexible = { slotId: "w-flexible-any-open-day", start: null, end: null, label: "Flexible", timeZone: TZ, kind: "flexible" };

async function main() {
  /* 1) prune --------------------------------------------------------------- */
  const pruned = pruneWindows(
    [
      win("gone", "2026-10-13T12:00:00Z", "2026-10-13T15:20:00Z"), // 13 min left after rounding: dropped
      win("running", "2026-10-13T14:00:00Z", "2026-10-13T18:00:00Z"), // 8-12, under way: clamped
      win("later", "2026-10-13T19:00:00Z", "2026-10-13T23:00:00Z"), // 1-5 PM: untouched
      flexible,
    ],
    NOW,
    TZ
  );
  assert.deepStrictEqual(pruned.windows.map((w) => w.slotId), ["running", "later", "w-flexible-any-open-day"]);
  const running = pruned.windows[0];
  assert.strictEqual(running.start.toISOString(), "2026-10-13T15:15:00.000Z", "clamped to now, rounded up to :15");
  assert.strictEqual(running.slotId, "running", "keeps its id so a vendor mid-form can still submit it");
  assert.match(running.label, /9:15 a\.m\. – 12:00 p\.m\./, "relabelled to the time that is left");
  assert.strictEqual(pruned.changed, true);
  assert.strictEqual(pruned.bookable, 2, "the flexible slot isn't counted as a fixed window");

  const untouched = pruneWindows([win("later", "2026-10-13T19:00:00Z", "2026-10-13T23:00:00Z")], NOW, TZ);
  assert.strictEqual(untouched.changed, false, "future windows are left exactly as they were");

  const asap = pruneWindows([win("w-asap-x", "2026-10-13T14:30:00Z", "2026-10-13T16:30:00Z", "asap")], NOW, TZ);
  assert.match(asap.windows[0].label, /^ASAP — /, "an emergency slot still reads as ASAP");

  /* 2) top up --------------------------------------------------------------- */
  const kept = [win("a", "2026-10-13T19:00:00Z", "2026-10-13T23:00:00Z"), flexible];
  const fresh = [
    win("a", "2026-10-13T19:00:00Z", "2026-10-13T23:00:00Z"), // same id: skipped
    win("clash", "2026-10-13T20:00:00Z", "2026-10-13T22:00:00Z"), // overlaps a: skipped
    win("b", "2026-10-14T14:00:00Z", "2026-10-14T18:00:00Z"),
    win("c", "2026-10-14T19:00:00Z", "2026-10-14T23:00:00Z"),
    flexible,
  ];
  const topped = topUpWindows(kept, fresh, "normal");
  assert.deepStrictEqual(topped.windows.map((w) => w.slotId), ["a", "b", "c", "w-flexible-any-open-day"]);
  assert.strictEqual(topped.added, 2);
  const capped = topUpWindows(kept, fresh, "emergency");
  assert.strictEqual(capped.windows.length, 3, "never more than the tier offers");

  /* 3) refresh: persists with a version check ------------------------------- */
  const writes = [];
  let raceLost = false;
  VendorOutreach.findOneAndUpdate = async (filter, update) => {
    writes.push({ filter, update });
    if (raceLost) return null;
    return { offeredWindows: update.$set.offeredWindows, windowsVersion: 1 };
  };
  VendorOutreach.findById = () => ({
    select: () => ({ lean: async () => ({ offeredWindows: [win("winner", "2026-10-14T14:00:00Z", "2026-10-14T18:00:00Z")], windowsVersion: 1 }) }),
  });
  const noContact = async () => ({ businessHours: null, operatingHours: null });

  // Normal tier, everything from yesterday's email is gone: tops up from now.
  const stale = {
    _id: "o1",
    status: "viewed",
    tier: "normal",
    windowsVersion: 0,
    offeredWindows: [win("old", "2026-10-13T14:00:00Z", "2026-10-13T15:10:00Z")],
  };
  let result = await refreshOutreachWindows(stale, { now: NOW, resolveContact: noContact });
  assert.strictEqual(result.windowsChanged, true);
  assert.ok(stale.offeredWindows.length >= 2, "topped back up to a real choice");
  assert.ok(stale.offeredWindows.every((w) => w.start > NOW), "nothing in the past");
  assert.deepStrictEqual(writes[0].filter.windowsVersion, { $in: [0, null] }, "guarded on the version it read");
  assert.deepStrictEqual(writes[0].update.$inc, { windowsVersion: 1 });

  // Same refresh twice gives the same ids: deterministic.
  const again = { ...stale, offeredWindows: [win("old", "2026-10-13T14:00:00Z", "2026-10-13T15:10:00Z")], windowsVersion: 0 };
  await refreshOutreachWindows(again, { now: new Date(NOW.getTime() + 20 * 1000), resolveContact: noContact });
  assert.deepStrictEqual(
    again.offeredWindows.map((w) => w.slotId),
    stale.offeredWindows.map((w) => w.slotId),
    "two refreshes in the same minute agree on slot ids"
  );

  // Lost the race: adopt the winner's list.
  raceLost = true;
  const racer = { ...stale, offeredWindows: [win("old", "2026-10-13T14:00:00Z", "2026-10-13T15:10:00Z")], windowsVersion: 0 };
  result = await refreshOutreachWindows(racer, { now: NOW, resolveContact: noContact });
  assert.deepStrictEqual(racer.offeredWindows.map((w) => w.slotId), ["winner"]);
  raceLost = false;

  // Nothing to do: no write, no contact lookup.
  writes.length = 0;
  let looked = false;
  const fine = {
    _id: "o2",
    status: "sent",
    tier: "normal",
    offeredWindows: [win("x", "2026-10-14T14:00:00Z", "2026-10-14T18:00:00Z"), win("y", "2026-10-14T19:00:00Z", "2026-10-14T23:00:00Z")],
  };
  result = await refreshOutreachWindows(fine, { now: NOW, resolveContact: async () => { looked = true; return {}; } });
  assert.strictEqual(result.windowsChanged, false);
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(looked, false, "the vendor profile is only fetched when a top-up is needed");

  // Answered outreach is frozen.
  const answered = { ...stale, status: "accepted", offeredWindows: [win("old", "2026-10-13T14:00:00Z", "2026-10-13T15:10:00Z")] };
  result = await refreshOutreachWindows(answered, { now: NOW, resolveContact: noContact });
  assert.strictEqual(result.windowsChanged, false);
  assert.strictEqual(answered.offeredWindows[0].slotId, "old");

  /* 4) bookable check ------------------------------------------------------- */
  assert.strictEqual(isWindowBookable(win("w", "2026-10-13T14:00:00Z", "2026-10-13T16:00:00Z"), NOW), true);
  assert.strictEqual(isWindowBookable(win("w", "2026-10-13T14:00:00Z", "2026-10-13T15:30:00Z"), NOW), false);
  assert.strictEqual(isWindowBookable(flexible, NOW), true);

  console.log("offeredWindows service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
