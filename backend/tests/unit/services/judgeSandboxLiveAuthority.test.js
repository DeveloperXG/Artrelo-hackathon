'use strict';
const assert = require('node:assert/strict');
const { createLiveAuthority, isLiveAuthority } = require('../../../services/judgeSandbox/liveAuthority.service');
const { createLiveNetwork } = require('../../../services/judgeSandbox/liveNetwork.service');
const { installGuardedLiveSandbox } = require('../../../services/judgeSandbox/offlineGuard.service');
const query = value => ({ select() { return this; }, lean: async () => value });
async function main() {
  assert.throws(() => createLiveAuthority({ proof: {} }), /EXPLICIT_LIVE_AUTHORITY_REQUIRED/);
  const network = createLiveNetwork({ claimAttempt: async () => false, fetchImpl: async () => { throw Error('NO_PROVIDER_ALLOWED'); } });
  const proof = installGuardedLiveSandbox({ database: 'artrelo_iris_judge_authority_unit_test', frontendOrigin: 'http://127.0.0.1:3144' }, network);
  let time = new Date('2026-11-01T01:00:00Z'), active = true, pairRef = 'unit-pair-1', changed = false, missingPair = false;
  const landlord = { id: 'unit-landlord-1', accountId: 'unit-account-1', role: 'landlord', expiresAt: time.getTime() + 60000 };
  const tenant = { ...landlord, id: 'unit-tenant-1', role: 'tenant' };
  const authorizePair = async user => {
    if (!active) throw Error('INERT_ACCOUNT_REVOKED');
    return { actorId: user.id, accountId: user.accountId, role: user.role, pair: { _id: pairRef } };
  };
  const args = { subjectId: 'unit-subject-1', stage: 'quote', landlordId: landlord.id };
  const authority = createLiveAuthority({ proof, authorizePair, now: () => time,
    loadBasis: async () => ({ request: { _id: 'unit-request-1', landlordId: landlord.id, tenantId: tenant.id, propertyId: 'unit-property', unitId: 'unit-unit', status: 'pending' },
      subject: { _id: args.subjectId, requestId: 'unit-request-1', landlordId: landlord.id, vendorId: 'unit-vendor-1' }, snapshot: { hash: changed ? 'changed' : 'current' }, contextHash: 'unit-context' }),
    Pairs: { findOne: criteria => { assert.equal(criteria.vendorIds, 'unit-vendor-1');return query(missingPair ? null : { _id: pairRef, vendorIds: ['unit-vendor-1'] }); } },
    Landlords: { findById: value => { assert.equal(value, landlord.id);return query({ _id: landlord.id, accountId: landlord.accountId, role: 'landlord', status: 'active' }); } } });
  assert(isLiveAuthority(authority));assert(!isLiveAuthority({}));
  await assert.rejects(authority.authorize('planning'), /LIVE_AUTHORITY_UNAVAILABLE/);
  await authority.withUser(tenant, async () => {
    assert.equal((await authority.authorize('intake')).pairRef, pairRef);
    await assert.rejects(authority.authorize('planning'), /LIVE_AUTHORITY_UNAVAILABLE/);
    await assert.rejects(authority.authorize('quote_analysis'), /LIVE_AUTHORITY_UNAVAILABLE/);
  });
  await authority.withUser(landlord, async () => {
    assert.equal((await authority.authorize('planning')).actorRef, landlord.id);
    assert.equal((await authority.authorize('selection')).actorRef, landlord.id);
    await assert.rejects(authority.authorize('intake'), /LIVE_AUTHORITY_UNAVAILABLE/);
    active = false;await assert.rejects(authority.authorize('planning'));active = true;
    pairRef = 'unit-pair-2';await assert.rejects(authority.authorize('planning'), /LIVE_AUTHORITY_UNAVAILABLE/);pairRef = 'unit-pair-1';
    time = new Date(landlord.expiresAt);await assert.rejects(authority.authorize('planning'), /LIVE_AUTHORITY_UNAVAILABLE/);time = new Date('2026-11-01T01:00:00Z');
  });
  await authority.withQuoteJob(args, async () => {
    assert.equal((await authority.authorize('quote_analysis')).actorRef, 'system:quote-review');
    await assert.rejects(authority.authorize('planning'), /LIVE_AUTHORITY_UNAVAILABLE/);
    changed = true;await assert.rejects(authority.authorize('quote_analysis'), /LIVE_AUTHORITY_UNAVAILABLE/);changed = false;
    missingPair = true;await assert.rejects(authority.authorize('quote_analysis'), /LIVE_AUTHORITY_UNAVAILABLE/);missingPair = false;
  });
  await assert.rejects(authority.authorize('quote_analysis'), /LIVE_AUTHORITY_UNAVAILABLE/);
  await assert.rejects(authority.withUser({ ...landlord, pairRef: 'client-selected' }, async () => {}), /LIVE_AUTHORITY_UNAVAILABLE/);
  time = new Date('2026-11-05T01:00:00Z');
  await assert.rejects(authority.withQuoteJob(args, () => authority.authorize('quote_analysis')), /LIVE_AUTHORITY_UNAVAILABLE/);
  network.dispose();
  console.log('PASS private live authority: actual proof requirement, per-role allowlist, token expiry/revocation/pair rebinding refusal, fresh owned quote-job scope, stale quote denial and no ambient authority leakage. Inert model fixtures only.');
}
main().catch(error => { console.error('FAIL guarded authority: ' + (error.code || 'ASSERTION'));process.exitCode = 1; });
