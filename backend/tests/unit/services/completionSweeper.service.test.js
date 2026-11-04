// The two completion timers.
//
// The filters are pure and tested directly (same approach as
// expiredOutreachFilter). The sweep passes are tested for the property that
// actually matters: a claim that loses the race must NOT go on to close the
// job, because the tenant answering and the sweeper auto-confirming in the same
// tick must produce exactly one outcome.

const assert = require("assert");

const JobCompletion = require("../../../models/JobCompletion");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const AgentActionLog = require("../../../models/AgentActionLog");
const { Notification } = require("../../../models/Notification");

const NOW = new Date("2026-08-06T12:00:00.000Z");

AgentActionLog.create = async () => ({});
Notification.create = async () => ({});

const {
  dueForAutoConfirmFilter,
  dueForEvidenceEscalationFilter,
  dueForPayoutReleaseFilter,
  sweepAutoConfirm,
  sweepPayoutRelease,
  GRACE_MS,
} = require("../../../services/completion/completionSweeper.service");

/* ---------------- 1) Auto-confirm filter ------------------------------- */

const autoFilter = dueForAutoConfirmFilter(NOW);

// ONLY awaiting_tenant. Every completion now lands there — the tenant is asked
// whatever the evidence said — so the evidence guard moved from the state
// machine into this filter's $or.
assert.strictEqual(autoFilter.status, "awaiting_tenant");
assert.strictEqual(
  new Date(autoFilter.autoConfirmAt.$lte).toISOString(),
  new Date(NOW.getTime() - GRACE_MS).toISOString(),
  "the grace period must be subtracted, not added"
);
// A null deadline must never match — a draft has no timer.
assert.strictEqual(autoFilter.autoConfirmAt.$ne, null);

// Silence only buys evidence that cleared the checks, or that a human has
// already looked at.
assert.deepStrictEqual(
  autoFilter.$or,
  [{ evidenceVerdict: "pass" }, { evidenceReviewedAt: { $ne: null } }],
  "auto-confirm requires a pass OR a completed review"
);

/* ---------------- 1b) The two passes are exact complements ------------- */
//
// This is the property that replaced "weak evidence is structurally unreachable
// from the sweeper". It is no longer unreachable — every completion sits in
// awaiting_tenant now — so the guarantee has to be that exactly one of the two
// passes can ever claim a given row. A completion matching both would race
// itself: auto-confirm would pay a job the escalation pass is sending to a human.

const escalationFilter = dueForEvidenceEscalationFilter(NOW);

assert.strictEqual(escalationFilter.status, "awaiting_tenant");
assert.strictEqual(
  new Date(escalationFilter.autoConfirmAt.$lte).toISOString(),
  new Date(NOW.getTime() - GRACE_MS).toISOString(),
  "both passes wait out the same grace period"
);
assert.strictEqual(escalationFilter.autoConfirmAt.$ne, null);
assert.deepStrictEqual(escalationFilter.evidenceVerdict, { $ne: "pass" });
assert.strictEqual(escalationFilter.evidenceReviewedAt, null);

// Evaluate both filters against every combination that reaches the deadline.
const matchesAuto = (c) =>
  c.status === "awaiting_tenant" && (c.evidenceVerdict === "pass" || c.evidenceReviewedAt !== null);
const matchesEscalation = (c) =>
  c.status === "awaiting_tenant" && c.evidenceVerdict !== "pass" && c.evidenceReviewedAt === null;

for (const evidenceVerdict of ["pass", "review", "fail"]) {
  for (const evidenceReviewedAt of [null, NOW]) {
    const completion = { status: "awaiting_tenant", evidenceVerdict, evidenceReviewedAt };
    const auto = matchesAuto(completion);
    const escalate = matchesEscalation(completion);
    assert.ok(
      !(auto && escalate),
      `${evidenceVerdict}/${evidenceReviewedAt ? "reviewed" : "unreviewed"} must not match both passes`
    );
    assert.ok(
      auto || escalate,
      `${evidenceVerdict}/${evidenceReviewedAt ? "reviewed" : "unreviewed"} must match one pass — a due completion cannot be stranded`
    );
  }
}

// The specific cases worth naming.
assert.ok(matchesAuto({ status: "awaiting_tenant", evidenceVerdict: "pass", evidenceReviewedAt: null }),
  "good evidence + silence auto-confirms");
