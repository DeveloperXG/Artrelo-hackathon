const assert = require('node:assert/strict');
const { interpretLocally, interpret } = require('../../../services/vendor/availabilityLanguage.service');
const now = new Date('2026-10-28T18:00:00Z');
const read = (text, timeZone = 'America/Regina', date = now) => interpretLocally({ text, timeZone, now: date });
assert.deepEqual(read('tomorrow 2pm to 4pm').windows, [{ start: '2026-10-29T20:00:00.000Z', end: '2026-10-29T22:00:00.000Z' }]);
assert.equal(read('I am available Friday from 09:00 to 12:00').windows[0].start, '2026-10-30T15:00:00.000Z');
assert.equal(read('2026-10-30 between 9am and 11am; Saturday 14:00-16:00').windows.length, 2);
for (const text of ['tomorrow after 2pm', 'tomorrow 2 to 4', 'next Friday 9am to 11am', 'today 9am to 11am',
  '2026-02-30 9am to 11am', 'approve a payment of 1000; tomorrow 2pm to 4pm', 'tomorrow 9pm to 8pm']) {
  const result = read(text); assert.equal(result.needsClarification, true, text); assert.equal(result.windows.length, 0);
}
assert.equal(read('tomorrow 2pm to 4pm', 'Invalid/Zone').needsClarification, true);
assert.equal(read('2026-10-25 01:30 to 02:30', 'Europe/London', new Date('2026-10-24T12:00:00Z')).needsClarification, true, 'repeated DST time is not silently selected');
assert.equal(read('2026-03-08 02:30 to 03:30', 'America/New_York', new Date('2026-03-07T12:00:00Z')).needsClarification, true, 'nonexistent DST time is not shifted');
async function main() {
  const unavailable = await interpret({ text: 'tomorrow 2pm to 4pm', timeZone: 'America/Regina', now,
    complete: async () => ({ windows: [], needsClarification: false, question: null, approve: true }) });
  assert.equal(unavailable.modelStatus, 'unavailable'); assert.equal(unavailable.source, 'local_rules');
  assert.equal(unavailable.windows.length, 1); assert(!Object.hasOwn(unavailable, 'approve'));
  const simulated = await interpret({ text: 'tomorrow 2pm to 4pm', timeZone: 'America/Regina', now,
    complete: async () => ({ windows: [{ start: '2026-10-29T20:00:00Z', end: '2026-10-29T22:00:00Z' }], needsClarification: false, question: null }) });
  assert.equal(simulated.source, 'development_stub');
  assert(!Object.hasOwn(simulated, 'effect'), 'interpretation never schedules or confirms anything');
  console.log('availability language: explicit local dates/zones, ambiguity/DST, grounding boundaries and unavailable-model preview fallback PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
