const assert = require('assert/strict');
const { createRuns } = require('../../../services/judgeSandbox/run.service');
const { view, hash } = require('../../../services/judgeSandbox/contract.service');
const at = new Date('2026-10-31T06:00:00Z'), runId = 'a'.repeat(24), pairId = 'b'.repeat(24);
const user = { id: 'owner' }, ctx = { actorId: 'owner', role: 'landlord', pair: { _id: pairId, label: 'Judge pair 1', vendorIds: ['vendor1'] } };
function fixture({ role = 'landlord', unknown = false, executeError = null, inspectErrorAfter = false } = {}) {
  let run = { _id: runId, pairId, revision: 3, state: 'ready_to_continue', stepCode: 'vendor_quote', startedAt: at, updatedAt: at, checkpoint: null, error: null, completedDirectives: [] };
  let executed = 0, claimed = 0, settled = 0, inspected = 0, sideEffectArgs;
  const journal = new Map(), auth = { ...ctx, role };
  const store = {
    find: async (c, ref) => ref && ref !== runId ? null : { ...run },
    prior: async (c, key, h) => { const old = journal.get(key);if (old && old.inputHash !== h) throw Object.assign(Error(), { code: 'idempotency_conflict' });return old; },
    replay: old => { if (old.state === 'unknown') throw Object.assign(Error(), { code: 'action_unknown' });return { data: old.result, httpStatus: 200, replay: true }; },
    observe: async (c, r, o) => { run = { ...r, ...o };return run; },
    start: async () => ({ data: view(run), httpStatus: 201 }),
    claim: async (c, ref, action, input, key, inputHash) => {
      claimed++;assert.equal(input.expectedRevision, run.revision);assert.equal(input.stepCode, run.stepCode);
      journal.set(key, { inputHash, state: unknown ? 'unknown' : 'claimed' });
      return { run, actionId: 'action_owned' };
    },
    settle: async (c, ref, action, outcome) => {
      settled++;run = { ...run, ...(outcome.observation || {}), revision: run.revision + 1 };
      const entry = [...journal.values()].at(-1);entry.state = outcome.code ? outcome.notStarted ? 'refused' : 'unknown' : 'completed';entry.result = view(run);
      return { data: view(run), httpStatus: outcome.code ? 409 : 200 };
    }
  };
  const service = createRuns({ enabled: true, authorize: async u => { assert.equal(u, user);return auth; }, store,
    inspect: async () => { inspected++;if (inspectErrorAfter && executed) throw Error('audit unavailable');return {}; },
    execute: async (...args) => { executed++;sideEffectArgs = args;if (executeError) throw executeError;return { receiptRef: 'safe_receipt' }; } });
  return { service, counts: () => ({ executed, claimed, settled, inspected }), args: () => sideEffectArgs };
}
(async () => {
  assert.throws(() => createRuns({ enabled: true }));
  const disabled = createRuns({ authorize: () => { throw Error('must not access data'); } });
  assert.equal((await disabled.status(user)).enabled, false);await assert.rejects(() => disabled.start(user, {}, 'idempotency_00001'), e => e.code === 'sandbox_disabled');
  const f = fixture(), input = { expectedRevision: 3, stepCode: 'vendor_quote' }, key = 'idempotency_00001';
  await f.service.action(user, runId, 'continue', input, key);assert.equal(f.counts().executed, 1);
  const replay = await f.service.action(user, runId, 'continue', input, key);assert.equal(replay.replay, true);assert.equal(f.counts().executed, 1);
  assert.deepEqual(Object.keys(f.args()[2]), ['actionId'], 'domain receives no arbitrary user body');
  await assert.rejects(() => f.service.action(user, runId, 'continue', { ...input, stepCode: 'booking' }, key), e => e.code === 'idempotency_conflict');
  await assert.rejects(() => f.service.action(user, runId, 'continue', { ...input, vendorId: 'foreign' }, 'idempotency_00002'));
  await assert.rejects(() => f.service.action(user, 'c'.repeat(24), 'continue', input, 'idempotency_00002'), e => e.code === 'record_not_found');
  const tenant = fixture({ role: 'tenant' });await assert.rejects(() => tenant.service.action(user, runId, 'continue', input, key), e => e.code === 'forbidden_role');assert.equal(tenant.counts().claimed, 0);
  const uncertain = fixture({ executeError: Error('transport lost') });await uncertain.service.action(user, runId, 'continue', input, key);await assert.rejects(() => uncertain.service.action(user, runId, 'continue', input, key), e => e.code === 'action_unknown');assert.equal(uncertain.counts().executed, 1);
  const reconcile = fixture({ inspectErrorAfter: true });await assert.rejects(() => reconcile.service.action(user, runId, 'continue', input, key), e => e.code === 'action_unknown');assert.equal(reconcile.counts().executed, 1);assert.equal(reconcile.counts().settled, 0);
  const privateRun = view({ _id: runId, revision: 1, stepCode: 'quote_resolution', state: 'waiting_on_landlord', detail: 'Sensitive financial detail', checkpoint: { kind: 'wallet_funding', requestId: 'request1', approvalId: 'approval1' }, error: null, startedAt: at, updatedAt: at }, 'tenant');
  assert.equal(privateRun.checkpoint, null);assert.equal(privateRun.allowedActions.length, 0);assert.equal(JSON.stringify(privateRun).includes('Sensitive'), false);assert.equal(JSON.stringify(privateRun).includes('approval1'), false);
  assert.notEqual(hash({ action: 'continue', input }), hash({ action: 'pause', input }));
  console.log('PASS judge run boundary: default disabled, scoped role, no arbitrary tool/record payload, exact replay/no second execution, foreign denial, uncertain no retry and tenant financial redaction.');
})().catch(e => { console.error(e);process.exitCode = 1; });
