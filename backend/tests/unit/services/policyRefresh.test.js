const assert = require('assert/strict');
const { createPolicyRefresh } = require('../../../services/policy/policyWrite.service');
let row, result, outage = false, runCount = 0;
const at = new Date('2026-10-29T22:00:00Z');
const Revision = {
  findOneAndUpdate(filter, update) { return { lean: async () => {
    if (!['pending', 'failed'].includes(row.refreshState) && !(row.refreshState === 'running' && row.refreshAttemptAt < new Date(at.getTime() - 300000))) return null;
    Object.assign(row, update.$set);return { ...row };
  } }; },
  async updateOne(filter, update) { if (row.refreshState === filter.refreshState && row.refreshAttemptAt === filter.refreshAttemptAt) Object.assign(row, update.$set); },
  find() { return { sort() { return this; }, limit() { return this; }, select() { return this; }, lean: async () => [{ _id: row._id }] }; },
};
const refresh = createPolicyRefresh({ Revision, now: () => at, run: async (landlordId, options) => {
  runCount++;assert.equal(landlordId, 'owner');assert.deepEqual(options.changedFields, ['defaultQuota']);
  if (outage) throw new Error('synthetic refresh outage');return result;
} });
const reset = state => { row = { _id: 'receipt', landlordId: 'owner', refreshState: state, refreshAttemptAt: new Date(at.getTime() - 600000), changedFields: ['digestFrequency', 'defaultQuota'] };result = { failed: 0 };outage = false;runCount = 0; };
(async () => {
  reset('pending');await refresh.refreshReceipt('receipt');assert.equal(row.refreshState, 'completed');assert.equal(runCount, 1);
  await refresh.refreshReceipt('receipt');assert.equal(runCount, 1, 'completed receipt is never replayed');
  reset('pending');result = { failed: 1 };await refresh.refreshReceipt('receipt');assert.equal(row.refreshState, 'partial');
  reset('pending');result = { setupIncomplete: true };await refresh.refreshReceipt('receipt');assert.equal(row.refreshState, 'partial');
  reset('pending');outage = true;await refresh.refreshReceipt('receipt');assert.equal(row.refreshState, 'failed');
  outage = false;await refresh.recover();assert.equal(row.refreshState, 'completed');
  reset('running');await refresh.recover();assert.equal(row.refreshState, 'completed', 'restart recovers an abandoned durable refresh lease');
  reset('running');row.refreshAttemptAt = at;await refresh.recover();assert.equal(runCount, 0, 'a live lease is not stolen');
  console.log('Policy refresh: selective fields, separate partial/failure, durable retry and stale-lease recovery PASS.');
})().catch(err => { console.error(err);process.exitCode = 1; });
