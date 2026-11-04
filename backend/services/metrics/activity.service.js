// Records that a landlord was active today.
//
// This is the only beta metric whose data did not already exist. Requests,
// appointments, approvals and the ledger are all in the database; "was this
// landlord still using the product 60 days in" is not, because lastLogin is
// written on password sign-in only. A landlord who stays signed in through
// refresh cookies looks idle forever.
//
// Hooked into the three places a landlord demonstrably acts: signing in,
// refreshing a session, and any audited decision (logAgentAction with
// actor "landlord").
//
// BEST EFFORT, LIKE THE AUDIT LOG. A failed bookkeeping write must never fail
// the sign-in or the decision it is recording, so this never throws.

const Landlord = require("../../models/Landlord");
const LandlordActivityDay = require("../../models/LandlordActivityDay");

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 5000;

// landlordId -> day key already recorded by THIS process. logAgentAction fires
// many times per request, so without this every audited action would cost a
// database round-trip to learn something that cannot have changed. It is only
// an optimisation: the conditional update below is what is authoritative, so a
// restart or a second instance just does one redundant write.
const seenToday = new Map();

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date) {
  return new Date(Math.floor(date.getTime() / DAY_MS) * DAY_MS);
}

async function touchLandlordActivity(landlordId, now = new Date()) {
  try {
    if (!landlordId) return;
    const id = String(landlordId);
    const day = dayKey(now);
    if (seenToday.get(id) === day) return;

    // Only the first touch of the day matches: later ones find lastActiveAt
    // already at or past the start of today and do nothing, which is what keeps
    // this to one write per landlord per day.
    const res = await Landlord.updateOne(
      { _id: landlordId, $or: [{ lastActiveAt: null }, { lastActiveAt: { $lt: startOfUtcDay(now) } }] },
      { $set: { lastActiveAt: now } }
    );

    if ((res?.matchedCount ?? res?.n ?? 0) > 0) {
      try {
        await LandlordActivityDay.updateOne(
          { landlordId, day },
          { $setOnInsert: { landlordId, day } },
          { upsert: true }
        );
      } catch (err) {
        // A race on the unique index means another request already wrote it.
        if (err?.code !== 11000) throw err;
      }
    }

    if (seenToday.size >= CACHE_LIMIT) seenToday.clear();
    seenToday.set(id, day);
  } catch (err) {
    console.error("[activity.service] touch failed", err?.message || err);
  }
}

function resetActivityCacheForTests() {
  seenToday.clear();
}

module.exports = { touchLandlordActivity, dayKey, startOfUtcDay, resetActivityCacheForTests };
