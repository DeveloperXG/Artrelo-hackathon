const assert = require("node:assert/strict");
const { createBudgetedAnalysisProvider, schema, schemaForContext } = require("../../../services/quotes/analysisProvider.service");
const { validSchema } = require("../../../services/ai/triageProvider.service");
let calls = 0, reserves = 0, expectedTimeout = 10000;
const parsed = { schemaVersion: 1, summary: "Review required.", flags: [], questions: [], reviewRecommendation: "landlord_review" };
const clientFactory = options => {
  assert.equal(options.baseURL, "https://api.meta.ai/v1"); assert.equal(options.maxRetries, 0); assert.equal(options.timeout, expectedTimeout);
  return { chat: { completions: { create: async body => {
    calls++; assert.equal(body.model, "muse-spark-1.3"); assert.equal(body.reasoning_effort, "minimal");
    assert.equal(body.max_completion_tokens, 4096);
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(parsed) } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
  } } } };
};
async function main() {
  assert.throws(() => createBudgetedAnalysisProvider({}), /authorizer/);
  const config = { meta_api_key: "synthetic-unit-placeholder", meta_model: "forbidden-model" };
  const denied = createBudgetedAnalysisProvider({ config, clientFactory, authorizeAttempt: async () => false });
  assert.equal((await denied({})).parsed, null); assert.equal(calls, 0);
  const allowed = createBudgetedAnalysisProvider({ config, clientFactory, authorizeAttempt: async ({ body, maxCompletionTokens }) => {
    reserves++; assert.equal(body.model, "muse-spark-1.3"); assert.equal(maxCompletionTokens, 4096);
    assert(Buffer.byteLength(JSON.stringify(body)) <= 32768); return true;
  } });
  const fakeResponse = await allowed({ title: "Synthetic unit fixture only" });
  assert.deepEqual(fakeResponse.parsed, parsed); assert.equal(reserves, 1); assert.equal(calls, 1);
  assert.equal(fakeResponse.telemetry.provider, "meta", "SDK response here is a local fake, not a live provider assertion");
  await allowed({ title: "x".repeat(40000) });
  assert.equal(reserves, 1); assert.equal(calls, 1, "oversized bodies fail before budget reservation or client call");
  expectedTimeout = 20000;
  const extended = createBudgetedAnalysisProvider({ config: { ...config, ai_triage_timeout_ms: 20000 }, clientFactory, authorizeAttempt: async () => true });
  assert.deepEqual((await extended({ title: 'Inert guarded deadline control' })).parsed, parsed);
  assert.equal(calls, 2, 'explicit guarded analysis timeout reaches SDK; ordinary default stays10s and retries stay0');
  const context = { request: { ref: 'request:owned' }, quote: { ref: 'quote:owned', items: [{ lineId: 'owned-line' }] }, history: [{ ref: 'job:owned' }] };
  const constrained = schemaForContext(context);
  const advisory = { ...parsed, flags: [{ code: 'unclear', lineIds: ['owned-line'], sourceRefs: ['quote:owned'], explanation: 'Review the supplied scope.' }] };
  assert.equal(validSchema(advisory, constrained.schema), true);
  assert.equal(validSchema({ ...advisory, flags: [{ ...advisory.flags[0], lineIds: ['foreign-line'] }] }, constrained.schema), false);
  assert.equal(validSchema({ ...advisory, flags: [{ ...advisory.flags[0], sourceRefs: ['request:foreign'] }] }, constrained.schema), false);
  assert.equal(schema.schema.properties.flags.items.properties.lineIds.items.enum, undefined, 'per-request constraints never mutate the shared template');
  const next = schemaForContext({ ...context, quote: { ref: 'quote:next', items: [{ lineId: 'next-line' }] } });
  assert.equal(validSchema(advisory, next.schema), false, 'a prior request schema cannot admit old reference values');
  let reservedBody, sentBody;
  const bound = createBudgetedAnalysisProvider({ config, authorizeAttempt: async ({ body }) => { reservedBody = body;return true; }, completeRequest: async body => {
    sentBody = body;return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(advisory) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  } });
  assert.deepEqual((await bound(context)).parsed, advisory);
  assert.deepEqual(reservedBody, sentBody, 'reservation and physical call bind the identical context-specific schema');
  console.log("Analysis adapter: synthetic client only, explicit pre-call budget gate, fixed Standard Spark and no retries PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
