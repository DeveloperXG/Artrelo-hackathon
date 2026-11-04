const OpenAI = require("openai");
const env = require("../../config/env");

// Deliberately independent of config/openai: fault determination retains its client.
function configuration(config = env) {
  const provider = config.ai_triage_provider || "openai";
  const fallback = config.ai_triage_fallback_provider || "none";
  const timeout = Number(config.ai_triage_timeout_ms || 10000);
  const maxTokens = Number(config.ai_triage_max_tokens || 2500);
  if (!["openai", "meta"].includes(provider) || !["none", "openai"].includes(fallback) ||
      (fallback !== "none" && provider !== "meta") ||
      !Number.isInteger(timeout) || timeout < 1 || timeout > 20000 ||
      !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
    throw Object.assign(new Error("Invalid triage configuration"), { safeCode: "invalid_configuration" });
  }
  const providers = [provider, ...(fallback === "none" ? [] : [fallback])];
  for (const name of providers) {
    const model = name === "meta" ? config.meta_model : config.openai_model;
    if (typeof model !== "string" || !/^[a-zA-Z0-9._:/-]{1,100}$/.test(model)) {
      throw Object.assign(new Error("Invalid triage model"), { safeCode: "invalid_configuration" });
    }
  }
  return { provider, fallback, timeout, maxTokens, providers };
}

// The shared contract uses this JSON-schema subset. Reject extras, wrong types,
// missing fields and invalid enum/range values BEFORE business normalization.
function validSchema(value, schema) {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = types.some((type) => type === "null" ? value === null :
    type === "array" ? Array.isArray(value) : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) :
    type === "integer" ? Number.isInteger(value) : typeof value === type);
  if (!matches || (schema.enum && !schema.enum.includes(value))) return false;
  if (typeof value === "number" && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value)) return value.length <= (schema.maxItems ?? Infinity) && value.every((item) => validSchema(item, schema.items));
  if (value && typeof value === "object") {
    if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))) return false;
    return Object.entries(value).every(([key, item]) => !schema.properties[key] || validSchema(item, schema.properties[key]));
  }
  return true;
}

function safeError(error) {
  if (error?.safeCode) return error.safeCode;
  if (error?.status === 429) return "rate_limited";
  if (error?.name === "APIConnectionTimeoutError" || error?.name === "AbortError" || error?.code === "ETIMEDOUT") return "timeout";
  return "provider_error";
}

function createTriageRunner({ config = env, clientFactory = (options) => new OpenAI(options), completeRequest = null, now = Date.now, validateResponse = validSchema } = {}) {
  if (typeof validateResponse !== 'function') throw new TypeError('A server-owned response validator is required');
  if (completeRequest !== null && typeof completeRequest !== 'function') throw new TypeError('An explicit completion capability is required');
  const clients = new Map();
  return async function run({ messages, schema }) {
    const attempts = [];
    let settings;
    try { settings = configuration(config); }
    catch (error) { return { parsed: null, telemetry: { provider: "deterministic_fallback", outcome: "fallback", errorCode: safeError(error), attempts } }; }
    for (const provider of settings.providers) {
      const started = now();
      const model = provider === "meta" ? config.meta_model : config.openai_model;
      const apiKey = provider === "meta" ? config.meta_api_key : config.openai_api_key;
      const attempt = { provider, model, outcome: "failed", durationMs: 0 };
      try {
        if (!completeRequest && !apiKey) throw Object.assign(new Error("Missing key"), { safeCode: "missing_key" });
        if (!completeRequest && !clients.has(provider)) clients.set(provider, clientFactory({ apiKey,
          ...(provider === "meta" ? { baseURL: "https://api.meta.ai/v1" } : config.openai_base_url ? { baseURL: config.openai_base_url } : {}),
          maxRetries: 0, timeout: settings.timeout }));
        const body = { model, messages,
          response_format: { type: "json_schema", json_schema: schema },
          // Spark's completion budget includes reasoning. Keep reasoning minimal
          // and use its tuned temperature default so structured output has room.
          ...(provider === "meta"
            ? { max_completion_tokens: settings.maxTokens, reasoning_effort: "minimal" }
            : { temperature: 0.5, max_tokens: settings.maxTokens }) };
        const completion = await (completeRequest ? completeRequest(body) : clients.get(provider).chat.completions.create(body));
        // A rejected answer can still be billable. Capture only numeric counters,
        // including on refusal/truncation/validation failure.
        for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
          const value = completion.usage?.[key];
          if (Number.isSafeInteger(value) && value >= 0) (attempt.usage ||= {})[key] = value;
        }
        const choice = completion?.choices?.[0];
        if (choice?.message?.refusal) throw Object.assign(new Error("Refused"), { safeCode: "refusal" });
        if (choice?.finish_reason !== "stop") throw Object.assign(new Error("Incomplete"), { safeCode: "incomplete_output" });
        if (!choice?.message?.content?.trim()) throw Object.assign(new Error("Empty"), { safeCode: "empty_output" });
        let parsed;
        try { parsed = JSON.parse(choice.message.content); }
        catch (_) { throw Object.assign(new Error("Invalid JSON"), { safeCode: "invalid_json" }); }
        if (!validateResponse(parsed, schema.schema)) throw Object.assign(new Error("Invalid schema"), { safeCode: "invalid_schema" });
        attempt.outcome = "success";
        attempt.durationMs = Math.max(0, now() - started);
        attempts.push(attempt);
        return { parsed, telemetry: { provider, model, outcome: attempts.length > 1 ? "provider_fallback" : "success", attempts } };
      } catch (error) {
        attempt.errorCode = safeError(error);
        attempt.durationMs = Math.max(0, now() - started);
        attempts.push(attempt);
      }
    }
    return { parsed: null, telemetry: { provider: "deterministic_fallback", outcome: "fallback", attempts } };
  };
}

const defaultTriage = createTriageRunner();
let guardedTriage = null;
function registerGuardedTriage(proof, run) {
  if (!require('../judgeSandbox/offlineGuard.service').isGuardedLiveProof(proof) || typeof run !== 'function' || guardedTriage) throw new TypeError('Explicit isolated triage registration required');
  guardedTriage = run;
}
module.exports = { configuration, validSchema, createTriageRunner, registerGuardedTriage,
  runTriage: input => (guardedTriage || defaultTriage)(input) };
