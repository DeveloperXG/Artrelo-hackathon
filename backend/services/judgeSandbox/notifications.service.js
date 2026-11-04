const { id } = require('./contract.service');
// Only genuine gaps: normal Decisions, booking tenant notices and reschedule
// notifications retain their own authorities and existing event keys.
const AUDIENCE = Object.freeze({
  request_triaged: ['tenant'],
  vendor_outreach_sent: ['landlord'],
  vendor_response_accepted: ['landlord', 'tenant'],
  vendor_appointment_created: ['landlord'],
  appointment_proposed: ['landlord'],
  vendor_completion_submitted: ['landlord']
});
function noticeFor(action, audience, simulated) {
  const common = {
    request_triaged: ['Request received', 'Your maintenance request is recorded. Follow its normal details and visit steps here.'],
    vendor_outreach_sent: ['Vendor contact recorded', simulated ? 'The sandbox accepted a simulated vendor contact. No real vendor message was sent.' : 'The recorded vendor contact is available in this request.'],
    vendor_response_accepted: audience === 'tenant' ? ['Request progressing', 'A vendor response is recorded. Your manager is reviewing the next step.'] : ['Vendor response recorded', 'Review the recorded itemized response and any actual pending Decision.'],
    vendor_appointment_created: ['Visit recorded', 'A visit has been recorded. The tenant must give their own confirmation on the normal visit card.'],
    appointment_proposed: ['Visit proposed', 'A proposed visit is recorded. Required vendor and tenant responses remain separate.'],
    vendor_completion_submitted: ['Work report submitted', 'A simulated vendor report is recorded. Review the actual evidence and completion Decisions; this does not verify a physical repair.'],
    closed_request: ['Workflow closed', 'The recorded maintenance workflow is closed. Wallet entries remain synthetic and pending/manual; no bank transfer or physical repair is established.']
  };
  const [title, message] = common[action] || [];
  return title ? { title, message, type: 'judge_run_update', simulated } : null;
}
function createNotificationBridge({ proof, authorize, domain, intervalMs = 2000 } = {}) {
  const guard = require('./offlineGuard.service');
  if ((!guard.isOfflineGuardProof(proof) && !guard.isGuardedLiveProof(proof)) || typeof authorize !== 'function' || !domain?.load) throw Error('EXPLICIT_OFFLINE_NOTIFICATION_CAPABILITY_REQUIRED');
  const Pair = require('../../models/JudgeSandboxPair'), Run = require('../../models/JudgeSandboxRun'), Landlord = require('../../models/Landlord');
  const Log = require('../../models/AgentActionLog'), Outbox = require('../../models/JudgeSandboxNotice');
  const { Notification } = require('../../models/Notification');
  let pending = null, timer = null;
  async function deliver(pair, run, request, source, sourceKind) {
    const scope = { pairId: pair._id, runId: run._id, sourceId: source._id, sourceKind };
    let record;
    try { record = await Outbox.findOneAndUpdate(scope, { $setOnInsert: scope }, { upsert: true, new: true }); }
    catch (e) { if (e.code !== 11000) throw e;record = await Outbox.findOne(scope); }
    if (record?.delivered) return;
    const action = sourceKind === 'closed_request' ? sourceKind : source.actionType;
    const simulation = source.metadata?.judgeSimulation;
    const simulated = simulation?.version === 1 && simulation.pairId === id(pair) || source.output?.provider === 'judge_simulation';
    const audiences = sourceKind === 'closed_request' ? ['landlord'] : AUDIENCE[action] || [];
    for (const audience of audiences) {
      const eventKey = `judge_notice:${id(run)}:${sourceKind}:${id(source)}:${audience}`;
      const userId = audience === 'landlord' ? pair.landlordId : pair.tenantId;
      const copy = noticeFor(action, audience, !!simulated);
      const notification = await require('../notification/notify.service').notifyUser({ ...copy, userId, eventKey,
        metadata: { workOrderId: id(request), actionUrl: `${audience === 'landlord' ? '/dashboard' : '/portal'}/requests/${id(request)}`, sandbox: true, simulated: !!simulated } });
      if (!notification || !await Notification.exists({ eventKey, userId })) {
        await Outbox.updateOne(scope, { $set: { lastError: 'notification_unavailable' } });return;
      }
    }
    await Outbox.updateOne(scope, { $set: { delivered: true, lastError: null } });
  }
  async function scan() {
    const pairs = await Pair.find({ active: true }).sort({ ordinal: 1 }).limit(12).lean();
    let processed = 0;
    for (const pair of pairs) {
      const run = await Run.findOne({ pairId: pair._id }).lean();if (!run) continue;
      const landlord = await Landlord.findById(pair.landlordId).select('accountId').lean();if (!landlord) continue;
      const ctx = await authorize({ id: pair.landlordId, accountId: landlord.accountId, role: 'landlord' });
      const { request } = await domain.load(ctx, run);if (!request) continue;
      // Anti-join committed records rather than advancing an ObjectId cursor:
      // a delayed transaction can commit an older ID after a newer one.
      const sources = await Log.aggregate([
        { $match: { requestId: request._id, landlordId: pair.landlordId, createdAt: { $gte: run.startedAt }, actionType: { $in: Object.keys(AUDIENCE) } } },
        { $lookup: { from: Outbox.collection.name, let: { source: '$_id' }, pipeline: [{ $match: { runId: run._id, sourceKind: 'audit', delivered: true, $expr: { $eq: ['$sourceId', '$$source'] } } }], as: 'delivery' } },
        { $match: { 'delivery.0': { $exists: false } } }, { $sort: { createdAt: 1, _id: 1 } }, { $limit: 50 },
        { $project: { _id: 1, actionType: 1, 'metadata.judgeSimulation': 1, 'output.provider': 1 } }
      ]);
      for (const source of sources) { await deliver(pair, run, request, source, 'audit');processed++; }
      if (request.status === 'completed') await deliver(pair, run, request, request, 'closed_request');
    }
    return processed;
  }
  function flush() { if (!pending) pending = scan().finally(() => { pending = null; });return pending; }
  function start() { if (!timer) { timer = setInterval(() => { void flush().catch(() => {}); }, intervalMs);timer.unref?.(); }return dispose; }
  async function dispose() { if (timer) clearInterval(timer);timer = null;if (pending) await pending.catch(() => {}); }
  return { flush, start, dispose };
}
module.exports = { createNotificationBridge, noticeFor, AUDIENCE };
