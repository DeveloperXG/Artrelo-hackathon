'use strict';
const assert = require('node:assert/strict'), http = require('node:http'), https = require('node:https'), net = require('node:net'), tls = require('node:tls');
const { createLiveNetwork, isLiveNetwork } = require('../../../services/judgeSandbox/liveNetwork.service');
const { installGuardedLiveSandbox, isGuardedLiveProof, isOfflineGuardProof } = require('../../../services/judgeSandbox/offlineGuard.service');
const { ENDPOINT } = require('../../../services/judgeSandbox/liveTransport.service');
const now = () => new Date('2026-11-01T00:00:00Z');
const body = { model: 'muse-spark-1.3', messages: [{ role: 'user', content: 'Inert isolated network test.' }], reasoning_effort: 'minimal', max_completion_tokens: 2048,
  response_format: { type: 'json_schema', json_schema: { name: 'inert', strict: true, schema: { type: 'object', properties: {}, additionalProperties: false } } } };
const opts = () => ({ method: 'POST', redirect: 'error', signal: new AbortController().signal,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer inert-test-value' }, body: JSON.stringify(body) });
let capability, mockedFetches = 0, claims = 0, server;
capability = createLiveNetwork({ now, claimAttempt: async ref => { claims++;return ref !== 'denied-attempt'; }, fetchImpl: async () => {
  mockedFetches++;
  assert(capability.permitsSocket([{ host: 'api.meta.ai', servername: 'api.meta.ai', port: 443 }]));
  assert(capability.permitsSocket([[{ host: 'api.meta.ai', servername: 'api.meta.ai', port: 443 }]]));
  assert(!capability.permitsSocket([{ host: 'elsewhere.invalid', servername: 'api.meta.ai', port: 443 }]));
  assert(!capability.permitsSocket([{ host: 'api.meta.ai', port: 80 }]));
  assert(!capability.permitsSocket([{ host: 'api.meta.ai', port: 443, rejectUnauthorized: false }]));
  await assert.rejects(() => global.fetch(ENDPOINT), /EXTERNAL_NETWORK_DISABLED/);
  assert.throws(() => https.request(ENDPOINT), /EXTERNAL_NETWORK_DISABLED/);
  return new Response('{}', { status: 200 });
} });
assert(isLiveNetwork(capability));assert(!isLiveNetwork({ ...capability }));
assert.throws(() => installGuardedLiveSandbox({ database: 'artrelo_judge_network_unit_test', frontendOrigin: 'http://127.0.0.1:3144' }, { guardedFetch: async () => {} }), /EXPLICIT_LIVE_NETWORK_REQUIRED/);
const proof = installGuardedLiveSandbox({ database: 'artrelo_judge_network_unit_test', frontendOrigin: 'http://127.0.0.1:3144' }, capability);
assert(isGuardedLiveProof(proof));assert(!isOfflineGuardProof(proof));assert(!isGuardedLiveProof({ ...proof }));
assert.equal(proof.mode, 'guarded_live_judge_core');assert.equal(process.env.MODEL_API_KEY, '');assert.equal(process.env.STRIPE_SECRET_KEY, '');
async function main() {
  assert(!capability.permitsSocket([{ host: 'api.meta.ai', port: 443 }]));
  await assert.rejects(() => fetch(ENDPOINT), /EXTERNAL_NETWORK_DISABLED/);
  assert.throws(() => http.get('http://elsewhere.invalid'), /EXTERNAL_NETWORK_DISABLED/);
  assert.throws(() => net.connect(443, 'api.meta.ai'), /EXTERNAL_NETWORK_DISABLED/);
  assert.throws(() => tls.connect({ host: 'api.meta.ai', port: 443 }), /EXTERNAL_NETWORK_DISABLED/);
  await capability.guardedFetch(ENDPOINT, opts(), { attemptRef: 'allowed-attempt', purpose: 'planning' });
  assert.equal(mockedFetches, 1);assert.equal(claims, 1);
  await assert.rejects(capability.guardedFetch(ENDPOINT, opts(), { attemptRef: 'allowed-attempt', purpose: 'planning' }), /LIVE_NETWORK_DENIED/);
  await assert.rejects(capability.guardedFetch('https://api.meta.ai/v1/responses/input_tokens', opts(), { attemptRef: 'new-attempt-1', purpose: 'planning' }), /LIVE_NETWORK_DENIED/);
  await assert.rejects(capability.guardedFetch(ENDPOINT + '?other=1', opts(), { attemptRef: 'new-attempt-2', purpose: 'planning' }), /LIVE_NETWORK_DENIED/);
  await assert.rejects(capability.guardedFetch(ENDPOINT, { ...opts(), redirect: 'follow' }, { attemptRef: 'new-attempt-3', purpose: 'planning' }), /LIVE_NETWORK_DENIED/);
  await assert.rejects(capability.guardedFetch(ENDPOINT, { ...opts(), dispatcher: {} }, { attemptRef: 'new-attempt-4', purpose: 'planning' }), /LIVE_NETWORK_DENIED/);
  await assert.rejects(capability.guardedFetch(ENDPOINT, opts(), { attemptRef: 'denied-attempt', purpose: 'planning' }), /LIVE_NETWORK_DENIED/);
  assert.equal(mockedFetches, 1);assert.equal(proof.diagnostics().modelAttempts, 1);
  assert.equal(proof.diagnostics().realDeliveryCalls, 0);assert.equal(proof.diagnostics().realPaymentCalls, 0);
  server = http.createServer((req, res) => res.end('local-positive-control'));
  server.listen(0, '127.0.0.1');await new Promise(resolve => server.once('listening', resolve));
  await new Promise((resolve, reject) => http.get('http://127.0.0.1:' + server.address().port, res => {
    let text = '';res.on('data', chunk => { text += chunk; });res.on('end', () => { try { assert.equal(text, 'local-positive-control');resolve(); } catch (error) { reject(error); } });
  }).on('error', reject));
  capability.dispose();
  await assert.rejects(capability.guardedFetch(ENDPOINT, opts(), { attemptRef: 'after-dispose', purpose: 'planning' }), /LIVE_NETWORK_DENIED/);
  console.log('PASS isolated live network: genuine capability, default external fetch/HTTP/TCP/TLS denial, one-shot fixed Chat/body/claim path with mocked provider, no counting/redirect/dispatcher escape and real loopback positive control. No key lookup or real provider call.');
}
main().catch(error => { console.error('FAIL guarded live network: ' + (error.code || 'ASSERTION'));process.exitCode = 1; })
  .finally(() => { server?.closeAllConnections();server?.close(); });
