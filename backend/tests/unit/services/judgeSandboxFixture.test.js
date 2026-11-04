const assert = require('assert/strict');
const { validateManifest, syntheticDatabase, makePrivateCredentials } = require('../../../services/judgeSandbox/fixture.service');
const { deniedFinancialMutation } = require('../../../services/judgeSandbox/application.service');
const m = { version: 1, authorizationRef: 'synthetic-test-manifest', assignedPairs: 10, sparePairs: 2,
  initialPolicy: { defaultQuotaMinor: 25000, lowAutopilot: true, mediumAutopilot: true, autoContact: true, maxVendors: 3, quoteClarification: true }, syntheticOpeningWalletMinor: 100000 };
assert.equal(validateManifest(m), m);
for (const bad of [{ ...m, reset: true }, { ...m, assignedPairs: 11 }, { ...m, sparePairs: 3 }, { ...m, syntheticOpeningWalletMinor: -1 }, { ...m, initialPolicy: { ...m.initialPolicy, approveSpend: true } }, { ...m, initialPolicy: { ...m.initialPolicy, defaultQuotaMinor: 1.5 } }]) assert.throws(() => validateManifest(bad));
syntheticDatabase({ name: 'artrelo_judge_fixture_test' });syntheticDatabase({ name: 'artrelo_iris_judge_core_123_test' });
for (const name of ['production', 'artrelo_iris_m4_20261029_test', 'artrelo_judge_real']) assert.throws(() => syntheticDatabase({ name }));
const credentials = makePrivateCredentials(12);assert.equal(credentials.length, 12);assert.equal(new Set(credentials.flatMap(row => [row.landlord, row.tenant])).size, 24);assert(credentials.every(row => row.landlord.length >= 24 && row.tenant.length >= 24));
for (const path of ['/landlords/ledger/deposits', '/landlords/ledger/entries/record/mark-paid', '/payments/intent', '/landlords/appointments/record/direct-payment', '/landlords/billing/setup']) assert.equal(deniedFinancialMutation({ method: 'POST', path }), true);
assert.equal(deniedFinancialMutation({ method: 'GET', path: '/landlords/ledger' }), false);assert.equal(deniedFinancialMutation({ method: 'POST', path: '/judge-sandbox/runs' }), false);
console.log('PASS judge fixtures: explicit bounded manifest only, synthetic namespaces, distinct private generated credentials, no reset, no top-up/manual-payment mutation; Wallet read retained.');
