// The rejection -> appeal lifecycle. Pins:
//   1. buildAppealState: available / pending / expired / none, and the one
//      appeal is spent for good (rejectIsFinal survives a reopen)
//   2. submitAppeal needs a note, writes conditionally, and says WHY it refused
//   3. reopen: back to queued with fresh routing and a one-entry history; the
//      first attempt's vendor rounds, raised quota and quote are cleared so a
//      new search doesn't read them as "every vendor tried"; it refuses a
//      closed window and a tenant who has left the unit
//   4. finalizeRejection deletes through the cascade, keeps a tombstone with no
//      requestId, and tells the tenant with a notification that carries no
//      workOrderId (or the cascade would delete it)
//   5. declineAppeal: needs a reason; nothing pending -> 409

const assert = require("assert");

// --- stubs, installed BEFORE the service is required ---------------------
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const Tenant = require("../../../models/Tenant");
const audit = require("../../../services/audit/agentAction.service");
const notify = require("../../../services/notification/notify.service");
const cleanup = require("../../../services/request/rejectedRequestCleanup.service");
const quota = require("../../../services/request/requestQuota.service");
const VendorOutreach = require("../../../models/VendorOutreach");
let clearedOutreachFor = [];
VendorOutreach.deleteMany = async (filter) => {
  clearedOutreachFor.push(String(filter.requestId));
  return { deletedCount: 2 };
};

let logged = [];
let notified = [];
let cascaded = [];
audit.logAgentAction = async (entry) => {
  logged.push(entry);
};
notify.notifyUser = async (entry) => {
  notified.push(entry);
};
cleanup.deleteRequestsWithCascade = async (ids) => {
  cascaded.push(...ids.map(String));
  return ids.length;
};
quota.getQuotaUsage = async () => ({
  daily: { used: 1, limit: 3 },
  weekly: { used: 2, limit: 7 },
  blocked: false,
  nextAvailableAt: null,
});

let tenantRow = { _id: "t1", firstName: "Sam", email: "sam@example.test", unit: "u1" };
Tenant.findById = () => ({ select: () => ({ lean: async () => tenantRow }) });

let updateResult = null;
let lastUpdate = null;
MaintenanceRequest.findOneAndUpdate = async (filter, update) => {
  lastUpdate = { filter, update };
  return updateResult;
};
let findOneRow = null;
MaintenanceRequest.findOne = () => {
  const chain = { select: () => chain, lean: async () => findOneRow };
  return chain;
};
let deletedRow = null;
MaintenanceRequest.findOneAndDelete = () => ({ lean: async () => deletedRow });
let existsRow = null;
MaintenanceRequest.exists = async () => existsRow;

const {
  buildAppealState,
  submitAppeal,
  reopenRejectedRequest,
  finalizeRejection,
  declineAppeal,
  AppealError,
} = require("../../../services/request/appeal.service");

const now = new Date("2026-10-08T12:00:00Z");
const later = new Date(now.getTime() + 3600 * 1000);
const earlier = new Date(now.getTime() - 3600 * 1000);

const rejects = async (promise, code) => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AppealError, `expected AppealError, got ${err}`);
    assert.strictEqual(err.code, code);
    return err;
  }
  throw new Error(`expected ${code}`);
};

