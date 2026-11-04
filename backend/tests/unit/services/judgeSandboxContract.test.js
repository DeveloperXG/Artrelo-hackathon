const assert = require('assert/strict');
const c = require('../../../contracts/judgeSandbox.v1.json');
const { assertValid } = require('../../../contracts/validate.cjs');
const check = (name, value) => assertValid(c.$defs[name], value, c.$defs);
const at = '2026-10-31T06:00:00.000Z';
const run = { runId: 'run_owned', requestId: null, revision: 1, state: 'waiting_on_tenant',
  step: { index: 1, total: 13, code: 'tenant_submit', title: 'Submit the tenant request', detail: 'Use the paired tenant account.' },
  allowedActions: ['pause'], checkpoint: { kind: 'tenant_submit', requestId: null, approvalId: null }, error: null, startedAt: at, updatedAt: at, completedAt: null };
check('Run', run);check('Status', { contractVersion: '1.2.0', enabled: true, pairLabel: 'Judge pair 1', role: 'landlord', simulatedVendorIds: ['vendor_owned'], run });
check('Status', { contractVersion: '1.2.0', enabled: false, pairLabel: null, role: null, simulatedVendorIds: [], run: null });
check('StartInput', {});check('ActionInput', { expectedRevision: 1, stepCode: 'vendor_quote' });
// Reject selectors/capabilities and consent shortcuts, not just malformed UI.
for (const injected of [{ landlordId: 'foreign' }, { pairId: 'foreign' }, { tenantConfirm: true }, { method: 'approve_bill' }]) assert.throws(() => check('StartInput', injected));
for (const input of [{ expectedRevision: 0, stepCode: 'vendor_quote' }, { expectedRevision: 1, stepCode: 'approve' }, { expectedRevision: 1, stepCode: 'vendor_quote', vendorId: 'foreign' }, { expectedRevision: 1, stepCode: 'vendor_quote', confirmed: true }]) assert.throws(() => check('ActionInput', input));
for (const [code] of Object.entries(c.errors)) check('Error', { success: false, code, message: 'Safe customer copy.', retryAfterSeconds: null, nextAvailableAt: null });
assert.throws(() => check('Error', { success: false, code: 'provider_dump', message: 'x', retryAfterSeconds: null, nextAvailableAt: null }));
assert.throws(() => check('Run', { ...run, updatedAt: '2026-99-99Tnope' }));
assert.throws(() => check('Run', { ...run, allowedActions: ['approve'] }));
assert.throws(() => check('Status', { contractVersion: '1.2.0', enabled: true, pairLabel: 'Pair', role: 'admin_override', simulatedVendorIds: [], run }));
assert.equal(c.steps.length, 14);assert.equal(new Set(c.steps).size, 14);
assert.equal(c.legacySteps.length, 13);assert.equal(new Set(c.legacySteps).size, 13);
assert.deepEqual(c.$defs.StepCode.enum, c.steps);assert.deepEqual(c.$defs.Run.properties.state.enum, c.states);
assert.deepEqual(c.$defs.Error.properties.code.enum, Object.keys(c.errors));
assert.deepEqual(c.$defs.RunError.properties.code.enum, Object.keys(c.errors));
console.log('PASS judge contract: closed transport, injected owner/consent/method selectors denied, finite allowed actions/errors, positive disabled and own-run shapes.');
