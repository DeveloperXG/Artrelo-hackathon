'use strict';
const assert = require('node:assert/strict');
const { createLiveTransport, ENDPOINT } = require('../../../services/judgeSandbox/liveTransport.service');
const { createLiveNetwork } = require('../../../services/judgeSandbox/liveNetwork.service');
const { createPlanner } = require('../../../services/iris/planner.service');
const { installGuardedLiveSandbox } = require('../../../services/judgeSandbox/offlineGuard.service');
const { guardedTimeoutMs } = require('../../../contracts/judgeSandboxFreshRecording.v1.json');
const base = Date.parse('2026-11-04T20:00:00.000Z'), delays = [], actualTimer = global.setTimeout;
const body = { model: 'muse-spark-1.3', messages: [{ role: 'user', content: 'Inert timing fixture.' }], reasoning_effort: 'minimal', max_completion_tokens: 2048,
  response_format: { type: 'json_schema', json_schema: { name: 'inert', strict: true, schema: { type: 'object', properties: {}, additionalProperties: false } } } };
const options = () => ({ method: 'POST', redirect: 'error', signal: new AbortController().signal,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer inert-not-a-real-key' }, body: JSON.stringify(body) });
const callbacks = { complete: async () => null, authorizeAttempt: async () => null, settleAttempt: async () => null };
async function main() {
  assert.equal(guardedTimeoutMs, 20000);
  assert.throws(() => createPlanner({ ...callbacks, timeoutMs: 20000 }), /Bounded model timeout/);
  assert.throws(() => createPlanner({ ...callbacks, timeoutMs: 20000, guardedLiveProof: {} }), /Bounded model timeout/);
  assert.equal(typeof createPlanner(callbacks), 'function');
  for (const time of [20001, 0, NaN]) assert.throws(() => createLiveNetwork({ timeoutMs: time, claimAttempt: async () => true, fetchImpl: async () => ({}) }), /EXPLICIT_LIVE_NETWORK_REQUIRED/);
  for (const deadline of [10000, 20000]) {
    let clock = base, capability;
    capability = createLiveNetwork({ timeoutMs: deadline, now: () => new Date(clock), claimAttempt: async () => true,
      fetchImpl: async () => { clock += 15000; assert.equal(capability.permitsSocket([{ host: 'api.meta.ai', port: 443 }]), deadline === 20000);
        clock = base + 20000; assert.equal(capability.permitsSocket([{ host: 'api.meta.ai', port: 443 }]), false); return {}; } });
    await capability.guardedFetch(ENDPOINT, options(), { attemptRef: 'inert-network-' + deadline, purpose: 'planning' });
  }
  let clock = Date.parse('2026-11-05T00:59:55.000Z'), expiring;
  expiring = createLiveNetwork({ timeoutMs: 20000, now: () => new Date(clock), claimAttempt: async () => true,
    fetchImpl: async () => { clock += 6000; assert.equal(expiring.permitsSocket([{ host: 'api.meta.ai', port: 443 }]), false); return {}; } });
  await expiring.guardedFetch(ENDPOINT, options(), { attemptRef: 'inert-expiry-bound', purpose: 'planning' });
  global.setTimeout = (fn, ms, ...args) => { delays.push(ms); return actualTimer(fn, ms >= 10000 ? 60000 : ms, ...args); };
  try {
    for (const timeoutMs of [undefined, guardedTimeoutMs]) {
      let settled = 0;
      const budget = { reserve: async v => ({ reservationRef: v.attemptRef }), markSent: async () => {},
        settle: async () => { settled++; return { state: 'settled', actualUSD: 0.0021, retainedReservationUSD: 0, halted: false }; },
        cancelBeforeSend: async () => { throw Error('UNEXPECTED_CANCEL'); }, summary: async () => ({ halted: false }), halt: async () => {} };
      const t = createLiveTransport({ budget, apiKey: 'inert-key', now: () => new Date(base), ...(timeoutMs ? { timeoutMs } : {}),
        authorize: async () => ({ realm: 'artrelo_iris_judge_timing_test', pairRef: 'inert-pair-seven', actorRef: 'inert-actor-seven' }), report: async () => {},
        fetchImpl: async () => new Response(JSON.stringify({ model: body.model, usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } }), { status: 200 }) });
      await t.execute({ purpose: 'planning', body }); assert.equal(settled, 1); await t.dispose();
    }
  } finally { global.setTimeout = actualTimer; }
  assert(delays.includes(10000)); assert(delays.includes(20000)); assert(delays.includes(3000));
  const network = createLiveNetwork({ claimAttempt: async () => false, fetchImpl: async () => { throw Error('NO_REAL_NETWORK'); } });
  const proof = installGuardedLiveSandbox({ database: 'artrelo_iris_judge_timing_test', frontendOrigin: 'http://127.0.0.1:3144' }, network);
  assert.equal(typeof createPlanner({ ...callbacks, timeoutMs: 20000, guardedLiveProof: proof }), 'function');
  assert.throws(() => createPlanner({ ...callbacks, timeoutMs: 20001, guardedLiveProof: proof }), /Bounded model timeout/);
  console.log('PASS guarded20s/default10s deadlines, genuine proof only extended planner,20s socket expiry/fixed campaign expiry, unchanged3s reporting; inert response settles once, no provider or database.');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { global.setTimeout = actualTimer; });
