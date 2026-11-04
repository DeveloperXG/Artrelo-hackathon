// Live send timing on a snapshot: what Approve contact would do right now.
// Computed per read from the vendor's live hours, never stored.

const assert = require("assert");
const env = require("../../../config/env");
env.outreach_timezone = "America/Regina";
const { normalizeHours } = require("../../../services/vendor/vendorHours");
const { decorateSendTiming } = require("../../../services/vendor/sendTiming.service");

const vendors = [
  {
    _id: "v-weekday",
    operatingHours: normalizeHours({
      preset: "custom",
      weekly: [1, 2, 3, 4, 5].map((day) => ({ day, open: "08:00", close: "15:00" })),
    }),
  },
  { _id: "v-always", operatingHours: normalizeHours({ preset: "always" }) },
];
let queried = 0;
const repo = {
  find: () => ({
    select: () => ({
      lean: async () => {
        queried += 1;
        return vendors;
      },
    }),
  }),
};

const FRI_6PM = new Date("2026-08-01T00:00:00.000Z");

async function main() {
  const entry = (key, vendorId) => ({ candidateKey: key, vendorId });
  const snapshot = {
    candidateLedger: [entry("weekday", "v-weekday"), entry("always", "v-always"), entry("ghost", null)],
    recommendations: [entry("weekday", "v-weekday")],
  };
  await decorateSendTiming(snapshot, { urgency: "medium" }, { now: FRI_6PM, vendorRepository: repo });
  assert.strictEqual(queried, 1, "one query for the whole snapshot");

  const weekday = snapshot.candidateLedger[0].sendTiming;
  assert.strictEqual(weekday.openNow, false);
  assert.strictEqual(weekday.sendNow, false);
  assert.strictEqual(weekday.scheduledFor, "2026-08-03T14:00:00.000Z");
  assert.match(weekday.scheduledForLabel, /Mon, Aug 3/);
  assert.match(weekday.hoursLabel, /Mon–Fri 8:00–15:00/);
  assert.deepStrictEqual(snapshot.recommendations[0].sendTiming, weekday, "sections are decorated too");

  const always = snapshot.candidateLedger[1].sendTiming;
  assert.strictEqual(always.openNow, true);
  assert.strictEqual(always.sendNow, true);
  assert.strictEqual(always.hoursLabel, "24/7");

  assert.strictEqual(snapshot.candidateLedger[2].sendTiming, null, "no vendor row, no claim");

  // An urgent job sends now even to a closed vendor.
  const urgent = { candidateLedger: [entry("weekday", "v-weekday")] };
  await decorateSendTiming(urgent, { urgency: "high" }, { now: FRI_6PM, vendorRepository: repo });
  assert.strictEqual(urgent.candidateLedger[0].sendTiming.sendNow, true);
  assert.strictEqual(urgent.candidateLedger[0].sendTiming.openNow, false, "still honestly closed");

  console.log("sendTiming.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
