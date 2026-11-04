const assert = require("node:assert/strict");
const { createBudgetedAnalysisProvider } = require("../../../services/quotes/analysisProvider.service");
let calls = 0, reserves = 0;
const parsed = { schemaVersion: 1, summary: "Review required.", flags: [], questions: [], reviewRecommendation: "landlord_review" };
const clientFactory = options => {
  assert.equal(options.baseURL, "https://api.meta.ai/v1"); assert.equal(options.maxRetries, 0); assert.equal(options.timeout, 10000);
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
  console.log("Analysis adapter: synthetic client only, explicit pre-call budget gate, fixed Standard Spark and no retries PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
