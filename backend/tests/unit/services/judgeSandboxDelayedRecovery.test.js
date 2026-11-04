const assert = require('assert/strict');
const { projectDomain, declineRecoveryProof } = require('../../../services/judgeSandbox/domain.service');
const { contract } = require('../../../services/judgeSandbox/contract.service');
const { createRuns } = require('../../../services/judgeSandbox/run.service');
const at = new Date('2026-11-04T06:00:00Z');
const run = { _id: 'run_owned', requestId: 'request_owned', revision: 10, state: 'failed', stepCode: 'routing',
  storyVersion: contract.storyVersions.declineRecovery, completedDirectives: ['routing', 'vendor_decline'],
  error: { code: 'action_unknown', retryable: false, retryAfterSeconds: null, nextAvailableAt: null },
  inFlightActionId: null, startedAt: at, updatedAt: at };
const request = { _id: run.requestId, landlordId: 'landlord_owned', status: 'queued' };
const firstOutreach = { _id: 'outreach_first', vendorId: 'vendor_first', identityId: 'identity_first',
  status: 'declined', respondedAt: at, response: { outcome: 'declined' } };
const outreach = { _id: 'outreach_second', vendorId: 'vendor_second', identityId: 'identity_second', status: 'sent', simulatedDelivery: true };
const deliveryReceipt = { _id: 'receipt_second', outreachId: outreach._id, requestId: request._id, landlordId: request.landlordId,
  vendorId: outreach.vendorId, identityId: outreach.identityId, channel: 'simulation', realDelivery: false, acceptedAt: at };
const data = { run, request, firstOutreach, outreach, deliveryReceipt };
const proof = declineRecoveryProof(data);
assert.equal(proof.observation.stepCode, 'vendor_quote');assert.equal(proof.declineReceiptRef, firstOutreach._id);
assert.equal(proof.deliveryReceiptRef, deliveryReceipt._id);
for (const changes of [
  { firstOutreach: { ...firstOutreach, response: null } }, { firstOutreach: { ...firstOutreach, respondedAt: null } },
  { firstOutreach: { ...firstOutreach, respondedAt: 'invalid' } },
  { firstOutreach: { ...firstOutreach, identityId: undefined } },
  { run: { ...run, completedDirectives: [] } }, { run: { ...run, stepCode: 'vendor_work' } },
  { run: { ...run, inFlightActionId: 'claimed_action' } }, { deliveryReceipt: null },
  { deliveryReceipt: { ...deliveryReceipt, vendorId: 'foreign' } },
  { deliveryReceipt: { ...deliveryReceipt, requestId: 'foreign' } },
  { deliveryReceipt: { ...deliveryReceipt, identityId: 'foreign' } },
  { deliveryReceipt: { ...deliveryReceipt, landlordId: 'foreign' } },
  { deliveryReceipt: { ...deliveryReceipt, realDelivery: true } },
  { deliveryReceipt: { ...deliveryReceipt, acceptedAt: 'invalid' } },
  { deliveryReceipt: { ...deliveryReceipt, _id: undefined } },
  { outreach: { ...outreach, deliveryUnconfirmed: true } }, { outreach: { ...outreach, status: 'accepted' } },
  { outreach: { ...outreach, vendorId: firstOutreach.vendorId } },
  { outreach: firstOutreach },
]) assert.equal(declineRecoveryProof({ ...data, ...changes }), null);
const hold = projectDomain({ ...data, outreach: firstOutreach, deliveryReceipt: null });
assert.equal(hold.state, 'waiting_on_landlord');assert.equal(hold.error, null);
assert.equal(hold.checkpoint.approvalId, null);
const human = declineRecoveryProof({ ...data, approval: { _id: 'pending_decision' } });
assert.equal(human.observation.state, 'waiting_on_landlord');assert.equal(human.observation.checkpoint.approvalId, 'pending_decision');
(async () => {
  let current = { ...run }, executions = 0, recoveries = 0, observations = 0;
  const service = createRuns({ enabled: true, authorize: async () => ({ role: 'landlord', pair: { label: 'Pair', vendorIds: [] } }),
    store: { find: async () => current, reconcileDecline: async (_ctx, old, p) => {
      recoveries++;assert.equal(old.error.code, 'action_unknown');current = { ...old, ...p.observation, revision: old.revision + 1 };return current;
    }, observe: async (_ctx, old, observation) => { observations++;current = { ...old, ...observation };return current; } },
    inspectDeclineRecovery: async () => proof, inspect: async () => proof.observation, execute: async () => { executions++; } });
  const result = await service.status({});assert.equal(result.run.step.code, 'vendor_quote');assert.equal(result.run.error, null);
  await service.status({});assert.equal(recoveries, 1);assert.equal(executions, 0);assert(observations >= 1);
  current = { ...run };
  const unavailable = createRuns({ enabled: true, authorize: async () => ({ role: 'landlord', pair: { label: 'Pair', vendorIds: [] } }),
    store: { find: async () => current, reconcileDecline: async () => { throw Error('not reached'); } },
    inspectDeclineRecovery: async () => null, inspect: async () => { throw Error('unknown must not be ordinarily re-observed'); }, execute: async () => { executions++; } });
  assert.equal((await unavailable.status({})).run.error.code, 'action_unknown');assert.equal(executions, 0);
  current = { ...run, stepCode: 'vendor_work' };
  const otherUnknown = createRuns({ enabled: true, authorize: async () => ({ role: 'landlord', pair: { label: 'Pair', vendorIds: [] } }),
    store: { find: async () => current, reconcileDecline: async () => { throw Error('not reached'); } },
    inspectDeclineRecovery: async () => { throw Error('unrelated unknown must not enter refusal recovery'); },
    inspect: async () => { throw Error('not reached'); }, execute: async () => { executions++; } });
  assert.equal((await otherUnknown.status({})).run.error.code, 'action_unknown');assert.equal(executions, 0);
  console.log('PASS delayed refusal recovery: exact distinct delivery proof, known human hold, unknown/foreign effects quarantine, status-only/no execution or replay.');
})().catch(e => { console.error(e);process.exitCode = 1; });
