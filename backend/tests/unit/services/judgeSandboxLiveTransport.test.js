'use strict';
const assert = require('node:assert/strict');
const { createLiveTransport, ENDPOINT, RESPONSE_BYTES } = require('../../../services/judgeSandbox/liveTransport.service');
const policy = require('../../../services/judgeSandbox/liveBudgetPolicy.service');
const key = 'inert-test-provider-key-never-a-real-secret';
const body = () => ({ model: policy.MODEL, messages: [{ role: 'system', content: 'Inert request.' }, { role: 'user', content: 'Inert question.' }],
  response_format: { type: 'json_schema', json_schema: { name: 'inert', strict: true, schema: { type: 'object', properties: {}, additionalProperties: false } } },
  reasoning_effort: 'minimal', max_completion_tokens: 2048 });
const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 };
const payload = () => ({ model: policy.MODEL, usage, choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const ctx = { realm: 'artrelo_iris_judge_transport_fixture_test', pairRef: 'inert-pair-1', actorRef: 'inert-actor-1' };
function fixture(overrides = () => ({})) {
  const trace = [], events = [], fetches = [];
  let state = 'none', halted = false;
  const budget = {
    async reserve(value) { trace.push('reserve');state = 'reserved';return { reservationRef: value.attemptRef, authorized: true }; },
    async markSent() { trace.push('mark');assert.equal(state, 'reserved');state = 'started'; },
    async settle(ref, value) {
      trace.push('settle');
      const late = state === 'unknown';
      if (value.usage && value.model === policy.MODEL) {
        state = 'settled';return { state, actualUSD: policy.usageCost(value.usage) / policy.NANO, retainedReservationUSD: 0, halted: late || halted };
      }
      state = 'unknown';halted = true;return { state, actualUSD: null, retainedReservationUSD: 1.319424, halted: true };
    },
    async cancelBeforeSend() { trace.push('cancel');assert.equal(state, 'reserved');state = 'not_sent'; },
    async summary() { return { kind: 'judge', chargedUSD: 0, reservedUSD: state === 'reserved' || state === 'started' || state === 'unknown' ? 1.319424 : 0, halted }; },
    async halt(reason) { trace.push('halt:' + reason);halted = true; }
  };
  const transport = createLiveTransport({ budget, apiKey: key, authorize: async () => ({ ...ctx }),
    report: async event => { events.push(event);assert(!JSON.stringify(event).includes(key));assert(!JSON.stringify(event).includes('Inert question.')); },
    fetchImpl: async (url, options) => {
      fetches.push({ url, options });assert.equal(url, ENDPOINT);assert.equal(options.method, 'POST');assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer ' + key);return response(payload());
    }, now: () => new Date('2026-11-01T00:00:00Z'), ...overrides(budget, trace, events, fetches) });
  return { transport, budget, trace, events, fetches, state: () => state, halted: () => halted };
}
async function rejectsSafely(promise) {
  await assert.rejects(promise, error => error.code === 'LIVE_TRANSPORT_UNAVAILABLE' && !String(error).includes(key));
}
async function main() {
  assert.throws(() => createLiveTransport({}), /EXPLICIT_LIVE_CAPABILITIES_REQUIRED/);
  const normal = fixture(() => ({}));
  assert.deepEqual(await normal.transport.execute({ purpose: 'planning', body: body() }), payload());
  assert.deepEqual(normal.trace, ['reserve', 'mark', 'settle']);assert.equal(normal.fetches.length, 1);
  assert.deepEqual(normal.events.map(x => x.event), ['reserved', 'settled']);
  const prepared = fixture((budget, trace) => {
    budget.assertReserved = async (ref, value) => {
      trace.push('reuse');assert.equal(value.actorRef, ctx.actorRef);
      return budget.reserve({ ...value, attemptRef: ref });
    };
    return {};
  });
  await prepared.transport.execute({ purpose: 'planning', body: body(), attemptRef: 'prepared-attempt', reservationRef: 'prepared-attempt' });
  assert.deepEqual(prepared.trace, ['reuse', 'reserve', 'mark', 'settle']);assert.equal(prepared.fetches.length, 1);
  await assert.rejects(prepared.transport.execute({ purpose: 'planning', body: body(), attemptRef: 'a', reservationRef: 'b' }), /LIVE_RESERVATION_MISMATCH/);
  const changedBody = body();
  const immutable = fixture(() => ({ authorize: async () => { changedBody.messages[1].content = 'Mutated after admission';return ctx; } }));
  await immutable.transport.execute({ purpose: 'planning', body: changedBody });
  assert.equal(JSON.parse(immutable.fetches[0].options.body).messages[1].content, 'Inert question.');
  const invalid = fixture(() => ({}));const bad = body();bad.tools = [];
  await assert.rejects(invalid.transport.execute({ purpose: 'planning', body: bad }), /UNEXPECTED_LIVE_REQUEST/);assert.equal(invalid.trace.length, 0);
  const cancelled = fixture(() => ({})), controller = new AbortController();controller.abort();
  await assert.rejects(cancelled.transport.execute({ purpose: 'planning', body: body(), signal: controller.signal }), /LIVE_CANCELLED_BEFORE_SEND/);
  assert.equal(cancelled.trace.length, 0);
  let identities = 0;
  const switched = fixture(() => ({ authorize: async () => ++identities === 1 ? ctx : { ...ctx, actorRef: 'inert-other-actor' } }));
  await rejectsSafely(switched.transport.execute({ purpose: 'planning', body: body() }));assert.deepEqual(switched.trace, ['reserve', 'cancel']);assert.equal(switched.fetches.length, 0);
  const reporting = fixture(() => ({ report: async () => { throw Error('Inert raw reporter failure ' + key); } }));
  await rejectsSafely(reporting.transport.execute({ purpose: 'planning', body: body() }));
  assert.deepEqual(reporting.trace.slice(0, 3), ['reserve', 'halt:report_delivery_failed', 'cancel']);assert.equal(reporting.fetches.length, 0);
  const reportHang = fixture(() => ({ report: () => new Promise(() => {}), reportTimeoutMs: 5 }));
  await rejectsSafely(reportHang.transport.execute({ purpose: 'planning', body: body() }));assert(reportHang.halted());assert.equal(reportHang.fetches.length, 0);
  let networkAttempts = 0;
  const failed = fixture(() => ({ fetchImpl: async () => { networkAttempts++;throw Error('Provider raw Authorization Bearer ' + key); } }));
  await rejectsSafely(failed.transport.execute({ purpose: 'planning', body: body() }));
  assert.equal(networkAttempts, 1);assert.equal(failed.state(), 'unknown');assert(failed.halted());
  await assert.rejects(failed.transport.execute({ purpose: 'planning', body: body() }), /LIVE_TRANSPORT_STOPPED/);assert.equal(networkAttempts, 1);
  const noUsage = fixture(() => ({ fetchImpl: async () => response({ ...payload(), usage: null }) }));
  await rejectsSafely(noUsage.transport.execute({ purpose: 'planning', body: body() }));assert.equal(noUsage.state(), 'unknown');
  const tooLarge = fixture(() => ({ fetchImpl: async () => new Response('x'.repeat(RESPONSE_BYTES + 1)) }));
  await rejectsSafely(tooLarge.transport.execute({ purpose: 'planning', body: body() }));assert.equal(tooLarge.state(), 'unknown');
  const afterSendReport = fixture(() => ({ report: async event => { if (event.event !== 'reserved') throw Error('Inert report failure'); } }));
  await rejectsSafely(afterSendReport.transport.execute({ purpose: 'planning', body: body() }));assert.equal(afterSendReport.state(), 'settled');assert(afterSendReport.halted());
  let finishNetwork, lateReported;
  const lateEvent = new Promise(resolve => { lateReported = resolve; });
  const timeout = fixture(() => ({ timeoutMs: 5, fetchImpl: () => new Promise(resolve => { finishNetwork = resolve; }),
    report: async event => { if (event.event === 'late_settlement') lateReported(event); } }));
  await rejectsSafely(timeout.transport.execute({ purpose: 'planning', body: body() }));assert.equal(timeout.state(), 'unknown');
  finishNetwork(response(payload()));
  let lateTimer, late;
  try { late = await Promise.race([lateEvent, new Promise((resolve, reject) => { lateTimer = setTimeout(() => reject(Error('LATE_ACCOUNTING_NOT_OBSERVED')), 1000); })]); }
  finally { clearTimeout(lateTimer); }
  assert.equal(late.state, 'settled');assert(timeout.halted());
  const expired = fixture(() => ({ now: () => new Date(policy.EXPIRES_AT) }));
  await rejectsSafely(expired.transport.execute({ purpose: 'planning', body: body() }));assert.equal(expired.fetches.length, 0);
  const disposed = fixture(() => ({}));await disposed.transport.dispose();
  await assert.rejects(disposed.transport.execute({ purpose: 'planning', body: body() }), /LIVE_TRANSPORT_STOPPED/);assert.equal(disposed.fetches.length, 0);
  assert.equal(disposed.halted(), false); // Healthy shutdown preserves durable campaign counters/authorization.
  let sends = 0, firstSignal;
  const quarantined = fixture(budget => {
    const settle = budget.settle.bind(budget), summary = budget.summary.bind(budget);
    budget.settle = async (ref, value) => { const result = await settle(ref, value);return { ...result, halted: false, quarantined: result.state === 'unknown' }; };
    budget.summary = async () => ({ ...await summary(), halted: false });
    return { fetchImpl: async (url, options) => {
      sends++;if (sends === 1) { firstSignal = options.signal;throw Error('INERT_UNCERTAIN_TRANSPORT'); }
      return response(payload());
    } };
  });
  await rejectsSafely(quarantined.transport.execute({ purpose: 'planning', body: body() }));
  assert.equal(sends, 1);assert(firstSignal.aborted);assert(quarantined.events.some(event => event.attemptQuarantined === true));
  const independentBody = { ...body(), messages: [{ role: 'user', content: 'Separate current advisory fixture.' }], max_completion_tokens: 4096 };
  await quarantined.transport.execute({ purpose: 'quote_analysis', body: independentBody });
  assert.equal(sends, 2, 'only an explicit fresh independent call follows the quarantine; original call is never retried');
  await quarantined.transport.dispose();
  console.log('PASS explicit guarded transport: immutable fixed Chat request, server authority recheck, reporting failure/timeout, no retry or secret errors, bounded response, cancel/expiry/dispose and late accounting only. Fake fetch/budget only; no key lookup or model/network call.');
}
main().catch(error => { console.error('FAIL guarded transport unit: ' + (error.code || 'ASSERTION'));process.exitCode = 1; });
