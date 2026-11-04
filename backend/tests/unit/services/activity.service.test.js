// Landlord activity: one write per landlord per UTC day, and never a throw.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * the first touch of a day records a LandlordActivityDay row and moves
//     lastActiveAt; later touches the same day write nothing;
//   * a touch on the next day records again;
//   * the unique (landlordId, day) index losing a race (E11000) is not an error;
//   * a database failure never propagates -- it must not fail a sign-in.

const assert = require("assert");
const Landlord = require("../../../models/Landlord");
const LandlordActivityDay = require("../../../models/LandlordActivityDay");
const svc = require("../../../services/metrics/activity.service");

async function main() {
  const DAY = 24 * 60 * 60 * 1000;
  const t0 = new Date("2026-10-09T10:00:00.000Z");

  // A fake landlord collection: lastActiveAt per id, honouring the one filter
  // the service sends.
  const lastActive = new Map();
  const dayRows = new Set();
  let landlordUpdates = 0;
  let dayUpserts = 0;
  let dayFailure = null;

  Landlord.updateOne = async (filter, update) => {
    landlordUpdates += 1;
    const cur = lastActive.get(String(filter._id));
    const cutoff = filter.$or[1].lastActiveAt.$lt;
    const due = cur === undefined || cur < cutoff;
    if (due) lastActive.set(String(filter._id), update.$set.lastActiveAt);
    return { matchedCount: due ? 1 : 0 };
  };
  LandlordActivityDay.updateOne = async (filter) => {
    dayUpserts += 1;
    if (dayFailure) throw dayFailure;
    dayRows.add(`${filter.landlordId}|${filter.day}`);
    return {};
  };

  /* -------- 1) First touch of the day records; the rest are free -------- */
  svc.resetActivityCacheForTests();
  await svc.touchLandlordActivity("L1", t0);
  assert.strictEqual(dayRows.size, 1);
  assert.ok(dayRows.has("L1|2026-10-09"));

  await svc.touchLandlordActivity("L1", new Date(t0.getTime() + 3600_000));
  await svc.touchLandlordActivity("L1", new Date(t0.getTime() + 7200_000));
  assert.strictEqual(landlordUpdates, 1, "later touches the same day cost no database call");
  assert.strictEqual(dayUpserts, 1);

  /* -------- 2) The next UTC day records again --------------------------- */
  await svc.touchLandlordActivity("L1", new Date(t0.getTime() + DAY));
  assert.ok(dayRows.has("L1|2026-10-10"));
  assert.strictEqual(dayRows.size, 2);

  /* -------- 3) Another landlord is independent -------------------------- */
  await svc.touchLandlordActivity("L2", t0);
  assert.ok(dayRows.has("L2|2026-10-09"));

  /* -------- 4) Cache cold (restart) still writes at most one row -------- */
  svc.resetActivityCacheForTests();
  const before = dayUpserts;
  await svc.touchLandlordActivity("L1", new Date(t0.getTime() + DAY + 1000));
  assert.strictEqual(dayUpserts, before, "authoritative filter sees lastActiveAt is current -> no second row");

  /* -------- 5) A lost race on the unique index is fine ------------------ */
  svc.resetActivityCacheForTests();
  dayFailure = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
  await svc.touchLandlordActivity("L3", t0); // must not throw
  dayFailure = null;

  /* -------- 6) A database failure never propagates ---------------------- */
  svc.resetActivityCacheForTests();
  Landlord.updateOne = async () => {
    throw new Error("mongo down");
  };
  const origError = console.error;
  console.error = () => {};
  await svc.touchLandlordActivity("L4", t0); // must not throw
  await svc.touchLandlordActivity(null, t0); // nor on a missing id
  console.error = origError;

  /* -------- 7) The day boundary is UTC ---------------------------------- */
  assert.strictEqual(svc.dayKey(new Date("2026-10-09T23:59:59.999Z")), "2026-10-09");
  assert.strictEqual(svc.dayKey(new Date("2026-10-10T00:00:00.000Z")), "2026-10-10");

  console.log("activity.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
