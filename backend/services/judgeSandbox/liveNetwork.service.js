'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const policy = require('./liveBudgetPolicy.service');
const { ENDPOINT } = require('./liveTransport.service');
const capabilities = new WeakSet();
function createLiveNetwork({ claimAttempt, fetchImpl, now = () => new Date() } = {}) {
  if (![claimAttempt, fetchImpl, now].every(fn => typeof fn === 'function')) throw policy.fail('EXPLICIT_LIVE_NETWORK_REQUIRED');
  const scope = new AsyncLocalStorage(), nonce = Object.freeze({}), used = new Set();
  let stopped = false, providerAttempts = 0;
  async function guardedFetch(url, options, context) {
    if (stopped || url !== ENDPOINT || !policy.exactKeys(context, ['attemptRef', 'purpose']) || !policy.ref(context.attemptRef) ||
        used.has(context.attemptRef) || !(now() < new Date(policy.EXPIRES_AT)) ||
        !policy.exactKeys(options, ['method', 'redirect', 'signal', 'headers', 'body']) || options.method !== 'POST' || options.redirect !== 'error' ||
        options.signal?.aborted || typeof options.signal?.addEventListener !== 'function' || typeof options.body !== 'string' ||
        !policy.exactKeys(options.headers, ['Content-Type', 'Authorization']) || options.headers['Content-Type'] !== 'application/json' ||
        typeof options.headers.Authorization !== 'string' || !/^Bearer [^\s\x00-\x1f\x7f]+$/.test(options.headers.Authorization)) throw policy.fail('LIVE_NETWORK_DENIED');
    let body;try { body = JSON.parse(options.body); } catch { throw policy.fail('LIVE_NETWORK_DENIED'); }
    policy.requestBasis(context.purpose, body);
    if (await claimAttempt(context.attemptRef, { purpose: context.purpose, body }) !== true) throw policy.fail('LIVE_NETWORK_DENIED');
    used.add(context.attemptRef);
    if (stopped || options.signal.aborted || !(now() < new Date(policy.EXPIRES_AT))) throw policy.fail('LIVE_NETWORK_DENIED');
    providerAttempts++;
    return scope.run({ nonce, expiresAt: new Date(now().getTime() + 10000) }, () => fetchImpl(url, options));
  }
  function permitsSocket(args) {
    const current = scope.getStore();
    if (stopped || current?.nonce !== nonce || !(now() < current.expiresAt) || !(now() < new Date(policy.EXPIRES_AT))) return false;
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (!first || typeof first !== 'object' || Array.isArray(first)) return false;
    const host = first.hostname || first.host;
    return host === 'api.meta.ai' && Number(first.port) === 443 && (!first.servername || first.servername === 'api.meta.ai') && first.rejectUnauthorized !== false;
  }
  const capability = Object.freeze({ guardedFetch, permitsSocket, dispose: () => { stopped = true; },
    diagnostics: () => ({ providerAttempts, stopped }) });
  capabilities.add(capability);return capability;
}
module.exports = { createLiveNetwork, isLiveNetwork: value => capabilities.has(value) };
