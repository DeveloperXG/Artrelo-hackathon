const assert = require("assert");
const f = require("../../../services/request/requestWorkflow.service");
const {
  eligibility,
} = require("../../../services/request/creationEligibility.service");
const {
  summarizeQuota,
} = require("../../../services/request/requestQuota.service");
const {
  rankSimilar,
} = require("../../../services/request/similarRequests.service");
const {
  summarizeOutreach,
} = require("../../../services/request/outreachSummary.service");
const now = new Date("2026-10-21T12:00:00Z");
let quota = summarizeQuota([], now);
assert.ok(eligibility({ quota, now }).allowed);
assert.deepStrictEqual(
  eligibility({ quota, openCount: 2, linked: false, now }).reasons,
  ["unit_unlinked", "open_cap"],
);
quota = summarizeQuota([now, now, now], now);
assert.deepStrictEqual(eligibility({ quota, now }).reasons, ["daily_limit"]);
const request = {
  status: "queued",
  ai: {
    impact: "Cannot use the sink",
    location: { room: "kitchen" },
    timeline: { started: "yesterday" },
  },
  appointmentStatus: "none",
};
assert.strictEqual(f.deriveFollowUp(request), null);
const incomplete = { ...request, ai: { impact: "Cannot use the sink" } };
assert.deepStrictEqual(
  f.deriveFollowUp(incomplete).questions.map((q) => q.topicId),
  ["location", "timeline"],
);
const { ai, follow } = f.mergeAnswers(incomplete, [
  { topicId: "location", state: "answered", value: "Kitchen" },
  { topicId: "timeline", state: "unknown" },
]);
assert.strictEqual(ai.location.room, "Kitchen");
assert.strictEqual(follow.state, "ready_for_review");
assert.deepStrictEqual(follow.remainingTopics, ["timeline"]);
assert.throws(
  () => f.assertContactAllowed({ ...incomplete, intakeFollowUp: follow }),
  /Review the tenant/,
);
assert.doesNotThrow(() =>
  f.assertContactAllowed({
    ...incomplete,
    intakeFollowUp: { ...follow, state: "reviewed" },
  }),
);
assert.throws(
  () =>
    f.mergeAnswers(incomplete, [
      { topicId: "location", state: "answered", value: "unknown" },
    ]),
  /Invalid/,
);
assert.throws(
  () => f.assertEditable(incomplete, 20),
  (e) => e.code === "stale_revision",
);
assert.strictEqual(
  f.assessSafety({ message: "I smell gas now" }).state,
  "confirmed_hazard",
);
assert.strictEqual(
  f.assessSafety({
    message: "No smoke or sparks; it might be dangerous",
    tenantReported: true,
  }).state,
  "needs_review",
);
assert.strictEqual(
  f.assessSafety({ message: "The tap drips", triage: { urgency: "emergency" } })
    .state,
  "needs_review",
);
assert.strictEqual(
  f.assessSafety({ message: "No smoke or sparks" }).state,
  "none",
);
const rows = [
  {
    _id: "one",
    issueTitle: "Kitchen faucet dripping",
    issueDescription: "Water leaks from kitchen tap",
    createdAt: now,
  },
  {
    _id: "two",
    issueTitle: "Bathroom faucet dripping",
    issueDescription: "Bathroom sink leaks",
    createdAt: now,
  },
  {
    _id: "three",
    issueTitle: "Oven not working",
    issueDescription: "Oven has no power",
    createdAt: now,
  },
];
assert.deepStrictEqual(
  rankSimilar({ issueDescription: "Kitchen sink leaks" }, rows).map(
    (r) => r.id,
  ),
  ["one"],
);
assert.strictEqual(
  rankSimilar(
    {
      issueTitle: "Not working",
      issueDescription: "Refrigerator has no power",
    },
    rows,
  ).length,
  0,
);
assert.strictEqual(
  rankSimilar({ issueDescription: "Something is not working" }, rows).length,
  0,
);
assert.strictEqual(
  summarizeOutreach({ _id: "o", status: "queued" }).state,
  "preparing",
);
assert.strictEqual(
  summarizeOutreach({
    _id: "o",
    status: "delivery_failed",
    deliveryUnconfirmed: true,
  }).state,
  "unconfirmed",
);
assert.strictEqual(
  summarizeOutreach({ _id: "o", status: "sent", initiation: "landlord" })
    .initiation,
  "landlord",
);
console.log(
  "request workflow policy, essential questions, safety, similarity and outreach tests passed",
);
