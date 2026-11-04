const { contract, validate, error, id, hash, view } = require('./contract.service');
function createRuns({ enabled = false, authorize, store, inspect, inspectDeclineRecovery = null, execute, now = () => Date.now() } = {}) {
  if (enabled && ![authorize, inspect, execute].every(fn => typeof fn === 'function') || enabled && !store) throw TypeError('Explicit sandbox authority, store and bounded domain adapter required');
  const enabledNow = () => enabled === true;
  const scope = async user => { if (!enabledNow()) throw error('sandbox_disabled');return authorize(user); };
  const keyCheck = key => { if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw error('invalid_input'); };
  async function current(ctx, runId = null) {
    let run = await store.find(ctx, runId);if (!run) return null;
    if (run.inFlightActionId && now() - new Date(run.updatedAt).getTime() > 120000) {
      // A timed-out lease does not grant a second execution. Preserve unknown
      // until the operator reconciles the actual domain receipt.
      await store.settle(ctx, id(run), id(run.inFlightActionId), { code: 'action_unknown' });
      run = await store.find(ctx, id(run));
    }
    if (!run.paused && !run.inFlightActionId && run.error?.code === 'action_unknown' &&
        run.state === 'failed' && run.stepCode === 'routing' && (run.completedDirectives || []).includes('vendor_decline') &&
        [contract.storyVersions.declineRecovery, contract.storyVersions.containedFaucet].includes(run.storyVersion) &&
        typeof inspectDeclineRecovery === 'function' && typeof store.reconcileDecline === 'function') {
      const proof = await inspectDeclineRecovery(ctx, run);
      if (proof) { view({ ...run, ...proof.observation });run = await store.reconcileDecline(ctx, run, proof); }
    }
    if (!run.paused && !run.inFlightActionId && run.error?.code !== 'action_unknown') {
      const observation = await inspect(ctx, run);
      // Only a trusted server adapter can observe a pair-owned request.
      // Validate its closed projection before any guide-state persistence.
      view({ ...run, ...observation });run = await store.observe(ctx, run, observation);
    }
    return run;
  }
  async function status(user) {
    if (!enabledNow()) return validate('Status', { contractVersion: contract.contractVersion, enabled: false, pairLabel: null, role: null, simulatedVendorIds: [], run: null });
    const ctx = await scope(user), run = await current(ctx);
    return validate('Status', { contractVersion: contract.contractVersion, enabled: true, pairLabel: ctx.pair.label,
      role: ctx.role, simulatedVendorIds: ctx.role === 'landlord' ? ctx.pair.vendorIds.map(id) : [], run: run ? view(run, ctx.role) : null });
  }
  async function start(user, input, key) {
    const ctx = await scope(user);if (ctx.role !== 'landlord') throw error('forbidden_role');
    validate('StartInput', input);keyCheck(key);
    return store.start(ctx, key, hash({ actorId: ctx.actorId, action: 'start', input }));
  }
  async function action(user, runId, actionName, input, key) {
    const ctx = await scope(user);if (ctx.role !== 'landlord') throw error('forbidden_role');
    validate('ActionInput', input);keyCheck(key);
    if (!contract.actions.includes(actionName) || !/^[a-f0-9]{24}$/.test(runId)) throw error('invalid_input');
    const inputHash = hash({ actorId: ctx.actorId, runId, action: actionName, input });
    const old = await store.prior(ctx, key, inputHash);if (old) return store.replay(old);
    const run = await current(ctx, runId);if (!run) throw error('record_not_found');
    const claimed = await store.claim(ctx, runId, actionName, input, key, inputHash);
    if (!claimed.actionId) return claimed;
    let result;
    try {
      // No client selector/body is passed to the domain adapter.
      result = await execute(ctx, claimed.run, { actionId: claimed.actionId });
    } catch (e) {
      const safeCode = Object.hasOwn(contract.errors, e.code) ? e.code : 'service_unavailable';
      return store.settle(ctx, runId, claimed.actionId, { code: safeCode, notStarted: e.execution === 'not_started' });
    }
    // Once execute returned, audit/observation failure is uncertain, not a
    // precondition refusal. Never call execute twice to repair a lost reply.
    const after = { ...claimed.run, inFlightActionId: null, completedDirectives: [...(claimed.run.completedDirectives || []), claimed.run.stepCode] };
    try {
      const observation = await inspect(ctx, after);view({ ...after, ...observation });
      return await store.settle(ctx, runId, claimed.actionId, { observation, receiptRef: result?.receiptRef || null });
    } catch {
      // Preserve the claimed journal if reconciliation itself is unavailable.
      // A later status explicitly reports it as uncertain; no side-effect retry.
      throw error('action_unknown');
    }
  }
  return { status, start, action };
}
module.exports = { createRuns };
