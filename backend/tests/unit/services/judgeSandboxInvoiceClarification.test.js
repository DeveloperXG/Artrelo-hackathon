const assert = require('node:assert/strict');
const { projectDomain } = require('../../../services/judgeSandbox/domain.service');
const { view } = require('../../../services/judgeSandbox/contract.service');
const now = new Date('2026-11-04T13:00:00Z');
const run = { _id: 'run_owned', revision: 24, stepCode: 'landlord_review', state: 'waiting_on_landlord',
  startedAt: now, updatedAt: now, completedDirectives: ['vendor_work'] };
const request = { _id: 'request_owned', landlordId: 'landlord_owned', status: 'approved' };
const appointment = { _id: 'visit_owned', requestId: request._id, landlordId: request.landlordId, vendorId: 'vendor_owned' };
const completion = { _id: 'completion_owned', landlordId: request.landlordId, requestId: request._id,
  appointmentId: appointment._id, vendorId: appointment.vendorId, quoteContractVersion: 2, status: 'confirmed',
  report: { submittedAt: now, actualCost: 240, finalStatement: { revision: 1, hash: 'invoice_hash' } },
  tenantConfirmation: { outcome: 'confirmed', respondedAt: now },
  invoiceReview: { state: 'waiting_clarification', clarificationId: 'followup_owned', quoteHash: 'invoice_hash', contextHash: 'context_owned' } };
const invoiceClarification = { _id: 'followup_owned', subjectId: completion._id, landlordId: request.landlordId,
  requestId: request._id, stage: 'invoice', state: 'draft', quoteRevision: 1, quoteHash: 'invoice_hash', contextHash: 'context_owned',
  expiresAt: new Date(now.getTime() + 3600000), nonce: 'PRIVATE_INERT_TEST_NONCE' };
const project = changes => projectDomain({ run, request, appointment, completion, invoiceClarification, now, ...changes });
for (const confirmed of [false, true]) {
  const subject = { ...completion, status: confirmed ? 'confirmed' : 'awaiting_tenant', tenantConfirmation: confirmed ? completion.tenantConfirmation : {} };
  const observation = project({ completion: subject });
  assert.equal(observation.stepCode, 'landlord_review');assert.equal(observation.state, 'ready_to_continue');
  assert.equal(observation.checkpoint, null);assert.match(observation.detail, /Waiting for the vendor/);
  assert.match(observation.detail, /no human approval or payment/);
  const result = view({ ...run, ...observation });assert(result.allowedActions.includes('continue'));
  assert(!JSON.stringify(result).includes(invoiceClarification.nonce));assert(!JSON.stringify(result).includes('followup_owned'));
  assert.deepEqual(subject.tenantConfirmation, confirmed ? completion.tenantConfirmation : {}, 'projection never clears or manufactures consent');
}
assert.equal(project({ approval: { _id: 'actual_pending' } }).checkpoint.approvalId, 'actual_pending', 'a real human checkpoint wins');
assert.equal(project({ clarification: { stage: 'quote', state: 'ready' } }).stepCode, 'landlord_review', 'old quote follow-up cannot take over invoice stage');
for (const delta of [null, { stage: 'quote' }, { state: 'answered' }, { state: 'delivery_unknown' }, { state: 'expired' },
  { expiresAt: now }, { expiresAt: 'invalid' }, { landlordId: 'foreign' }, { requestId: 'foreign' }, { subjectId: 'foreign' },
  { _id: 'foreign' }, { quoteRevision: 2 }, { quoteHash: 'stale' }, { contextHash: 'stale' }]) {
  const observation = project({ invoiceClarification: delta === null ? null : { ...invoiceClarification, ...delta } });
  assert.equal(observation.state, 'waiting_on_landlord');assert.equal(observation.checkpoint, null);
  assert(!view({ ...run, ...observation }).allowedActions.includes('continue'));
  assert.match(observation.detail, /current answerable clarification is not available/);
}
for (const delta of [{ vendorId: 'foreign' }, { appointmentId: 'foreign' }, { landlordId: 'foreign' }, { requestId: 'foreign' },
  { status: 'closed' }, { quoteContractVersion: undefined }, { report: { ...completion.report, finalStatement: { revision: 2, hash: 'invoice_hash' } } }]) {
  assert.notEqual(project({ completion: { ...completion, ...delta } }).state, 'ready_to_continue');
}
for (const changed of [{ ...appointment, vendorId: 'foreign' }, { ...appointment, landlordId: 'foreign' }, { ...appointment, requestId: 'foreign' }, null])
  assert.notEqual(project({ appointment: changed }).state, 'ready_to_continue');
assert.equal(project({ completion: { ...completion, invoiceReview: { state: 'needs_review' } }, approval: { _id: 'invoice_decision' } }).checkpoint.approvalId, 'invoice_decision');
assert.equal(project({ completion: { ...completion, invoiceReview: { state: 'cleared' }, tenantConfirmation: {} } }).stepCode, 'tenant_completion', 'answering cannot consent for tenant');
console.log('PASS invoice Guide projection: exact current subject/stage/vendor/hash/revision, tenant order independence, truthful unavailable hold, actual human priority and no private capability projection.');
