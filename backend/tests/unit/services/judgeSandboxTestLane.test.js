'use strict';
const assert = require('node:assert/strict');
const policy = require('../../../services/judgeSandbox/liveBudgetPolicy.service');
const protocols = require('../../../services/judgeSandbox/liveProtocol.service');
const { createLiveBudgetStore } = require('../../../services/judgeSandbox/liveBudgetStore.service');
const { hash } = require('../../../services/judgeSandbox/contract.service');
const operator = require('../../../scripts/judge-sandbox-live.cjs');
const now = new Date('2026-11-03T19:00:00.000Z'), plan = policy.TEST_PLAN;
const state = { backendTree: 'a'.repeat(40), frontendTree: 'b'.repeat(40) };
const metadata = { database: plan.realm, manifestHash: 'c'.repeat(64), ...state, now };
const pairs = plan.phases.map(value => ({ ordinal: value.ordinal, _id: 'inert-local-pair-' + value.ordinal, active: true }));
function publicProtocol(phase = plan.phases[0]) {
  return { version: 2, phase: phase.name, campaignId: plan.campaignId, campaignAuthorizationRef: plan.authorizationRef,
    goRef: 'msg_aaaaaaaaaaaa', realm: plan.realm, manifestHash: metadata.manifestHash, ...state, allowedOrdinals: [phase.ordinal],
    rates: { ...protocols.RATES }, ratesVerifiedAt: '2026-11-03T18:00:00.000Z', expiresAt: policy.EXPIRES_AT, testPlanHash: policy.TEST_PLAN_HASH };
}
const configInput = { campaignId: plan.campaignId, kind: 'test', authorizationRef: plan.authorizationRef };
const config = policy.campaignConfig(configInput);
assert(Object.isFrozen(plan) && Object.isFrozen(plan.phases) && plan.phases.every(Object.isFrozen));
assert.equal(policy.TEST_PLAN_HASH, hash(require('../../../contracts/judgeSandboxTestLane.v1.json')));
assert.deepEqual([config.baselineNano, config.pauseNano, config.hardNano, config.maximumCalls], [457197250, 13e9, 20e9, 52]);
assert.equal(config.baselineRef, plan.baselineRef);
for (const changed of [{ campaignId: 'inert-fresh-test-counter' }, { authorizationRef: 'msg_bbbbbbbbbbbb' }, { baselineNano: 0 }, { maximumCalls: 53 }])
  assert.throws(() => policy.campaignConfig({ ...configInput, ...changed }), /INVALID_LIVE_CAMPAIGN/);
