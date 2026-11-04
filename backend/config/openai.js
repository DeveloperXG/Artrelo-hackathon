const OpenAI = require("openai");
const env = require("./env");

let _client = null;

function getOpenAI() {
  if (!env.openai_api_key) {
    console.warn("[openai] Missing API key. Set OPENAI_API_KEY.");
    return null;
  }
  if (_client) return _client;
  _client = new OpenAI({
    apiKey: env.openai_api_key,
    ...(env.openai_base_url ? { baseURL: env.openai_base_url } : {}),
    timeout: 20000,
    maxRetries: 2,
  });
  return _client;
}

module.exports = { getOpenAI };
