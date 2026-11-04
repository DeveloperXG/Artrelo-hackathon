'use strict';
const assert = require('node:assert/strict');
const p = require('../../../services/judgeSandbox/liveBudgetPolicy.service');
const { createLiveBudgetStore } = require('../../../services/judgeSandbox/liveBudgetStore.service');
const cfg = p.campaignConfig({ campaignId: 'judge-unit-campaign', kind: 'judge', authorizationRef: 'msg_6c5b68639d3d' });
const body = (purpose = 'planning') => ({ model: p.MODEL, messages: [{ role: 'system', content: 'Inert fixture schema-only request.' }, { role: 'user', content: 'Inert fixture.' }],
  response_format: { type: 'json_schema', json_schema: { name: 'inert', strict: true, schema: { type: 'object', additionalProperties: false, properties: {} } } },
  reasoning_effort: 'minimal', max_completion_tokens: p.OUTPUT_LIMITS[purpose] });
const counters = (chargedNano = 0, attemptCount = 0) => ({ chargedNano, reservedNano: 0, attemptCount, sentCount: attemptCount });
const campaign = overrides => ({ ...counters(), configHash: cfg.configHash, halted: false, ...overrides });
const now = new Date('2026-11-01T00:00:00Z');
assert.equal(cfg.pairHardNano, 2_000_000_000);
assert.equal(cfg.pauseNano, 10_000_000_000);
assert.equal(cfg.hardNano, 15_000_000_000);
assert(Object.isFrozen(cfg));
for (const [purpose, expected] of [['planning', 1_319_424_000], ['selection', 1_319_424_000], ['intake', 1_321_345_000], ['quote_analysis', 1_328_128_000]]) {
  const basis = p.requestBasis(purpose, body(purpose));assert.equal(basis.reservedNano, expected);
  p.assertAdmission(cfg, campaign(), counters(), expected, now);
  const remaining = cfg.pairHardNano - expected;
  p.assertAdmission(cfg, campaign({ chargedNano: remaining }), counters(remaining), expected, now);
  assert.throws(() => p.assertAdmission(cfg, campaign(), counters(remaining + 1), expected, now), /LIVE_BUDGET_PAUSED/);
  assert.throws(() => p.assertAdmission(cfg, campaign({ chargedNano: cfg.pauseNano - expected }), counters(), expected, now), /LIVE_BUDGET_PAUSED/);
  p.assertAdmission(cfg, campaign({ chargedNano: cfg.pauseNano - expected - 1 }), counters(), expected, now);
}
for (const mutate of [x => { x.model = 'muse-spark-1.3-contributor'; }, x => { x.tools = []; }, x => { x.stream = true; },
  x => { x.max_completion_tokens++; }, x => { x.reasoning_effort = 'high'; }, x => { x.response_format.json_schema.strict = false; },
  x => { x.messages[0].content = [{ type: 'image_url' }]; }, x => { x.messages[0].role = 'tool'; }, x => { x.messages[0].credentials = 'inert'; },
  x => { x.previous_response_id = 'not_allowed'; }]) {
  const changed = body();mutate(changed);assert.throws(() => p.requestBasis('planning', changed), /UNEXPECTED_LIVE_REQUEST/);
}
const huge = body();huge.messages[1].content = '字'.repeat(12000);assert.throws(() => p.requestBasis('planning', huge), /LIVE_BODY_LIMIT/);
assert.throws(() => p.requestBasis('unapproved', body()), /UNEXPECTED_LIVE_REQUEST/);
assert.equal(p.usageCost({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 }), 2_100_000);
for (const usage of [null, { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
  { prompt_tokens: 1.1, completion_tokens: 1, total_tokens: 2.1 }, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 },
  { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, extra: 'unexpected' },
  { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER }]) assert.throws(() => p.usageCost(usage), /INVALID_LIVE_USAGE/);
assert.throws(() => p.assertAdmission(cfg, campaign(), counters(), 1, new Date(p.EXPIRES_AT)), /LIVE_EXPIRED/);
assert.throws(() => p.assertAdmission(cfg, campaign({ halted: true }), counters(), 1, now), /LIVE_CAMPAIGN_STOPPED/);
assert.throws(() => p.assertAdmission(cfg, campaign(), counters(0, 30), 1, now), /LIVE_SEND_LIMIT/);
assert.throws(() => p.assertAdmission(cfg, campaign({ attemptCount: 300 }), counters(), 1, now), /LIVE_SEND_LIMIT/);
assert.throws(() => p.assertAdmission(cfg, campaign({ reservedNano: NaN }), counters(), 1, now), /LIVE_ACCOUNTING_INVALID/);
assert.throws(() => p.campaignConfig({ campaignId: 'judge-unit-campaign', kind: 'judge', authorizationRef: 'msg_6c5b68639d3d', pairHardNano: 999 }), /INVALID_LIVE_CAMPAIGN/);
assert.throws(() => createLiveBudgetStore({ connection: { name: 'production', db: {} }, config: {} }), /ISOLATED_BUDGET_DATABASE_REQUIRED/);
const recording = p.campaignConfig({ campaignId: 'recording-unit-campaign', kind: 'recording', authorizationRef: 'msg_6c5b68639d3d' });
assert.equal(recording.pauseNano, 3e9);assert.equal(recording.hardNano, 5e9);assert.equal(recording.pairHardNano, null);assert.equal(recording.maximumCalls, 100);
assert.notEqual(recording.configHash, cfg.configHash);
console.log('PASS isolated live budget policy: fixed owner caps/rates, full-window reservations, Unicode/body/tool/model limits, exact nanoUSD usage and pair/global/send/expiry boundaries. No DB, key or model call.');
