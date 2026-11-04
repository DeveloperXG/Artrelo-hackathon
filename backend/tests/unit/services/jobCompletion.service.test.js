// The single close path.
//
// Two properties matter more than the rest:
//
//  1. The overage gate runs FIRST and DECLINES TO CLOSE. Silence from a tenant
//     auto-confirms a job, but it must never buy an overage — that is the one
//     money guardrail unconditional auto-confirm keeps.
//  2. The close claim is idempotent. Two callers (a tenant confirming and the
//     sweeper firing) must produce exactly one finalCost, one appointment
//     transition, and one payout.

const assert = require("assert");

const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const Appointment = require("../../../models/Appointment");
const JobCompletion = require("../../../models/JobCompletion");
const ApprovalRequest = require("../../../models/ApprovalRequest");
const Vendor = require("../../../models/Vendor");
const VendorIdentity = require("../../../models/VendorIdentity");
const LandlordPolicy = require("../../../models/LandlordPolicy");
const AgentActionLog = require("../../../models/AgentActionLog");
const JobToken = require("../../../models/JobToken");
const LandlordLedger = require("../../../models/LandlordLedger");
const { Notification } = require("../../../models/Notification");
const VendorOutreach = require("../../../models/VendorOutreach");
const Property = require("../../../models/Property");
const Landlord = require("../../../models/Landlord");

const CEILING = 300;

let completionRow = null;
let requestRow = null;
let appointmentUpdates = [];
let approvals = [];
let audits = [];
let vendorUpdates = [];
let identityUpdates = [];
let tokenUpdates = [];
let beforeCloseClaim = null;

const makeCompletion = (overrides = {}) => ({
  _id: "comp-1",
  appointmentId: "appt-1",
  requestId: "req-1",
  landlordId: "landlord-1",
  tenantId: "tenant-1",
  vendorId: "vendor-1",
  identityId: "identity-1",
  status: "confirmed",
  closedAt: null,
  updatedAt: new Date("2026-10-20T00:00:00Z"),
  approvedCeiling: CEILING,
  report: { actualCost: 280, workPerformed: "Replaced the P-trap" },
  tenantConfirmation: { outcome: "confirmed", rating: 5, autoConfirmed: false },
  overage: {},
  evidenceVerdict: "pass",
  ...overrides,
});

const makeRequest = () => ({
  _id: "req-1",
  landlordId: "landlord-1",
  tenantId: "tenant-1",
  issueTitle: "Kitchen sink leaking",
  estimatedCost: CEILING,
  status: "in_progress",
  timeline: [],
  save: async function save() {
    return this;
  },
});

/* ---------------- Stubs ------------------------------------------------ */

// Mongo applies dotted paths as nested writes. Both stubs go through this, so
// a $set of "overage.approvedAmount" lands where the service expects to read it
// back rather than as a literal key with a dot in its name.
const applySet = (target, $set = {}) => {
  for (const [key, value] of Object.entries($set)) {
    if (!key.includes(".")) {
      target[key] = value;
      continue;
    }
    const path = key.split(".");
    const leaf = path.pop();
    let node = target;
    for (const step of path) {
      if (!node[step]) node[step] = {};
      node = node[step];
    }
    node[leaf] = value;
  }
  return target;
};

JobCompletion.findById = async () => completionRow;
JobCompletion.updateOne = async (filter, update) => {
  if (!completionRow) return { modifiedCount: 0 };
  applySet(completionRow, update.$set);
  return { modifiedCount: 1 };
};
JobCompletion.findOneAndUpdate = async (filter, update) => {
  if (!completionRow) return null;
  if (update.$set?.closeRecovery && beforeCloseClaim) beforeCloseClaim();
  if (filter.updatedAt && Number(filter.updatedAt) !== Number(completionRow.updatedAt)) return null;
  // The real close claim: { _id, closedAt: null, status: "confirmed" }.
  if (filter.closedAt === null && completionRow.closedAt !== null) return null;
  if (filter.status && completionRow.status !== filter.status) return null;
  applySet(completionRow, update.$set);
  return completionRow;
};

