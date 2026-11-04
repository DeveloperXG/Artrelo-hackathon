const assert = require("assert");
const {
  applyQuotaLimitToSnapshot,
  cloneSnapshot,
  findLedgerEntry,
  getActiveCandidate,
  requeueCandidatesForNextRound,
  rebuildSnapshotSections,
} = require("../../../services/vendor/vendorSnapshot.service");

const makeSnapshot = () => ({
  decision: {
    actionType: "request_quota_increase",
    approvalRequired: true,
    quotaLimit: 300,
    managerSummary: "Estimate exceeds the quota.",
    suggestedQuota: 475,
  },
  candidateLedger: [
    { candidateKey: "preset__a", name: "A", state: "approved_for_contact", displayGroup: "active", score: 9 },
    { candidateKey: "preset__b", name: "B", state: "held", displayGroup: "held", score: 7 },
  ],
});

/* -------- applyQuotaLimitToSnapshot -------- */
// A vendor-quote approval deliberately skips regeneration (it would replace the
// whole Mixed field and destroy the ledger), so the decision block has to be
// corrected in place or it keeps advertising the pre-approval limit.

let snapshot = applyQuotaLimitToSnapshot(makeSnapshot(), 475);
assert.strictEqual(snapshot.decision.quotaLimit, 475, "quotaLimit is updated");
assert.strictEqual(
  snapshot.decision.actionType,
  "request_quota_increase",
  "the rest of the decision block is left alone"
);
assert.strictEqual(snapshot.decision.suggestedQuota, 475, "other decision fields survive");
assert.strictEqual(snapshot.candidateLedger.length, 2, "the ledger is untouched");
assert.strictEqual(
  snapshot.candidateLedger[0].state,
  "approved_for_contact",
  "candidate state survives — this is the whole reason we don't regenerate"
);

// String input from a JSON body is coerced.
assert.strictEqual(applyQuotaLimitToSnapshot(makeSnapshot(), "500").decision.quotaLimit, 500);

// Garbage is ignored rather than writing NaN into the snapshot.
["", null, undefined, "abc", NaN].forEach((bad) => {
  const result = applyQuotaLimitToSnapshot(makeSnapshot(), bad);
  assert.strictEqual(result.decision.quotaLimit, 300, `ignores ${JSON.stringify(bad)}`);
});

// A snapshot with no decision yet still gets one rather than throwing.
const bare = applyQuotaLimitToSnapshot({ candidateLedger: [] }, 250);
assert.strictEqual(bare.decision.quotaLimit, 250);
assert.strictEqual(applyQuotaLimitToSnapshot(null, 250), null, "null snapshot is a no-op");

// Zero is a legitimate limit and must not be treated as missing.
assert.strictEqual(applyQuotaLimitToSnapshot(makeSnapshot(), 0).decision.quotaLimit, 0);

/* -------- the surrounding helpers still behave -------- */

const rebuilt = rebuildSnapshotSections(applyQuotaLimitToSnapshot(makeSnapshot(), 475));
assert.strictEqual(rebuilt.decision.quotaLimit, 475, "rebuild preserves the new limit");
assert.strictEqual(rebuilt.activeCandidateKey, "preset__a");
assert.strictEqual(getActiveCandidate(rebuilt).name, "A");
assert.strictEqual(findLedgerEntry(rebuilt, "preset__b").name, "B");
assert.strictEqual(findLedgerEntry(rebuilt, "nope"), null);

// cloneSnapshot must stay a deep copy — callers mutate the clone and reassign.
const original = makeSnapshot();
const copy = cloneSnapshot(original);
copy.decision.quotaLimit = 999;
copy.candidateLedger[0].state = "selected";
assert.strictEqual(original.decision.quotaLimit, 300, "clone is deep");
assert.strictEqual(original.candidateLedger[0].state, "approved_for_contact");

/* -------- requeueCandidatesForNextRound -------- */
// After a round closes, everyone still in play has to be re-dealt exactly as a
// fresh generation would deal them. Leaving them `held` is not cosmetic: held
// entries render with no Approve action and activateCandidateState refuses
// them, so the vendor the fallback approval names cannot be activated at all.

const queue = requeueCandidatesForNextRound({
  candidateLedger: [
    // Already answered — must keep its terminal state.
    { candidateKey: "k-declined", name: "Declined", state: "excluded", displayGroup: "excluded", score: 99 },
    // Parked by applyHoldStateToRemainingCandidates when the first vendor went active.
    { candidateKey: "k-b", name: "B", state: "held", displayGroup: "held", holdReason: "on hold", score: 90, outreach: { status: "not_sent" } },
    { candidateKey: "k-e", name: "E", state: "held", displayGroup: "held", holdReason: "on hold", score: 60 },
    { candidateKey: "k-c", name: "C", state: "held", displayGroup: "held", holdReason: "on hold", score: 80 },
    { candidateKey: "k-d", name: "D", state: "held", displayGroup: "held", holdReason: "on hold", score: 70 },
    // A manager rejection is a decision, not a hold — it survives the re-deal.
    { candidateKey: "k-rejected", name: "Rejected", state: "manager_rejected", displayGroup: "excluded", score: 95 },
  ],
});
const queued = Object.fromEntries(queue.candidateLedger.map((entry) => [entry.candidateKey, entry]));

assert.strictEqual(queued["k-b"].state, "recommended", "highest score is promoted");
assert.strictEqual(queued["k-c"].state, "recommended");
assert.strictEqual(queued["k-d"].state, "recommended");
assert.strictEqual(queued["k-b"].displayGroup, "recommended");
assert.strictEqual(queued["k-e"].state, "pending", "fourth by score drops to the backup group");
assert.strictEqual(queued["k-e"].displayGroup, "eligible_not_top_k");
assert.ok(
  queue.candidateLedger.every((entry) => !entry.holdReason),
  "hold reasons go with the holds"
);
assert.strictEqual(queued["k-declined"].state, "excluded", "a closed round is not re-dealt");
assert.strictEqual(queued["k-rejected"].state, "manager_rejected", "a manager rejection stands");

// Ranking is by score, not ledger order — the ledger is left in place so the
// section arrays keep a stable order across rebuilds.
assert.deepStrictEqual(
  queue.candidateLedger.map((entry) => entry.candidateKey),
  ["k-declined", "k-b", "k-e", "k-c", "k-d", "k-rejected"],
  "the ledger is re-labelled, not re-ordered"
);

// A vendor mid-round is not up for re-dealing.
const midRound = requeueCandidatesForNextRound({
  candidateLedger: [
    { candidateKey: "k-live", state: "held", displayGroup: "held", score: 99, outreach: { status: "sent" } },
    { candidateKey: "k-free", state: "held", displayGroup: "held", score: 10 },
  ],
});
assert.strictEqual(midRound.candidateLedger[0].state, "held", "an open outreach keeps its entry parked");
assert.strictEqual(midRound.candidateLedger[1].state, "recommended");

assert.deepStrictEqual(
  requeueCandidatesForNextRound({}).candidateLedger,
  undefined,
  "a snapshot with no ledger is returned untouched"
);

console.log("vendorSnapshot.service tests passed");
