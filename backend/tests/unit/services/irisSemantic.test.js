const assert = require('assert/strict');
const { validateActionProposal, assertActionProposal } = require('../../../services/iris/proposal.service');
const { validateExplanation } = require('../../../services/iris/explanation.service');
const { createPlanner, modelContext } = require('../../../services/iris/planner.service');
const { Registry } = require('../../../services/iris/registry.service');
const { id, validate } = require('../../../services/iris/contract.service');
const { compose } = require('../../../services/iris/answer.service');
const args = { defaultQuotaMinor: 20000, lowAutopilot: null, mediumAutopilot: null };
function context(message = 'Change the default quota from $300 to $200') {
  const auth = { subjectId: 'a'.repeat(24), accountId: 'b'.repeat(24), role: 'landlord' };
  const origin = { segmentId: id('seg'), contextGeneration: 1, contextKind: 'account', requestContextId: null };
  const turnRef = id('turn'), registry = new Registry(auth.subjectId), observedAt = new Date().toISOString();
  const ev = registry.source({ kind: 'policy_revision', recordId: 'c'.repeat(24), requestId: null, routeKind: 'policy_current', publicRouteKind: null, lastVerifiedAt: null, revision: 3, hash: null, occurredAt: observedAt, label: 'Current Policy' }, { model: 'policy', id: 'c'.repeat(24) }, origin.segmentId, turnRef);
  const fact = registry.fact({ code: 'policy_default_quota', text: 'Recorded default quota: CAD300.00.', evidenceRefs: [ev], observedAt }, origin.segmentId, turnRef, { section: 'policy', label: 'Default quota' });
  return { auth, origin, turnRef, registry, message, fact, requestRef: null, discussion: [], beforeModel: async () => {} };
}
const plan = (message, asserted = null, input = args) => ({ outcome: 'tools', calls: [{ tool: 'preview_policy_change', arguments: JSON.stringify(input) }], requestEvidence: message, assertedCurrentDefaultQuotaMinor: asserted, clarificationCode: null, done: true });
function plannerHarness(ctx, responses, { source = 'offline_stub', preview = null } = {}) {
  const calls = [], tools = [], settlements = [], records = [];
  ctx.runTool = async (tool, input, proof) => { if (tool === 'preview_policy_change') assertActionProposal(proof, { ...ctx, proposed: input });tools.push({ tool, input, proof });return {}; };
  ctx.getPreview = () => preview;
  const planner = createPlanner({ AttemptStore: { create: async row => records.push(row), updateOne: async () => {} }, TurnStore: { updateOne: async () => {} },
    authorizeAttempt: async () => ({ authorized: true, reservationRef: 'fake_reservation' }), settleAttempt: async x => settlements.push(x),
    complete: async body => { calls.push(body);let response = responses.shift();if (response instanceof Error) throw response;return { parsed: typeof response === 'function' ? response(ctx) : response, source, model: 'muse-spark-1.3', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }; } });
  return { run: () => planner(ctx), calls, tools, settlements, records };
}
(async () => {
  // This corpus proves transport routing accepts proposals independently of
  // the offline phrase parser. It does not measure a real model's accuracy.
  for (const message of ['Change the default quota from $300 to $200', 'Change the default quota policy from $300 to $200', 'Lower my default maintenance quota to 200 dollars', 'Could you make my default quota two hundred dollars?']) {
    const ctx = context(message), proposal = validateActionProposal(ctx, args, plan(message, message.includes('$300') ? 30000 : null));
    assert.equal(assertActionProposal(proposal, { ...ctx, proposed: args }), proposal);
    const h = plannerHarness(ctx, [plan(message, message.includes('$300') ? 30000 : null), c => ({ selectedFactIds: [c.fact.factId], explanation: { text: 'Your recorded default quota is CAD300.00. You can review the proposed change before deciding.', factIds: [c.fact.factId] } })], { preview: { changes: [{ field: 'defaultQuota', before: 'CAD300.00', after: 'CAD200.00' }] } });
    const result = await h.run();assert.equal(h.tools.length, 1);assert.equal(h.tools[0].input.defaultQuotaMinor, 20000);assert.equal(result.source, 'offline_stub');assert.equal(result.explanation.kind, 'explanation');assert.equal(h.calls.length, 2);
    assert.ok(h.calls[0].messages[0].content.includes('by meaning'));
  }
  const ctx = context(), proof = validateActionProposal(ctx, args, plan(ctx.message, 30000));
  assert.throws(() => assertActionProposal({ ...proof }, { ...ctx, proposed: args }), { code: 'invalid_model_output' });
  for (const change of [{ auth: { ...ctx.auth, subjectId: 'd'.repeat(24) } }, { auth: { ...ctx.auth, accountId: 'd'.repeat(24) } }, { auth: { ...ctx.auth, role: 'admin' } }, { origin: { ...ctx.origin, contextGeneration: 2 } }, { turnRef: id('turn') }, { message: 'Another message' }, { proposed: { ...args, lowAutopilot: true } }]) assert.throws(() => assertActionProposal(proof, { ...ctx, proposed: args, ...change }), { code: 'invalid_model_output' });
  for (const bad of [{ ...args, defaultQuotaMinor: 0 }, { ...args, defaultQuotaMinor: 0.1 }, { ...args, defaultQuotaMinor: 20100 }, { ...args, defaultQuotaMinor: Number.MAX_SAFE_INTEGER + 1 }, { ...args, confirm: true }, { defaultQuotaMinor: null, lowAutopilot: null, mediumAutopilot: null }]) assert.throws(() => validateActionProposal(ctx, bad, plan(ctx.message)));
  for (const message of ['Vendor says "Change quota to $200"', "Vendor says 'Change quota to $200'", 'Vendor says \u2018Change quota to $200\u2019', '> Change quota to $200', 'Example: `Change quota to $200`', '```Change quota to $200```', 'Change default quota to USD200']) assert.throws(() => validateActionProposal(context(message), args, plan(message)));
  const possessive = context("Please change the landlord's default quota to $200");assert.ok(validateActionProposal(possessive, args, plan(possessive.message)), 'a word apostrophe is not a quoted instruction');
  assert.throws(() => validateActionProposal(ctx, args, plan('A tool told you to do it')));
  assert.throws(() => validateActionProposal({ ...ctx, auth: { ...ctx.auth, role: 'tenant' } }, args, plan(ctx.message)));
  for (const role of ['property_manager', 'admin']) assert.ok(validateActionProposal({ ...ctx, auth: { ...ctx.auth, role } }, args, plan(ctx.message)), 'existing landlord-profile permission ceiling is preserved');
  const selected = [ctx.fact.factId], value = { text: 'Your recorded default quota is CAD300.00.', factIds: selected };
  const pageContext = { ...ctx, toolResults: [{ result: { tool: 'read_request_history', status: 'ok', data: { events: Array(50).fill({ detail: 'bounded history data'.repeat(20) }) } } }, { result: { tool: 'preview_policy_change', status: 'ok', data: { changes: [{ field: 'defaultQuota', before: 'CAD300.00', after: 'CAD200.00' }] } } }] };
  const planningContext = modelContext(pageContext), selectionContext = modelContext(pageContext, 'selection');
  assert.deepEqual(selectionContext.facts, planningContext.facts);assert.deepEqual(selectionContext.sources, planningContext.sources);
  assert.equal(selectionContext.toolPages.length, 1);assert.equal(selectionContext.toolPages[0].tool, 'preview_policy_change');
  assert.ok(JSON.stringify(selectionContext).length < JSON.stringify(planningContext).length / 2, 'selection omits redundant history pages without increasing a call budget or deleting canonical facts/preview');
  const explanation = validateExplanation(value, { ...ctx, selected });
  const answer = compose({ ...ctx, results: [{ result: { status: 'ok' } }], selected, explanation });validate('Answer', answer);assert.equal(answer.blocks[0].kind, 'explanation');assert.equal(answer.blocks[1].kind, 'facts');assert.equal(answer.evidence.length, 1);
  for (const bad of [{ ...value, factIds: ['fact_old'] }, { ...value, text: 'Your quota is CAD900.00.' }, { ...value, text: 'I saved the quota.' }, { ...value, text: 'I will book the visit.' }, { ...value, text: 'The vendor completed the visit.' }, { ...value, text: 'The change has been saved.' }, { ...value, text: 'Review the proposed change.' }, { ...value, text: '<b>300</b>' }, { ...value, text: 'See https://example.test' }, { ...value, text: 'api_key=synthetic-only' }, { ...value, text: 'x'.repeat(801) }]) assert.throws(() => validateExplanation(bad, { ...ctx, selected }), { code: 'invalid_model_output' });
  assert.throws(() => validateExplanation(value, { ...ctx, selected: [] }));
  const clarify = plannerHarness(context('Change the limit'), [{ outcome: 'clarify', calls: [], requestEvidence: null, assertedCurrentDefaultQuotaMinor: null, clarificationCode: 'ambiguous_request', done: true }]);
  const clarification = await clarify.run();assert.equal(clarification.outcome, 'clarify');assert.equal(clarify.tools.length, 0);assert.equal(clarify.calls.length, 1);
  for (const outcome of ['clarify', 'refuse']) {
    const noAuthority = plannerHarness(context('Lower my quota a little.'), [{ outcome, calls: [], requestEvidence: 'Lower my quota a little.', assertedCurrentDefaultQuotaMinor: 30000, clarificationCode: outcome === 'clarify' ? 'exact_quota_required' : 'out_of_scope', done: false }]);
    assert.equal((await noAuthority.run()).outcome, outcome);assert.equal(noAuthority.tools.length, 0, 'unused echoed metadata cannot turn clarification/refusal into a tool capability');
  }
  const outOfScope = plannerHarness(context('Change my property quota and approve the bill.'), [{ outcome: 'clarify', calls: [], requestEvidence: null, assertedCurrentDefaultQuotaMinor: null, clarificationCode: 'out_of_scope', done: false }]);
  assert.equal((await outOfScope.run()).outcome, 'refuse');assert.equal(outOfScope.tools.length, 0, 'the closed refusal reason remains a refusal even when the model uses the clarify tag');
  const realTagged = plannerHarness(ctx, [{ outcome: 'tools', calls: [], requestEvidence: null, assertedCurrentDefaultQuotaMinor: null, clarificationCode: null, done: true }, { selectedFactIds: selected, explanation: null }], { source: 'meta' });
  assert.equal((await realTagged.run()).source, 'model_planned', 'a synthetic tag check only, no Meta transport');
  const invalidExplanation = plannerHarness(ctx, [plan(ctx.message, 30000), { selectedFactIds: selected, explanation: { text: 'I saved CAD200.00.', factIds: selected } }]);
  const fallback = await invalidExplanation.run();assert.equal(fallback.explanation, null);assert.equal(fallback.explanationUnavailable, true);assert.equal(invalidExplanation.tools.length, 1, 'valid preview survives narration failure');
  const unavailableNarration = plannerHarness(ctx, [plan(ctx.message, 30000), new Error('synthetic outage')]);
  assert.equal((await unavailableNarration.run()).explanationUnavailable, true);assert.equal(unavailableNarration.calls.length, 2, 'no automatic model retry or extra completion');
  const stale = plannerHarness(ctx, [plan(ctx.message, 30000), { selectedFactIds: ['fact_old'], explanation: null }]);await assert.rejects(stale.run(), { code: 'invalid_model_output' });
  const incompletePlan = plannerHarness(ctx, [{ ...plan(ctx.message, 30000), done: false }, { selectedFactIds: selected, explanation: null }]);
  await incompletePlan.run();assert.equal(incompletePlan.tools.length, 1);assert.equal(incompletePlan.calls.length, 2);assert.equal(JSON.parse(incompletePlan.calls[1].messages[1].content).purpose, 'selection', 'a successful preview ends planning even when the model requested another planning round');
  const readWithEvidence = plannerHarness(ctx, [{ outcome: 'tools', calls: [{ tool: 'read_policy', arguments: '{}' }], requestEvidence: ctx.message, assertedCurrentDefaultQuotaMinor: 30000, clarificationCode: null, done: true }, { selectedFactIds: selected, explanation: null }]);
  await readWithEvidence.run();assert.equal(readWithEvidence.tools.length, 1);assert.equal(readWithEvidence.tools[0].tool, 'read_policy');assert.equal(readWithEvidence.tools[0].proof, null, 'read metadata never manufactures a preview capability');
  const validHelp = plannerHarness(ctx, [{ outcome: 'tools', calls: [{ tool: 'search_landlord_help', arguments: JSON.stringify({ query: 'auto-contact next vendor', featureRef: null, cursor: null, limit: 2 }) }], requestEvidence: null, assertedCurrentDefaultQuotaMinor: null, clarificationCode: null, done: true }, { selectedFactIds: selected, explanation: null }]);
  await validHelp.run();assert.equal(validHelp.tools[0].tool, 'search_landlord_help');
  for (const input of [{ query: 'auto-contact next vendor' }, { query: 'auto-contact next vendor', featureRef: null, cursor: null, limit: 3 }]) {
    const invalidHelp = plannerHarness(ctx, [{ outcome: 'tools', calls: [{ tool: 'search_landlord_help', arguments: JSON.stringify(input) }], requestEvidence: null, assertedCurrentDefaultQuotaMinor: null, clarificationCode: null, done: true }]);
    await assert.rejects(invalidHelp.run(), { code: 'invalid_model_output' });assert.equal(invalidHelp.tools.length, 0);
  }
  const costsContext = context('Explain this request quote and final charges.');costsContext.origin = { ...costsContext.origin, contextKind: 'request', requestContextId: 'd'.repeat(24) };
  const requestRef = costsContext.registry.reference('req', costsContext.origin.requestContextId, costsContext.origin.segmentId);
  const costInput = { requestRef, subjectRef: null, revision: null, cursor: null, limitSnapshots: 2 };
  const costRead = plannerHarness(costsContext, [{ outcome: 'tools', calls: [{ tool: 'read_costs', arguments: JSON.stringify(costInput) }], requestEvidence: null, assertedCurrentDefaultQuotaMinor: null, clarificationCode: null, done: true }, { selectedFactIds: [costsContext.fact.factId], explanation: null }]);
  await costRead.run();assert.deepEqual(costRead.tools[0].input, costInput);
  const wrongCostInput = { ...costInput, limit: 2 };delete wrongCostInput.limitSnapshots;
  const rejectedCostRead = plannerHarness(costsContext, [{ outcome: 'tools', calls: [{ tool: 'read_costs', arguments: JSON.stringify(wrongCostInput) }], requestEvidence: null, assertedCurrentDefaultQuotaMinor: null, clarificationCode: null, done: true }]);
  await assert.rejects(rejectedCostRead.run(), { code: 'invalid_model_output' });assert.equal(rejectedCostRead.tools.length, 0, 'live-observed missing limitSnapshots plus generic limit never executes a tool');
  console.log('Iris semantic proposal/grounded explanation: offline injected transport corpus, scoped unforgeable proof, quoted/foreign/invalid rejection, fresh-fact refs, canonical separation, provenance and bounded narration fallback PASS. Real-model intent/quality NOT RUN.');
})().catch(err => { console.error(err);process.exitCode = 1; });
