const assert = require('assert/strict');
const crypto = require('crypto');
const compiledAnswers = [];
const answers = require('../../../services/iris/answer.service');
const originalCompose = answers.compose;
answers.compose = input => {
  const answer = originalCompose(input);compiledAnswers.push(structuredClone(answer));return answer;
};
const { createConversations } = require('../../../services/iris/conversation.service');
const { validate, id, error, contract } = require('../../../services/iris/contract.service');
const owner = 'a'.repeat(24), account = 'b'.repeat(24), requestA = 'c'.repeat(24), requestB = 'd'.repeat(24);
const user = { id: owner, accountId: account, role: 'landlord' };
function harness({ planner = null, sourceBytes = 0, policyCodes = ['policy_default_quota'], createTurn = null } = {}) {
  let at = Date.parse('2026-10-29T22:00:00Z'), revoked = false, auditFail = false, readBarrier = null;
  const jobs = [], durable = [], audits = [], previews = [], discards = [];
  const now = () => new Date(at);
  const authorize = async u => { if (revoked || u.id !== owner) throw error('auth_expired', 'Sign in again.');return { subjectId: owner, accountId: account, role: 'landlord' }; };
  const reads = {
    ownRequest: async (subject, ref) => { if (subject !== owner || ![requestA, requestB].includes(ref)) throw error('record_not_found', 'This request is not available.');return { issueTitle: ref === requestA ? 'Synthetic A' : 'Synthetic B' }; },
    read: async (tool, args, { registry, turnRef, origin }) => {
      if (readBarrier) await readBarrier;
      const ev = registry.source({ kind: tool === 'read_policy' ? 'policy_revision' : 'request', recordId: origin.requestContextId || 'policy', requestId: origin.requestContextId, routeKind: origin.requestContextId ? 'request_current' : 'policy_current', publicRouteKind: null, lastVerifiedAt: null, revision: 1, hash: null, occurredAt: now().toISOString(), label: 'Synthetic source' }, { model: 'test', ...(sourceBytes ? { padding: 'x'.repeat(sourceBytes) } : {}) }, origin.segmentId, turnRef);
      for (const code of policyCodes) registry.fact({ code, text: code === 'policy_default_quota' ? 'Current default quota: CAD300.00.' : code === 'policy_low' ? 'Low autopilot: On.' : 'Medium autopilot: Off.', evidenceRefs: [ev], observedAt: now().toISOString() }, origin.segmentId, turnRef, { section: 'policy', label: code === 'policy_default_quota' ? 'Default quota' : code === 'policy_low' ? 'Low autopilot' : 'Medium autopilot' });
      return { result: { status: 'ok', facts: registry.factsFor(turnRef), evidence: [registry.sources.get(ev).evidence], truncated: false }, notice: null };
    },
    verifyEvidence: async () => {},
  };
  const changes = { preview: async args => {
    const base = structuredClone(require('../../../contracts/iris.v2.fixtures.json').cases.find(c => c.schema === 'PolicyChangeView' && c.valid).value);
    const result = { preview: { ...base, id: id('pc'), origin: args.origin, state: 'preview_ready', appliedRevision: null, verifiedValues: null, auditRef: null, refreshState: 'not_required' }, confirmationToken: 'f'.repeat(64) };previews.push({ args, result });return result;
  }, discard: async (auth, ref) => { discards.push(ref); } };
  const Turns = { create: async row => { if (createTurn) await createTurn(row);if (durable.some(r => r.clientTurnId === row.clientTurnId)) throw Object.assign(new Error('duplicate'), { code: 11000 });durable.push(row); }, updateOne: async () => {} };
  const Access = { create: async row => { if (auditFail) throw new Error('synthetic audit outage');audits.push(row); } };
  const service = createConversations({ authorize, reads, changes, Turns, Access, knowledge: { get: () => true }, planner, now, schedule: job => jobs.push(job) });
  return { service, jobs, durable, audits, previews, discards, now, advance: ms => { at += ms; }, revoke: () => { revoked = true; }, failAudit: () => { auditFail = true; }, block: promise => { readBarrier = promise; }, drain: async () => { while (jobs.length) await jobs.shift()(); } };
}
async function open(h, ref = requestA, generation = 0) {
  const c = await h.service.create(user, { clientConversationId: crypto.randomUUID() });
  const origin = await h.service.context(user, c.conversationId, { requestContextId: ref, contextGeneration: generation });
  return { c, origin };
}
const input = (origin, text = 'What is my quota?') => ({ clientTurnId: crypto.randomUUID(), text, requestContextId: origin.requestContextId, contextGeneration: origin.contextGeneration });
(async () => {
  const h = harness(), { c, origin } = await open(h);
  assert.deepEqual(await h.service.context(user, c.conversationId, { requestContextId: requestA, contextGeneration: 0 }), origin);
  await assert.rejects(h.service.context(user, c.conversationId, { requestContextId: 'e'.repeat(24), contextGeneration: 1 }), { code: 'record_not_found' });
  const body = input(origin), first = await h.service.accept(user, c.conversationId, body);
  assert.deepEqual((await h.service.accept(user, c.conversationId, body)).turnId, first.turnId);
  assert.equal(h.durable.length, 1);assert.equal(h.jobs.length, 1);
  assert.equal(JSON.stringify(h.durable).includes(body.text), false);
  await assert.rejects(h.service.accept(user, c.conversationId, { ...body, text: 'different' }), { code: 'invalid_input' });
  await h.drain();
  const view = await h.service.getTurn(user, first.turnId);validate('TurnView', view);
  assert.equal(view.status, 'completed');assert.equal(view.answer.source, 'deterministic_records');
  assert.deepEqual(view.answer, compiledAnswers[0], 'the public answer exactly matches the canonical DTO produced before retention');
  const retained = h.service.conversations.get(c.conversationId), savedTurn = [...retained.turns.values()][0];
  assert.equal(savedTurn.view.answer, null, 'completed record answers do not retain a duplicate full DTO');
  assert.ok(savedTurn.answerRecipe, 'the accounted rendering recipe remains available');
  h.advance(1000);const polledAgain = await h.service.getTurn(user, first.turnId);
  assert.deepEqual(polledAgain.answer, view.answer, 'polling rehydrates exactly the same IDs, sources, values and observation time');
  assert.equal(retained.registry.contexts.size, 1, 'scope metadata is stored once for the turn');
  assert.ok([...retained.registry.sources.values()].every(s => !Object.hasOwn(s, 'facts') && s.factIds.length === 1));
  const peek = await h.service.evidence(user, view.answer.evidence[0].ref);assert.equal(peek.facts.length, 1);
  assert.ok(h.audits.every(a => !Object.hasOwn(a, 'text') && !Object.hasOwn(a, 'arguments')));
  await h.service.context(user, c.conversationId, { requestContextId: null, contextGeneration: 1 });
  const accountOrigin = await h.service.context(user, c.conversationId, { requestContextId: null, contextGeneration: 1 });
  assert.deepEqual(h.service.recall(h.service.conversations.get(c.conversationId), accountOrigin), []);
  const accountTurn = await h.service.accept(user, c.conversationId, input(accountOrigin, 'What is my policy?'));await h.drain();
  const bOrigin = await h.service.context(user, c.conversationId, { requestContextId: requestB, contextGeneration: 2 });
  await h.service.accept(user, c.conversationId, input(bOrigin, 'What is my policy?'));await h.drain();
  const back = await h.service.context(user, c.conversationId, { requestContextId: requestA, contextGeneration: 3 });
  const recalled = h.service.recall(h.service.conversations.get(c.conversationId), back);
  assert.equal(recalled.length, 1);assert.equal(recalled[0].human, body.text);
  assert.deepEqual(Object.keys(recalled[0]).sort(), ['answerIntent', 'human', 'kind']);
  assert.equal(JSON.stringify(recalled).includes('evidence'), false);
  await assert.rejects(h.service.context(user, c.conversationId, { requestContextId: requestA, contextGeneration: 2 }), { code: 'stale_context' });
  await assert.rejects(h.service.accept(user, c.conversationId, input(accountOrigin)), { code: 'context_mismatch' });
  const offRequest = await h.service.getTurn(user, accountTurn.turnId);assert.equal(offRequest.origin.contextKind, 'account');
  assert.deepEqual((await h.service.getTurn(user, first.turnId)).answer, view.answer, 'navigation never substitutes current facts into an earlier answer');
  h.advance(30 * 60000 + 1);
  await assert.rejects(h.service.getTurn(user, first.turnId), { code: 'conversation_expired' });
  assert.equal(h.service.conversations.get(c.conversationId).registry, null);
  const restarted = await open(h);assert.deepEqual(h.service.recall(h.service.conversations.get(restarted.c.conversationId), restarted.origin), []);

  const a = harness(), ac = await open(a), ai = input(ac.origin);
  a.failAudit();const accepted = await a.service.accept(user, ac.c.conversationId, ai);await a.drain();
  const failed = await a.service.getTurn(user, accepted.turnId);assert.equal(failed.status, 'unavailable');assert.equal(failed.error.code, 'audit_unavailable');assert.equal(failed.answer, null);

  const r = harness(), rc = await open(r);await r.service.accept(user, rc.c.conversationId, input(rc.origin));r.revoke();await r.drain();
  await assert.rejects(r.service.getTurn(user, first.turnId), { code: 'auth_expired' });assert.equal(r.service.conversations.get(rc.c.conversationId).registry, null);

  const cap = harness(), cp = await open(cap);
  const t1 = await cap.service.accept(user, cp.c.conversationId, input(cp.origin));
  await cap.service.accept(user, cp.c.conversationId, input(cp.origin));
  await assert.rejects(cap.service.accept(user, cp.c.conversationId, input(cp.origin)), { code: 'concurrent_turn_limit' });
  assert.equal((await cap.service.cancel(user, t1.turnId)).status, 'cancelled');await cap.drain();
  assert.equal((await cap.service.getTurn(user, t1.turnId)).status, 'cancelled');
  for (let i = 2; i < 20; i++) {
    // Avoid manufacturing active-segment memory pressure in this independent
    // hard-turn-count test; each turn uses a new inactive segment.
    const org = await cap.service.context(user, cp.c.conversationId, { requestContextId: i % 2 ? requestA : null, contextGeneration: i });
    await cap.service.accept(user, cp.c.conversationId, input(org));await cap.drain();
  }
  const current = cap.service.conversations.get(cp.c.conversationId).current;
  await assert.rejects(cap.service.accept(user, cp.c.conversationId, input(current)), { code: 'turn_limit' });
  await cap.service.close(user, cp.c.conversationId);assert.equal(cap.service.conversations.get(cp.c.conversationId).registry, null);
  const model = harness({ planner: async ctx => {
    await ctx.beforeModel();assert.equal(ctx.signal.aborted, false);
    const args = { defaultQuotaMinor: 25000, lowAutopilot: null, mediumAutopilot: null };
    const proof = require('../../../services/iris/proposal.service').validateActionProposal(ctx, args, { requestEvidence: ctx.message, assertedCurrentDefaultQuotaMinor: null });
    const result = await ctx.runTool('preview_policy_change', args, proof);
    assert.equal(JSON.stringify(result).includes('f'.repeat(64)), false, 'UI capability must never reach planner');
    return { selected: ctx.registry.factsFor(ctx.turnRef).map(f => f.factId), source: 'offline_stub', model: 'muse-spark-1.3' };
  } });
  const mc = await open(model), mt = await model.service.accept(user, mc.c.conversationId, input(mc.origin, 'Set my default quota to CAD250'));await model.drain();
  const modeled = await model.service.getTurn(user, mt.turnId);assert.equal(modeled.status, 'completed');assert.equal(modeled.answer.source, 'offline_stub');assert.ok(modeled.preview);assert.equal(model.previews.length, 1, 'a model preview is not created twice');
  const fallback = harness({ planner: async () => { throw Object.assign(new Error('synthetic unavailable model'), { code: 'model_unavailable' }); } });
  const fc = await open(fallback), ft = await fallback.service.accept(user, fc.c.conversationId, input(fc.origin));await fallback.drain();
  const fv = await fallback.service.getTurn(user, ft.turnId);assert.equal(fv.status, 'completed');assert.equal(fv.answer.source, 'deterministic_records');assert.ok(fv.answer.blocks.some(b => b.code === 'unavailable'));
  assert.deepEqual((await fallback.service.getTurn(user, ft.turnId)).answer, fv.answer, 'fallback notices also keep stable block IDs');
  const unsafe = harness({ planner: async () => { throw Object.assign(new Error('required model audit outage'), { code: 'audit_unavailable' }); } });
  const uc = await open(unsafe), ut = await unsafe.service.accept(user, uc.c.conversationId, input(uc.origin));await unsafe.drain();assert.equal((await unsafe.service.getTurn(user, ut.turnId)).answer, null, 'required audit outage cannot fall back to exposing unaudited work');
  const memory = harness({ sourceBytes: Math.floor(contract.limits.transcriptBytes / 4) }), mm = await open(memory);let limited = false;
  for (let i = 0; i < 19; i++) {
    try {
      const t = await memory.service.accept(user, mm.c.conversationId, input(mm.origin, 'What is my policy? ' + 'x'.repeat(1900)));await memory.drain();
      const v = await memory.service.getTurn(user, t.turnId);if (v.error?.code === 'transcript_limit') { limited = true;break; }
    } catch (err) { if (err.code !== 'transcript_limit') throw err;limited = true;break; }
  }
  assert.equal(limited, true, 'retained private record data is charged to the current active-segment bound');
  await assert.rejects(memory.service.accept(user, mm.c.conversationId, input(mm.origin, 'Short question')), { code: 'transcript_limit' });
  const trimmed = harness({ sourceBytes: Math.floor(contract.limits.transcriptBytes / 4) }), tc = await open(trimmed), oldTurn = await trimmed.service.accept(user, tc.c.conversationId, input(tc.origin));await trimmed.drain();
  let last;
  for (let generation = 1; generation <= 1000; generation++) last = await trimmed.service.context(user, tc.c.conversationId, { requestContextId: generation % 2 ? null : requestA, contextGeneration: generation });
  assert.equal(trimmed.service.conversations.get(tc.c.conversationId).segments.length, 2, 'empty navigation contexts cannot grow retained memory');
  assert.equal((await trimmed.service.getTurn(user, oldTurn.turnId)).status, 'completed', 'real earlier dialogue survives empty navigation');
  const removed = [];
  for (let generation = 1001; generation <= 1018; generation++) {
    last = await trimmed.service.context(user, tc.c.conversationId, { requestContextId: generation % 2 ? requestA : null, contextGeneration: generation });
    const next = await trimmed.service.accept(user, tc.c.conversationId, input(last, 'What is my policy? ' + 'x'.repeat(1900)));await trimmed.drain();
    const v = await trimmed.service.getTurn(user, next.turnId);assert.equal(v.status, 'completed');removed.push(...v.trimmedSegmentIds);
    assert.equal(v.trimmedSegmentIds.includes(last.segmentId), false);
  }
  assert.ok(removed.length > 0, 'real inactive segments are evicted whole under actual dialogue pressure');
  // Exact original browser phrases must reach the same bounded preview path.
  for (const [message, expected] of [
    ['Turn off autopilot for low-severity requests', { defaultQuotaMinor: null, lowAutopilot: false, mediumAutopilot: null }],
    ['Turn on autopilot for medium-severity requests', { defaultQuotaMinor: null, lowAutopilot: null, mediumAutopilot: true }],
  ]) {
    const original = harness(), opened = await open(original, null);
    const submitted = await original.service.accept(user, opened.c.conversationId, input(opened.origin, message));await original.drain();
    const result = await original.service.getTurn(user, submitted.turnId);
    assert.equal(result.status, 'completed');assert.equal(result.preview.state, 'preview_ready');
    assert.deepEqual(original.previews[0].args.proposed, expected);original.service.dispose();
  }
  const negated = harness(), no = await open(negated, null);
  const nt = await negated.service.accept(user, no.c.conversationId, input(no.origin, 'Set my default quota to CAD250 and do not turn Low-severity autopilot off.'));await negated.drain();
  const nv = await negated.service.getTurn(user, nt.turnId);assert.equal(nv.preview, null);assert.equal(nv.confirmationToken, null);assert.equal(negated.previews.length, 0);
  assert.ok(nv.answer.blocks.some(b => b.kind === 'clarification'));negated.service.dispose();
  // Cheap OFFLINE behavior has no pending-number FSM, in either page context.
  for (const ref of [null, requestA]) {
    const off = harness(), opened = await open(off, ref);
    for (const message of ['Change the default quota', '200']) {
      const t = await off.service.accept(user, opened.c.conversationId, input(opened.origin, message));await off.drain();
      const v = await off.service.getTurn(user, t.turnId);
      assert.equal(v.preview, null);assert.equal(v.activities.length, 0);
      assert.match(v.answer.blocks[0].question, /complete command|setting and new value/);
      assert.doesNotMatch(v.answer.blocks[0].question, /Open Requests|What exact positive/);
    }
    assert.equal(off.service.conversations.get(opened.c.conversationId).policyFocus, undefined, 'offline creates no pending/focus state');
    off.service.dispose();
  }
  // Real conversation plumbing + inert semantic planner/proposal. This proves
  // context supply and validation, not a claim about live-model intelligence.
  const observed = [], { modelContext } = require('../../../services/iris/planner.service');
  const conversational = harness({ policyCodes: ['policy_default_quota', 'policy_low', 'policy_medium'], planner: async ctx => {
    const data = modelContext(ctx);observed.push({ message: ctx.message, ...data });
    const facts = ctx.registry.factsFor(ctx.turnRef), quota = facts.find(f => f.code === 'policy_default_quota');
    if (ctx.message === 'Change the default quota') return { outcome: 'clarify', clarificationCode: 'exact_quota_required', source: 'offline_stub', model: 'muse-spark-1.3' };
    if (ctx.message === '200' || ctx.message === 'Could you lower it to two hundred dollars?') {
      assert.deepEqual(data.policyDiscussion.fields, ['defaultQuotaMinor']);
      const args = { defaultQuotaMinor: 20000, lowAutopilot: null, mediumAutopilot: null };
      const proof = require('../../../services/iris/proposal.service').validateActionProposal(ctx, args, { requestEvidence: ctx.message, assertedCurrentDefaultQuotaMinor: null });
      await ctx.runTool('preview_policy_change', args, proof);
      return { selected: [quota.factId], source: 'offline_stub', model: 'muse-spark-1.3' };
    }
    return { selected: ctx.message === 'Explain all my policies' ? facts.map(f => f.factId) : ctx.message === 'Unrelated topic' ? [] : [quota.factId], source: 'offline_stub', model: 'muse-spark-1.3' };
  } });
  const dialog = await open(conversational, null);
  const say = async (origin, text) => { const t = await conversational.service.accept(user, dialog.c.conversationId, input(origin, text));await conversational.drain();return conversational.service.getTurn(user, t.turnId); };
  await say(dialog.origin, 'Explain my default quota');
  const nav = await conversational.service.context(user, dialog.c.conversationId, { requestContextId: requestA, contextGeneration: 1 });
  assert.ok((await say(nav, 'Could you lower it to two hundred dollars?')).preview, 'online paraphrase uses model proposal, never offline phrase matching');
  assert.equal(conversational.previews[0].args.proposed.defaultQuotaMinor, 20000);
  assert.equal(observed.at(-1).earlierDiscussion.length, 0, 'account raw text is not added to request recall');
  assert.equal(JSON.stringify(observed.at(-1).policyDiscussion).includes('300'), false, 'focus contains no old saved value');
  await say(nav, 'Change the default quota');
  assert.equal(conversational.service.conversations.get(dialog.c.conversationId).policyFocus.awaitingQuotaAmount, true);
  assert.ok((await say(nav, '200')).preview, 'online explicit amount answers exact typed preceding question');
  assert.ok(observed.at(-1).earlierDiscussion.some(d => d.human === 'Change the default quota'), 'same-request earlier human meaning still supplied');
  await say(nav, 'Explain all my policies');
  assert.equal(conversational.service.conversations.get(dialog.c.conversationId).policyFocus.fields.length, 3, 'broad table does not invent one target');
  await say(nav, 'Unrelated topic');
  assert.equal(conversational.service.conversations.get(dialog.c.conversationId).policyFocus, null);
  const lastPolicyTurn = await say(nav, 'Explain my default quota');
  assert.ok(conversational.service.conversations.get(dialog.c.conversationId).policyFocus);
  conversational.advance(30 * 60000 + 1);
  await assert.rejects(conversational.service.getTurn(user, lastPolicyTurn.turnId), { code: 'conversation_expired' });
  assert.equal(conversational.service.conversations.get(dialog.c.conversationId).policyFocus, null, 'real expiry clears typed meaning as well as transcript');
  conversational.service.dispose();
  let releaseSlow, enteredSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; }), entered = new Promise(resolve => { enteredSlow = resolve; });
  const racedContexts = [];
  const focusRace = harness({ policyCodes: ['policy_default_quota', 'policy_low', 'policy_medium'], planner: async ctx => {
    racedContexts.push(modelContext(ctx).policyDiscussion);
    if (ctx.message === 'Slow default answer') { enteredSlow();await slowGate; }
    return { selected: [ctx.registry.factsFor(ctx.turnRef).find(f => f.code === (ctx.message === 'Slow default answer' ? 'policy_default_quota' : 'policy_medium')).factId], source: 'offline_stub', model: 'muse-spark-1.3' };
  } });
  const racedDialog = await open(focusRace, null);
  await focusRace.service.accept(user, racedDialog.c.conversationId, input(racedDialog.origin, 'Slow default answer'));
  const slowJob = focusRace.jobs.shift()();await entered;
  await focusRace.service.accept(user, racedDialog.c.conversationId, input(racedDialog.origin, 'Medium policy'));
  await focusRace.jobs.shift()();
  assert.deepEqual(focusRace.service.conversations.get(racedDialog.c.conversationId).policyFocus.fields, ['mediumAutopilot']);
  releaseSlow();await slowJob;
  assert.deepEqual(focusRace.service.conversations.get(racedDialog.c.conversationId).policyFocus.fields, ['mediumAutopilot'], 'slow old completion cannot replace newer topic');
  assert.equal(racedContexts[1], null, 'concurrently accepted question does not borrow unsettled focus');
  focusRace.service.dispose();
  // A failed durable acceptance decrements the usage cap, not causal ordering.
  // A later accepted turn still owns the topic even when the failure returns first.
  const failedId = crypto.randomUUID();let rejectAcceptance, acceptanceEntered;
  const failingGate = new Promise((resolve, reject) => { rejectAcceptance = reject; }), gateEntered = new Promise(resolve => { acceptanceEntered = resolve; });
  const acceptanceRace = harness({ policyCodes: ['policy_default_quota', 'policy_medium'], createTurn: async row => {
    if (row.clientTurnId === failedId) { acceptanceEntered();await failingGate; }
  }, planner: async ctx => ({ selected: [ctx.registry.factsFor(ctx.turnRef).find(f => f.code === (ctx.message === 'Default policy' ? 'policy_default_quota' : 'policy_medium')).factId], source: 'offline_stub', model: 'muse-spark-1.3' }) });
  const acceptanceDialog = await open(acceptanceRace, null);
  await acceptanceRace.service.accept(user, acceptanceDialog.c.conversationId, input(acceptanceDialog.origin, 'Default policy'));await acceptanceRace.drain();
  const failing = acceptanceRace.service.accept(user, acceptanceDialog.c.conversationId, { ...input(acceptanceDialog.origin), clientTurnId: failedId }).catch(error => error);
  await gateEntered;
  await acceptanceRace.service.accept(user, acceptanceDialog.c.conversationId, input(acceptanceDialog.origin, 'Medium policy'));
  rejectAcceptance(new Error('Synthetic durable acceptance outage'));assert.equal((await failing).code, 'audit_unavailable');
  await acceptanceRace.drain();
  assert.deepEqual(acceptanceRace.service.conversations.get(acceptanceDialog.c.conversationId).policyFocus.fields, ['mediumAutopilot'], 'failed acceptance cannot leave the old default topic over a later successful Medium answer');
  acceptanceRace.service.dispose();
  console.log('Iris conversation: exact-request recall, fresh ownership, privacy, audit fail-closed, idempotency, caps, cancellation and expiry PASS.');
})().catch(err => { console.error(err);process.exitCode = 1; });
