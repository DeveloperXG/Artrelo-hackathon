const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const c = require('../../../contracts/judgeSandbox.v1.json');
const { assertValid } = require('../../../contracts/validate.cjs');
const check = (name, value) => assertValid(c.$defs[name], value, c.$defs);
const at = '2026-11-01T15:00:00.000Z';
const legacy = { runId: 'run_legacy', requestId: 'request_owned', revision: 3, state: 'ready_to_continue',
  step: { index: 3, total: 13, code: 'vendor_quote', title: 'Receive the itemized quote', detail: 'Legacy run retains its original next action.' },
  allowedActions: ['continue', 'pause'], checkpoint: null, error: null, startedAt: at, updatedAt: at, completedAt: null };
const recovery = { ...legacy, runId: 'run_new', step: { ...legacy.step, index: 3, total: 14, code: 'vendor_decline', title: 'Simulated vendor declines' } };
check('Run', legacy);check('Run', recovery);
check('Run', { ...legacy, state: 'completed', step: { ...legacy.step, index: 13, code: 'complete' }, allowedActions: [], completedAt: at });
check('Run', { ...recovery, state: 'completed', step: { ...recovery.step, index: 14, code: 'complete' }, allowedActions: [], completedAt: at });
assert.throws(() => check('Run', { ...legacy, step: { ...legacy.step, code: 'vendor_decline' } }));
assert.throws(() => check('Run', { ...legacy, step: { ...legacy.step, index: 14 } }));
assert.throws(() => check('Run', { ...recovery, step: { ...recovery.step, total: 15 } }));
assert.throws(() => check('Run', { ...recovery, step: { ...recovery.step, index: 15 } }));
assert.throws(() => check('Run', { ...recovery, step: { ...recovery.step, code: 'force_recovery' } }));
check('ActionInput', { expectedRevision: 3, stepCode: 'vendor_decline' });
for (const extra of [{ vendorId: 'foreign' }, { outcome: 'declined' }, { force: true }, { confirmed: true }, { storyVersion: c.storyVersions.declineRecovery }]) {
  assert.throws(() => check('ActionInput', { expectedRevision: 3, stepCode: 'vendor_decline', ...extra }));
  assert.throws(() => check('StartInput', extra));
}
assert.deepEqual(c.actions, ['continue', 'pause', 'resume']);
assert.deepEqual(c.steps.filter(step => step !== 'vendor_decline'), c.legacySteps);
assert.equal(c.steps.indexOf('vendor_decline'), 2);
const backend = fs.readFileSync(path.resolve(__dirname, '../../../contracts/judgeSandbox.v1.json'));
const frontend = fs.readFileSync(path.resolve(__dirname, '../../../../frontend/src/app/contracts/judgeSandbox.v1.json'));
assert.deepEqual(backend, frontend, 'Frozen contract copies must be byte-identical');
check('Status', { contractVersion: '1.2.0', enabled: true, pairLabel: 'Pair', role: 'landlord', simulatedVendorIds: ['owned_a', 'owned_b'], run: recovery });
assert.throws(() => check('Status', { contractVersion: '1.0.0', enabled: true, pairLabel: 'Pair', role: 'landlord', simulatedVendorIds: ['owned_a', 'owned_b'], run: recovery }));
const service = require('../../../services/judgeSandbox/contract.service');
assert.throws(() => service.validate('Run', { ...recovery, step: { ...recovery.step, index: 4 } }));
assert.throws(() => service.validate('Run', { ...legacy, step: { ...legacy.step, index: 4 } }));
const stored = { _id: 'run_stored', requestId: 'request_owned', revision: 3, state: 'ready_to_continue', stepCode: 'vendor_quote', startedAt: at, updatedAt: at };
assert.deepEqual([service.view(stored).step.index, service.view(stored).step.total], [3, 13]);
const next = { ...stored, storyVersion: c.storyVersions.declineRecovery, stepCode: 'vendor_decline' };
assert.deepEqual([service.view(next).step.index, service.view(next).step.total], [3, 14]);
assert.deepEqual([service.view({ ...stored, stepCode: 'complete', state: 'completed' }).step.index, service.view({ ...stored, stepCode: 'complete', state: 'completed' }).step.total], [13, 13]);
assert.deepEqual([service.view({ ...next, stepCode: 'complete', state: 'completed' }).step.index, service.view({ ...next, stepCode: 'complete', state: 'completed' }).step.total], [14, 14]);
assert.throws(() => service.view({ ...stored, storyVersion: 'future_unknown' }));
console.log('PASS recovery Guide contract: separate new/legacy sequences, preserved completed shape, closed actions/selectors, exact frontend copy.');
