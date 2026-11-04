'use strict';
// Explicit isolated capability only. No environment/key lookup or transport.
const { hash } = require('./contract.service');
const testPlanInput = require('../../contracts/judgeSandboxTestLane.v1.json');
const TEST_PLAN = Object.freeze({ ...testPlanInput, phases: Object.freeze(testPlanInput.phases.map(value => Object.freeze({ ...value }))) });
const TEST_PLAN_HASH = hash(TEST_PLAN);
const freshRecording = require('../../contracts/judgeSandboxFreshRecording.v1.json');
const NANO = 1_000_000_000;
const MODEL = 'muse-spark-1.3';
const WINDOW = 1_048_576;
const INPUT_NANO = 1250, OUTPUT_NANO = 4250;
const EXPIRES_AT = '2026-11-05T01:00:00.000Z';
const OUTPUT_LIMITS = Object.freeze({ intake: 2500, planning: 2048, selection: 2048, quote_analysis: 4096 });
const CAPS = Object.freeze({
  test: Object.freeze({ pauseNano: TEST_PLAN.pauseNano, hardNano: TEST_PLAN.hardNano, pairHardNano: null, maximumCalls: TEST_PLAN.maximumCalls, pairMaximumCalls: null }),
  recording: Object.freeze({ pauseNano: 3 * NANO, hardNano: 5 * NANO, pairHardNano: null, maximumCalls: 100, pairMaximumCalls: null }),
  judge: Object.freeze({ pauseNano: 10 * NANO, hardNano: 15 * NANO, pairHardNano: 2 * NANO, maximumCalls: 300, pairMaximumCalls: 30 })
});
const fail = code => Object.assign(new Error(code), { code });
const ref = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,119}$/.test(value);
const database = value => /^artrelo_(?:iris_judge_|judge_)[a-z0-9_]+_test$/.test(value || '');
const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...names].sort().join();
function campaignConfig(input) {
  if (!exactKeys(input, ['campaignId', 'kind', 'authorizationRef']) || !ref(input.campaignId) || !Object.hasOwn(CAPS, input.kind) ||
      !/^msg_[a-f0-9]{12}$/.test(input.authorizationRef || '')) throw fail('INVALID_LIVE_CAMPAIGN');
  if (input.kind === 'test' && (input.campaignId !== TEST_PLAN.campaignId || input.authorizationRef !== TEST_PLAN.authorizationRef)) throw fail('INVALID_LIVE_CAMPAIGN');
  const config = { version: 1, ...input, model: MODEL, inputWindow: WINDOW, inputNanoPerToken: INPUT_NANO,
    outputNanoPerToken: OUTPUT_NANO, expiresAt: EXPIRES_AT, ...CAPS[input.kind],
    ...(input.kind === 'recording' && input.campaignId === freshRecording.campaignId && input.authorizationRef === freshRecording.authorizationRef
      ? { pauseNano: freshRecording.pauseNano, capAmendmentRef: freshRecording.recordingPauseApprovalRef } : {}),
    ...(input.kind === 'test' ? { baselineNano: TEST_PLAN.baselineNano, baselineRef: TEST_PLAN.baselineRef, testPlanHash: TEST_PLAN_HASH } : {}) };
  return Object.freeze({ ...config, configHash: hash(config) });
}
function requestBasis(purpose, body) {
  const maximum = OUTPUT_LIMITS[purpose];
  const keys = ['model', 'messages', 'response_format', 'reasoning_effort', 'max_completion_tokens'];
  if (!maximum || !body || !Object.keys(body).every(k => keys.includes(k) || k === 'stream') ||
      keys.some(k => !Object.hasOwn(body, k)) || body.model !== MODEL || body.reasoning_effort !== 'minimal' ||
      body.max_completion_tokens !== maximum || Object.hasOwn(body, 'stream') && body.stream !== false ||
      !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 128 ||
      body.messages.some(m => !exactKeys(m, ['role', 'content']) || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') ||
      body.response_format?.type !== 'json_schema' || body.response_format?.json_schema?.strict !== true ||
      !body.response_format.json_schema.schema || typeof body.response_format.json_schema.schema !== 'object') throw fail('UNEXPECTED_LIVE_REQUEST');
  const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bodyBytes > 32768) throw fail('LIVE_BODY_LIMIT');
  return { purpose, bodyHash: hash(body), bodyBytes, maxCompletionTokens: maximum,
    reservedNano: WINDOW * INPUT_NANO + maximum * OUTPUT_NANO };
}
function usageCost(usage) {
  if (!exactKeys(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens']) ||
      !Object.values(usage).every(n => Number.isSafeInteger(n) && n >= 0) ||
      !Number.isSafeInteger(usage.prompt_tokens + usage.completion_tokens) ||
      usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens) throw fail('INVALID_LIVE_USAGE');
  const cost = usage.prompt_tokens * INPUT_NANO + usage.completion_tokens * OUTPUT_NANO;
  if (!Number.isSafeInteger(cost)) throw fail('INVALID_LIVE_USAGE');
  return cost;
}
function assertAdmission(config, campaign, pair, reservation, now) {
  if (!Number.isFinite(now.getTime()) || now >= new Date(config.expiresAt)) throw fail('LIVE_EXPIRED');
  if (!campaign || campaign.configHash !== config.configHash || campaign.halted) throw fail('LIVE_CAMPAIGN_STOPPED');
  for (const row of [campaign, pair]) {
    if (!row || !['chargedNano', 'reservedNano', 'attemptCount', 'sentCount'].every(k => Number.isSafeInteger(row[k]) && row[k] >= 0)) throw fail('LIVE_ACCOUNTING_INVALID');
  }
  const global = campaign.chargedNano + campaign.reservedNano + reservation;
  const local = pair.chargedNano + pair.reservedNano + reservation;
  if (![global, local].every(Number.isSafeInteger)) throw fail('LIVE_ACCOUNTING_INVALID');
  if (global >= config.pauseNano || global > config.hardNano || config.pairHardNano !== null && local > config.pairHardNano) throw fail('LIVE_BUDGET_PAUSED');
  if (campaign.attemptCount >= config.maximumCalls || config.pairMaximumCalls !== null && pair.attemptCount >= config.pairMaximumCalls) throw fail('LIVE_SEND_LIMIT');
}
module.exports = { NANO, MODEL, WINDOW, INPUT_NANO, OUTPUT_NANO, EXPIRES_AT, OUTPUT_LIMITS, CAPS,
  TEST_PLAN, TEST_PLAN_HASH, fail, ref, database, exactKeys, campaignConfig, requestBasis, usageCost, assertAdmission };