MaintenanceRequest.findById = async () => requestRow;
MaintenanceRequest.updateOne = async (filter, update) => {
  applySet(requestRow, update.$set);
  if (update.$addToSet?.timeline && !requestRow.timeline.some(event =>
    Number(event.at) === Number(update.$addToSet.timeline.at) && event.status === update.$addToSet.timeline.status)) {
    requestRow.timeline.push(update.$addToSet.timeline);
  }
  return { matchedCount: 1, modifiedCount: 1 };
};
Appointment.updateOne = async (filter, update) => {
  appointmentUpdates.push({ filter, update });
  return { matchedCount: 1, modifiedCount: 1 };
};
LandlordPolicy.findOne = () => ({ lean: async () => ({ defaultQuota: CEILING }) });
ApprovalRequest.findOne = async () => null;
ApprovalRequest.prototype.save = async function save() {
  this._id = `approval-${approvals.length + 1}`;
  approvals.push(this);
  return this;
};
Vendor.findById = () => ({ select: () => ({ lean: async () => ({ rating: 4, ratingCount: 1 }) }) });
Vendor.updateOne = async (filter, update) => {
  vendorUpdates.push(update);
  return { modifiedCount: 1 };
};
VendorIdentity.updateOne = async (filter, update) => {
  identityUpdates.push(update);
  return { modifiedCount: 1 };
};
JobToken.updateOne = async (filter, update) => {
  tokenUpdates.push({ filter, update });
  return { modifiedCount: 1 };
};
AgentActionLog.create = async (row) => {
  audits.push(row);
  return row;
};
Notification.create = async () => ({});
// The low-balance check that runs after the payout. Unstubbed it throws on the
// string ids and takes the whole (non-fatal) ledger block down with it, which
// hid whether the payout figures above were ever reached.
LandlordLedger.findOne = async () => ({ _id: "ledger-1", available: 100000, lowBalanceNotifiedAt: null });
LandlordLedger.updateOne = async () => ({ modifiedCount: 1 });

// Captured rather than left to fail non-fatally: the payout figure is the whole
// point of the overage tests below.
let holdReleases = [];
const ledger = require("../../../services/ledger/ledger.service");
ledger.releaseHold = async (args) => {
  holdReleases.push(args);
  return { payoutEntryId: "ledger-entry-1" };
};
ledger.settlePayout = async () => ({});

// The service fee, captured with the ORDER it ran in relative to the payout.
let moneySteps = [];
let feeCalls = [];
let feeThrows = false;
const origReleaseHold = ledger.releaseHold;
ledger.releaseHold = async (args) => {
  moneySteps.push("release");
  return origReleaseHold(args);
};
// The rail the job was booked on. undefined = an appointment from before the
// field existed, which is platform; "direct" = the landlord pays the vendor.
let appointmentRow = { _id: "appt-1" };
Appointment.findById = () => ({ select: () => ({ lean: async () => appointmentRow }) });
Appointment.findOne = () => ({ sort() { return this; }, select() { return this; }, lean: async () => ({ _id: "appt-1" }) });

// Direct jobs record what is owed instead of touching the ledger.
let directDue = [];
require("../../../services/ledger/directPayment.service").recordDirectPaymentDue = async (args) => {
  directDue.push(args);
  return { recorded: true };
};

// The vendor's "job complete" email, captured so the payment line can be read.
let emails = [];
require("../../../services/notification/email.service").sendEmail = async (msg) => {
  emails.push(msg);
  return { delivered: true };
};
VendorOutreach.findOne = () => ({
  select: () => ({ lean: async () => ({ toEmail: "pat@plumbing.test", vendorNameSnapshot: "Pat's Plumbing" }) }),
});
Property.findById = () => ({ select: () => ({ lean: async () => null }) });
Landlord.findById = () => ({ select: () => ({ lean: async () => ({ companyName: "Pine Property" }) }) });

require("../../../services/ledger/serviceFee.service").applyServiceFee = async (args) => {
  moneySteps.push("fee");
  feeCalls.push(args);
  if (feeThrows) throw new Error("fee service down");
  return null;
};

const {
  closeJobCompletion,
  resolveCompletionOverage,
  resolveCompletionReview,
  overageAllowance,
} = require("../../../services/completion/jobCompletion.service");

