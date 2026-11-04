const mongoose = require('mongoose');
const { contract, error, id, view } = require('./contract.service');
function createStore({ Runs = require('../../models/JudgeSandboxRun'), Actions = require('../../models/JudgeSandboxAction'),
  Events = require('../../models/JudgeSandboxEvent'), connection = mongoose.connection, now = () => new Date() } = {}) {
  const find = (ctx, runId = null) => Runs.findOne({ pairId: ctx.pair._id, landlordId: ctx.pair.landlordId, ...(runId ? { _id: runId } : {}) }).lean();
  const prior = async (ctx, key, inputHash, session = null) => {
    const row = await Actions.findOne({ pairId: ctx.pair._id, key }).session(session).lean();
    if (row && (row.inputHash !== inputHash || id(row.actorId) !== ctx.actorId)) throw error('idempotency_conflict');
    return row;
  };
  const event = (ctx, run, kind, actionId, session, actorRole = 'landlord', receiptRef = null) => Events.create([{ pairId: ctx.pair._id, runId: run._id,
    revision: run.revision, kind, actorRole, actorId: actorRole === 'landlord' ? ctx.actorId : null, stepCode: run.stepCode, actionId, receiptRef }], { session });
  function replay(row) {
    if (row.state === 'completed') return { replay: true, data: row.result, httpStatus: row.httpStatus };
    if (row.state === 'refused') throw error(row.errorCode);
    throw error(row.state === 'unknown' ? 'action_unknown' : 'run_busy');
  }
  async function start(ctx, key, inputHash) {
    try {
      return await connection.transaction(async session => {
        const old = await prior(ctx, key, inputHash, session);if (old) return replay(old);
        if (await Runs.exists({ pairId: ctx.pair._id }).session(session)) throw error('run_exists');
        const at = now(), [run] = await Runs.create([{ pairId: ctx.pair._id, landlordId: ctx.pair.landlordId, revision: 1,
          storyVersion: contract.storyVersions.containedFaucet,
          state: 'waiting_on_tenant', stepCode: 'tenant_submit', detail: 'The paired tenant submits through the ordinary request form.',
          checkpoint: { kind: 'tenant_submit', requestId: null, approvalId: null }, startedAt: at, updatedAt: at }], { session });
        const projected = view(run.toObject());
        const [action] = await Actions.create([{ pairId: ctx.pair._id, runId: run._id, actorId: ctx.actorId, key, inputHash,
          action: 'start', stepCode: 'tenant_submit', state: 'completed', result: projected, httpStatus: 201 }], { session });
        await event(ctx, run, 'started', action._id, session);return { data: projected, httpStatus: 201 };
      });
    } catch (e) {
      if (e.code !== 11000) throw e;
      const old = await prior(ctx, key, inputHash);if (old) return replay(old);throw error('run_exists');
    }
  }
  async function observe(ctx, run, observation) {
    if (run.paused || run.inFlightActionId || run.error?.code === 'action_unknown') return run;
    const fields = ['requestId', 'stepCode', 'state', 'detail', 'checkpoint', 'error', 'completedAt'];
    const clean = Object.fromEntries(fields.map(k => [k, Object.hasOwn(observation, k) ? observation[k] : run[k] ?? null]));
    const old = Object.fromEntries(fields.map(k => [k, run[k] ?? null]));
    // Normalize ObjectIds/Dates before comparison, without logging their data.
    if (JSON.stringify(JSON.parse(JSON.stringify(clean))) === JSON.stringify(JSON.parse(JSON.stringify(old)))) return run;
    return connection.transaction(async session => {
      const updated = await Runs.findOneAndUpdate({ _id: run._id, pairId: ctx.pair._id, revision: run.revision, paused: false, inFlightActionId: null },
        { $set: { ...clean, updatedAt: now() }, $inc: { revision: 1 } }, { session, new: true, lean: true });
      if (!updated) return find(ctx, id(run));
      await event(ctx, updated, 'observed', null, session, 'automation');return updated;
    });
  }
  async function claim(ctx, runId, action, input, key, inputHash) {
    try {
      return await connection.transaction(async session => {
        const old = await prior(ctx, key, inputHash, session);if (old) return replay(old);
        const run = await Runs.findOne({ _id: runId, pairId: ctx.pair._id, landlordId: ctx.pair.landlordId }).session(session).lean();
        if (!run) throw error('record_not_found');
        if (run.inFlightActionId) throw error('run_busy');
        if (run.error?.code === 'action_unknown') throw error('action_unknown');
        if (run.revision !== input.expectedRevision || run.stepCode !== input.stepCode) throw error('stale_revision');
        if (!view(run).allowedActions.includes(action)) throw error(run.checkpoint ? 'checkpoint_requires_human' : 'step_not_ready');
        const [record] = await Actions.create([{ pairId: ctx.pair._id, runId: run._id, actorId: ctx.actorId, key, inputHash,
          action, stepCode: run.stepCode, state: 'claimed' }], { session });
        const pause = action === 'pause', resume = action === 'resume';
        const update = action === 'continue' ? { state: 'running', inFlightActionId: record._id }
          : { paused: pause, state: pause ? 'paused' : run.stateBeforePause || 'waiting_on_landlord', stateBeforePause: pause ? run.state : null };
        const updated = await Runs.findOneAndUpdate({ _id: run._id, pairId: ctx.pair._id, revision: run.revision, inFlightActionId: null },
          { $set: { ...update, updatedAt: now() }, $inc: { revision: 1 } }, { session, new: true, lean: true });
        if (!updated) throw error('stale_revision');
        await event(ctx, updated, pause ? 'paused' : resume ? 'resumed' : 'claimed', record._id, session);
        if (action !== 'continue') {
          const data = view(updated);await Actions.updateOne({ _id: record._id, state: 'claimed' }, { $set: { state: 'completed', result: data, httpStatus: 200 } }, { session });
          return { data, httpStatus: 200 };
        }
        return { run: updated, actionId: id(record), httpStatus: 202 };
      });
    } catch (e) {
      if (e.code !== 11000) throw e;
      const old = await prior(ctx, key, inputHash);if (old) return replay(old);throw error('run_busy');
    }
  }
  async function reconcileDecline(ctx, run, proof) {
    if (!proof?.declineReceiptRef || !proof?.deliveryReceiptRef || proof.observation?.error ||
        id(proof.observation?.requestId) !== id(run.requestId) ||
        run.paused || run.inFlightActionId || run.state !== 'failed' || run.stepCode !== 'routing' ||
        run.error?.code !== 'action_unknown' || !(run.completedDirectives || []).includes('vendor_decline')) return run;
    return connection.transaction(async session => {
      const owned = { pairId: ctx.pair._id, runId: run._id };
      // A genuine uncertain/claimed action always stays quarantined, even if
      // another domain record later exists. Never repair by replaying it.
      if (await Actions.exists({ ...owned, state: { $in: ['claimed', 'unknown'] } }).session(session)) return find(ctx, id(run));
      const last = await Actions.findOne({ ...owned, action: 'continue' }).sort({ createdAt: -1, _id: -1 }).session(session).lean();
      if (!last || last.state !== 'completed' || last.stepCode !== 'vendor_decline' || last.receiptRef !== proof.declineReceiptRef) return find(ctx, id(run));
      const fields = Object.fromEntries(['requestId', 'stepCode', 'state', 'detail', 'checkpoint', 'error', 'completedAt'].map(k => [k, proof.observation[k] ?? null]));
      const updated = await Runs.findOneAndUpdate({ _id: run._id, pairId: ctx.pair._id, landlordId: ctx.pair.landlordId,
        revision: run.revision, paused: false, inFlightActionId: null, state: 'failed', stepCode: 'routing', 'error.code': 'action_unknown' },
      { $set: { ...fields, updatedAt: now() }, $inc: { revision: 1 } }, { session, new: true, lean: true });
      if (!updated) return find(ctx, id(run));
      await event(ctx, updated, 'observed', last._id, session, 'automation', proof.deliveryReceiptRef);
      return updated;
    });
  }
  async function settle(ctx, runId, actionId, { observation = null, code = null, notStarted = false, receiptRef = null } = {}) {
    return connection.transaction(async session => {
      const action = await Actions.findOne({ _id: actionId, runId, pairId: ctx.pair._id, state: 'claimed' }).session(session).lean();
      const run = await Runs.findOne({ _id: runId, pairId: ctx.pair._id, inFlightActionId: actionId }).session(session).lean();
      if (!action || !run) throw error('action_unknown');
      const state = code ? notStarted ? 'refused' : 'unknown' : 'completed';
      const failure = code ? { code: notStarted ? code : 'action_unknown', retryable: false, retryAfterSeconds: null, nextAvailableAt: null } : null;
      const fields = observation || {};
      const updated = await Runs.findOneAndUpdate({ _id: run._id, pairId: ctx.pair._id, revision: run.revision, inFlightActionId: actionId },
        { $set: { ...fields, state: code ? 'failed' : fields.state || 'ready_to_continue', error: failure, inFlightActionId: null, updatedAt: now() },
          $inc: { revision: 1 }, ...(!code ? { $addToSet: { completedDirectives: action.stepCode } } : {}) }, { session, new: true, lean: true });
      if (!updated) throw error('action_unknown');
      const data = view(updated);
      await Actions.updateOne({ _id: action._id, state: 'claimed' }, { $set: { state, result: data, httpStatus: code ? 409 : 200, errorCode: failure?.code || null, receiptRef } }, { session });
      await event(ctx, updated, state, action._id, session, 'automation', receiptRef);
      return { data, httpStatus: code ? 409 : 200 };
    });
  }
  return { find, prior, replay, start, observe, claim, settle, reconcileDecline };
}
module.exports = { createStore };