async function main() {
  /* 1) buildAppealState --------------------------------------------------- */
  const open = buildAppealState({ status: "rejected", appealWindowExpiresAt: later }, now);
  assert.strictEqual(open.state, "available");
  assert.strictEqual(open.canAppeal, true);
  assert.strictEqual(open.canReopen, true, "the landlord may withdraw while the window is open");

  const pending = buildAppealState({ status: "rejected", isAppealed: true, appealUsed: true, appealWindowExpiresAt: earlier }, now);
  assert.strictEqual(pending.state, "pending");
  assert.strictEqual(pending.canAppeal, false);
  assert.strictEqual(pending.canReopen, true, "an appeal can be accepted after the window closes");

  const expired = buildAppealState({ status: "rejected", appealWindowExpiresAt: earlier }, now);
  assert.strictEqual(expired.state, "expired");
  assert.strictEqual(expired.canReopen, false);

  const reopened = buildAppealState({ status: "queued", appealUsed: true }, now);
  assert.strictEqual(reopened.state, "none");
  assert.strictEqual(reopened.rejectIsFinal, true, "the one appeal stays spent after a reopen");
  assert.strictEqual(buildAppealState({ status: "queued" }, now).rejectIsFinal, false);

  /* 2) submitAppeal ------------------------------------------------------- */
  await rejects(submitAppeal({ requestId: "r1", tenantId: "t1", note: "  ", now }), "appeal_note_required");

  updateResult = { _id: "r1", landlordId: "l1", issueTitle: "Leak", rejectionReason: "Tenant-caused" };
  logged = [];
  notified = [];
  await submitAppeal({ requestId: "r1", tenantId: "t1", note: "It's from upstairs", now });
  assert.strictEqual(lastUpdate.filter.status, "rejected");
  assert.deepStrictEqual(lastUpdate.filter.appealUsed, { $ne: true }, "one appeal per request");
  assert.deepStrictEqual(lastUpdate.filter.appealWindowExpiresAt, { $gt: now }, "only inside the window");
  assert.strictEqual(lastUpdate.update.$set.appealUsed, true);
  assert.strictEqual(logged[0].actionType, "request_appealed");
  assert.strictEqual(logged[0].actor, "tenant", "the tenant appealed, not the landlord");
  assert.strictEqual(notified[0].type, "request_appeal_submitted");
  assert.strictEqual(notified[0].userId, "l1");

  updateResult = null;
  findOneRow = { status: "rejected", isAppealed: true };
  await rejects(submitAppeal({ requestId: "r1", tenantId: "t1", note: "again", now }), "appeal_already_submitted");
  findOneRow = { status: "rejected", appealWindowExpiresAt: earlier };
  await rejects(submitAppeal({ requestId: "r1", tenantId: "t1", note: "late", now }), "appeal_window_closed");
  findOneRow = null;
  await rejects(submitAppeal({ requestId: "r1", tenantId: "t1", note: "x", now }), "request_not_found");

  /* 3) reopen --------------------------------------------------------------- */
  findOneRow = {
    _id: "r2",
    tenantId: "t1",
    unitId: "u1",
    status: "rejected",
    isAppealed: true,
    appealUsed: true,
    rejectionReason: "Tenant-caused",
    appealNote: "It's from upstairs",
  };
  updateResult = { _id: "r2", tenantId: "t1", issueTitle: "Leak", status: "queued" };
  notified = [];
  const { wasAppeal } = await reopenRejectedRequest({ requestId: "r2", landlordId: "l1", actorId: "l1", now });
  assert.strictEqual(wasAppeal, true);
  const set = lastUpdate.update.$set;
  assert.strictEqual(set.status, "queued");
  assert.strictEqual(set.routingStatus, "pending");
  assert.strictEqual(set.vendorRecommendationSnapshot, null, "routing starts fresh");
  assert.strictEqual(set.quotaOverride, null, "the first round's raised quota doesn't cap the second");
  assert.strictEqual(set.estimatedCost, 0, "an old vendor quote is not the new estimate");
  assert.deepStrictEqual(clearedOutreachFor, [], "durable routing worker owns cleanup before search");
  assert.deepStrictEqual(set.initialRouting, { status: "pending", attempts: 0, nextAttemptAt: now,
    cleanupBefore: now, requiresContactReview: true }, "reopening explicitly enrols fresh guarded work");
  assert.strictEqual(set.timeline.length, 1, "a fresh history...");
  assert.ok(/Tenant-caused/.test(set.timeline[0].note) && /upstairs/.test(set.timeline[0].note), "...that keeps why");
  assert.ok(!("appealUsed" in set), "the appeal stays spent");
  assert.strictEqual(lastUpdate.filter.isAppealed, true, "conditional on the appeal still pending");
  assert.strictEqual(notified[0].type, "request_reopened");
  assert.strictEqual(notified[0].metadata.workOrderId, "r2");
  assert.strictEqual(notified[0].email, "sam@example.test");

  findOneRow = { _id: "r3", tenantId: "t1", unitId: "u1", status: "rejected", appealWindowExpiresAt: earlier };
  await rejects(reopenRejectedRequest({ requestId: "r3", landlordId: "l1", now }), "request_not_reopenable");

  findOneRow = { _id: "r4", tenantId: "t1", unitId: "u9", status: "rejected", isAppealed: true };
  await rejects(reopenRejectedRequest({ requestId: "r4", landlordId: "l1", now }), "tenant_left_unit");

  /* 4) finalizeRejection --------------------------------------------------- */
  deletedRow = {
    _id: "r5",
    tenantId: "t1",
    landlordId: "l1",
    issueTitle: "Leak",
    issueDescription: "Water",
    rejectionReason: "Tenant-caused",
    appealNote: "It's from upstairs",
  };
  logged = [];
  notified = [];
  cascaded = [];
  const gone = await finalizeRejection({
    filter: { _id: "r5", status: "rejected", isAppealed: true },
    reason: "Photos show impact damage",
    kind: "appeal_declined",
    actorId: "l1",
    now,
  });
  assert.strictEqual(gone._id, "r5");
  assert.deepStrictEqual(cascaded, ["r5"], "everything hanging off it goes too");
  const tombstone = logged.find((row) => row.actionType === "request_finally_rejected");
  assert.ok(tombstone, "a private record is kept");
  assert.strictEqual(tombstone.requestId, null, "with no requestId, so no cascade can remove it");
  assert.strictEqual(tombstone.metadata.firstRejectionReason, "Tenant-caused");
  assert.strictEqual(tombstone.metadata.appealNote, "It's from upstairs");
  const final = notified[0];
  assert.strictEqual(final.type, "request_rejected_final");
  assert.ok(!final.metadata.workOrderId, "no workOrderId: the request is gone and the cascade matches on it");
  assert.ok(/1 of 3 today/.test(final.message), "next steps say where the tenant stands");
  assert.ok(/Emergencies/.test(final.message));
  assert.ok(final.message.length <= 1000, "fits the notification column");

  deletedRow = null;
  assert.strictEqual(
    await finalizeRejection({ filter: {}, reason: "x", kind: "appeal_declined", now }),
    null,
    "a request that changed underneath is left alone"
  );

  /* 5) declineAppeal ------------------------------------------------------- */
  await rejects(declineAppeal({ requestId: "r6", landlordId: "l1", reason: "" }), "reason_required");
  deletedRow = null;
  existsRow = { _id: "r6" };
  await rejects(declineAppeal({ requestId: "r6", landlordId: "l1", reason: "No" }), "no_pending_appeal");
  existsRow = null;
  await rejects(declineAppeal({ requestId: "r6", landlordId: "l1", reason: "No" }), "request_not_found");

  console.log("appeal.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
