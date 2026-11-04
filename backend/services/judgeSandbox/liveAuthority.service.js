'use strict';
// Private server scope only; HTTP bodies cannot choose a budget pair or actor.
const { AsyncLocalStorage } = require('node:async_hooks');
const policy = require('./liveBudgetPolicy.service');
const capabilities = new WeakSet();
const id = value => String(value?._id || value || '');
function createLiveAuthority({ proof, authorizePair, loadBasis, Pairs = null, Landlords = null, now = () => new Date() } = {}) {
  if (!require('./offlineGuard.service').isGuardedLiveProof(proof) ||
      ![authorizePair, loadBasis, now].every(fn => typeof fn === 'function')) throw policy.fail('EXPLICIT_LIVE_AUTHORITY_REQUIRED');
  Pairs ||= require('../../models/JudgeSandboxPair');Landlords ||= require('../../models/Landlord');
  if (!Pairs?.findOne || !Landlords?.findById) throw policy.fail('EXPLICIT_LIVE_AUTHORITY_REQUIRED');
  const scope = new AsyncLocalStorage();
  const reject = () => { throw policy.fail('LIVE_AUTHORITY_UNAVAILABLE'); };
  async function withUser(user, action) {
    if (!policy.exactKeys(user, ['id', 'role', 'accountId', 'expiresAt']) || !user.id || !user.accountId ||
        typeof user.role !== 'string' || !Number.isFinite(user.expiresAt) || user.expiresAt <= now().getTime() || typeof action !== 'function') return reject();
    const safeUser = Object.freeze({ ...user, id: id(user.id), accountId: id(user.accountId) });
    const initial = await authorizePair({ id: safeUser.id, accountId: safeUser.accountId, role: safeUser.role });
    if (id(initial.actorId) !== safeUser.id || id(initial.accountId) !== safeUser.accountId || !initial.pair) return reject();
    return scope.run(Object.freeze({ kind: 'user', user: safeUser, pairRef: id(initial.pair) }), action);
  }
  async function quoteContext(args) {
    if (!policy.exactKeys(args, ['subjectId', 'stage', 'landlordId']) || !['quote', 'invoice'].includes(args.stage) || !args.subjectId || !args.landlordId) return reject();
    const basis = await loadBasis(args), request = basis?.request, subject = basis?.subject;
    if (!request || !subject || !basis.snapshot?.hash || !basis.contextHash || id(subject) !== id(args.subjectId) ||
        id(request.landlordId) !== id(args.landlordId) || id(subject.landlordId) !== id(args.landlordId) ||
        id(subject.requestId) !== id(request) || !subject.vendorId || request.archivedAt || ['completed', 'cancelled', 'rejected'].includes(request.status)) return reject();
    const pair = await Pairs.findOne({ active: true, landlordId: request.landlordId, tenantId: request.tenantId,
      propertyId: request.propertyId, unitId: request.unitId, vendorIds: subject.vendorId }).lean();
    if (!pair || !pair.vendorIds?.some(value => id(value) === id(subject.vendorId))) return reject();
    const owner = await Landlords.findById(args.landlordId).select('_id accountId role status').lean();
    if (!owner || owner.status !== 'active') return reject();
    const current = await authorizePair({ id: id(owner), accountId: id(owner.accountId), role: owner.role || 'landlord' });
    if (current.role !== 'landlord' || id(current.pair) !== id(pair)) return reject();
    return { pairRef: id(pair), requestRef: id(request), quoteHash: basis.snapshot.hash, contextHash: basis.contextHash };
  }
  async function withQuoteJob(args, action) {
    if (typeof action !== 'function') return reject();
    const frozen = Object.freeze({ ...args }), bound = Object.freeze(await quoteContext(frozen));
    return scope.run(Object.freeze({ kind: 'quote_job', args: frozen, bound }), action);
  }
  async function authorize(purpose) {
    if (!Object.hasOwn(policy.OUTPUT_LIMITS, purpose) || now() >= new Date(policy.EXPIRES_AT)) return reject();
    const current = scope.getStore();if (!current) return reject();
    if (current.kind === 'quote_job') {
      if (purpose !== 'quote_analysis') return reject();
      const fresh = await quoteContext(current.args);
      if (JSON.stringify(fresh) !== JSON.stringify(current.bound)) return reject();
      return { realm: proof.database, pairRef: fresh.pairRef, actorRef: 'system:quote-review' };
    }
    const user = current.user;
    if (!user || user.expiresAt <= now().getTime() || purpose === 'quote_analysis') return reject();
    const fresh = await authorizePair({ id: user.id, accountId: user.accountId, role: user.role });
    if (id(fresh.actorId) !== user.id || id(fresh.accountId) !== user.accountId || id(fresh.pair) !== current.pairRef ||
        (purpose === 'intake' ? fresh.role !== 'tenant' : fresh.role !== 'landlord')) return reject();
    return { realm: proof.database, pairRef: id(fresh.pair), actorRef: user.id };
  }
  const capability = Object.freeze({ withUser, withQuoteJob, authorize });capabilities.add(capability);return capability;
}
module.exports = { createLiveAuthority, isLiveAuthority: value => capabilities.has(value) };
