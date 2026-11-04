const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Preparation = require('../../../models/BookingPreparation');
const Entry = require('../../../models/LedgerEntry');
const calendar = require('../../../services/vendor/vendorCalendar.service');
const ledger = require('../../../services/ledger/ledger.service');
const notices = require('../../../services/vendor/coordinationNotices.service');
const live = require('../../../services/realtime/liveEvents.service');
const env = require('../../../config/env');
env.booking_confirmations_paused = false;
let row, queued, attempts, available, failure;
Preparation.findOne = async () => row;
Preparation.findOneAndUpdate = async (filter, update) => {
  assert.equal(filter.revision, row.revision);
  row = { ...row, ...update.$set, revision: row.revision + update.$inc.revision };
  return row;
};
Entry.exists = async () => false;
ledger.ensureLedger = async () => ({ available, arrears: 0, bankOwed: 0 });
calendar.canonicalId = async identity => identity;
calendar.ensureCalendar = async () => {};
notices.queueNotices = async value => queued.push(value.phase);
notices.nudge = () => {};
live.publish = () => {};
mongoose.connection.transaction = async () => {
  attempts++;
  throw Object.assign(new Error('Reservation refused'), { code: failure });
};
const { prepareAcceptedBooking } = require('../../../services/vendor/bookingPreparation.service');
function reset(phase = 'awaiting_funds') {
  row = { _id: 'preparation', outreachId: 'outreach', landlordId: 'landlord', tenantId: 'tenant',
    requestId: 'request', identityId: 'identity', active: true, revision: 2, paymentMode: 'platform',
    phase, reasonCode: phase === 'awaiting_funds' ? 'insufficient_funds' : null,
    amountCents: 100, shortfallCents: 0, deadlineAt: new Date(Date.now() + 86400000),
    arrivalAt: new Date(Date.now() + 3600000), durationMinutes: 60 };
  queued = []; attempts = 0; available = 100; failure = 'insufficient_funds';
}
const run = () => prepareAcceptedBooking({ outreach: { _id: 'outreach' },
  request: { _id: 'request', landlordId: 'landlord' }, bookedAmount: 1, appointmentFields: {} });
(async () => {
  reset();
  for (let retry = 0; retry < 4; retry++) assert.equal((await run()).awaitingFunds, true);
  assert.equal(attempts, 4);
  assert.equal(row.revision, 2, 'an unchanged reservation failure must preserve coordination revision');
  assert.deepEqual(queued, [], 'recovery must not send another waiting email for the same blocker');

  reset('preparing');
  await run(); await run(); await run();
  assert.deepEqual(queued, ['awaiting_funds'], 'the first real blocker still notifies once');

  reset(); available = 0;
  await run(); await run();
  assert.equal(attempts, 0, 'insufficient balance still blocks before reservation');
  assert.equal(row.shortfallCents, 100);
  assert.deepEqual(queued, ['awaiting_funds'], 'a changed shortfall is recorded once');

  reset(); failure = 'time_unavailable';
  assert.equal((await run()).awaitingTime, true);
  assert.equal(row.phase, 'awaiting_vendor');
  assert.deepEqual(queued, ['awaiting_vendor'], 'a new blocker still asks for another time');
  console.log('booking recovery notice regression tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
