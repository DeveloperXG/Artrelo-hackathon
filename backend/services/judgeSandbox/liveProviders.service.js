'use strict';
// Explicit isolated bootstrap only. No environment key lookup or default client.
const { randomUUID } = require('node:crypto');
const policy = require('./liveBudgetPolicy.service');
const instances = new WeakMap();
function createLiveProviders({ proof, authority, budget, transport } = {}) {
  if (!require('./offlineGuard.service').isGuardedLiveProof(proof) || !require('./liveAuthority.service').isLiveAuthority(authority) ||
      !['reserve', 'viewAttempt', 'cancelBeforeSend', 'settle', 'beginModelTurn', 'finishModelTurn'].every(key => typeof budget?.[key] === 'function') || typeof transport?.execute !== 'function') throw policy.fail('EXPLICIT_LIVE_PROVIDERS_REQUIRED');
  const { createTriageRunner } = require('../ai/triageProvider.service');
  const configFor = maximum => ({ ai_triage_provider: 'meta', ai_triage_fallback_provider: 'none', meta_model: policy.MODEL,
    ai_triage_timeout_ms: 10000, ai_triage_max_tokens: maximum });
  async function stopRecovery(reason) {
    if (typeof budget.stopRecovery !== 'function') return;
    try { await budget.stopRecovery(reason); }
    catch { await transport.dispose?.();throw policy.fail('LIVE_RECOVERY_STOP_UNVERIFIED'); }
  }
  async function withModelTurn(purpose,turnRef,action) {
    const {error}=require('../iris/contract.service');
    try{await budget.beginModelTurn({turnRef,...await authority.authorize(purpose)});}
    catch{throw error('model_unavailable','This pair already has a model turn or the model is unavailable. Authorized records remain available.');}
    let completed=false;
    try{const result=await action();completed=true;return result;}
    catch(error){await stopRecovery('model_turn_failed');throw error;}
    finally{try{await budget.finishModelTurn(turnRef,completed?'completed':'failed');}catch{throw error('audit_unavailable','The model turn could not be safely closed. No model retry was started.');}}
  }
  const triageCore = createTriageRunner({ config: configFor(2500), completeRequest: body => transport.execute({ purpose: 'intake', body }) });
  const triage=async input=>{
    try{return await withModelTurn('intake','intake_turn_'+randomUUID(),async()=>{
      const result=await triageCore(input);
      if(!result.parsed)await stopRecovery('provider_validation_failed');
      else if(['high','emergency'].includes(result.parsed.urgency)||Number(result.parsed.severity)>=4)
        await stopRecovery('unsupported_intake');
      return result; // Never rewrite a genuine High classification to fit a take.
    });}
    catch{return{parsed:null,telemetry:{provider:'deterministic_fallback',outcome:'fallback',errorCode:'model_busy_or_unavailable',attempts:[]}};}
  };
  async function settlePrepared(ref) {
    const row = await budget.viewAttempt(ref);
    if (!row) throw policy.fail('LIVE_ATTEMPT_NOT_OWNED');
    if (row.state === 'reserved') await budget.cancelBeforeSend(ref);
    else if (row.state === 'started') await budget.settle(ref, {});
    else if (!['settled', 'unknown', 'not_sent'].includes(row.state)) throw policy.fail('LIVE_ACCOUNTING_INVALID');
  }
  async function completeIris(body, options = {}) {
    const purpose = body?.response_format?.json_schema?.name === 'iris_planning_v2' ? 'planning'
      : body?.response_format?.json_schema?.name === 'iris_selection_v2' ? 'selection' : null;
    if (!purpose) throw policy.fail('UNEXPECTED_LIVE_REQUEST');
    const iris = require('../iris/contract.service'), { assertValid } = require('../../contracts/validate.cjs');
    const run = createTriageRunner({ config: configFor(2048),
      completeRequest: wire => transport.execute({ ...options, purpose, body: wire }),
      validateResponse: (value, schema) => { try { assertValid(schema, value, iris.contract.$defs);return true; } catch { return false; } } });
    const result = await run({ messages: body.messages, schema: body.response_format.json_schema }), attempt = result.telemetry.attempts?.[0];
    if (!result.parsed) await stopRecovery('provider_validation_failed');
    if (!result.parsed && !['refusal', 'incomplete_output', 'empty_output', 'invalid_json', 'invalid_schema'].includes(attempt?.errorCode)) {
      throw iris.error('model_unavailable', 'The model is unavailable. Your authorized records remain available.');
    }
    return { parsed: result.parsed, usage: attempt?.usage || null, source: 'meta', model: policy.MODEL, validationError: attempt?.errorCode || null };
  }
  const plannerCore = require('../iris/planner.service').createPlanner({ complete: completeIris,
    authorizeAttempt: async ({ attemptRef, turnRef, purpose, body }) => budget.reserve({ attemptRef, ...await authority.authorize(purpose), purpose, body, caseRef: turnRef || null }),
    settleAttempt: async ({ reservationRef }) => settlePrepared(reservationRef) });
  const planner=context=>withModelTurn('planning',context.turnRef,()=>plannerCore(context));
  async function quoteReview(args) {
    const review = require('../quotes/review.service');let entered = false;
    try {
      return await authority.withQuoteJob(args, async () => {
        entered = true;let preparedRef = null;
        const completeCore = require('../quotes/analysisProvider.service').createBudgetedAnalysisProvider({ config: configFor(4096),
          authorizeAttempt: async ({ purpose, body }) => {
            try {
              const ref = 'quote_' + randomUUID();
              await budget.reserve({ attemptRef: ref, ...await authority.authorize(purpose), purpose, body, caseRef: args.stage + ':' + String(args.subjectId) });preparedRef = ref;return true;
            } catch { return false; }
          },
          completeRequest: body => transport.execute({ purpose: 'quote_analysis', body, attemptRef: preparedRef, reservationRef: preparedRef }) });
        const complete=context=>withModelTurn('quote_analysis','quote_turn_'+randomUUID(),async()=>{
          const result=await completeCore(context);if(!result.parsed)await stopRecovery('provider_validation_failed');return result;
        });
        try { return await review.runReview({ ...args, complete, source: 'meta' }); }
        finally { if (preparedRef) await settlePrepared(preparedRef); }
      });
    } catch (err) {
      if (entered) throw err;
      // Rebinding failure cannot start a model call. Existing backend review
      // still owns whether this subject can be shown to its human landlord.
      return review.runReview({ ...args, complete: null, source: 'disabled' });
    }
  }
  let registered = false;
  function register() {
    if (registered) throw policy.fail('LIVE_PROVIDERS_ALREADY_REGISTERED');
    require('../ai/triageProvider.service').registerGuardedTriage(proof, triage);
    require('../quotes/review.service').registerGuardedReview(proof, quoteReview);registered = true;
  }
  function createIrisRouter() {
    const { authorize } = require('../iris/auth.service'), knowledge = require('../iris/knowledge.service').loadKnowledge();
    const changes = require('../iris/policyChange.service').createPolicyChanges();
    const service = require('../iris/conversation.service').createConversations({ authorize, changes, knowledge, planner,
      reads: require('../iris/readContext.service').createReadContext({ knowledge }),
      Turns: require('../../models/IrisTurn'), Access: require('../../models/IrisToolAccess') });
    return require('../../routes/iris.routes').createIrisRouter({ service, changes, knowledge });
  }
  const instance = Object.freeze({ register, createIrisRouter, withUser: authority.withUser });instances.set(instance, proof);return instance;
}
module.exports = { createLiveProviders, isLiveProviders: (value, proof) => instances.get(value) === proof && !!proof };