for (const phase of plan.phases) {
  const publicValue = publicProtocol(phase), validated = protocols.validateProtocol(publicValue, metadata), binding = protocols.resolveBinding(validated, pairs);
  assert.equal(binding.kind, 'test'); assert.equal(binding.maximumCalls, 52); assert.equal(binding.phaseMaximumCalls, phase.maximumCalls);
  assert.deepEqual(binding.allowedPairs, [{ realm: plan.realm, pairRef: 'inert-local-pair-' + phase.ordinal, ordinal: phase.ordinal, phase: phase.name, maximumCalls: phase.maximumCalls }]);
  assert(Object.isFrozen(binding.allowedPairs[0]));
  for (const ordinal of [1, 2, 3, 4, 5, 6, 10].filter(value => value !== phase.ordinal))
    assert.throws(() => protocols.validateProtocol({ ...publicValue, allowedOrdinals: [ordinal] }, metadata), /INVALID_FROZEN_LIVE_PROTOCOL/);
  for (const changed of [{ version: 1 }, { testPlanHash: 'd'.repeat(64) }, { phase: 'test' }, { allowedOrdinals: [3, 4, 5] },
    { campaignId: 'inert-fresh-test-counter' }, { campaignAuthorizationRef: 'msg_bbbbbbbbbbbb' }, { realm: 'artrelo_judge_release_test' },
    { backendTree: 'd'.repeat(40) }, { frontendTree: 'd'.repeat(40) }, { baselineNano: 0 }, { maximumCalls: 999 }])
    assert.throws(() => protocols.validateProtocol({ ...publicValue, ...changed }, { ...metadata, database: changed.realm || plan.realm }), /INVALID_FROZEN_LIVE_PROTOCOL/);
  assert.throws(() => protocols.resolveBinding(validated, pairs.map(pair => ({ ...pair, active: false }))), /LIVE_PROTOCOL_PAIR_MISMATCH/);
}
const valid = protocols.resolveBinding(protocols.validateProtocol(publicProtocol(), metadata), pairs);
const fakeConnection = name => ({ name, db: {}, getClient: () => ({ startSession() {} }) });
assert.throws(() => createLiveBudgetStore({ connection: fakeConnection(protocols.CONTROL_DATABASE), config: configInput }), /LIVE_PROTOCOL_MISMATCH/);
assert.throws(() => createLiveBudgetStore({ connection: fakeConnection('artrelo_judge_budget_control_other_test'), config: configInput, protocol: valid }), /LIVE_PROTOCOL_MISMATCH/);
const counters = (chargedNano, attempts = 0) => ({ chargedNano, reservedNano: 0, attemptCount: attempts, sentCount: attempts });
const campaign = (chargedNano = config.baselineNano, attempts = 0) => ({ ...counters(chargedNano, attempts), configHash: config.configHash, halted: false });
const reservation = 1319424000;
policy.assertAdmission(config, campaign(), counters(0), reservation, now);
policy.assertAdmission(config, campaign(config.pauseNano - reservation - 1), counters(0), reservation, now);
assert.throws(() => policy.assertAdmission(config, campaign(config.pauseNano - reservation), counters(0), reservation, now), /LIVE_BUDGET_PAUSED/);
assert.throws(() => policy.assertAdmission(config, campaign(config.baselineNano, 52), counters(0), reservation, now), /LIVE_SEND_LIMIT/);
assert.equal(policy.campaignConfig({ campaignId: 'inert-recording-unchanged', kind: 'recording', authorizationRef: plan.authorizationRef }).pauseNano, 3e9);
assert.equal(policy.campaignConfig({ campaignId: 'inert-judge-unchanged', kind: 'judge', authorizationRef: plan.authorizationRef }).maximumCalls, 300);
console.log('PASS TEST lane immutable baseline/caps, exact one-pair phase protocols, no foreign realm/source/counter, required real protocol capability, unchanged legacy caps. No DB, provider, key or prompt.');

async function rejectBeforePrompt() {
  let prompts = 0;
  const manifest = require('../../../contracts/judgeSandbox.v1.json');
  // Rejection happens on protocol/source validation, before any private capability.
  const fixture = require('../../../services/judgeSandbox/fixture.service');
  const actualManifest = { version: 1, authorizationRef: 'inert-operator-proof', assignedPairs: 8, sparePairs: 2,
    initialPolicy: { defaultQuotaMinor: 25000, lowAutopilot: true, mediumAutopilot: true, autoContact: true, maxVendors: 3, quoteClarification: true }, syntheticOpeningWalletMinor: 100000 };
  fixture.validateManifest(actualManifest);
  const roster = { version: 1, pairs: Array.from({ length: 10 }, (_, i) => ({ ordinal: i + 1, landlordEmail: `landlord${i + 1}@artrelo.judge`, tenantEmail: `tenant${i + 1}@artrelo.judge` })) };
  const bad = { ...publicProtocol(), manifestHash: hash(actualManifest), testPlanHash: 'e'.repeat(64) };
  await assert.rejects(operator.collectEnvelope({ options: { mode: 'serve', database: plan.realm, frontendOrigin: 'http://127.0.0.1:3144', port: 8028 }, manifestPath: 'manifest', rosterPath: 'roster', protocolPath: 'protocol' }, {
    readPublicJson: file => file === 'manifest' ? actualManifest : file === 'roster' ? roster : bad, state: () => state, now: () => now,
    prompt: async () => { prompts++; throw Error('Private prompt forbidden'); },
  }), /INVALID_FROZEN_LIVE_PROTOCOL/);
  assert.equal(prompts, 0); assert(manifest);
  console.log('PASS TEST protocol refusal before signing/key prompt; no owner runtime, credential or live activation.');
}
rejectBeforePrompt().catch(error => { console.error(error); process.exitCode = 1; });
