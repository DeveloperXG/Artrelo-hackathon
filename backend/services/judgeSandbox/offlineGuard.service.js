const path = require('path'), crypto = require('crypto');
const REAL_KEYS = ['MODEL_API_KEY', 'OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_PUB_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET_THIN',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PROXY_NUMBERS', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'SENTRY_DSN', 'SYSTEM_API_KEY'];
const OFF_FLAGS = ['IS_PRODUCTION', 'OUTREACH_EMAIL_ENABLED', 'EMERGENCY_CALLS_ENABLED', 'RELAY_SMS_ENABLED', 'SERVICE_BILLING_ENABLED', 'SERVICE_BILLING_COLLECTION_ENABLED', 'REGISTRATION_ENABLED', 'TENANT_SIGNUP_ENABLED'];
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const proofs = new WeakSet();
const liveProofs = new WeakSet();
let installed = false;
function hostOf(input, second) {
  if (Array.isArray(input)) return hostOf(input[0], input[1]);
  if (typeof input === 'number') return typeof second === 'string' ? second : 'localhost';
  if (typeof input === 'string' || input instanceof URL) { try { return new URL(input).hostname; } catch { return null; } }
  if (input?.url) return hostOf(input.url);
  if (input?.hostname) return input.hostname;
  if (input?.host) { if (loopback.has(input.host)) return input.host;try { return new URL('http://' + input.host).hostname; } catch { return null; } }
  if (Number.isInteger(input?.port) || typeof input?.port === 'string' && /^\d+$/.test(input.port)) return 'localhost';
  return null;
}
function installCore({ database, frontendOrigin, signingSecrets = null } = {}, liveNetwork = null) {
  if (!/^artrelo_(?:iris_judge_|judge_)[a-z0-9_]+_test$/.test(database || '') || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d{4,5}$/.test(frontendOrigin || '')) throw Error('INVALID_ISOLATED_SANDBOX_TARGET');
  const secrets = signingSecrets || { access: crypto.randomBytes(48).toString('base64url'), refresh: crypto.randomBytes(48).toString('base64url'), session: crypto.randomBytes(48).toString('base64url') };
  if (!['access', 'refresh', 'session'].every(k => typeof secrets[k] === 'string' && secrets[k].length >= 32) || new Set(Object.values(secrets)).size !== 3) throw Error('ISOLATED_SIGNING_INPUT_REQUIRED');
  process.env.NODE_ENV = 'test';for (const key of REAL_KEYS) process.env[key] = '';for (const flag of OFF_FLAGS) process.env[flag] = 'false';
  Object.assign(process.env, { MONGODB_URI: 'mongodb://127.0.0.1:27128/' + database + '?replicaSet=artreloIrisTests', JWT_SECRET: secrets.access, REFRESH_TOKEN_SECRET: secrets.refresh,
    SESSION_SECRET: secrets.session, FRONTEND_URL: frontendOrigin, APP_PUBLIC_URL: frontendOrigin, OUTREACH_TIMEZONE: 'America/Toronto',
    AI_TRIAGE_PROVIDER: 'openai', AI_TRIAGE_FALLBACK_PROVIDER: 'none', QUOTE_ITEMIZATION_ENABLED: 'true', QUOTE_ANALYSIS_MODE: 'stub', OPENAI_LOG: 'off' });
  require(path.resolve(__dirname, '../../node_modules/dotenv')).config = () => ({ parsed: {} });
  let deniedNetworkAttempts = 0;
  const allow = (first, second) => { if (!loopback.has(hostOf(first, second))) { deniedNetworkAttempts++;throw Error('EXTERNAL_NETWORK_DISABLED'); } };
  const nativeFetch = global.fetch;
  global.fetch = async (input, ...args) => { allow(input);return nativeFetch(input, ...args); };
  for (const name of ['http', 'https']) for (const method of ['request', 'get']) {
    const mod = require(name), original = mod[method];mod[method] = function (...args) { allow(args[0], args[1]);return original.apply(this, args); };
  }
  const net = require('net'), connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) { if (!liveNetwork?.permitsSocket(args)) allow(args[0], args[1]);return connect.apply(this, args); };
  const tls = require('tls'), tlsConnect = tls.connect;
  tls.connect = function (...args) { if (!liveNetwork?.permitsSocket(args)) allow(args[0], args[1]);return tlsConnect.apply(this, args); };
  const proof = Object.freeze({ database, frontendOrigin, mode: liveNetwork ? 'guarded_live_judge_core' : 'offline_judge_core', diagnostics: () => ({ deniedNetworkAttempts,
    ...(liveNetwork ? { modelAttempts: liveNetwork.diagnostics().providerAttempts } : { realModelCalls: 0 }), realDeliveryCalls: 0, realPaymentCalls: 0,
    production: false, email: false, sms: false, emergencyCalls: false, billingCollection: false }) });
  (liveNetwork ? liveProofs : proofs).add(proof);installed = true;return proof;
}
function installOfflineSandbox(options = {}) { return installCore(options); }
function installGuardedLiveSandbox(options = {}, liveNetwork) {
  if (!require('./liveNetwork.service').isLiveNetwork(liveNetwork)) throw Error('EXPLICIT_LIVE_NETWORK_REQUIRED');
  return installCore(options, liveNetwork);
}
module.exports = { installOfflineSandbox, installGuardedLiveSandbox, isOfflineGuardProof: proof => proofs.has(proof),
  isGuardedLiveProof: proof => liveProofs.has(proof), inAppOnly: () => installed, hostOf, REAL_KEYS, OFF_FLAGS };
