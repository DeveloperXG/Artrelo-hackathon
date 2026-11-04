'use strict';
const assert = require('node:assert/strict');
const policy = require('../../../services/judgeSandbox/liveBudgetPolicy.service');
const { createLiveNetwork } = require('../../../services/judgeSandbox/liveNetwork.service');
const { installGuardedLiveSandbox } = require('../../../services/judgeSandbox/offlineGuard.service');
const { createLiveAuthority } = require('../../../services/judgeSandbox/liveAuthority.service');
const network = createLiveNetwork({ claimAttempt: async () => false, fetchImpl: async () => { throw Error('NO_NETWORK_ALLOWED'); } });
const proof = installGuardedLiveSandbox({ database: 'artrelo_iris_judge_provider_unit_test', frontendOrigin: 'http://127.0.0.1:3144' }, network);
const query = value => ({ select() { return this; }, lean: async () => value });
const landlord = { id: 'fixture-landlord-1', accountId: 'fixture-account-1', role: 'landlord', expiresAt: Date.now() + 60000 };
const tenant = { ...landlord, id: 'fixture-tenant-1', role: 'tenant' };
const pair = { _id: 'fixture-pair-1', vendorIds: ['fixture-vendor-1'] };
const args = { subjectId: 'fixture-subject-1', stage: 'quote', landlordId: landlord.id };
const basis = { request: { _id: 'fixture-request-1', landlordId: landlord.id, tenantId: tenant.id, unitId: 'fixture-unit', propertyId: 'fixture-property', status: 'pending' },
  subject: { _id: args.subjectId, landlordId: landlord.id, requestId: 'fixture-request-1', vendorId: pair.vendorIds[0] }, snapshot: { hash: 'quote-current' }, contextHash: 'context-current' };
const authority = createLiveAuthority({ proof, authorizePair: async user => ({ pair, actorId: user.id, accountId: user.accountId, role: user.role }), loadBasis: async () => basis,
  Pairs: { findOne: () => query(pair) }, Landlords: { findById: () => query({ _id: landlord.id, accountId: landlord.accountId, role: 'landlord', status: 'active' }) } });
