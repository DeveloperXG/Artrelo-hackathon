const assert = require("assert");
const { createTriageRunner, validSchema, configuration } = require("../../../services/ai/triageProvider.service");
const { TRIAGE_SCHEMA, deterministicTriage, normalizeTriageOutput, aiTriage } = require("../../../services/ai/categorization.service");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const corpus = require("../../fixtures/triageCorpus");

const sample = require("../../fixtures/strictTriagePayload");
const payload = sample(TRIAGE_SCHEMA.schema);
payload.summary = "Synthetic maintenance issue.";
const config = { ai_triage_provider: "meta", ai_triage_fallback_provider: "none", meta_api_key: "synthetic-meta", meta_model: "muse-spark-1.3", openai_api_key: "synthetic-openai", openai_model: "gpt-4o-mini" };
const response = (body = payload, extras = {}) => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(body) }, ...extras }], usage: { total_tokens: 12, secret: "never persist" } });
function assertProviderParameters(request, provider, budget = 2500) {
  assert.strictEqual(request.response_format.json_schema, TRIAGE_SCHEMA);
  if (provider === "meta") {
    assert.equal(request.max_completion_tokens, budget);
    assert.equal(request.reasoning_effort, "minimal");
    assert(!Object.hasOwn(request, "temperature"), "Spark keeps its tuned temperature default");
    assert(!Object.hasOwn(request, "max_tokens"), "Spark uses the documented completion budget parameter");
  } else {
    assert.equal(request.max_tokens, budget);
    assert.equal(request.temperature, 0.5);
    assert(!Object.hasOwn(request, "reasoning_effort"), "Meta reasoning settings must not leak to GPT");
    assert(!Object.hasOwn(request, "max_completion_tokens"), "GPT retains its existing request contract");
  }
}

