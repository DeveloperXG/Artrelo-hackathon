const assert = require('assert/strict');
const { createPlanner, createMetaCompletion } = require('../../../services/iris/planner.service');
const { Registry } = require('../../../services/iris/registry.service');
const { id } = require('../../../services/iris/contract.service');
function harness({ kind = 'request', responses = [], denied = false, throws = false, timeout = false, timeoutMs = 10000, auditFails = false } = {}) {
  const records = [], settled = [], calls = [], tools = [], reservations = [];
  const auth = { subjectId: 'a'.repeat(24), accountId: 'b'.repeat(24), role: 'landlord' }, turnRef = id('turn'), origin = { segmentId: id('seg'), contextKind: kind, requestContextId: kind === 'request' ? 'c'.repeat(24) : null };
  const registry = new Registry(auth.subjectId);
  const ev = registry.source({ kind: 'request', recordId: 'd'.repeat(24), requestId: origin.requestContextId, routeKind: 'request_current', publicRouteKind: null, lastVerifiedAt: null, revision: 1, hash: null, occurredAt: new Date().toISOString(), label: 'Synthetic owned source' }, { secretPointer: 'must-never-serialize' }, origin.segmentId, turnRef);
  const fact = registry.fact({ code: 'current_setting', text: 'Current recorded default: CAD250.00.', evidenceRefs: [ev], observedAt: new Date().toISOString() }, origin.segmentId, turnRef);
  const AttemptStore = { create: async row => { if (auditFails) throw new Error('synthetic audit outage');records.push(row); }, updateOne: async (filter, update) => Object.assign(records.find(r => r.attemptRef === filter.attemptRef), update.$set) };
  const context = { auth, registry, turnRef, origin, requestRef: kind === 'request' ? id('req') : null, message: 'What is my policy?', discussion: [{ human: 'Earlier discussion only', answerIntent: 'read', evidence: 'do-not-copy', confirmationToken: 'do-not-copy' }], beforeModel: async () => {}, runTool: async (tool, args) => { tools.push({ tool, args });return {}; } };
  const planner = createPlanner({ AttemptStore, TurnStore: { updateOne: async () => {} }, timeoutMs,
    authorizeAttempt: async value => { reservations.push(value);return denied ? null : { authorized: true, reservationRef: id('reservation') }; },
    settleAttempt: async value => settled.push(value), complete: async body => {
      calls.push(body);if (throws) throw new Error('synthetic provider failure');if (timeout) return new Promise(() => {});
      const next = responses.shift();let parsed = typeof next === 'function' ? next(fact) : next || { selectedFactIds: [fact.factId], explanation: null };
      // Legacy test scenarios still exercise the same budgets/errors, using
      // the newly frozen closed transport shape rather than an old response.
      if (parsed.calls && !parsed.outcome) parsed = { outcome: 'tools', requestEvidence: null, assertedCurrentDefaultQuotaMinor: null, clarificationCode: null, ...parsed };
      if (parsed.selectedFactIds && !Object.hasOwn(parsed, 'explanation')) parsed.explanation = null;
      return { parsed, source: 'offline_stub', model: 'muse-spark-1.3', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
    } });
  return { planner, context, records, settled, calls, tools, reservations, fact };
}
(async () => {
  assert.throws(() => createPlanner());assert.throws(() => createMetaCompletion());
  // Exercise the real provider adapter with a fake SDK, including the nullable
  // anyOf fields that the legacy triage-only checker cannot interpret.
  const { contract } = require('../../../services/iris/contract.service');
  const sdkOutputs = [
    { outcome: 'tools', calls: [], requestEvidence: null, assertedCurrentDefaultQuotaMinor: null, clarificationCode: null, done: true },
    { selectedFactIds: [], explanation: null },
    { selectedFactIds: [], explanation: null, executable: true },
  ];
  const metaAdapter = createMetaCompletion({ config: { meta_api_key: 'synthetic-injected-key-never-sent' }, clientFactory: () => ({ chat: { completions: { create: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(sdkOutputs.shift()) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) } } }) });
  const adapterBody = schema => ({ messages: [], response_format: { json_schema: { name: 'owned_test', strict: true, schema } } });
  assert.equal((await metaAdapter(adapterBody(contract.$defs.OnlinePlan))).parsed.outcome, 'tools');
  assert.deepEqual((await metaAdapter(adapterBody(contract.$defs.OnlineAnswer))).parsed, { selectedFactIds: [], explanation: null });
  const rejectedAdapter = await metaAdapter(adapterBody(contract.$defs.OnlineAnswer));assert.equal(rejectedAdapter.parsed, null);assert.equal(rejectedAdapter.validationError, 'invalid_schema');assert.equal(rejectedAdapter.usage.total_tokens, 20, 'rejected output still reports billable usage');
  const h = harness({ responses: [{ calls: [], done: true }] });
  const answer = await h.planner(h.context);assert.deepEqual(answer.selected, [h.fact.factId]);assert.equal(answer.source, 'offline_stub');assert.equal(h.calls.length, 2);assert.equal(h.settled.length, 2);
  const serialized = JSON.stringify(h.calls);
  for (const privateValue of ['must-never-serialize', h.context.auth.subjectId, h.context.auth.accountId, h.context.origin.requestContextId, 'd'.repeat(24), 'do-not-copy']) assert.equal(serialized.includes(privateValue), false, privateValue);
  assert.ok(serialized.includes('untrusted_discussion'));assert.ok(serialized.includes('untrusted_record_fact'));
  assert.ok(h.calls.every(b => b.max_completion_tokens === 2048 && b.reasoning_effort === 'minimal' && Buffer.byteLength(JSON.stringify(b)) <= 32768));
  assert.ok(h.records.every(r => r.state === 'completed' && !Object.hasOwn(r, 'body')));
  const deny = harness({ denied: true });await assert.rejects(deny.planner(deny.context), { code: 'model_unavailable' });assert.equal(deny.calls.length, 0);assert.equal(deny.records[0].state, 'rejected');
  const audit = harness({ auditFails: true });await assert.rejects(audit.planner(audit.context), { code: 'audit_unavailable' });assert.equal(audit.calls.length, 0);assert.equal(audit.reservations.length, 0);
  const network = harness({ throws: true });await assert.rejects(network.planner(network.context), { code: 'model_unavailable' });assert.equal(network.calls.length, 1);assert.equal(network.records[0].state, 'unknown');assert.equal(network.settled[0].usage, null);
  const timeout = harness({ timeout: true, timeoutMs: 5 });await assert.rejects(timeout.planner(timeout.context), { code: 'model_unavailable' });assert.equal(timeout.calls.length, 1);assert.equal(timeout.records[0].state, 'unknown');
  const stale = harness({ responses: [{ calls: [], done: true }, { selectedFactIds: ['fact_from_earlier_segment'] }] });await assert.rejects(stale.planner(stale.context), { code: 'invalid_model_output' });
  const hidden = harness({ responses: [{ calls: [{ tool: 'approve_spend', arguments: '{}' }], done: true }] });await assert.rejects(hidden.planner(hidden.context), { code: 'invalid_model_output' });assert.equal(hidden.tools.length, 0);
  const account = harness({ kind: 'account', responses: [{ calls: [{ tool: 'read_request_history', arguments: '{"requestRef":"req_guess","cursor":null,"limit":1}' }], done: true }] });await assert.rejects(account.planner(account.context), { code: 'tool_limit' });assert.equal(account.tools.length, 0);
  const write = harness({ responses: [{ calls: [{ tool: 'preview_policy_change', arguments: '{"defaultQuotaMinor":1,"lowAutopilot":null,"mediumAutopilot":null}' }], done: true }] });await assert.rejects(write.planner(write.context), { code: 'invalid_model_output' });assert.equal(write.tools.length, 0, 'record text or model cannot supply current human request evidence');
  const rounds = harness({ responses: Array.from({ length: 2 }, () => ({ calls: Array.from({ length: 3 }, () => ({ tool: 'read_policy', arguments: '{}' })), done: false })) });const bounded = await rounds.planner(rounds.context);assert.equal(bounded.completions, 3);assert.equal(bounded.functions, 6);assert.equal(rounds.tools.length, 6);
  const cancelled = harness();cancelled.context.isCancelled = () => true;await assert.rejects(cancelled.planner(cancelled.context), { code: 'turn_interrupted' });assert.equal(cancelled.calls.length, 0);
  const revoked = harness();revoked.context.beforeModel = async () => { throw Object.assign(new Error('expired'), { code: 'auth_expired' }); };await assert.rejects(revoked.planner(revoked.context), { code: 'auth_expired' });assert.equal(revoked.calls.length, 0);
  console.log('Iris planner injected-fake PASS: explicit spend gate, durable unknown/no retry, cancellation/timeout, scope/ID redaction, untrusted recall, current-fact selection and2x3/3-completion bounds. No live model calls.');
})().catch(err => { console.error(err);process.exitCode = 1; });