let plannerOptions;
require('../../../services/iris/planner.service').createPlanner = options => { plannerOptions = options;return async () => ({ selected: [], source: 'model_planned' }); };
const review = require('../../../services/quotes/review.service');
review.runReview = async input => input.complete ? input.complete({ request: { ref: 'request:fixture-request-1' } }) : { parsed: null, telemetry: { provider: 'disabled' } };
const { createLiveProviders, isLiveProviders } = require('../../../services/judgeSandbox/liveProviders.service');
const calls = [], rows = new Map();let unavailable = false, invalid = false, highIntake = false, cancellations = 0;
const recoveryStops = [];
const budget = {
  async stopRecovery(reason) { recoveryStops.push(reason);return { stopped: true }; },
  async beginModelTurn() { return {}; },
  async finishModelTurn() { return {}; },
  async reserve(value) { assert(!rows.has(value.attemptRef));rows.set(value.attemptRef, { state: 'reserved', value });return { authorized: true, reservationRef: value.attemptRef }; },
  async viewAttempt(ref) { return rows.get(ref); },
  async cancelBeforeSend(ref) { assert.equal(rows.get(ref).state, 'reserved');rows.get(ref).state = 'not_sent';cancellations++; },
  async settle(ref) { rows.get(ref).state = 'unknown'; }
};
const answer = { outcome: 'clarify', calls: [], requestEvidence: null, assertedCurrentDefaultQuotaMinor: null, clarificationCode: 'severity_required', done: true };
const transport = { async execute(input) {
  const auth = await authority.authorize(input.purpose);policy.requestBasis(input.purpose, input.body);
  if (input.reservationRef) { assert.equal(input.reservationRef, input.attemptRef);assert.equal(rows.get(input.attemptRef).value.pairRef, auth.pairRef); }
  calls.push(input);
  if (unavailable) { if (input.reservationRef) rows.get(input.attemptRef).state = 'unknown';throw Error('INERT_TRANSPORT_UNAVAILABLE'); }
  if (input.reservationRef) rows.get(input.attemptRef).state = 'settled';
  const parsed = input.purpose === 'quote_analysis' ? { schemaVersion: 1, summary: 'Inert human review.', flags: [], questions: [], reviewRecommendation: 'landlord_review' }
    : input.purpose === 'intake' ? { summary: 'Inert maintenance issue.', ...(highIntake ? { urgency: 'high', severity: 4 } : {}) } : invalid ? { unsupported: true } : answer;
  return { model: policy.MODEL, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(parsed) } }] };
} };
async function main() {
  assert.throws(() => createLiveProviders({ proof: {}, authority, budget, transport }), /EXPLICIT_LIVE_PROVIDERS_REQUIRED/);
  const providers = createLiveProviders({ proof, authority, budget, transport });assert(isLiveProviders(providers, proof));assert(!isLiveProviders({}, proof));
  const triage = require('../../../services/ai/triageProvider.service');
  const input = { messages: [{ role: 'user', content: 'Inert fixture question.' }], schema: { name: 'triage_fixture', strict: true,
    schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } } };
  assert.equal((await triage.runTriage(input)).parsed, null);assert.equal(calls.length, 0);
  providers.register();assert.throws(providers.register, /LIVE_PROVIDERS_ALREADY_REGISTERED/);
  await authority.withUser(tenant, async () => { assert.equal((await triage.runTriage(input)).telemetry.provider, 'meta'); });
  await authority.withUser(landlord, async () => { assert.equal((await triage.runTriage(input)).parsed, null); });
  assert.equal(calls.length, 1);assert.equal(calls[0].body.max_completion_tokens, 2500);
  highIntake = true;
  const highInput = { ...input, schema: { ...input.schema, schema: { ...input.schema.schema, properties: {
    ...input.schema.schema.properties, urgency: { type: 'string' }, severity: { type: 'integer' } } } } };
  await authority.withUser(tenant, async () => {
    const result = await triage.runTriage(highInput);assert.equal(result.parsed.urgency, 'high');assert.equal(result.parsed.severity, 4);
  });
  assert(recoveryStops.includes('unsupported_intake'));highIntake = false;
  const contract = require('../../../contracts/iris.v2.json');
  const body = { model: policy.MODEL, messages: input.messages, reasoning_effort: 'minimal', max_completion_tokens: 2048,
    response_format: { type: 'json_schema', json_schema: { name: 'iris_planning_v2', strict: true, schema: contract.$defs.OnlinePlan } } };
  await authority.withUser(landlord, async () => {
    const reserve = async ref => plannerOptions.authorizeAttempt({ attemptRef: ref, purpose: 'planning', body });
    const prepared = await reserve('fixture-planning-1');
    const output = await plannerOptions.complete(body, { attemptRef: prepared.reservationRef, reservationRef: prepared.reservationRef });
    assert.deepEqual(output.parsed, answer);assert.equal(output.source, 'meta');await plannerOptions.settleAttempt(prepared);
    invalid = true;const invalidRef = await reserve('fixture-planning-invalid');
    const rejected = await plannerOptions.complete(body, { attemptRef: invalidRef.reservationRef, reservationRef: invalidRef.reservationRef });
    assert.equal(rejected.parsed, null);assert.equal(rejected.validationError, 'invalid_schema');assert.equal(rejected.usage.total_tokens, 120);invalid = false;
    assert(recoveryStops.includes('provider_validation_failed'));
    const unused = await reserve('fixture-planning-cancelled');await plannerOptions.settleAttempt(unused);assert.equal(cancellations, 1);
    unavailable = true;const failed = await reserve('fixture-planning-unavailable');
    await assert.rejects(plannerOptions.complete(body, { attemptRef: failed.reservationRef, reservationRef: failed.reservationRef }), error => error.code === 'model_unavailable');
    await plannerOptions.settleAttempt(failed);assert.equal(rows.get(failed.reservationRef).state, 'unknown');unavailable = false;
  });
  const quote = await review.queueRuntimeReview(args);assert.equal(quote.telemetry.provider, 'meta');assert.equal(calls.at(-1).purpose, 'quote_analysis');
  assert.equal(calls.at(-1).body.max_completion_tokens, 4096);assert.equal(cancellations, 1);
  const invoice = await review.queueRuntimeReview({ ...args, stage: 'invoice' });assert.equal(invoice.telemetry.provider, 'meta');
  assert.equal(calls.at(-1).purpose, 'quote_analysis');assert.equal(rows.size, 6); // Four Iris preparations and two advisories, never duplicate admission.
  network.dispose();
  console.log('PASS explicit provider seams: default off, no credential sentinel/SDK, tenant intake, landlord Iris reservation reuse, invalid-output distinction, safe unavailable fallback, unused cancellation and owned quote/final adapter. Fake transport and review/planner scaffolds only; no app/HTTP acceptance.');
}
main().catch(error => { console.error('FAIL guarded providers: ' + (error.code || 'ASSERTION'));process.exitCode = 1; });
