const assert = require('node:assert/strict');
const { project, createLoader } = require('../../../services/vendor/bookingCapabilities.service');
const preparation = { _id: 'preparation', landlordId: 'owner', requestId: 'request', appointmentId: 'visit', phase: 'scheduled', active: true };
const request = { _id: 'request', landlordId: 'owner', status: 'in_progress' };
const now = new Date('2026-10-29T00:00:00Z');
const appointment = { _id: 'visit', requestId: 'request', landlordId: 'owner', status: 'scheduled', tenantConfirmation: { accepted: true },
  confirmedStart: new Date('2026-10-30T15:00:00Z'), confirmedEnd: new Date('2026-10-30T16:00:00Z') };
const base = { preparation, request, appointment, completion: null, audience: 'landlord', now };
assert.equal(project(base).state, 'confirmed');
assert.equal(project(base).canRequestReschedule, false, 'incomplete mutation protocol is not advertised as an available action');
assert.equal(project({ ...base, rescheduleEnabled: true }).canRequestReschedule, true);
assert.equal(project({ ...base, rescheduleEnabled: true }).requiresRescheduleReason, true);
assert.equal(project({ ...base, audience: 'vendor', rescheduleEnabled: true }).canRequestReschedule, false);
assert.equal(project({ ...base, appointment: { ...appointment, confirmedStart: null }, rescheduleEnabled: true }).canRequestReschedule, false);
const tooClose = project({ ...base, now: new Date('2026-10-30T12:46:00Z'), rescheduleEnabled: true });
assert.equal(tooClose.state, 'confirmed'); assert.equal(tooClose.canRequestReschedule, false);
assert.equal(tooClose.reasonCode, 'reschedule_response_window_closed');
assert.equal(project({ ...base, now: new Date('2026-10-30T12:45:00Z'), rescheduleEnabled: true }).canRequestReschedule, true);
assert.equal(project({ ...base, appointment: { ...appointment, tenantConfirmation: {} } }).state, 'confirmation_unknown');
for (const status of ['work_verifying', 'in_review', 'disputed', 'completed', 'cancelled', 'failed']) {
  const actual = project({ ...base, appointment: { ...appointment, status }, rescheduleEnabled: true });
  assert.equal(actual.canRequestReschedule, false, 'current appointment state outranks retained scheduled preparation');
  assert.equal(actual.canConfirmInitial, false);
}
const completion = { _id: 'completion', requestId: 'request', landlordId: 'owner', appointmentId: 'visit', status: 'draft', checkIn: null };
assert.equal(project({ ...base, completion: { ...completion, status: undefined } }).state, 'unavailable', 'missing legacy work state is not fabricated as a submitted repair');
for (const row of [{ ...completion, checkIn: {} }, { ...completion, report: { submittedAt: new Date() } }, { ...completion, status: 'awaiting_tenant' }]) {
  const actual = project({ ...base, completion: row, rescheduleEnabled: true });
  assert.equal(actual.reasonCode, 'work_already_started'); assert.equal(actual.canRequestReschedule, false);
}
for (const foreign of [
  { request: { ...request, landlordId: 'foreign' } },
  { appointment: { ...appointment, requestId: 'foreign' } },
  { appointment: { ...appointment, landlordId: 'foreign' } },
  { completion: { ...completion, requestId: 'foreign' } },
]) {
  const actual = project({ ...base, ...foreign, rescheduleEnabled: true });
  assert.equal(actual.state, 'unavailable'); assert.equal(actual.canRequestReschedule, false);
}
for (const closed of [{ status: 'completed' }, { status: 'cancelled' }, { archivedAt: new Date() }]) {
  assert.equal(project({ ...base, request: { ...request, ...closed }, rescheduleEnabled: true }).state, 'closed');
}
const initial = { ...base, preparation: { ...preparation, phase: 'awaiting_tenant' }, appointment: { ...appointment, status: 'awaiting_tenant', tenantConfirmation: { accepted: false } } };
assert.equal(project(initial).canConfirmInitial, true);
assert.equal(project({ ...initial, audience: 'tenant' }).canSuggestInitialAlternatives, true);
assert.equal(project({ ...initial, audience: 'vendor' }).canConfirmInitial, false);

async function main() {
  const calls = [];
  const model = (name, value) => ({ findOne(filter) { calls.push({ name, filter }); return { select(fields) { calls.at(-1).fields = fields; return { lean: async () => value }; } }; } });
  const load = createLoader({ Request: model('request', request), Appointment: model('appointment', appointment),
    Completion: model('completion', { ...completion, status: 'awaiting_tenant', report: { submittedAt: new Date() } }) });
  const result = await load(preparation, 'landlord', { rescheduleEnabled: true, now });
  assert.equal(result.state, 'completion_submitted'); assert.equal(result.canRequestReschedule, false);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.filter.landlordId, 'owner');
  assert.equal(calls[1].filter.requestId, 'request'); assert.equal(calls[2].filter.requestId, 'request');
  assert.equal(calls[2].filter.appointmentId, 'visit');
  assert(!/checkIn|submittedAt|landlordId|actualCost|ceiling/.test(JSON.stringify(result)), 'projection returns capability facts, not private source documents');
  console.log('booking capabilities: owned current state, post-work denial, initial positive controls and inactive reschedule protocol PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
