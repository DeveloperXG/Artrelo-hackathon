const assert = require("assert");
const Completion = require("../../../models/JobCompletion");
const Appointment = require("../../../models/Appointment");
const Request = require("../../../models/MaintenanceRequest");
let notices = [], audits = [];
let retiredTokens = 0;
require("../../../services/vendor/jobToken.service").revokeJobToken = async () => { retiredTokens++; };
require("../../../services/comms/proxySession.service").closeProxySession = async () => ({});
require("../../../services/notification/notify.service").notifyUser = async value => { notices.push(value); };
require("../../../services/audit/agentAction.service").logAgentAction = async value => { audits.push(value); };
for (const action of ["releaseHold", "settlePayout", "chargeServiceFee"]) {
  require("../../../services/ledger/ledger.service")[action] = () => { throw new Error("Recovery must not move money"); };
}
require("../../../services/completion/jobCompletion.service").bumpVendorCompletionStats = () => { throw new Error("Recovery must not repeat stats"); };
const { projectClosedCompletion, sweepCompletionRecovery, authorizedPayable } = require("../../../services/completion/completionRecovery.service");
const NOW = new Date("2026-10-20T12:00:00Z");
let completion, request, appointment, failRequest, superseded, filters;
const path = (row, key) => key.split(".").reduce((value, part) => value?.[part], row);
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
  if (key === "$or") return value.some(option => matches(row, option));
  const actual = path(row, key);
  if (value === null) return actual == null;
  if (value && typeof value === "object" && !(value instanceof Date)) return Object.entries(value).every(([op, expected]) =>
    op === "$in" ? expected.includes(actual) : op === "$nin" ? !expected.includes(actual) : op === "$lte" ? actual <= expected : op === "$gt" ? actual > expected : false);
  return actual instanceof Date || value instanceof Date ? Number(actual) === Number(value) : actual === value;
});
const update = (row, changes) => {
  for (const [key, value] of Object.entries(changes.$set || {})) {
    const parts = key.split("."); const last = parts.pop(); let target = row;
    for (const part of parts) target = target[part] ||= {};
    target[last] = structuredClone(value);
  }
  for (const [key, value] of Object.entries(changes.$inc || {})) row.closeRecovery.attempts = (path(row, key) || 0) + value;
};
Completion.find = filter => { filters.push(filter); return { sort() { return this; }, limit() { return this; },
  lean: async () => matches(completion, filter) ? [structuredClone(completion)] : [] }; };
Completion.findOneAndUpdate = async (filter, changes) => {
  if (!matches(completion, filter)) return null;
  update(completion, changes); return structuredClone(completion);
};
Completion.updateOne = async (filter, changes) => { if (!matches(completion, filter)) return { matchedCount: 0 };
  update(completion, changes); return { matchedCount: 1 }; };
Request.findOne = () => ({ lean: async () => structuredClone(request) });
Request.updateOne = async (filter, changes) => {
  if (failRequest) throw new Error("database write interrupted");
  if (!matches(request, filter)) return { matchedCount: 0 };
  update(request, changes);
  if (changes.$addToSet?.timeline) {
    const event = changes.$addToSet.timeline;
    if (!request.timeline.some(existing => JSON.stringify(existing) === JSON.stringify(event))) request.timeline.push(event);
  }
  return { matchedCount: 1 };
};
Appointment.exists = async () => superseded;
Appointment.findOne = () => ({ sort() { return this; }, select() { return this; }, lean: async () => ({ _id: superseded ? "a-newer" : "a1" }) });
Appointment.updateOne = async (filter, changes) => {
  if (!matches(appointment, filter)) return { matchedCount: 0 };
  update(appointment, changes); return { matchedCount: 1 };
};
function reset() {
  completion = { _id: "c1", appointmentId: "a1", requestId: "r1", landlordId: "l1", status: "closed",
    closedAt: new Date("2026-10-20T10:00:00Z"), report: { actualCost: 480, workPerformed: "Replaced valve" },
    overage: { decision: "approved", approvedAmount: 400 }, tenantConfirmation: { autoConfirmed: false },
    closeRecovery: { version: 1, payableCents: 40000, projectionPending: true, actorUserId: "t1" } };
  request = { _id: "r1", landlordId: "l1", status: "in_progress", updatedAt: new Date("2026-10-20T09:00:00Z"), timeline: [] };
  appointment = { _id: "a1", landlordId: "l1", status: "work_verifying" };
  notices = []; audits = []; filters = []; failRequest = false; superseded = false;
}
async function run() {
  reset(); assert.strictEqual(authorizedPayable(completion), 400);
  // A crash between the appointment and request projections is recoverable.
  failRequest = true;
  await assert.rejects(() => projectClosedCompletion({ completion, request: structuredClone(request) }));
  assert.strictEqual(appointment.status, "completed"); assert.strictEqual(request.status, "in_progress");
  failRequest = false;
  // The stored close decision wins even if an approval was later changed.
  completion.overage.approvedAmount = 470;
  const repaired = await sweepCompletionRecovery(NOW);
  assert.strictEqual(repaired, 1); assert.strictEqual(request.finalCost, 400);
  assert.strictEqual(retiredTokens, 1, "interrupted close retires the vendor credential");
  assert.strictEqual(request.timeline.length, 1); assert.strictEqual(request.timeline[0].actorId, "t1");
  assert.strictEqual(notices.length, 1); assert.strictEqual(audits[0].output.paymentsReplayed, false);
  await sweepCompletionRecovery(NOW);
  assert.strictEqual(notices.length, 1, "no repeated recovery notice");
  await projectClosedCompletion({ completion, request: structuredClone(request) });
  assert.strictEqual(request.timeline.length, 1, "projection retries do not duplicate timeline events");
  reset(); completion.closeRecovery.settlementRecordedAt = NOW;
  await Promise.all([sweepCompletionRecovery(NOW), sweepCompletionRecovery(NOW)]);
  assert.strictEqual(request.timeline.length, 1); assert.strictEqual(notices.length, 0, "a known settlement needs no payment notice");
  reset(); delete completion.closeRecovery;
  await sweepCompletionRecovery(NOW); assert.strictEqual(request.status, "in_progress", "no historical backfill");
  reset(); request.status = "cancelled";
  await assert.rejects(() => projectClosedCompletion({ completion, request }));
  assert.strictEqual(appointment.status, "work_verifying", "cancelled work stays cancelled");
  reset(); superseded = true;
  const originalError = console.error; console.error = () => {};
  for (let tick = 0; tick < 4; tick++) await sweepCompletionRecovery(new Date(NOW.getTime() + tick * 300_000));
  console.error = originalError;
  assert.strictEqual(request.status, "in_progress"); assert.strictEqual(notices.length, 1, "bounded failures produce one attention notice");
  assert.strictEqual(completion.closeRecovery.attempts, 3, "bad records do not starve the queue indefinitely");
  console.log("completion recovery interruption/concurrency/payment-isolation tests passed");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
