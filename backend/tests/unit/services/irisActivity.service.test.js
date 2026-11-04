const assert = require("assert");
const mongoose = require("mongoose");
const { projectRequest, lifecycleEvents, auditEvent, currentState, compareEvents } = require("../../../services/request/irisActivityProjection.service");
const { createActivityService, pagination, encode } = require("../../../services/request/irisActivity.service");
const oid = (n) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, "0"));
const owner = oid(1), other = oid(2), a = oid(3), b = oid(4);
const at = "2026-10-26T12:00:00.000Z";
const base = { _id: a, landlordId: owner, issueTitle: "Synthetic kitchen repair", propertyId: oid(5), unitId: oid(6), status: "pending", routingStatus: "pending", updatedAt: new Date(at),
  timeline: [{ status: "pending", at: new Date(at), actorRole: "tenant" }] };
const requests = [base, { ...base, _id: b, issueTitle: "Independent request", status: "completed", timeline: [{ status: "completed", at: null }] }];
const logs = [
  { _id: oid(11), landlordId: owner, requestId: a, actor: "system", actionType: "vendor_recommendations_generated", createdAt: new Date(at), summary: "SECRET https://secret.example/link", metadata: { token: "hidden", ceiling: 1000 }, input: { private: true } },
  { _id: oid(12), landlordId: owner, requestId: a, actor: "vendor", actionType: "vendor_response_declined", createdAt: new Date(at) },
  { _id: oid(13), landlordId: owner, requestId: a, actor: "system", actionType: "vendor_outreach_send_failed", createdAt: null },
  { _id: oid(14), landlordId: other, requestId: a, actor: "system", actionType: "vendor_outreach_sent", createdAt: new Date(at) },
];
const equal = (a, b) => a instanceof Date || b instanceof Date ? new Date(a).getTime() === new Date(b).getTime() : String(a) === String(b);
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((child) => matches(row, child));
    const actual = key.split(".").reduce((target, part) => target?.[part], row);
    if (value === null) return actual == null;
    if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId)) {
      if (value.$in) return value.$in.some((item) => equal(actual, item));
      if (Object.hasOwn(value, "$ne")) return !equal(actual, value.$ne);
      if (value.$gt) return actual != null && new Date(actual) > value.$gt;
      if (value.$lt) return actual != null && (actual instanceof Date ? actual < value.$lt : String(actual) < String(value.$lt));
    }
    return equal(actual, value);
  });
}
function query(rows) {
  let data = rows;
  return { select() { return this; }, sort(order) { data = [...data].sort((a, b) => {
    for (const [key, direction] of Object.entries(order)) {
      const av = a[key] == null ? "" : a[key] instanceof Date ? a[key].toISOString() : String(a[key]);
      const bv = b[key] == null ? "" : b[key] instanceof Date ? b[key].toISOString() : String(b[key]);
      if (av !== bv) return av.localeCompare(bv) * direction;
    } return 0;
  }); return this; }, limit(n) { data = data.slice(0, n); return this; }, async lean() { return data; } };
}
const calls = [];
let completionRow = null;
let approvalRows = [];
let listRows = null;
const service = createActivityService({
  Requests: { async aggregate(pipeline) { calls.push(pipeline); return listRows || [{ ...base, _activityAt: new Date(at), _logs: [logs[1]], _preparations: [], _outreaches: [] }, { ...requests[1], _activityAt: new Date(at) }]; },
    findOne(filter) { calls.push(filter); const found = requests.find((row) => matches(row, filter)); return { select() { return this; }, async lean() { return found || null; } }; } },
  Logs: { collection: { name: "logs" }, async aggregate(pipeline) {
    calls.push(pipeline);
    // This unit fixture covers pagination/projection of unrelated recorded-time
    // rows only. Owned domain joins and equal-time causes run against Mongo in
    // the maintained activity integration test, not a fake aggregation engine.
    let rows = logs.filter(row => matches(row, pipeline[0].$match)).map(row => ({ ...row,
      _eventAt: row.createdAt, _timeBasis: row.createdAt ? "recorded" : "unknown",
      _eventOrder: `audit:${row._id}:0:${row._id}` }));
    const boundary = pipeline.slice(1).find(stage => stage.$match);
    if (boundary) rows = rows.filter(row => matches(row, boundary.$match));
    return query(rows).sort(pipeline.find(stage => stage.$sort).$sort).limit(pipeline.find(stage => stage.$limit).$limit).lean();
  } },
  Preparations: { collection: { name: "preparations" }, findOne(filter) { calls.push(filter); return { select() { return this; }, sort() { return this; }, async lean() { return null; } }; } },
  Outreaches: { collection: { name: "outreaches" }, findOne(filter) { calls.push(filter); return { select() { return this; }, sort() { return this; }, async lean() { return null; } }; } },
  Completions: { collection: { name: "completions" }, findOne(filter) { calls.push(filter); return { select() { return this; }, sort() { return this; }, async lean() { return completionRow && matches(completionRow, filter) ? completionRow : null; } }; } },
  Approvals: { collection: { name: "approvals" }, findOne(filter) { calls.push(filter); return { select() { return this; }, sort() { return this; }, async lean() { return approvalRows.find((row) => matches(row, filter)) || null; } }; },
    async aggregate(pipeline) { calls.push(pipeline); return approvalRows.filter((row) => matches(row, pipeline[0].$match)).sort((a, b) => Math.max(new Date(b.createdAt || 0), new Date(b.decidedAt || 0)) - Math.max(new Date(a.createdAt || 0), new Date(a.decidedAt || 0))).slice(0, 1); } },
  Properties: { find(filter) { calls.push(filter); return query([{ _id: oid(5), name: "Synthetic Property" }]); } },
  Units: { find(filter) { calls.push(filter); return query([{ _id: oid(6), propertyId: oid(5), unitNumber: "101" }]); } },
  now: () => new Date("2026-10-26T13:00:00.000Z"),
});
async function main() {
  for (const badLimit of ["0", "101", "-1", "1.2", "NaN", ["1"], 1]) assert.throws(() => pagination({ limit: badLimit }, "test", 20));
  for (const cursor of ["invalid", "e30", [], encode("other", at, "id"), encode("test", "yesterday", "id")]) assert.throws(() => pagination({ cursor }, "test", 20));
  assert.equal(pagination({}, "test", 20).limit, 20);
  const snapshot = JSON.stringify(base);
  const unknown = projectRequest({ ...base, updatedAt: null, timeline: [] });
  assert.equal(unknown.state, "unknown"); assert.equal(unknown.updatedAt, null);
  assert.equal(lifecycleEvents(requests[1])[0].at, null);
  assert.equal(projectRequest({ ...base, updatedAt: new Date("2026-10-27T23:59:00Z") }).updatedAt, at, "metadata update does not replace meaningful event time");
  const failed = auditEvent(logs[2]);
  assert.equal(failed.state, "failed"); assert(!failed.summary.includes("was sent"));
  assert.equal(auditEvent(logs[0]).actor, "System");
  assert.equal(auditEvent(logs[0]).recordedAt, at);
  assert.equal(auditEvent(logs[0]).timeBasis, "recorded");
  assert.match(auditEvent(logs[0]).summary, /recommendations/);
  assert(!/SECRET|hidden|ceiling|https:/.test(JSON.stringify(auditEvent(logs[0]))));
  const expanded = auditEvent({ ...logs[0], output: { candidateCount: 3, excludedCount: 2, approvalRequired: true, privateCeiling: 1000, topCandidate: "SECRET" } });
  assert(expanded.details.some((detail) => detail.label === "Vendor candidates" && detail.value === "3"));
  assert(!/SECRET|privateCeiling|1000/.test(JSON.stringify(expanded)));
  assert.equal(auditEvent({ ...logs[0], actionType: "unknown_SECRET" }).state, "unknown");
  assert.equal(auditEvent({ ...logs[0], actionType: "unknown_SECRET" }).type, "unclassified_activity");
  const pendingChange = { ...base, status: 'in_progress', appointmentStatus: 'scheduled', rescheduleState: {
    active: true, status: 'awaiting_vendor', expiresAt: new Date(Date.now() + 3600000) } };
  assert.equal(currentState(pendingChange, { preparation: { active: true, phase: 'scheduled' } }).waitingFor, 'Vendor confirmation');
  assert.equal(currentState({ ...pendingChange, rescheduleState: { ...pendingChange.rescheduleState, status: 'awaiting_tenant' } }).waitingFor, 'Tenant confirmation');
  assert.match(currentState(pendingChange).summary, /original visit remains confirmed/);
  assert.equal(auditEvent({ ...logs[0], actionType: 'booking_reschedule_committed', actor: 'system' }).actor, 'System');
  const legacyTimeline = [{ status: 'assigned', actorRole: 'landlord', at },
    { status: 'assigned', actorRole: 'tenant', at, note: 'Vendor and tenant confirmed the replacement visit time; the original was retained until this change committed.' },
    { status: 'completed', actorRole: 'system', at }];
  const timelineBytes = JSON.stringify(legacyTimeline);
  const correctedTimeline = lifecycleEvents({ ...base, timeline: legacyTimeline });
  assert.equal(correctedTimeline.length, 2, 'only known duplicate reschedule marker is hidden from presentation');
  assert.equal(correctedTimeline[0].title, 'Vendor assigned', 'real vendor assignment retained');
  assert.equal(correctedTimeline[1].id, `lifecycle:${base._id}:2`, 'original pagination indexes retained');
  assert.equal(JSON.stringify(legacyTimeline), timelineBytes, 'historical source facts are not deleted or rewritten');
  assert.equal(auditEvent({ ...logs[0], actionType: 'booking_reschedule_response_deadline_shortened', actor: 'system' }).actor, 'System');
  for (const actionType of ["cost_review_approved", "cost_review_rejected", "completion_overage_decided", "quota_increase_approved", "quota_increase_rejected"]) {
    const decision = auditEvent({ ...logs[0], actor: "landlord", actionType });
    assert.equal(decision.type, actionType); assert.equal(decision.actor, "Landlord");
    assert(!/SECRET|hidden|1000|https:/.test(JSON.stringify(decision)), "decision activity must not forward monetary/private payloads");
  }
  const submitted = { ...base, status: "in_progress", appointmentStatus: "work_verifying" };
  const retainedPreparation = { active: true, phase: "scheduled" };
  const repair = projectRequest(submitted, { preparation: retainedPreparation });
  assert.equal(repair.stage, "review"); assert.equal(repair.state, "waiting");
  assert.equal(repair.waitingFor, "Tenant confirmation"); assert.equal(repair.automationState, "awaiting_tenant");
  assert.match(repair.summary, /repair outcome/);
  const pendingMoney = { _id: oid(90), landlordId: owner, requestId: a, type: "quota_increase", status: "pending", expiresAt: new Date(Date.now() + 3600000) };
  assert.equal(projectRequest(submitted, { preparation: retainedPreparation, approval: pendingMoney }).waitingFor, "Landlord decision", "independent financial hold still wins");
  const now = new Date("2026-10-26T13:00:00Z");
  assert.equal(currentState({ ...base, initialRouting: { status: "processing", leaseUntil: "2026-10-26T12:59:59Z" } }, { now }).state, "waiting");
  assert.equal(currentState({ ...base, initialRouting: { status: "processing", leaseUntil: "2026-10-26T13:01:00Z" } }, { now }).state, "in_progress");
  assert.equal(currentState(base, { now, preparation: { active: true, phase: "preparing", leaseUntil: "2026-10-26T12:00:00Z" } }).state, "waiting");
  for (const [overrides, options, state, waiting] of [
    [{ status: "completed" }, {}, "completed", null], [{ status: "cancelled" }, {}, "completed", null],
    [{ routingStatus: "failed" }, {}, "failed", "Landlord review"], [{ appointmentStatus: "disputed" }, {}, "needs_attention", "Landlord completion review"],
    [{ intakeFollowUp: { state: "awaiting_answers" } }, {}, "waiting", "Tenant details"],
    [{ intakeFollowUp: { state: "ready_for_review" } }, {}, "needs_attention", "Landlord intake review"],
    [{}, { outreach: { status: "sent", deliveryUnconfirmed: true } }, "failed", "Landlord delivery review"],
    [{}, { outreach: { status: "declined" } }, "waiting", "Vendor routing"],
    [{}, { outreach: { status: "queued" } }, "waiting", "Vendor outreach delivery"],
    [{}, { outreach: { status: "viewed" } }, "waiting", "Vendor response"],
    [{}, { preparation: { active: true, phase: "awaiting_vendor" } }, "waiting", "Vendor confirmation"],
    [{}, { preparation: { active: true, phase: "awaiting_approval" } }, "needs_attention", "Landlord booking review"],
  ]) { const current = currentState({ ...base, ...overrides }, options); assert.equal(current.state, state); assert.equal(current.waitingFor, waiting); }
  const hold = projectRequest({ ...base, status: "completed", safetyAssessment: { state: "needs_review" } }, { logs: [logs[0]] });
  assert.equal(hold.state, "needs_attention"); assert.equal(hold.latestEvent, null);
  const closed = projectRequest({ ...base, status: "completed" }, { logs: [logs[1]] });
  assert.equal(closed.latestEvent, null);
  const first = await service.detail(String(owner), String(a), { limit: "2" });
  assert.equal(first.events.length, 2); assert(first.nextCursor);
  const second = await service.detail(String(owner), String(a), { limit: "2", cursor: first.nextCursor });
  const combined = [...first.events, ...second.events];
  assert.equal(new Set(combined.map((event) => event.id)).size, 4);
  assert.deepEqual(combined, [...combined].sort(compareEvents));
  assert.equal(second.nextCursor, null);
  assert(combined.some((event) => event.at === null));
  assert(!combined.some((event) => event.id === `audit:${oid(14)}`));
  assert.deepEqual(first.request, second.request, "request projection is independent of event page");
  await assert.rejects(service.detail(String(other), String(a)), (error) => error.status === 404);
  await assert.rejects(service.detail(String(owner), "bad-id"), (error) => error.status === 400);
  await assert.rejects(service.detail(String(owner), String(b), { cursor: first.nextCursor }), (error) => error.status === 400);
  const list = await service.list(String(owner), { limit: "1", activeOnly: "true" });
  assert.equal(list.requests.length, 1); assert(list.nextCursor);
  assert.equal(list.requests[0].propertyLabel, "Synthetic Property");
  assert.equal(list.requests[0].unitLabel, "101");
  assert.deepEqual(list.requests[0], first.request, "list and detail use identical projection");
  const pipeline = calls.find((entry) => Array.isArray(entry) && entry.some((stage) => stage.$lookup?.as === "_logs"));
  assert.equal(String(pipeline[0].$match.landlordId), String(owner));
  const activeIndex = pipeline.findIndex((stage) => stage.$match?.$or);
  assert(activeIndex > 0 && activeIndex < pipeline.findIndex((stage) => stage.$limit), "active filter precedes pagination");
  assert(pipeline[activeIndex].$match.$or.some((filter) => filter["_completionHolds.0"]?.$exists), "completed requests with unresolved settlement remain active");
  assert.deepEqual(pipeline.find((stage) => stage.$sort)?.$sort, { _activityAt: -1, _id: -1 });
  assert.equal(pipeline.find((stage) => stage.$limit)?.$limit, 2);
  for (const stage of pipeline.filter((stage) => stage.$lookup)) assert.equal(String(stage.$lookup.pipeline[0].$match.landlordId), String(owner));
  await assert.rejects(service.list(String(owner), { activeOnly: "yes" }), (error) => error.status === 400);
  completionRow = { _id: oid(30), landlordId: owner, requestId: b, status: "closed", closedAt: new Date(at),
    closeRecovery: { version: 1, projectionPending: false, settlementRecordedAt: null, reviewedAt: new Date(at) } };
  logs.push({ _id: oid(31), landlordId: owner, requestId: b, actor: "system", actionType: "completion_settlement_review_required", createdAt: new Date(at) });
  const unsettled = await service.detail(String(owner), String(b));
  assert.equal(unsettled.request.state, "needs_attention");
  assert.equal(unsettled.request.waitingFor, "Landlord settlement review");
  assert.equal(unsettled.request.actionRequired, true);
  assert.equal(unsettled.request.latestEvent.type, "completion_settlement_review_required");
  assert(!JSON.stringify(unsettled).includes("closeRecovery"));
  completionRow.closeRecovery.settlementRecordedAt = new Date(at);
  completionRow.closeRecovery.projectionPending = true;
  assert.equal((await service.detail(String(owner), String(b))).request.state, "needs_attention", "settlement alone cannot clear unresolved projection");
  completionRow.closeRecovery.projectionPending = false;
  assert.equal((await service.detail(String(owner), String(b))).request.state, "completed", "only positively recorded settlement and projection clear hold");
  const approval = { _id: oid(40), requestId: b, landlordId: owner, type: "vendor_contact_approval", status: "pending",
    createdAt: new Date("2026-10-26T12:30:00Z"), expiresAt: new Date("2026-10-26T14:00:00Z"),
    amountRequested: 12345, reason: "PRIVATE reason", payload: { token: "PRIVATE token" } };
  approvalRows = [{ ...approval, _id: oid(41), landlordId: other }, { ...approval, _id: oid(42), requestId: a },
    { ...approval, _id: oid(43), createdAt: new Date("2026-10-26T10:00:00Z"), expiresAt: new Date("2026-10-26T12:59:59Z") }, approval];
  const pending = (await service.detail(String(owner), String(b))).request;
  assert.deepEqual(pending.pendingApproval, { approvalId: String(approval._id), type: "vendor_contact_approval", status: "pending" });
  assert.equal(pending.automationState, "awaiting_landlord");
  assert.equal(pending.updatedAt, approval.createdAt.toISOString());
  assert.equal(pending.stage, "review", "terminal work does not hide a pending approval");
  assert(!/PRIVATE|amountRequested|12345|payload|expiresAt|reason|decisionClaimToken/.test(JSON.stringify(pending)));
  listRows = [{ ...requests[1], _pendingApprovals: [approval], _approvalActivity: [approval], _logs: logs.filter((row) => String(row.requestId) === String(b)), _activityAt: approval.createdAt }];
  const activePending = await service.list(String(owner), { activeOnly: "true" });
  assert.deepEqual(activePending.requests[0], pending, "both endpoints expose the same pending approval and automation state");
  const approvalPipeline = calls.filter((entry) => Array.isArray(entry) && entry.some((stage) => stage.$lookup?.as === "_logs")).at(-1);
  const pendingLookupIndex = approvalPipeline.findIndex((stage) => stage.$lookup?.as === "_pendingApprovals");
  const pendingLookup = approvalPipeline[pendingLookupIndex].$lookup;
  assert.equal(String(pendingLookup.pipeline[0].$match.landlordId), String(owner));
  assert.equal(pendingLookup.pipeline[0].$match.status, "pending");
  assert.equal(pendingLookup.pipeline[0].$match.expiresAt.$gt.toISOString(), "2026-10-26T13:00:00.000Z");
  const pendingActiveIndex = approvalPipeline.findIndex((stage) => stage.$match?.$or?.some((filter) => filter["_pendingApprovals.0"]?.$exists));
  assert(pendingActiveIndex > pendingLookupIndex && pendingActiveIndex < approvalPipeline.findIndex((stage) => stage.$limit));
  assert(!/payload|amountRequested|reason/.test(JSON.stringify(pendingLookup.pipeline.at(-1))));
  approval.status = "approved"; approval.decidedAt = new Date("2026-10-26T12:45:00Z");
  const decided = (await service.detail(String(owner), String(b))).request;
  assert.equal(decided.pendingApproval, null); assert.equal(decided.automationState, "completed");
  assert.equal(decided.updatedAt, approval.decidedAt.toISOString());
  for (const [overrides, options, expected] of [
    [{ initialRouting: { status: "processing", leaseUntil: "2026-10-26T13:01:00Z" } }, {}, "running"],
    [{ initialRouting: { status: "processing", leaseUntil: "2026-10-26T12:59:59Z" } }, {}, "idle"],
    [{}, { preparation: { active: true, phase: "preparing", leaseUntil: "2026-10-26T13:01:00Z" } }, "running"],
    [{}, { preparation: { active: true, phase: "preparing", leaseUntil: "2026-10-26T12:59:59Z" } }, "idle"],
    [{}, { preparation: { active: false, phase: "preparing", leaseUntil: "2026-10-26T13:01:00Z" } }, "unknown"],
    [{ status: "in_progress" }, {}, "idle"],
    [{}, { preparation: { active: true, phase: "awaiting_approval" } }, "awaiting_landlord"],
    [{}, { outreach: { status: "sent" } }, "awaiting_vendor"],
    [{ intakeFollowUp: { state: "awaiting_answers" } }, {}, "awaiting_tenant"],
    [{ status: "completed" }, {}, "completed"], [{ routingStatus: "failed" }, {}, "failed"],
    [{ safetyAssessment: { state: "needs_review" } }, {}, "escalated"], [{}, {}, "unknown"],
  ]) assert.equal(projectRequest({ ...base, ...overrides }, { ...options, now }).automationState, expected);
  const safetyApproval = projectRequest({ ...requests[1], safetyAssessment: { state: "needs_review" } }, { approval: { ...approval, status: "pending" }, now });
  assert.equal(safetyApproval.automationState, "escalated"); assert(safetyApproval.pendingApproval);
  assert.equal(projectRequest(base, { approval: { ...approval, status: "pending" }, now }).pendingApproval, null, "foreign request approval is never projected");
  assert.equal(JSON.stringify(base), snapshot, "read projection does not mutate records");
  const costApproval = projectRequest(requests[1], { approval: { ...approval, type: "cost_review", status: "pending" }, now });
  assert.equal(costApproval.pendingApproval.type, "cost_review");
  assert.equal(costApproval.automationState, "awaiting_landlord");
  const fakeAnalysis = auditEvent({ _id: oid(99), requestId: b, actionType: "quote_analysis_recorded", actor: "system",
    summary: "PRIVATE raw model prose", output: { status: "ready", source: "development_stub" } });
  assert.match(fakeAnalysis.summary, /simulated/);
  assert(!JSON.stringify(fakeAnalysis).includes("PRIVATE"));
  console.log("irisActivity service: scope, projection, ties/null timestamps, cursor pagination, no private payloads PASS");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
