const assert = require('node:assert/strict');
const Appointment = require('../../../models/Appointment');
const { claim } = require('../../../services/vendor/workMutationFence.service');
const calls = []; let matched = 1;
Appointment.updateOne = async (filter, patch) => { calls.push({ filter, patch }); return { matchedCount: matched }; };
async function main() {
  const appointment = { _id: 'visit', landlordId: 'owner', requestId: 'request', bookingVersion: 2,
    confirmedStart: new Date('2026-10-30T15:00Z'), confirmedEnd: new Date('2026-10-30T16:00Z') };
  assert.equal(await claim(appointment), true);
  assert.equal(calls[0].filter.landlordId, 'owner'); assert.equal(calls[0].filter.requestId, 'request');
  assert.equal(calls[0].filter.confirmedStart, appointment.confirmedStart);
  assert.equal(calls[0].patch[0].$set.workMutationStartedAt.$ifNull[0], '$workMutationStartedAt');
  matched = 0; assert.equal(await claim(appointment), false, 'changed time cannot accept a stale work update');
  assert.equal(await claim({ ...appointment, bookingVersion: undefined }), true);
  assert.equal(calls.length, 2, 'legacy without the reschedule contract does not claim a fabricated time basis');
  console.log('work mutation fence: current owned slot CAS, first-marker retention and stale refusal PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