const reset = () => {
  completionRow = makeCompletion();
  requestRow = makeRequest();
  appointmentUpdates = [];
  approvals = [];
  audits = [];
  vendorUpdates = [];
  identityUpdates = [];
  tokenUpdates = [];
  holdReleases = [];
  moneySteps = [];
  feeCalls = [];
  feeThrows = false;
  appointmentRow = { _id: "appt-1" };
  directDue = [];
  emails = [];
  beforeCloseClaim = null;
};

/* ---------------- 1) Tolerance ----------------------------------------- */

assert.strictEqual(overageAllowance(100), 10, "small jobs get the flat $10 floor");
assert.strictEqual(overageAllowance(1000), 20, "large jobs get the 2% proportional allowance");

async function main() {
  /* -------------- 2) The happy path closes and projects ---------------- */

  reset();
  const ok = await closeJobCompletion({ completionId: "comp-1", reason: "tenant_confirmed" });

  assert.strictEqual(ok.closed, true);
  assert.strictEqual(requestRow.status, "completed");
  assert.strictEqual(requestRow.finalCost, 280, "finalCost comes from the vendor's actual cost");
  assert.strictEqual(requestRow.appointmentStatus, "completed");
  assert.strictEqual(requestRow.completionNotes, "Replaced the P-trap");

  // The timeline entry must use a STATUS_ENUM value — work_verifying is not one,
  // and StatusEventSchema.status validates against the same list.
  assert.strictEqual(requestRow.timeline.length, 1);
  assert.strictEqual(requestRow.timeline[0].status, "completed");
  assert.strictEqual(requestRow.timeline[0].actorRole, "tenant");

  // Appointment.completed finally gets reached.
  assert.strictEqual(appointmentUpdates[0].update.$set.status, "completed");
  // The vendor's credential is retired, bounding a leaked link to the job.
  assert.strictEqual(tokenUpdates.length, 1);
  // Trust data banked on BOTH the roster row and the global identity.
  assert.strictEqual(vendorUpdates[0].$inc.successfulJobs, 1);
  assert.strictEqual(identityUpdates[0].$inc["aggregate.completedJobs"], 1);
  assert.strictEqual(identityUpdates[0].$inc["aggregate.ratingSum"], 5);
  // Running mean: (4*1 + 5) / 2 = 4.5
  assert.strictEqual(vendorUpdates[0].$set.rating, 4.5);
  assert.ok(audits.some((a) => a.actionType === "job_completion_closed"));

  // The service fee: once, AFTER the payout, on the completion's own key, for
  // the amount actually paid, and quoted as of the close -- so a replay decides
  // the same way.
  assert.deepStrictEqual(moneySteps, ["release", "fee"], "the fee comes after the vendor's payout");
  assert.strictEqual(feeCalls.length, 1);
  assert.strictEqual(feeCalls[0].settlementId, "comp-1");
  assert.strictEqual(String(feeCalls[0].completionId), "comp-1");
  assert.strictEqual(feeCalls[0].payoutCents, holdReleases[0].payoutCents, "on what the vendor was actually paid");
  assert.ok(feeCalls[0].at instanceof Date, "quoted as of the close");

  /* -------------- 3) Closing twice is a no-op -------------------------- */

  const again = await closeJobCompletion({ completionId: "comp-1", reason: "auto_confirmed" });
  assert.strictEqual(again.closed, false);
  assert.strictEqual(again.reason, "already_closed");
  assert.strictEqual(requestRow.timeline.length, 1, "the second close must not push a second event");

  /* -------------- 4) An overage DECLINES to close ---------------------- */

  reset();
  completionRow = makeCompletion({
    report: { actualCost: 640, workPerformed: "Replaced the stack" },
    tenantConfirmation: { outcome: "confirmed", autoConfirmed: true }, // silence
  });

  const over = await closeJobCompletion({ completionId: "comp-1", reason: "auto_confirmed" });

  assert.strictEqual(over.closed, false, "an overage must not close");
  assert.strictEqual(over.reason, "overage_pending");
  assert.strictEqual(requestRow.status, "in_progress", "the request must NOT be completed");
  assert.strictEqual(requestRow.finalCost, undefined, "no finalCost may be written");
  assert.strictEqual(completionRow.closedAt, null);
  assert.strictEqual(appointmentUpdates.length, 0, "the appointment must not advance");

  // The approval carries the discriminator decideApprovalRequest branches on.
  assert.strictEqual(approvals.length, 1);
  assert.strictEqual(approvals[0].type, "quota_increase");
  assert.strictEqual(approvals[0].payload.source, "completion_overage");
  assert.strictEqual(approvals[0].payload.completionId, "comp-1");
  assert.strictEqual(approvals[0].amountRequested, 640);
  assert.strictEqual(completionRow.overage.isOver, true);

  /* -------------- 5) Inside tolerance still closes --------------------- */

  reset();
  // $305 against a $300 ceiling: over, but inside the $10 floor. A rounding
  // cent must not page a landlord at 2am.
  completionRow = makeCompletion({ report: { actualCost: 305, workPerformed: "Tightened joint" } });
  const tolerated = await closeJobCompletion({ completionId: "comp-1" });
  assert.strictEqual(tolerated.closed, true, "within tolerance must close");
  assert.strictEqual(requestRow.finalCost, 305);
  assert.strictEqual(approvals.length, 0, "no approval for a rounding difference");

  /* -------------- 6) An approved overage closes at the higher figure --- */

  reset();
  completionRow = makeCompletion({
    report: { actualCost: 640, workPerformed: "Replaced the stack" },
    overage: { isOver: true, decision: "approved" },
  });
  const approved = await closeJobCompletion({ completionId: "comp-1", reason: "review_approved" });
  assert.strictEqual(approved.closed, true);
  assert.strictEqual(requestRow.finalCost, 640);
  assert.strictEqual(approvals.length, 0, "an already-approved overage must not re-raise");

  /* -------------- 7) Only a confirmed completion may close ------------- */

  for (const status of ["draft", "awaiting_tenant", "in_review", "disputed"]) {
    reset();
    completionRow = makeCompletion({ status });
    const blocked = await closeJobCompletion({ completionId: "comp-1" });
    assert.strictEqual(blocked.closed, false, `${status} must not close`);
    assert.ok(blocked.reason.startsWith("not_confirmed"));
    assert.strictEqual(requestRow.status, "in_progress");
  }

  /* -------------- 8) Auto-confirm is audited as the system ------------- */

  reset();
  completionRow = makeCompletion({
    tenantConfirmation: { outcome: "confirmed", autoConfirmed: true },
  });
  await closeJobCompletion({ completionId: "comp-1", reason: "auto_confirmed" });
  const closeAudit = audits.find((a) => a.actionType === "job_completion_closed");
  assert.strictEqual(closeAudit.actor, "system", "an auto-close must be attributable to the system");
  assert.strictEqual(requestRow.timeline[0].actorRole, "system");

  /* -------------- 9) An approved overage CAPS the payout --------------- */
  // The reported bug: a manager approving a MODIFIED amount changed nothing.
  // The figure went to request.quotaOverride, which resolveApprovedCeiling
  // never reads, and the payout took report.actualCost regardless — so the
  // vendor was transferred what they invoiced, not what was authorized.
  reset();
  completionRow = makeCompletion({
    report: { actualCost: 480, workPerformed: "Replaced the stack" },
    overage: { isOver: true, decision: "approved", approvedAmount: 400 },
  });
  const capped = await closeJobCompletion({ completionId: "comp-1", reason: "review_approved" });

  assert.strictEqual(capped.closed, true);
  assert.strictEqual(requestRow.finalCost, 400, "finalCost follows what was authorized");
  assert.strictEqual(holdReleases.length, 1);
  assert.strictEqual(holdReleases[0].payoutCents, 40000, "the vendor is paid the authorized figure");
  assert.strictEqual(
    holdReleases[0].heldCents,
    30000,
    "the escrow release stays on what was reserved at booking — releasing more would invent money"
  );

  /* -------------- 10) Approving as requested pays in full -------------- */
  reset();
  completionRow = makeCompletion({
    report: { actualCost: 480, workPerformed: "Replaced the stack" },
    overage: { isOver: true, decision: "approved", approvedAmount: 480 },
  });
  await closeJobCompletion({ completionId: "comp-1", reason: "review_approved" });
  assert.strictEqual(requestRow.finalCost, 480, "no silent haircut when the invoice is approved as-is");
  assert.strictEqual(holdReleases[0].payoutCents, 48000);

  /* -------------- 11) Authorizing MORE never inflates the invoice ------ */
  reset();
  completionRow = makeCompletion({
    report: { actualCost: 480, workPerformed: "Replaced the stack" },
    overage: { isOver: true, decision: "approved", approvedAmount: 600 },
  });
  await closeJobCompletion({ completionId: "comp-1", reason: "review_approved" });
  assert.strictEqual(requestRow.finalCost, 480, "a generous authorization still pays the invoice");
  assert.strictEqual(holdReleases[0].payoutCents, 48000);

  /* -------------- 12) Money first, then evidence ----------------------- */
  // Both approvals used to be raised at submit, in no order, and the review's
  // payload froze the PRE-approval ceiling — which is why the review card kept
  // quoting the old figure after the amount had been changed.
  reset();
  completionRow = makeCompletion({
    status: "in_review",
    evidenceVerdict: "review",
    report: { actualCost: 480, workPerformed: "Replaced the stack" },
    overage: { isOver: true, decision: "pending" },
  });
  const heldForEvidence = await resolveCompletionOverage({
    completionId: "comp-1",
    decision: "approved",
    approvedAmount: 400,
  });

  assert.strictEqual(heldForEvidence.closed, false);
  assert.strictEqual(
    heldForEvidence.reason,
    "awaiting_evidence_review",
    "the job now waits on the evidence, having settled the money"
  );
  assert.strictEqual(completionRow.overage.approvedAmount, 400, "the authorized figure is recorded");
  assert.strictEqual(holdReleases.length, 0, "nothing is paid while the evidence is unresolved");
  assert.strictEqual(approvals.length, 1, "exactly one approval — the review — is raised now");
  assert.strictEqual(approvals[0].type, "completion_review");
  assert.strictEqual(
    approvals[0].payload.completion.approvedCeiling,
    400,
    "and it quotes the amount just authorized, not the stale booking ceiling"
  );

  /* -------------- 13) A rejected overage asks nothing further ---------- */
  reset();
  completionRow = makeCompletion({
    status: "in_review",
    evidenceVerdict: "review",
    report: { actualCost: 480, workPerformed: "Replaced the stack" },
    overage: { isOver: true, decision: "pending" },
  });
  const rejected = await resolveCompletionOverage({ completionId: "comp-1", decision: "rejected" });

  assert.strictEqual(rejected.closed, false);
  assert.strictEqual(completionRow.status, "disputed");
  assert.strictEqual(approvals.length, 0, "no point reviewing evidence for a job nobody will pay for");
  assert.strictEqual(
    vendorUpdates.filter((update) => update.$inc?.failedJobs).length,
    1,
    "and the disputed stat moves exactly once"
  );

  /* -------------- 14) A review stamps evidenceReviewedAt --------------- */
  //
  // THE LOOP GUARD. Now that every completion goes to the tenant, weak evidence
  // that goes unanswered is escalated by completionSweeper — and that pass
  // refuses any completion with evidenceReviewedAt set. Without this write, a
  // manager could approve the review, hand it back to the tenant, and have the
  // tenant's silence escalate it again. And again.
  reset();
  completionRow = makeCompletion({
    status: "in_review",
    evidenceVerdict: "review",
    evidenceReviewedAt: null,
  });
  const reviewed = await resolveCompletionReview({ completionId: "comp-1", decision: "approved" });

  assert.ok(reviewed, "the review resolves");
  assert.strictEqual(completionRow.status, "awaiting_tenant", "handed back to the tenant");
  assert.ok(
    completionRow.evidenceReviewedAt,
    "a human looked — this is what makes the completion auto-confirmable again"
  );
  assert.strictEqual(
    completionRow.evidenceVerdict,
    "review",
    "and the verdict is NOT rewritten to pass — a dispute depends on what the checks said at submit"
  );
  assert.ok(
    new Date(completionRow.autoConfirmAt).getTime() > Date.now(),
    "with a fresh window for the tenant"
  );

  /* A rejection stamps it too: the fact recorded is that someone looked, not
   * what they concluded. */
  reset();
  completionRow = makeCompletion({
    status: "in_review",
    evidenceVerdict: "review",
    evidenceReviewedAt: null,
  });
  await resolveCompletionReview({ completionId: "comp-1", decision: "rejected" });
  assert.strictEqual(completionRow.status, "disputed");
  assert.ok(completionRow.evidenceReviewedAt, "a rejection is also a human having looked");

  /* -------------- A failing fee never blocks or undoes the close -------- */
  reset();
  feeThrows = true;
  const origErr = console.error;
  console.error = () => {};
  const survived = await closeJobCompletion({ completionId: "comp-1", reason: "tenant_confirmed" });
  console.error = origErr;
  assert.strictEqual(survived.closed, true, "the job closes");
  assert.strictEqual(holdReleases.length, 1, "and the vendor is still paid");
  assert.strictEqual(requestRow.status, "completed");

  /* -------------- A booked-before-the-field job still pays out --------- */
  // No paymentMode on the appointment means it was booked on the wallet rail
  // and has a hold: it must settle through the ledger, not be read as direct.
  reset();
  await closeJobCompletion({ completionId: "comp-1", reason: "tenant_confirmed" });
  assert.strictEqual(holdReleases.length, 1, "an appointment without a mode is a platform job");
  assert.strictEqual(directDue.length, 0);
  assert.ok(!/directly/.test(emails[0]?.text || ""), "and the vendor is not told to expect a direct payment");

  /* -------------- A direct job never touches the ledger ---------------- */
  reset();
  appointmentRow = { _id: "appt-1", paymentMode: "direct" };
  const direct = await closeJobCompletion({ completionId: "comp-1", reason: "tenant_confirmed" });
  assert.strictEqual(direct.closed, true, "the job closes exactly as before");
  assert.strictEqual(requestRow.status, "completed");
  assert.strictEqual(requestRow.finalCost, 280);
  assert.strictEqual(holdReleases.length, 0, "no hold is released: none was ever placed");
  assert.strictEqual(feeCalls.length, 0, "no fee is taken from a wallet that is not in use");
  assert.strictEqual(direct.ledger, null);
  assert.deepStrictEqual(
    directDue.map((d) => [String(d.appointmentId), d.amountCents]),
    [["appt-1", 28000]],
    "what the landlord owes the vendor is recorded, in cents"
  );
  assert.ok(
    /Your property manager will pay you \$280 directly/.test(emails[0].text),
    "the vendor is told who pays them"
  );

  // An approved overage caps a direct payment exactly as it caps a payout.
  reset();
  appointmentRow = { _id: "appt-1", paymentMode: "direct" };
  completionRow = makeCompletion({
    report: { actualCost: 400, workPerformed: "Replaced the trap and valve" },
    overage: { decision: "approved", approvedAmount: 350 },
  });
  await closeJobCompletion({ completionId: "comp-1", reason: "tenant_confirmed" });
  assert.strictEqual(directDue[0].amountCents, 35000, "owed is what was authorized, not what was invoiced");

  reset();
  completionRow.overage = { decision: "approved", approvedAmount: 280 };
  beforeCloseClaim = () => {
    completionRow.overage.approvedAmount = 200;
    completionRow.updatedAt = new Date("2026-10-20T00:00:01Z");
  };
  const changedApproval = await closeJobCompletion({ completionId: "comp-1" });
  assert.strictEqual(changedApproval.closed, false, "a changed approval must be re-read before closing");
  assert.strictEqual(holdReleases.length, 0, "never pay an older, higher approved amount");

  reset();
  completionRow.quoteContractVersion = 2;
  completionRow.report.finalStatement = { hash: "current" };
  let itemizedClose = await closeJobCompletion({ completionId: "comp-1" });
  assert.strictEqual(itemizedClose.reason, "cost_review_pending");
  completionRow.invoiceReview = { state: "cleared", quoteHash: "stale" };
  itemizedClose = await closeJobCompletion({ completionId: "comp-1" });
  assert.strictEqual(itemizedClose.reason, "cost_review_pending");
  assert.strictEqual(holdReleases.length, 0, "pending/stale invoice review cannot release money");
  assert.strictEqual(appointmentUpdates.length, 0);

  console.log("jobCompletion.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
