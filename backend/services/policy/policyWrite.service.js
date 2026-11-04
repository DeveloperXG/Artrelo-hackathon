const mongoose = require('mongoose');
const crypto = require('crypto');
const Policies = require('../../models/LandlordPolicy');
const Revisions = require('../../models/LandlordPolicyRevision');
const Logs = require('../../models/AgentActionLog');
const FIELDS = ['defaultQuota', 'categoryQuotas', 'propertyQuotas', 'unitQuotas', 'requireApprovalForExternalSearch',
  'requireApprovalOverQuota', 'requireApprovalForFirstTimeVendor', 'allowQuoteClarification',
  'allowAutopilotForLowSeverity', 'allowAutopilotForMediumSeverity', 'digestFrequency',
  'emergencyNotificationChannels', 'lowFundsThreshold', 'autoAdvanceOnVendorDecline', 'maxOutreachAttempts'];
const ROUTING_FIELDS = ['defaultQuota', 'categoryQuotas', 'propertyQuotas', 'unitQuotas', 'requireApprovalOverQuota',
  'requireApprovalForFirstTimeVendor', 'maxOutreachAttempts', 'allowAutopilotForLowSeverity', 'allowAutopilotForMediumSeverity'];
const fail = (code, message, status = 400, extras = {}) => Object.assign(new Error(message), { code, status, ...extras });
function stable(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value?.toHexString) return JSON.stringify(value.toHexString());
  if (value instanceof Map) value = Object.fromEntries(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value ?? null);
}
function values(policy) {
  const out = {};
  for (const field of FIELDS) out[field] = policy?.[field] instanceof Map ? Object.fromEntries(policy[field]) : policy?.[field] ?? null;
  return out;
}
function policyHash(policy) {
  return crypto.createHash('sha256').update(stable({ exists: Boolean(policy), revision: policy?.policyRevision ?? null, values: values(policy) })).digest('hex');
}
function normalizePatch(patch) {
  const result = {};
  const numberLike = raw => typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '');
  for (const key of Object.keys(patch)) {
    if (!FIELDS.includes(key)) throw fail('invalid_input', 'This policy field is not supported.', 400, { field: key });
    let raw = patch[key];
    if (key === 'defaultQuota') {
      if (raw === null || raw === '') raw = null;
      else if (!numberLike(raw) || !Number.isFinite(Number(raw)) || Number(raw) <= 0) throw fail('invalid_input', 'Enter a default quota greater than $0.', 400, { field: key });
      else raw = Number(raw);
    } else if (key === 'maxOutreachAttempts') {
      if (!numberLike(raw) || !Number.isInteger(Number(raw)) || Number(raw) < 0 || Number(raw) > 5) throw fail('invalid_input', 'Choose a whole number of vendors from 0 to 5.', 400, { field: key });
      raw = Number(raw);
    } else if (key === 'lowFundsThreshold') {
      if (!numberLike(raw) || !Number.isFinite(Number(raw)) || Number(raw) < 0) throw fail('invalid_input', 'Enter an amount of $0 or more.', 400, { field: key });
      raw = Number(raw);
    } else if (['categoryQuotas', 'propertyQuotas', 'unitQuotas'].includes(key)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.values(raw).every(v => numberLike(v) && Number.isFinite(Number(v)) && Number(v) > 0)) throw fail('invalid_input', 'Each quota must be an amount greater than $0.', 400, { field: key });
      raw = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
    } else if (key === 'allowQuoteClarification' && typeof raw !== 'boolean') throw fail('invalid_input', 'Choose whether routine quote follow-up is allowed.', 400, { field: key });
    result[key] = raw;
  }
  return result;
}
function presentPolicy(raw) {
  const base = raw?.toObject ? raw.toObject({ flattenMaps: true }) : raw;
  const filled = new Policies(base || {}).toObject({ flattenMaps: true });
  return { _id: String(filled._id), landlordId: String(filled.landlordId), ...values(filled),
    policyRevision: filled.policyRevision ?? 0, policyChangeReceiptRef: filled.policyChangeReceiptRef || null,
    auditRef: filled.auditRef || null, createdAt: filled.createdAt?.toISOString?.() || base?.createdAt || null,
    updatedAt: filled.updatedAt?.toISOString?.() || base?.updatedAt || null };
}
function createPolicyWriter({ Policy = Policies, Revision = Revisions, Audit = Logs, connection = mongoose.connection, now = () => new Date() } = {}) {
  async function writePolicy({ landlordId, expectedRevision, patch, actorId = landlordId, actorRole = 'landlord', origin = 'policy_ui', changeRef = null, expectedHash = null, session: existingSession = null }) {
    if (String(actorId) !== String(landlordId) || !['landlord', 'property_manager', 'admin'].includes(actorRole)) throw fail('forbidden', 'This policy is not available to this signed-in profile.', 403);
    if (!['policy_ui', 'iris_confirmed'].includes(origin)) throw fail('invalid_input', 'Invalid policy write origin.');
    if (expectedRevision === undefined) throw fail('policy_revision_required', 'Reload Policy before saving these settings.', 428, { currentPolicyRevision: null, field: 'expectedPolicyRevision' });
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw fail('invalid_input', 'Reload the current policy revision.', 400, { field: 'expectedPolicyRevision' });
    const normalized = normalizePatch(patch);
    const work = async session => {
      const before = await Policy.findOne({ landlordId }).session(session).lean();
      const currentRevision = before ? before.policyRevision ?? 0 : null;
      if (currentRevision !== expectedRevision || (expectedHash && policyHash(before) !== expectedHash)) throw fail('stale_policy', 'Your policy changed. Review the current settings before saving.', 409, { currentPolicyRevision: currentRevision });
      const candidate = new Policy({ ...(before || {}), ...normalized, landlordId });
      const invalid = candidate.validateSync();
      if (invalid) throw invalid;
      const afterValues = values(candidate.toObject({ flattenMaps: true }));
      const castPatch = Object.fromEntries(Object.keys(normalized).map(key => [key, afterValues[key]]));
      const revision = (currentRevision ?? 0) + 1;
      const revisionId = new mongoose.Types.ObjectId(), auditId = new mongoose.Types.ObjectId();
      const receiptRef = 'policyrev_' + revisionId, auditRef = 'audit_' + auditId;
      let saved;
      if (!before) {
        [saved] = await Policy.create([{ landlordId, ...castPatch, policyRevision: revision, policyChangeReceiptRef: receiptRef, auditRef }], { session });
      } else {
        const filter = { _id: before._id, landlordId, ...(before.policyRevision === undefined ? { $or: [{ policyRevision: 0 }, { policyRevision: { $exists: false } }] } : { policyRevision: currentRevision }) };
        saved = await Policy.findOneAndUpdate(filter, { $set: { ...castPatch, policyChangeReceiptRef: receiptRef, auditRef }, $inc: { policyRevision: 1 } }, { session, new: true, runValidators: true, context: 'query' });
        if (!saved) throw fail('stale_policy', 'Your policy changed. Reload it before saving.', 409, { currentPolicyRevision: null });
      }
      const snapshot = saved.toObject({ flattenMaps: true });
      if (snapshot.policyRevision !== revision || Object.keys(castPatch).some(k => stable(snapshot[k]) !== stable(castPatch[k]))) throw fail('service_unavailable', 'The saved policy could not be verified.', 503);
      const changedFields = Object.keys(castPatch).filter(key => stable(before?.[key]) !== stable(snapshot[key]));
      const routingChanged = changedFields.some(k => ROUTING_FIELDS.includes(k));
      try {
        await Audit.create([{ _id: auditId, landlordId, requestId: null, actor: 'landlord', actionType: 'policy_changed',
          summary: 'Policy settings updated after explicit confirmation.', input: { beforeRevision: currentRevision, fields: changedFields },
          output: { policyRevision: revision, receiptRef, appliedBy: 'system' }, metadata: { origin, actorId: String(actorId), actorRole, changeRef } }], { session });
        await Revision.create([{ _id: revisionId, landlordId, revision, beforeRevision: currentRevision, beforeValues: values(before), afterValues: values(snapshot), observedBeforeAt: now(), actorSubjectId: actorId, actorRole, origin, auditId, changeRef, changedFields, refreshState: routingChanged ? 'pending' : 'not_required' }], { session });
      } catch (error) {
        throw fail('audit_unavailable', 'This confirmation was not applied. Please try a fresh preview when the service is available.', 503);
      }
      return { policy: presentPolicy(saved), before, changedFields, routingChanged, receiptId: revisionId, receiptRef, auditRef, revision };
    };
    try { return existingSession ? await work(existingSession) : await connection.transaction(work); }
    catch (error) {
      if (error.code === 11000) throw fail('stale_policy', 'Your policy changed. Reload it before saving.', 409, { currentPolicyRevision: null });
      throw error;
    }
  }
  return { writePolicy };
}
function createPolicyRefresh({ Revision = Revisions, now = () => new Date(), run = (landlordId, options) => require('../../controllers/request.controller').reevaluateRequestsForPolicy(landlordId, options) } = {}) {
  const eligible = () => ({ $or: [{ refreshState: { $in: ['pending', 'failed'] } }, { refreshState: 'running', refreshAttemptAt: { $lt: new Date(now().getTime() - 5 * 60000) } }] });
  async function refreshReceipt(receiptId) {
    const attempt = now();
    const row = await Revision.findOneAndUpdate({ _id: receiptId, ...eligible() }, { $set: { refreshState: 'running', refreshAttemptAt: attempt } }, { new: true }).lean();
    if (!row) return;
    const lease = { _id: row._id, refreshState: 'running', refreshAttemptAt: attempt };
    try {
      const changedFields = row.changedFields.filter(field => ROUTING_FIELDS.includes(field));
      const result = await run(row.landlordId, { changedFields });
      await Revision.updateOne(lease, { $set: { refreshState: result?.setupIncomplete || result?.failed > 0 ? 'partial' : 'completed' } });
    } catch { await Revision.updateOne(lease, { $set: { refreshState: 'failed' } }); }
  }
  async function recover() {
    const rows = await Revision.find(eligible()).sort({ updatedAt: 1 }).limit(20).select('_id').lean();
    for (const row of rows) await refreshReceipt(row._id);
  }
  return { refreshReceipt, recover };
}
const refresh = createPolicyRefresh();
const refreshReceipt = refresh.refreshReceipt;
function queueRefresh(receiptId) { setImmediate(() => refreshReceipt(receiptId).catch(() => {})); }
function startPolicyRefreshRecovery() { const tick = () => refresh.recover().catch(() => {});tick();const timer = setInterval(tick, 60000);timer.unref?.();return timer; }
module.exports = { ...createPolicyWriter(), createPolicyWriter, createPolicyRefresh, normalizePatch, presentPolicy, values, policyHash, stable, fail, FIELDS, ROUTING_FIELDS, queueRefresh, refreshReceipt, startPolicyRefreshRecovery };
