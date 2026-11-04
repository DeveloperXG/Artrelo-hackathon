'use strict';
// Public activation metadata only. A GO reference is an operator-supplied audit
// pointer, not cryptographic proof of an executive decision; owner procedure
// still requires the separately accepted frozen protocol before key entry.
const policy = require('./liveBudgetPolicy.service');
const { hash } = require('./contract.service');
const bindings = new WeakSet();
const validated = new WeakSet();
const CONTROL_DATABASE = 'artrelo_judge_budget_control_test';
const RATES = Object.freeze({ model: policy.MODEL, inputWindow: policy.WINDOW, inputNanoPerToken: policy.INPUT_NANO, outputNanoPerToken: policy.OUTPUT_NANO });
function validateProtocol(input, { database, manifestHash, backendTree, frontendTree, now = new Date() } = {}) {
  const keys = ['version','phase','campaignId','campaignAuthorizationRef','goRef','realm','manifestHash','backendTree','frontendTree','allowedOrdinals','rates','ratesVerifiedAt','expiresAt'];
  const testPhase = input?.version === 2 ? policy.TEST_PLAN.phases.find(value => value.name === input.phase) : null;
  const testValid = testPhase && input.testPlanHash === policy.TEST_PLAN_HASH && input.campaignId === policy.TEST_PLAN.campaignId &&
    input.campaignAuthorizationRef === policy.TEST_PLAN.authorizationRef && input.realm === policy.TEST_PLAN.realm &&
    Array.isArray(input.allowedOrdinals) && input.allowedOrdinals.length === 1 && input.allowedOrdinals[0] === testPhase.ordinal;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !policy.exactKeys(input, testPhase ? [...keys,'testPlanHash'] : keys) ||
      !(input.version === 1 && ['qualification','recording','judge'].includes(input.phase) || testValid) ||
      !policy.ref(input.campaignId) || ![input.campaignAuthorizationRef,input.goRef].every(value => /^msg_[a-f0-9]{12}$/.test(value || '')) ||
      !policy.database(input.realm) || input.realm !== database || !/^[a-f0-9]{64}$/.test(input.manifestHash || '') || input.manifestHash !== manifestHash ||
      ![input.backendTree,input.frontendTree].every(value => /^[a-f0-9]{40}$/.test(value || '')) || input.backendTree !== backendTree || input.frontendTree !== frontendTree ||
      !Array.isArray(input.allowedOrdinals) || !input.allowedOrdinals.length || input.allowedOrdinals.length > 10 ||
      input.allowedOrdinals.some(n => !Number.isInteger(n) || n < 1 || n > 10 || input.phase === 'qualification' && n === 1) ||
      new Set(input.allowedOrdinals).size !== input.allowedOrdinals.length || !policy.exactKeys(input.rates, Object.keys(RATES)) ||
      Object.entries(RATES).some(([key,value]) => input.rates[key] !== value) ||
      typeof input.ratesVerifiedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.ratesVerifiedAt) ||
      !Number.isFinite(Date.parse(input.ratesVerifiedAt)) || new Date(input.ratesVerifiedAt) > now ||
      input.expiresAt !== policy.EXPIRES_AT || !(now < new Date(policy.EXPIRES_AT))) throw policy.fail('INVALID_FROZEN_LIVE_PROTOCOL');
  const result = Object.freeze({ ...input, allowedOrdinals: Object.freeze([...input.allowedOrdinals].sort((a,b) => a-b)), rates: RATES });validated.add(result);return result;
}
function resolveBinding(protocol, pairs) {
  if (!validated.has(protocol) || !Array.isArray(pairs) || !protocol.allowedOrdinals.every(n => pairs.filter(pair => pair.ordinal === n && pair.active === true).length === 1)) throw policy.fail('LIVE_PROTOCOL_PAIR_MISMATCH');
  const testPhase = protocol.version === 2 ? policy.TEST_PLAN.phases.find(value => value.name === protocol.phase) : null;
  const allowedPairs = protocol.allowedOrdinals.map(n => ({ realm: protocol.realm, pairRef: String(pairs.find(pair => pair.ordinal === n)._id),
    ...(testPhase ? { ordinal: n, phase: testPhase.name, maximumCalls: testPhase.maximumCalls } : {}) }));
  if (allowedPairs.some(pair => !policy.ref(pair.pairRef)) || new Set(allowedPairs.map(pair=>pair.pairRef)).size !== allowedPairs.length) throw policy.fail('LIVE_PROTOCOL_PAIR_MISMATCH');
  const publicProtocolHash = hash(protocol), kind = testPhase ? 'test' : protocol.phase === 'judge' ? 'judge' : 'recording';
  const value = { protocolHash: publicProtocolHash, protocolKey: hash({ campaignId: protocol.campaignId, goRef: protocol.goRef }),
    phase: protocol.phase, goRef: protocol.goRef, backendTree: protocol.backendTree, frontendTree: protocol.frontendTree,
    manifestHash: protocol.manifestHash, maximumCalls: protocol.phase === 'qualification' ? 12 : policy.CAPS[kind].maximumCalls,
    ...(testPhase ? { testPlanHash: policy.TEST_PLAN_HASH, phaseMaximumCalls: testPhase.maximumCalls } : {}),
    campaignId: protocol.campaignId, authorizationRef: protocol.campaignAuthorizationRef, kind, allowedPairs: Object.freeze(allowedPairs.map(Object.freeze)) };
  const binding = Object.freeze({ ...value, bindingHash: hash(value) });bindings.add(binding);return binding;
}
module.exports = { CONTROL_DATABASE, RATES, validateProtocol, resolveBinding, isProtocolBinding: value => bindings.has(value) };
