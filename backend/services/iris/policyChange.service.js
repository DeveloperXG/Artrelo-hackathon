const crypto = require('crypto');
const mongoose = require('mongoose');
const Change = require('../../models/IrisPolicyChange');
const Policy = require('../../models/LandlordPolicy');
const Revision = require('../../models/LandlordPolicyRevision');
const Audit = require('../../models/AgentActionLog');
const Request = require('../../models/MaintenanceRequest');
const writer = require('../policy/policyWrite.service');
const { createImpact } = require('./impact.service');
const { assertPreviewIntent } = require('./intent.service');
const { assertActionProposal } = require('./proposal.service');
const { contract, validate, error, id, hash, iso } = require('./contract.service');
const { cents, money } = require('./readContext.service');
function createPolicyChanges({ Changes = Change, Policies = Policy, Revisions = Revision, Logs = Audit, Requests = Request, impact = createImpact(), policyWriter = writer, connection = mongoose.connection, now = () => new Date() } = {}) {
  const secret = crypto.randomBytes(32);
  const scope = auth => ({ subjectId: auth.subjectId, accountId: auth.accountId });
  const stages = row => ['preview', 'validate', 'confirm', 'execute', 'verify', 'audit'].map((stage, i) => ({ stage,
    state: row.state === 'applied' ? 'completed' : row.state === 'failed' && [3, 5].includes(i) ? 'failed' : i < 2 || (row.attemptedAt && i === 2) ? 'completed' : 'not_started',
    at: i < 2 ? iso(row.asOf) : row.state === 'applied' ? iso(row.appliedAt) : row.attemptedAt && [2, 3, 5].includes(i) ? iso(row.attemptedAt) : null }));
  const counts = rows => rows.reduce((out, row) => { const key = { eligible_next: 'eligible', retained_passed: 'passed', shadowed: 'shadowed', not_applicable: 'notApplicable', legacy_unknown: 'unknown' }[row.disposition];out[key]++;return out; }, { eligible: 0, passed: 0, shadowed: 0, notApplicable: 0, unknown: 0 });
  function cursor(row, offset) {
    const body = Buffer.from(JSON.stringify({ id: row.changeRef, owner: String(row.subjectId), offset, hash: row.impactHash })).toString('base64url');
    return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  }
  function readCursor(row, input) {
    if (input === null) return 0;
    const parts = input.split('.');
    if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) throw error('invalid_input', 'This impact page is not available.');
    const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts[1], 'hex'))) throw error('invalid_input', 'This impact page is not available.');
    let body;try { body = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { throw error('invalid_input', 'This impact page is not available.'); }
    if (body.id !== row.changeRef || body.owner !== String(row.subjectId) || body.hash !== row.impactHash || !Number.isSafeInteger(body.offset) || body.offset < 0 || body.offset > row.impactRows.length) throw error('invalid_input', 'This impact page is not available.');
    return body.offset;
  }
  async function owned(auth, changeRef, { session = null, token = false } = {}) {
    let q = Changes.findOne({ changeRef, ...scope(auth) });
    if (token) q = q.select('+tokenHash');
    if (session) q = q.session(session);
    const row = await q.lean();
    if (!row) throw error('record_not_found', 'This policy change is not available.');
    return row;
  }
  async function view(auth, changeRef) {
    let row = await owned(auth, changeRef);
    if (row.state === 'preview_ready' && new Date(row.expiresAt).getTime() <= now().getTime()) {
      await Changes.updateOne({ _id: row._id, state: 'preview_ready', expiresAt: { $lte: now() } }, { $set: { state: 'expired' } });
      row = await owned(auth, changeRef);
    }
    const receipt = row.policyReceiptId ? await Revisions.findOne({ _id: row.policyReceiptId, landlordId: auth.subjectId }).select('refreshState').lean() : null;
    return validate('PolicyChangeView', { id: row.changeRef, origin: row.origin, state: row.state, basePolicyRevision: row.basePolicyRevision, appliedRevision: row.appliedRevision ?? null,
      asOf: iso(row.asOf), expiresAt: iso(row.expiresAt), changes: row.changes, patchHash: row.patchHash, impactHash: row.impactHash, impactCounts: counts(row.impactRows),
      impactCursor: null, impactComplete: row.impactComplete, stages: stages(row), verifiedValues: row.verifiedValues || null, auditRef: row.auditRef || null,
      refreshState: receipt?.refreshState || (row.state === 'applied' ? 'pending' : 'not_required'), errorCode: row.errorCode || null });
  }
  async function preview({ auth, origin, message, proposed, registry, turnRef, proposal = null }) {
    const intent = proposal === null ? assertPreviewIntent(message, proposed) : assertActionProposal(proposal, { auth, origin, message, proposed, turnRef });
    const raw = await Policies.findOne({ landlordId: auth.subjectId }).lean();
    const policy = raw ? writer.presentPolicy(raw) : new Policies({ landlordId: auth.subjectId }).toObject({ flattenMaps: true });
    function currentFacts() {
      const observedAt = iso(now());
      const ref = registry.source({ kind: 'policy_revision', recordId: raw?._id ? String(raw._id) : 'unsaved-policy', requestId: null, routeKind: 'policy_current', publicRouteKind: null, lastVerifiedAt: null,
        revision: raw ? raw.policyRevision ?? 0 : null, hash: writer.policyHash(raw), occurredAt: iso(raw?.updatedAt), label: 'Your current Policy' }, { model: 'policy', id: raw?._id ? String(raw._id) : null }, origin.segmentId, turnRef);
      const values = [['policy_default_quota', 'Default quota', policy.defaultQuota === null ? 'Not set; human approval required' : money(cents(policy.defaultQuota))], ['policy_low', 'Low autopilot', policy.allowAutopilotForLowSeverity ? 'On' : 'Off'], ['policy_medium', 'Medium autopilot', policy.allowAutopilotForMediumSeverity ? 'On' : 'Off']];
      const facts = values.map(([code, label, value]) => registry.fact({ code, text: `${label}: ${value}.`, evidenceRefs: [ref], observedAt }, origin.segmentId, turnRef, { section: 'policy', label, displayValue: value }));
      return { currentFactIds: facts.map(f => f.factId), facts, evidence: [registry.sources.get(ref).evidence] };
    }
    if (proposal && proposal.assertedCurrentDefaultQuotaMinor !== null && proposal.assertedCurrentDefaultQuotaMinor !== cents(policy.defaultQuota)) return { mismatch: true, noop: false, preview: null, confirmationToken: null, ...currentFacts() };
    const patch = Object.fromEntries(Object.entries(intent.patch).filter(([field, value]) => writer.stable(policy[field]) !== writer.stable(value)));
    if (!Object.keys(patch).length) return { noop: true, preview: null, confirmationToken: null, ...currentFacts() };
    const result = await impact.capture(auth, policy, patch, { registry, scope: origin.segmentId, turnRef });
    const token = crypto.randomBytes(32).toString('hex'), changeRef = id('pc'), at = now();
    const changes = Object.entries(patch).map(([field, after]) => ({ field, before: field === 'defaultQuota' ? policy.defaultQuota === null ? 'Not set' : money(cents(policy.defaultQuota)) : policy[field] ? 'On' : 'Off', after: field === 'defaultQuota' ? money(cents(after)) : after ? 'On' : 'Off' }));
    await connection.transaction(async session => {
      await Changes.create([{ changeRef, ...scope(auth), role: auth.role, turnRef, origin, basePolicyRevision: raw ? raw.policyRevision ?? 0 : null, policyExisted: Boolean(raw), basePolicyHash: writer.policyHash(raw), patch, changes, patchHash: hash(writer.stable(patch)), impactHash: result.hash, impactRows: result.rows, impactComplete: true, asOf: at, expiresAt: new Date(at.getTime() + 5 * 60000), tokenHash: hash(token), state: 'preview_ready' }], { session });
      try { await Logs.create([{ landlordId: auth.subjectId, requestId: null, actor: 'system', actionType: 'iris_policy_previewed', summary: 'A policy preview was prepared for human review. No settings were changed.', input: { fields: Object.keys(patch), patchHash: hash(writer.stable(patch)) }, output: { previewRef: changeRef }, metadata: { origin: 'iris_preview', actorId: auth.subjectId, interpretation: proposal ? 'model_proposal' : 'offline_phrase' } }], { session }); }
      catch { throw error('audit_unavailable', 'Iris could not record this preview. No settings were changed.'); }
    });
    return { noop: false, preview: await view(auth, changeRef), confirmationToken: token, ...currentFacts() };
  }
  async function discard(auth, changeRef) {
    const row = await owned(auth, changeRef);
    await Changes.updateOne({ _id: row._id, state: 'preview_ready' }, { $set: { state: 'discarded' } });
    return view(auth, changeRef);
  }
  async function confirm(auth, changeRef, input) {
    const endpoint = contract.endpoints.find(x => x.path === '/policy-changes/:id/confirm');
    require('../../contracts/validate.cjs').assertValid(endpoint.input, input, contract.$defs);
    let appliedReceiptId = null;
    try {
      await connection.transaction(async session => {
        const row = await owned(auth, changeRef, { session, token: true });
        if (row.state === 'applied') {
          if (row.clientActionId !== input.clientActionId) throw error('preview_consumed', 'This preview has already been confirmed. Check its saved status.');
          return;
        }
        if (row.state !== 'preview_ready' || new Date(row.expiresAt) <= now()) throw error('preview_expired', 'This preview is no longer active. Review a fresh preview.');
        if (row.role !== auth.role) throw error('forbidden', 'Review a fresh preview for your current signed-in profile.');
        if (!crypto.timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(hash(input.confirmationToken), 'hex'))) throw error('forbidden', 'This confirmation is not available.');
        if (row.basePolicyRevision !== input.expectedPolicyRevision || row.patchHash !== input.patchHash || row.impactHash !== input.impactHash) throw error('stale_policy', 'This preview is out of date. Review a fresh preview.');
        const policy = await Policies.findOne({ landlordId: auth.subjectId }).session(session).lean();
        if (writer.policyHash(policy) !== row.basePolicyHash) throw error('stale_policy', 'Your policy changed. Review a fresh preview.', { currentPolicyRevision: policy?.policyRevision ?? null });
        const filled = policy ? writer.presentPolicy(policy) : new Policies({ landlordId: auth.subjectId }).toObject({ flattenMaps: true });
        const latest = await impact.capture(auth, filled, row.patch, { session });
        if (latest.hash !== row.impactHash) throw error('impact_changed', 'The in-flight checkpoint impact changed. Review a fresh preview.');
        const result = await policyWriter.writePolicy({ landlordId: auth.subjectId, actorId: auth.subjectId, actorRole: auth.role, origin: 'iris_confirmed', expectedRevision: row.basePolicyRevision, expectedHash: row.basePolicyHash, patch: row.patch, changeRef, session });
        const updated = await Changes.updateOne({ _id: row._id, state: 'preview_ready' }, { $set: { state: 'applied', clientActionId: input.clientActionId, attemptedAt: now(), appliedAt: now(), appliedRevision: result.revision,
          verifiedValues: { defaultQuotaMinor: result.policy.defaultQuota === null ? null : cents(result.policy.defaultQuota), lowAutopilot: result.policy.allowAutopilotForLowSeverity, mediumAutopilot: result.policy.allowAutopilotForMediumSeverity }, auditRef: result.auditRef, policyReceiptId: result.receiptId } }, { session });
        if (updated.modifiedCount !== 1) throw error('preview_consumed', 'This preview has already changed. Check its status.');
        appliedReceiptId = result.routingChanged ? result.receiptId : null;
      });
    } catch (err) {
      if (err.code === 'audit_unavailable') await Changes.updateOne({ changeRef, ...scope(auth), state: 'preview_ready' }, { $set: { state: 'failed', attemptedAt: now(), errorCode: 'audit_unavailable' } });
      if (['stale_policy', 'impact_changed'].includes(err.code)) await Changes.updateOne({ changeRef, ...scope(auth), state: 'preview_ready' }, { $set: { state: 'stale', errorCode: err.code } });
      if (err.code === 11000) throw error('preview_consumed', 'This action has already been used. Check the saved policy change.');
      throw err;
    }
    if (appliedReceiptId) policyWriter.queueRefresh(appliedReceiptId);
    const output = await view(auth, changeRef);
    const { publish } = require('../realtime/liveEvents.service');
    publish(auth.subjectId, 'policy');publish(auth.subjectId, 'iris_policy_changes');
    return output;
  }
  async function impactPage(auth, changeRef, input) {
    const row = await owned(auth, changeRef), offset = readCursor(row, input.cursor);
    const selected = row.impactRows.slice(offset, offset + input.limit);
    const ids = [...new Set(selected.map(x => x.requestId))];
    const available = await Requests.countDocuments({ _id: { $in: ids }, landlordId: auth.subjectId });
    if (available !== ids.length) throw error('stale_evidence', 'This historical impact context is no longer available.');
    const next = offset + input.limit < row.impactRows.length ? cursor(row, offset + input.limit) : null;
    return validate('ImpactPage', { previewId: changeRef, asOf: iso(row.asOf), rows: selected, nextCursor: next, complete: next === null });
  }
  async function auditEvidence(auth, ref) {
    if (!/^audit_[a-f0-9]{24}$/i.test(ref)) throw error('record_not_found', 'This source is not available.');
    const auditId = ref.slice(6);
    const receipt = await Revisions.findOne({ landlordId: auth.subjectId, auditId }).lean();
    const audit = receipt ? await Logs.findOne({ _id: auditId, landlordId: auth.subjectId, actionType: 'policy_changed' }).lean() : null;
    if (!receipt || !audit) throw error('record_not_found', 'This source is not available.');
    const change = receipt.changeRef ? await Changes.findOne({ changeRef: receipt.changeRef, ...scope(auth), state: 'applied' }).select('turnRef').lean() : null;
    const evidence = { ref, kind: 'audit', recordId: auditId, requestId: null, routeKind: 'none', publicRouteKind: null, lastVerifiedAt: null,
      revision: receipt.revision, hash: null, occurredAt: iso(audit.createdAt), label: 'Policy change audit' };
    const observedAt = iso(now()), values = receipt.afterValues;
    const texts = [`Backend saved policy revision ${receipt.revision} after explicit human confirmation through ${receipt.origin === 'iris_confirmed' ? 'the Iris panel' : 'Policy'}. This did not approve spending, delivery, booking or consent.`,
      `Recorded saved values: default quota ${values.defaultQuota === null ? 'not set' : money(cents(values.defaultQuota))}; Low autopilot ${values.allowAutopilotForLowSeverity ? 'On' : 'Off'}; Medium autopilot ${values.allowAutopilotForMediumSeverity ? 'On' : 'Off'}. These are this revision's values, not a claim about a later Policy.`];
    const facts = texts.map((text, i) => ({ factId: 'fact_' + auditId + '_' + i, code: 'saved_policy_receipt', text, evidenceRefs: [ref], observedAt }));
    return { view: validate('EvidenceView', { evidence, facts, observedAt }), turnRef: change?.turnRef || 'policy_receipt_' + receipt._id };
  }
  return { preview, confirm, discard, view, impactPage, owned, auditEvidence };
}
module.exports = { createPolicyChanges };
