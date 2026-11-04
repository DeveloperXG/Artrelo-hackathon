// One row per landlord per UTC day on which they were active.
//
// WHY A ROW PER DAY, NOT A COUNTER OR A LAST-SEEN DATE. Landlord.lastActiveAt
// answers "when were they last here", which is enough to spot a lapsed account
// but cannot answer the question beta retention actually asks: "were they still
// using it 30, 60, 90 days in?" That needs the history, and history cannot be
// backfilled -- a day that was not recorded is gone. One tiny row per active
// day is the cheapest shape that keeps it (a landlord produces at most 365 a
// year).
//
// UTC on purpose: a deterministic day boundary that does not depend on the
// server's timezone or move when the host does.

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const LandlordActivityDaySchema = new Schema(
  {
    landlordId: { type: Schema.Types.ObjectId, ref: "Landlord", required: true },
    // "YYYY-MM-DD", UTC.
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The unique pair is what makes the upsert idempotent under two requests racing
// on the same day.
LandlordActivityDaySchema.index({ landlordId: 1, day: 1 }, { unique: true });

module.exports = mongoose.model("LandlordActivityDay", LandlordActivityDaySchema);