assert.ok(matchesEscalation({ status: "awaiting_tenant", evidenceVerdict: "review", evidenceReviewedAt: null }),
  "weak evidence + silence goes to the manager instead of paying out");
assert.ok(matchesAuto({ status: "awaiting_tenant", evidenceVerdict: "review", evidenceReviewedAt: NOW }),
  "weak evidence a manager ALREADY approved auto-confirms — this is what stops the escalation looping forever");

/* ---------------- 2) Payout-release filter ----------------------------- */

const payoutFilter = dueForPayoutReleaseFilter(NOW);
assert.strictEqual(payoutFilter.status, "confirmed");
assert.strictEqual(payoutFilter.closedAt, null, "an already-closed job must never re-release");
assert.strictEqual(payoutFilter.payoutReleaseAt.$ne, null);
assert.strictEqual(
  new Date(payoutFilter.payoutReleaseAt.$lte).toISOString(),
  new Date(NOW.getTime() - GRACE_MS).toISOString()
);

// The two filters are disjoint: nothing can be swept by both passes in one tick.
assert.notStrictEqual(autoFilter.status, payoutFilter.status);

/* ---------------- 3) Purity -------------------------------------------- */

assert.deepStrictEqual(dueForAutoConfirmFilter(NOW), dueForAutoConfirmFilter(NOW));
const later = dueForAutoConfirmFilter(new Date(NOW.getTime() + 60000));
assert.notStrictEqual(
  new Date(later.autoConfirmAt.$lte).getTime(),
  new Date(autoFilter.autoConfirmAt.$lte).getTime()
);