async function main() {
  assert(validSchema(payload, TRIAGE_SCHEMA.schema));
  for (const invalid of [{}, { ...payload, arbitrary: true }, { ...payload, severity: 99 }, { ...payload, location: { room: "kitchen" } }, { ...payload, access: { ...payload.access, permissionToEnter: "yes" } }, { ...payload, category: "invented" }]) assert(!validSchema(invalid, TRIAGE_SCHEMA.schema));
  for (const invalid of [{ ai_triage_provider: "invalid" }, { ai_triage_provider: "openai", ai_triage_fallback_provider: "openai" }, { ai_triage_timeout_ms: "99999" }, { ai_triage_max_tokens: "NaN" }]) assert.throws(() => configuration({ ...config, ...invalid }));

  for (const provider of ["meta", "openai"]) {
    const options = [];
    const calls = [];
    const runner = createTriageRunner({ config: { ...config, ai_triage_provider: provider }, clientFactory: (opts) => {
      options.push(opts);
      return { chat: { completions: { create: async (request) => { calls.push(request); return response(); } } } };
    } });
    for (const entry of corpus) {
      const result = await runner({ messages: [{ role: "user", content: entry.message }], schema: TRIAGE_SCHEMA });
      assert.equal(result.telemetry.provider, provider);
      assert.equal(result.telemetry.outcome, "success");
      const triage = normalizeTriageOutput(result.parsed, entry.message, entry.category, entry.context || {});
      assert.equal(triage.access.permissionToEnter, entry.consent ?? null);
      if (entry.emergency) assert.equal(triage.urgency, "emergency");
      const stored = new MaintenanceRequest({ ai: { ...triage, source: provider, raw: result.telemetry } }).toObject().ai;
      assert.equal(stored.source, provider);
      assert.deepEqual(stored.raw, result.telemetry);
      assert(!JSON.stringify(result.telemetry).includes("synthetic-"));
      assert(!JSON.stringify(result.telemetry).includes("never persist"));
    }
    assert.equal(options.length, 1);
    assert.equal(options[0].maxRetries, 0);
    assert.equal(options[0].timeout, 10000);
    assert.equal(options[0].baseURL, provider === "meta" ? "https://api.meta.ai/v1" : undefined);
    calls.forEach((call) => assertProviderParameters(call, provider));
  }

  for (const provider of ["meta", "openai"]) {
    let calls = 0;
    const runner = createTriageRunner({ config: { ...config, ai_triage_provider: provider, ai_triage_timeout_ms: "20000", ai_triage_max_tokens: "4096" },
      clientFactory: (options) => {
        assert.equal(options.timeout, 20000, "configured timeout remains bounded for both clients");
        assert.equal(options.maxRetries, 0, "neither client may silently multiply requests");
        return { chat: { completions: { create: async (request) => { calls++; assertProviderParameters(request, provider, 4096); return response(); } } } };
      } });
    const result = await runner({ messages: [], schema: TRIAGE_SCHEMA });
    assert.equal(result.telemetry.outcome, "success");
    assert.equal(calls, 1);
  }

  const failures = [
    [() => { throw { status: 429, message: "private exception" }; }, "rate_limited"],
    [() => { throw { name: "APIConnectionTimeoutError" }; }, "timeout"],
    [() => response({}, { message: { refusal: "private refusal" } }), "refusal"],
    [() => response(payload, { finish_reason: "length" }), "incomplete_output"],
    [() => response(payload, { message: { content: "" } }), "empty_output"],
    [() => response(payload, { message: { content: "invalid" } }), "invalid_json"],
    [() => response({ summary: "incomplete" }), "invalid_schema"],
    [() => { throw new Error("secret exception body"); }, "provider_error"],
  ];
  for (const [fail, code] of failures) {
    for (const fallback of ["none", "openai"]) {
      let count = 0;
      const runner = createTriageRunner({ config: { ...config, ai_triage_fallback_provider: fallback }, clientFactory: (options) => {
        assert.equal(options.timeout, 10000);
        assert.equal(options.maxRetries, 0);
        return { chat: { completions: { create: async (request) => {
          count++;
          assertProviderParameters(request, count === 1 ? "meta" : "openai");
          return count === 1 ? fail() : response();
        } } } };
      } });
      const result = await runner({ messages: [], schema: TRIAGE_SCHEMA });
      assert.equal(result.telemetry.attempts[0].errorCode, code);
      if (["refusal", "incomplete_output", "empty_output", "invalid_json", "invalid_schema"].includes(code)) assert.equal(result.telemetry.attempts[0].usage.total_tokens, 12);
      assert.equal(count, fallback === "none" ? 1 : 2);
      assert.equal(result.telemetry.provider, fallback === "none" ? "deterministic_fallback" : "openai");
      assert(!/private|secret/.test(JSON.stringify(result.telemetry)));
    }
  }
  let truncatedCalls = 0;
  const truncated = await createTriageRunner({ config, clientFactory: () => ({ chat: { completions: { create: async (request) => {
    truncatedCalls++; assertProviderParameters(request, "meta");
    return { ...response(payload, { finish_reason: "length" }), usage: { prompt_tokens: 2938, completion_tokens: 2500, total_tokens: 5438 } };
  } } } }) })({ messages: [], schema: TRIAGE_SCHEMA });
  assert.equal(truncatedCalls, 1, "truncation does not trigger an implicit retry or a larger budget");
  assert.equal(truncated.parsed, null, "even valid JSON is rejected when completion is truncated");
  assert.equal(truncated.telemetry.provider, "deterministic_fallback");
  assert.equal(truncated.telemetry.attempts[0].errorCode, "incomplete_output");
  assert.deepEqual(truncated.telemetry.attempts[0].usage, { prompt_tokens: 2938, completion_tokens: 2500, total_tokens: 5438 });
  const missing = await createTriageRunner({ config: { ...config, meta_api_key: "" }, clientFactory: () => { throw new Error("must not construct"); } })({ messages: [], schema: TRIAGE_SCHEMA });
  assert.equal(missing.telemetry.attempts[0].errorCode, "missing_key");
  for (const entry of corpus) {
    const triage = deterministicTriage(entry);
    if (entry.room) assert.equal(triage.location.room.toLowerCase(), entry.room);
    if (entry.emergency) assert.equal(triage.urgency, "emergency");
    if (entry.answeredTopic) assert(triage.intakeState.answers.some((answer) => answer.topicId === entry.answeredTopic && answer.state === entry.answerState));
    assert.equal(triage.access.permissionToEnter, entry.consent ?? null);
  }
  const detailed = deterministicTriage(corpus[0]);
  for (const topicId of ["impact", "location", "timeline", "attemptedFixes", "availability", "entryPermission"]) {
    assert(detailed.intakeState.answers.some((answer) => answer.topicId === topicId), topicId);
    assert.notEqual(detailed.intakeState.selectedQuestion?.topicId, topicId);
  }
  assert(detailed.location.area.includes("cabinet"));
  assert(detailed.timeline.started.includes("two hours"));
  assert(detailed.attemptedFixes.some((fix) => fix.includes("tightened")));
  const visitOnly = deterministicTriage({ message: "The kitchen tap leaks. I can be home for two hours on Monday evening." });
  assert(!visitOnly.timeline.started, "visit duration is not issue onset");
  const withdrawnOnset = deterministicTriage({ message: "Actually I do not know when it started.", context: { previousTriage: detailed } });
  assert.equal(withdrawnOnset.timeline.started, "", "withdrawn onset clears prior fact");
  assert.equal(withdrawnOnset.location.room, detailed.location.room);
  assert.equal(withdrawnOnset.impact, detailed.impact);
  assert.deepEqual(withdrawnOnset.attemptedFixes, detailed.attemptedFixes);
  assert.equal(withdrawnOnset.access.permissionToEnter, false);
  assert(withdrawnOnset.intakeState.answers.some((answer) => answer.topicId === "timeline" && answer.state === "unknown"));
  const offline = await aiTriage(corpus[0]);
  assert.equal(offline.triage.source, "deterministic_fallback");
  console.log("triageProvider: shared corpus, schema, failures, controlled fallback, consent, safety and persistence PASS");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
