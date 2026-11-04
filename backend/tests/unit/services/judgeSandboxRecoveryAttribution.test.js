const assert = require('assert/strict');
const { createSimulationScope, metadataForRecord } = require('../../../services/judgeSandbox/simulationScope.service');
const { activityActor } = require('../../../services/request/activityActor.service');
const pair = { _id: 'pair_owned', landlordId: 'landlord_owned', vendorIds: ['vendor_a', 'vendor_b'] };
const scope = createSimulationScope({ verifyPair: async () => pair, verifyVendor: async () => {}, acceptDelivery: async () => ({ receiptRef: 'test_receipt' }) });
(async () => {
  await scope.withVendor({ pair }, 'request_owned', 'vendor_a', 'action_decline', async () => {
    const declined = { landlordId: pair.landlordId, requestId: 'request_owned', actor: 'vendor', actionType: 'vendor_response_declined' };
    const sent = { landlordId: pair.landlordId, requestId: 'request_owned', actor: 'ai_agent', actionType: 'vendor_outreach_sent', output: { provider: 'judge_simulation', vendorId: 'vendor_b' } };
    const declineMeta = metadataForRecord(declined), deliveryMeta = metadataForRecord(sent);
    assert.equal(declineMeta.vendorId, 'vendor_a');assert.equal(deliveryMeta.vendorId, 'vendor_b');
    assert.equal(activityActor({ ...declined, metadata: { judgeSimulation: declineMeta } }).actorKind, 'simulated_vendor');
    assert.equal(activityActor({ ...sent, metadata: { judgeSimulation: deliveryMeta } }).actorKind, 'automation');
    assert.equal(metadataForRecord({ ...sent, output: { provider: 'judge_simulation' } }).vendorId, 'delivery-only');
    assert.equal(metadataForRecord({ ...sent, output: { provider: 'judge_simulation', vendorId: 'foreign' } }).vendorId, 'delivery-only');
    assert.equal(metadataForRecord({ ...sent, landlordId: 'foreign' }), null);
    assert.equal(metadataForRecord({ ...sent, requestId: 'foreign' }), null);
    assert.equal(metadataForRecord({ ...declined, actor: 'tenant' }), null);
  });
  assert.equal(metadataForRecord({ landlordId: pair.landlordId, requestId: 'request_owned', actor: 'vendor' }), null);
  console.log('PASS recovery attribution: A refusal and B delivery stay distinct; backend actor remains Automation, unknown/foreign vendor not invented, scope denial unchanged.');
})().catch(error => { console.error(error);process.exitCode = 1; });
