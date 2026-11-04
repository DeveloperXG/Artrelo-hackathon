const assert = require('assert/strict');
const { createSimulationScope, acceptOutreachDelivery, metadataForRecord } = require('../../../services/judgeSandbox/simulationScope.service');
const pair = { _id: 'pair1', landlordId: 'owner1', vendorIds: ['vendor1'] };
let accepted = 0, verified = 0;
const scope = createSimulationScope({ verifyPair: async ctx => { verified++;assert.equal(ctx.pair, pair);return pair; },
  verifyVendor: async (p, request, vendor) => { if (request !== 'request1' || vendor !== 'vendor1') throw Object.assign(Error(), { code: 'record_not_found' }); },
  acceptDelivery: async input => { assert.equal(input.requestId, 'request1');accepted++;return { receiptRef: 'simulation_receipt' }; } });
const args = { outreachId: 'outreach1', requestId: 'request1', landlordId: 'owner1', vendorId: 'vendor1' };
(async () => {
  assert.throws(() => createSimulationScope());assert.equal(await acceptOutreachDelivery(args), null);assert.equal(metadataForRecord({ actor: 'vendor' }), null);
  await scope.withPair({ pair }, async () => {
    const result = await acceptOutreachDelivery(args);assert.equal(result.provider, 'judge_simulation');assert.equal(result.simulated, true);
    await assert.rejects(() => acceptOutreachDelivery({ ...args, landlordId: 'foreign' }), e => e.code === 'record_not_found');
    await assert.rejects(() => acceptOutreachDelivery({ ...args, vendorId: 'foreign' }), e => e.code === 'record_not_found');
    assert.equal(metadataForRecord({ landlordId: 'owner1', requestId: 'request1', actor: 'tenant' }), null, 'real human actions stay human');
  });
  await scope.withVendor({ pair }, 'request1', 'vendor1', 'action1', async () => {
    assert.equal(metadataForRecord({ landlordId: 'owner1', requestId: 'request1', actor: 'vendor' }).vendorId, 'vendor1');
    assert.equal(metadataForRecord({ landlordId: 'foreign', requestId: 'request1', actor: 'vendor' }), null);
    assert.equal(metadataForRecord({ landlordId: 'owner1', requestId: 'foreign', actor: 'vendor' }), null);
    assert.equal(metadataForRecord({ landlordId: 'owner1', requestId: 'request1', actor: 'landlord' }), null);
    await new Promise(resolve => setTimeout(resolve, 5));assert.equal(metadataForRecord({ landlordId: 'owner1', requestId: 'request1', actor: 'vendor' }).actionId, 'action1');
  });
  await assert.rejects(() => scope.withVendor({ pair }, 'foreign', 'vendor1', 'action1', () => {}), e => e.code === 'record_not_found');
  assert.equal(await acceptOutreachDelivery(args), null);assert.equal(accepted, 1);assert.equal(verified, 3);
  console.log('PASS explicit simulation: no default capability, pair/vendor/request denial, async scope isolation, truthful receipt and human actor preserved.');
})().catch(e => { console.error(e);process.exitCode = 1; });
