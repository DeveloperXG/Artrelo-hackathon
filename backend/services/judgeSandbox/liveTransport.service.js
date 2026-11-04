'use strict';
// No paid/default registration. Bootstrap must inject the guarded network
// capability, current server authorization, private key, accounting and reporter.
const { randomUUID } = require('node:crypto');
const policy = require('./liveBudgetPolicy.service');
const ENDPOINT = 'https://api.meta.ai/v1/chat/completions';
const RESPONSE_BYTES = 262144;
function createLiveTransport({ budget, authorize, fetchImpl, apiKey, report, timeoutMs = 10000, reportTimeoutMs = 3000, now = () => new Date() } = {}) {
  if (!budget || !['reserve', 'markSent', 'settle', 'cancelBeforeSend', 'summary', 'halt'].every(k => typeof budget[k] === 'function') ||
      ![authorize, fetchImpl, report].every(fn => typeof fn === 'function') || typeof apiKey !== 'string' || !apiKey.trim() ||
      Buffer.byteLength(apiKey) > 1024 || /[\x00-\x20\x7f]/.test(apiKey) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000 ||
      !Number.isInteger(reportTimeoutMs) || reportTimeoutMs < 1 || reportTimeoutMs > 3000 || typeof now !== 'function') throw policy.fail('EXPLICIT_LIVE_CAPABILITIES_REQUIRED');
  let privateKey = apiKey, stopped = false, active = null;
  const authority = async purpose => {
    let ctx;try { ctx = await authorize(purpose); } catch { throw policy.fail('LIVE_AUTHORITY_UNAVAILABLE'); }
    if (!ctx || !policy.database(ctx.realm) || ![ctx.pairRef, ctx.actorRef].every(policy.ref)) throw policy.fail('LIVE_AUTHORITY_UNAVAILABLE');
    return { realm: ctx.realm, pairRef: ctx.pairRef, actorRef: ctx.actorRef };
  };
  async function publish(event, ref, purpose, extra = {}) {
    let timer;
    try {
      await Promise.race([(async () => {
        const accounting = await budget.summary();
        await report({ event, attemptRef: ref, purpose, ...extra, accounting });
      })(), new Promise((resolve, reject) => { timer = setTimeout(() => reject(policy.fail('LIVE_REPORT_FAILED')), reportTimeoutMs); })]);
    }
    catch { throw policy.fail('LIVE_REPORT_FAILED'); }
    finally { clearTimeout(timer); }
  }
  async function readResponse(response) {
    if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 || !response.body?.getReader) throw policy.fail('LIVE_RESPONSE_INVALID');
    const reader = response.body.getReader(), chunks = [];let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > RESPONSE_BYTES) { await reader.cancel();throw policy.fail('LIVE_RESPONSE_LIMIT'); }
        chunks.push(Buffer.from(next.value));
      }
    } finally { reader.releaseLock(); }
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw policy.fail('LIVE_RESPONSE_INVALID'); }
    const u = payload?.usage;
    const usage = u ? { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens } : null;
    return { payload, usage, httpStatus: response.status, model: payload?.model === policy.MODEL ? policy.MODEL : payload?.model ? 'unexpected_model' : null };
  }
  async function stop(reason) {
    stopped = true;
    try { await budget.halt(reason); } catch { /* Existing in-flight reservation is never released on an unproven stop write. */ }
  }
  async function execute({ purpose, body, signal = null, attemptRef = 'guarded_' + randomUUID(), reservationRef = null } = {}) {
    if (stopped || !privateKey) throw policy.fail('LIVE_TRANSPORT_STOPPED');
    if (active) throw policy.fail('LIVE_LANE_BUSY');
    // Capture immutable transport bytes before any asynchronous boundary.
    let frozen;
    try { frozen = JSON.parse(JSON.stringify(body)); } catch { throw policy.fail('UNEXPECTED_LIVE_REQUEST'); }
    policy.requestBasis(purpose, frozen);
    const ctx = await authority(purpose);
    if (signal?.aborted) throw policy.fail('LIVE_CANCELLED_BEFORE_SEND');
    if (reservationRef !== null && (reservationRef !== attemptRef || typeof budget.assertReserved !== 'function')) throw policy.fail('LIVE_RESERVATION_MISMATCH');
    const reservation = reservationRef === null ? await budget.reserve({ attemptRef, ...ctx, purpose, body: frozen })
      : await budget.assertReserved(reservationRef, { ...ctx, purpose, body: frozen });
    const ref = reservation.reservationRef;
    let marked = false, settled = false, timer, abortHandler, work;
    const controller = new AbortController();active = controller;
    try {
      try { await publish('reserved', ref, purpose); }
      catch {
        // Persist stop before releasing a proven-not-sent reservation. If that
        // write fails, keep the durable occupied lane rather than enabling peers.
        stopped = true;
        await budget.halt('report_delivery_failed');
        await budget.cancelBeforeSend(ref);settled = true;
        throw policy.fail('LIVE_REPORT_FAILED');
      }
      const fresh = await authority(purpose);
      if (JSON.stringify(ctx) !== JSON.stringify(fresh) || signal?.aborted || stopped) {
        await budget.cancelBeforeSend(ref);settled = true;
        throw policy.fail('LIVE_CANCELLED_BEFORE_SEND');
      }
      await budget.markSent(ref, frozen);marked = true;
      // Only this fixed destination is expressible. The injected fetch must be
      // the separate process network guard; no native/global fetch fallback.
      work = Promise.resolve().then(() => {
        if (stopped || !privateKey || controller.signal.aborted || !(now() < new Date(policy.EXPIRES_AT))) throw policy.fail('LIVE_INTERRUPTED');
        return fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + privateKey }, body: JSON.stringify(frozen) }, { attemptRef: ref, purpose });
      }).then(readResponse);
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => { controller.abort();reject(policy.fail('LIVE_TIMEOUT')); },
          Math.min(timeoutMs, Math.max(1, Date.parse(policy.EXPIRES_AT) - now().getTime())));
        abortHandler = () => { controller.abort();reject(policy.fail('LIVE_INTERRUPTED')); };
        if (signal?.aborted) abortHandler();else signal?.addEventListener('abort', abortHandler, { once: true });
      });
      const result = await Promise.race([work, timeout]);
      const accounting = await budget.settle(ref, result);settled = true;
      await publish(accounting.state, ref, purpose, { state: accounting.state, actualUSD: accounting.actualUSD, retainedReservationUSD: accounting.retainedReservationUSD,
        httpStatus: result.httpStatus, model: result.model, usage: accounting.state === 'settled' ? result.usage : null });
      if (accounting.halted || accounting.state !== 'settled') { stopped = true;throw policy.fail('LIVE_PROVIDER_STOPPED'); }
      return result.payload;
    } catch (error) {
      if (!settled) {
        if (marked) {
          stopped = true;
          controller.abort();
          try {
            const unknown = await budget.settle(ref, {});settled = true;
            stopped = unknown.quarantined !== true;
            await publish('unknown', ref, purpose, { state: unknown.state, actualUSD: null, retainedReservationUSD: unknown.retainedReservationUSD,
              attemptQuarantined: unknown.quarantined === true });
          } catch { await stop('accounting_unavailable'); }
          // A late response can reconcile accounting once but never reaches
          // the app, executes a tool or clears the durable uncertainty stop.
          if (work) void work.then(async late => {
            try {
              const actual = await budget.settle(ref, late);
              await publish('late_settlement', ref, purpose, { state: actual.state, actualUSD: actual.actualUSD,
                retainedReservationUSD: actual.retainedReservationUSD, httpStatus: late.httpStatus, model: late.model, usage: actual.state === 'settled' ? late.usage : null });
            } catch { /* Retain unknown and stop; no retry. */ }
          }, () => {});
        } else if (!stopped) {
          try { await budget.cancelBeforeSend(ref);settled = true; } catch { await stop('accounting_unavailable'); }
        }
      }
      if (error?.code === 'LIVE_REPORT_FAILED') await stop('report_delivery_failed');
      // Arbitrary provider/SDK/header/body errors never escape into logs/UI.
      throw policy.fail('LIVE_TRANSPORT_UNAVAILABLE');
    } finally { clearTimeout(timer);signal?.removeEventListener('abort', abortHandler);active = null; }
  }
  async function dispose() {
    stopped = true;privateKey = null;
    // Healthy shutdown does not replenish counters or revoke an otherwise
    // approved campaign. Interrupting an active send is a durable stop.
    if (active) { active.abort();await stop('operator_stopped'); }
  }
  return { execute, dispose };
}
module.exports = { createLiveTransport, ENDPOINT, RESPONSE_BYTES };
