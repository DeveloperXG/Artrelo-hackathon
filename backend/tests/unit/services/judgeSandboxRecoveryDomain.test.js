const assert = require('assert/strict');
const { projectDomain } = require('../../../services/judgeSandbox/domain.service');
const { contract } = require('../../../services/judgeSandbox/contract.service');
const run = { _id: 'run_new', stepCode: 'routing', storyVersion: contract.storyVersions.declineRecovery, completedDirectives: [] };
const request = { _id: 'request_owned', landlordId: 'landlord_owned', status: 'queued' };
const a = { _id: 'outreach_a', vendorId: 'vendor_a', identityId: 'identity_a', status: 'sent', simulatedDelivery: true };
const b = { ...a, _id: 'outreach_b', vendorId: 'vendor_b', identityId: 'identity_b' };
const receipt = row => ({ _id: 'receipt_' + row._id, outreachId: row._id, landlordId: request.landlordId, requestId: request._id,
  vendorId: row.vendorId, identityId: row.identityId, channel: 'simulation', realDelivery: false, acceptedAt: new Date('2026-11-01T16:00:00Z') });
const project = fields => projectDomain({ run, request, outreach: a, firstOutreach: a, deliveryReceipt: receipt(a), ...fields });
assert.equal(project({}).stepCode, 'vendor_decline');
assert.equal(project({ run: { ...run, storyVersion: contract.storyVersions.legacy } }).stepCode, 'vendor_quote');
assert.equal(project({ run: { ...run, storyVersion: undefined }, firstOutreach: null, deliveryReceipt: null }).stepCode, 'vendor_quote');
for (const change of [{ deliveryReceipt: null }, { outreach: { ...a, simulatedDelivery: false } }, { outreach: { ...a, deliveryUnconfirmed: true } },
  { deliveryReceipt: { ...receipt(a), vendorId: 'foreign' } }, { deliveryReceipt: { ...receipt(a), identityId: 'foreign' } },
  { deliveryReceipt: { ...receipt(a), landlordId: 'foreign' } }, { deliveryReceipt: { ...receipt(a), outreachId: 'foreign' } },
  { deliveryReceipt: { ...receipt(a), realDelivery: true } }, { deliveryReceipt: { ...receipt(a), acceptedAt: 'invalid' } }]) {
  const state = project(change);assert.equal(state.state, 'failed');assert.equal(state.error.code, 'action_unknown');
}
assert.equal(project({ firstOutreach: null }).state, 'running');
const refused = { ...a, status: 'declined', respondedAt: new Date(), response: { outcome: 'declined' } };
const recovered = project({ outreach: b, firstOutreach: refused, deliveryReceipt: receipt(b) });
assert.equal(recovered.stepCode, 'vendor_quote');assert.match(recovered.detail, /first vendor refusal/);
assert.equal(project({ outreach: b, firstOutreach: { ...refused, status: 'expired', response: null }, deliveryReceipt: receipt(b) }).stepCode, 'vendor_quote', 'recorded out-of-band outcome never triggers another planned decline');
assert.equal(project({ outreach: refused, firstOutreach: refused, deliveryReceipt: null }).state, 'waiting_on_landlord');
const after = { ...run, completedDirectives: ['vendor_decline'] };
assert.equal(project({ run: after }).error.code, 'action_unknown', 'never repeat a completed directive when the current row disagrees');
assert.equal(project({ run: after, outreach: refused, firstOutreach: refused, deliveryReceipt: null }).error, null, 'a completed known refusal waiting for next contact is a hold, not an unknown action');
assert.equal(project({ run: after, outreach: refused, firstOutreach: refused, deliveryReceipt: null }).state, 'waiting_on_landlord');
assert.equal(project({ run: after, request: { ...request, routingStatus: 'paused' }, outreach: refused, firstOutreach: refused }).state, 'waiting_on_landlord');
assert.equal(project({ run: after, outreach: refused, firstOutreach: refused, approval: { _id: 'real_decision' } }).checkpoint.approvalId, 'real_decision');
assert.equal(project({ outreach: { ...a, status: 'accepted', respondedAt: new Date() } }).stepCode, 'booking', 'never rewind an actual accepted quote to force a refusal');
console.log('PASS recovery projection: first-only refusal, actual next-vendor delivery, legacy and out-of-band truth, missing/foreign/unknown proof and real human holds.');