async function main() {
  /* -------------- 4) A lost claim must not close the job --------------- */

  MaintenanceRequest.findById = () => ({
    select: () => ({ lean: async () => ({ status: "in_progress" }) }),
  });

  JobCompletion.find = () => ({
    select: () => ({ lean: async () => [{ _id: "c1", requestId: "req-1" }] }),
  });

  // The tenant answered in the same tick, so the conditional update matches
  // nothing.
  let claimAttempts = 0;
  JobCompletion.findOneAndUpdate = async () => {
    claimAttempts += 1;
    return null;
  };

  const confirmed = await sweepAutoConfirm(NOW);
  assert.strictEqual(claimAttempts, 1, "the claim must still be attempted");
  assert.strictEqual(confirmed, 0, "a lost claim must not be counted as auto-confirmed");

  /* -------------- 5) A won claim sets the trailing window -------------- */

  let claimed = null;
  JobCompletion.findOneAndUpdate = async (filter, update) => {
    assert.strictEqual(filter.status, "awaiting_tenant", "the claim must be conditional");
    claimed = update.$set;
    return {
      _id: "c1",
      requestId: { toString: () => "req-1" },
      landlordId: "l1",
      tenantId: "t1",
      autoConfirmAt: NOW,
      payoutReleaseAt: claimed.payoutReleaseAt,
    };
  };

  const won = await sweepAutoConfirm(NOW);
  assert.strictEqual(won, 1);
  assert.strictEqual(claimed.status, "confirmed");
  assert.strictEqual(claimed["tenantConfirmation.autoConfirmed"], true);

  // Auto-confirm must NOT release money. The trailing window is the whole
  // reason a silent confirmation stays reversible.
  assert.ok(
    claimed.payoutReleaseAt > NOW,
    "auto-confirm must schedule the payout later, never release it immediately"
  );

  /* -------------- 6) A terminal request is skipped entirely ------------ */

  MaintenanceRequest.findById = () => ({
    select: () => ({ lean: async () => ({ status: "cancelled" }) }),
  });
  let touched = false;
  JobCompletion.findOneAndUpdate = async () => {
    touched = true;
    return null;
  };
  const skipped = await sweepAutoConfirm(NOW);
  assert.strictEqual(skipped, 0);
  assert.strictEqual(touched, false, "a cancelled request must not be claimed at all");

  /* -------------- 7) Payout release delegates to the close path -------- */

  MaintenanceRequest.findById = () => ({
    select: () => ({ lean: async () => ({ status: "in_progress" }) }),
  });

  const jobCompletionService = require("../../../services/completion/jobCompletion.service");
  const calls = [];
  const realClose = jobCompletionService.closeJobCompletion;
  // The sweeper captured this binding at require time, so patch the module
  // object the same way the runtime resolves it.
  require.cache[require.resolve("../../../services/completion/jobCompletion.service")].exports
    .closeJobCompletion = async (args) => {
    calls.push(args);
    return { closed: true };
  };

  // Re-require the sweeper so it picks up the patched close function.
  delete require.cache[
    require.resolve("../../../services/completion/completionSweeper.service")
  ];
  const patched = require("../../../services/completion/completionSweeper.service");
  const closedCount = await patched.sweepPayoutRelease(NOW);

  assert.strictEqual(closedCount, 1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].completionId, "c1");
  assert.strictEqual(calls[0].reason, "auto_confirmed");

  require.cache[require.resolve("../../../services/completion/jobCompletion.service")].exports
    .closeJobCompletion = realClose;

  /* -------------- 8) Escalation: the ONLY path to the manager ---------- */
  //
  // Weak evidence plus a tenant who never answered. This is what replaced the
  // submit-time review gate, and it is a much smaller set: a tenant who looks
  // and confirms closes the job however few photos the vendor uploaded.

  const jcExports = require.cache[
    require.resolve("../../../services/completion/jobCompletion.service")
  ].exports;
  const realEnsureReview = jcExports.ensureCompletionReviewApproval;
  const reviewsRaised = [];
  jcExports.ensureCompletionReviewApproval = async (args) => {
    reviewsRaised.push(args);
    return { _id: { toString: () => "review-1" } };
  };

  delete require.cache[
    require.resolve("../../../services/completion/completionSweeper.service")
  ];
  const withReview = require("../../../services/completion/completionSweeper.service");

  const Appointment = require("../../../models/Appointment");
  const Vendor = require("../../../models/Vendor");
  Appointment.updateOne = async () => ({ modifiedCount: 1 });
  Vendor.findById = () => ({ select: () => ({ lean: async () => ({ name: "Prairie Plumbing" }) }) });

  const savedRequest = {
    _id: "req-1",
    landlordId: "l1",
    appointmentStatus: "work_verifying",
    routingStatus: "routed",
    save: async function save() {
      return this;
    },
  };
  MaintenanceRequest.findById = (id) => {
    // requestIsStillOpen calls .select().lean(); the escalation body awaits the
    // document itself. One stub has to satisfy both shapes.
    void id;
    const chain = {
      select: () => ({ lean: async () => ({ status: "in_progress" }) }),
      then: (resolve, reject) => Promise.resolve(savedRequest).then(resolve, reject),
    };
    return chain;
  };

  let escalationClaim = null;
  JobCompletion.findOneAndUpdate = async (filter, update) => {
    escalationClaim = { filter, update };
    return {
      _id: { toString: () => "c1" },
      requestId: "req-1",
      landlordId: "l1",
      appointmentId: "appt-1",
      vendorId: "vendor-1",
      evidenceVerdict: "review",
      evidenceReasons: ["no_after_photo"],
      autoConfirmAt: NOW,
    };
  };

  const escalated = await withReview.sweepEvidenceEscalation(NOW);

  assert.strictEqual(escalated, 1);
  assert.strictEqual(escalationClaim.filter.status, "awaiting_tenant", "claim is conditional");
  assert.strictEqual(
    escalationClaim.filter.evidenceReviewedAt,
    null,
    "and refuses a completion a human already ruled on — this is the loop guard"
  );
  assert.strictEqual(escalationClaim.update.$set.status, "in_review");
  assert.strictEqual(reviewsRaised.length, 1, "exactly one review approval is raised");
  assert.strictEqual(reviewsRaised[0].vendorName, "Prairie Plumbing");
  assert.strictEqual(savedRequest.routingStatus, "approval_needed");
  assert.strictEqual(savedRequest.appointmentStatus, "in_review", "kept in lockstep");

  // The whole point: escalating must not pay anybody.
  assert.ok(
    !escalationClaim.update.$set.payoutReleaseAt,
    "escalation schedules no payout — that is what auto-confirm does, and this is the branch that refuses it"
  );

  jcExports.ensureCompletionReviewApproval = realEnsureReview;

  console.log("completionSweeper.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
