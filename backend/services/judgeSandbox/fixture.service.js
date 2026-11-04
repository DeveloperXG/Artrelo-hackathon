const crypto = require('crypto'), mongoose = require('mongoose');
const { error, hash, id } = require('./contract.service');
const KEYS = ['version', 'authorizationRef', 'assignedPairs', 'sparePairs', 'initialPolicy', 'syntheticOpeningWalletMinor'];
const POLICY_KEYS = ['defaultQuotaMinor', 'lowAutopilot', 'mediumAutopilot', 'autoContact', 'maxVendors', 'quoteClarification'];
function validateManifest(m) {
  if (!m || Array.isArray(m) || Object.keys(m).sort().join() !== [...KEYS].sort().join() || m.version !== 1 || typeof m.authorizationRef !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(m.authorizationRef) ||
    !Number.isInteger(m.assignedPairs) || m.assignedPairs < 8 || m.assignedPairs > 10 || !Number.isInteger(m.sparePairs) || m.sparePairs < 1 || m.sparePairs > 2 || m.assignedPairs + m.sparePairs > 12 ||
    !Number.isSafeInteger(m.syntheticOpeningWalletMinor) || m.syntheticOpeningWalletMinor < 0 || m.syntheticOpeningWalletMinor > 10000000) throw error('invalid_input');
  const p = m.initialPolicy;
  if (!p || Object.keys(p).sort().join() !== [...POLICY_KEYS].sort().join() || !Number.isSafeInteger(p.defaultQuotaMinor) || p.defaultQuotaMinor < 0 || p.defaultQuotaMinor > 100000000 ||
    !['lowAutopilot', 'mediumAutopilot', 'autoContact', 'quoteClarification'].every(k => typeof p[k] === 'boolean') || !Number.isInteger(p.maxVendors) || p.maxVendors < 0 || p.maxVendors > 5) throw error('invalid_input');
  return m;
}
function syntheticDatabase(connection = mongoose.connection) {
  if (!/^artrelo_(?:iris_judge_|judge_)[a-z0-9_]+_test$/.test(connection.name || '')) throw error('sandbox_disabled');
}
async function seedFixtures({ manifest, credentialsForPair, roster = null, operatorBinding = null, connection = mongoose.connection } = {}) {
  validateManifest(manifest);syntheticDatabase(connection);if (connection !== mongoose.connection) throw error('sandbox_disabled');
  if (typeof credentialsForPair !== 'function') throw TypeError('Private credential capability required; credentials are never returned');
  const Seed = require('../../models/JudgeSandboxSeed'), Pair = require('../../models/JudgeSandboxPair'), Account = require('../../models/Account');
  const Landlord = require('../../models/Landlord'), Tenant = require('../../models/Tenant'), Property = require('../../models/Property'), Unit = require('../../models/Unit');
  const Policy = require('../../models/LandlordPolicy'), Vendor = require('../../models/Vendor'), Identity = require('../../models/VendorIdentity');
  const ledger = require('../ledger/ledger.service'), bcrypt = require('bcryptjs'), manifestHash = hash(manifest), count = manifest.assignedPairs + manifest.sparePairs;
  if (roster) require('./operatorInput.service').validateRoster(roster, count);
  const old = await Seed.findById('judge-core-v1').lean();
  if (old) {
    if (old.manifestHash !== manifestHash || old.state !== 'ready') throw error('service_unavailable');
    if (await Pair.countDocuments({ active: true, fixtureVersion: manifestHash }) !== count) throw error('service_unavailable');
    return { alreadySeeded: true, manifestHash, pairCount: count, realDeposits: 0 };
  }
  if (await Account.exists({}) || await Pair.exists({}) || await require('../../models/MaintenanceRequest').exists({})) throw error('service_unavailable');
  await Promise.all(mongoose.modelNames().map(name => mongoose.model(name).init()));
  try { await Seed.create({ _id: 'judge-core-v1', manifestHash, authorizationRef: manifest.authorizationRef, pairCount: count, state: 'starting',
    ...(operatorBinding ? { operatorBinding } : {}) }); }
  catch (e) { if (e.code === 11000) throw error('run_busy');throw e; }
  try {
    for (let ordinal = 1; ordinal <= count; ordinal++) {
      const privateInputs = await credentialsForPair(ordinal);
      if (!privateInputs || !['landlord', 'tenant'].every(role => typeof privateInputs[role] === 'string' && Buffer.byteLength(privateInputs[role]) >= 12 && Buffer.byteLength(privateInputs[role]) <= 72)) throw error('invalid_input');
      const llEmail = roster ? roster.pairs[ordinal - 1].landlordEmail : `judge-${ordinal}-landlord@example.invalid`;
      const ttEmail = roster ? roster.pairs[ordinal - 1].tenantEmail : `judge-${ordinal}-tenant@example.invalid`;
      const hashes = await Promise.all(['landlord', 'tenant'].map(role => bcrypt.hash(privateInputs[role], 12)));
      let pair;
      await connection.transaction(async session => {
        const [llAccount, ttAccount] = await Account.create([{ email: llEmail, hashedPassword: hashes[0], emailVerifiedAt: new Date() }, { email: ttEmail, hashedPassword: hashes[1], emailVerifiedAt: new Date() }], { session, ordered: true });
        const [landlord] = await Landlord.create([{ accountId: llAccount._id, email: llEmail, firstName: 'Judge', lastName: String(ordinal), role: 'landlord', status: 'active', paymentMode: 'platform' }], { session });
        const [property] = await Property.create([{ landlordId: landlord._id, name: 'Synthetic Maple Court ' + ordinal, address: ordinal + ' Synthetic Demo Lane, Toronto' }], { session });
        const [unit] = await Unit.create([{ propertyId: property._id, unitNumber: 'Demo ' + ordinal, isOccupied: true, status: 'Rented' }], { session });
        const [tenant] = await Tenant.create([{ accountId: ttAccount._id, email: ttEmail, firstName: 'Judge', lastName: String(ordinal), role: 'tenant', status: 'active', isVerified: true, landlord: landlord._id, unit: unit._id }], { session });
        await Unit.updateOne({ _id: unit._id }, { $set: { tenantId: tenant._id } }, { session });
        await Property.updateOne({ _id: property._id }, { $set: { units: [unit._id] } }, { session });
        await Landlord.updateOne({ _id: landlord._id }, { $set: { properties: [property._id] } }, { session });
        const p = manifest.initialPolicy;
        await Policy.create([{ landlordId: landlord._id, policyRevision: 1, defaultQuota: p.defaultQuotaMinor / 100, allowAutopilotForLowSeverity: p.lowAutopilot,
          allowAutopilotForMediumSeverity: p.mediumAutopilot, autoAdvanceOnVendorDecline: p.autoContact, maxOutreachAttempts: p.maxVendors, allowQuoteClarification: p.quoteClarification,
          requireApprovalOverQuota: true, requireApprovalForFirstTimeVendor: true, requireApprovalForExternalSearch: true }], { session });
        const vendors = [], identities = [];
        for (let n = 1; n <= 2; n++) {
          const email = `judge-${ordinal}-vendor-${n}@example.invalid`;
          const [identity] = await Identity.create([{ identityKey: email, emailNormalized: email, displayName: `Simulated Plumbing ${ordinal}-${n}` }], { session });
          const [vendor] = await Vendor.create([{ landlordId: landlord._id, identityId: identity._id, name: `Simulated Plumbing ${ordinal}-${n}`, email,
            category: 'Plumbing', specialties: ['Plumbing'], categories: ['Plumbing'], city: 'Toronto', serviceArea: 'Toronto', serviceAreas: ['Toronto'], source: 'preset',
            verificationStatus: 'trusted', operatingHours: require('../vendor/vendorHours').normalizeHours({ preset: 'always' }), emergencyAvailable: false, averageCost: n === 1 ? 220 : 225,
            rating: n === 1 ? 4.9 : 4.7, reliabilityScore: 95, insuranceVerified: true, licenseVerified: true,
            notes: 'SYNTHETIC fixture; trust/insurance/license flags describe this simulated roster, not a verified real contractor.' }], { session });
          vendors.push(vendor._id);identities.push(identity._id);
        }
        [pair] = await Pair.create([{ ordinal, label: 'Judge pair ' + ordinal, landlordId: landlord._id, tenantId: tenant._id, propertyId: property._id,
          unitId: unit._id, vendorIds: vendors, identityIds: identities, active: false, spare: ordinal > manifest.assignedPairs, fixtureVersion: manifestHash }], { session });
      });
      const amount = manifest.syntheticOpeningWalletMinor;
      if (amount) await ledger.postEntry({ landlordId: pair.landlordId, idempotencyKey: 'judge-core-synthetic-opening:' + id(pair), type: 'adjustment', amountCents: amount,
        lines: [{ account: ledger.account.available(pair.landlordId), direction: 'debit', amountCents: amount }, { account: ledger.account.funding(), direction: 'credit', amountCents: amount }],
        provider: 'manual', providerStatus: 'none', actor: 'system', memo: 'SYNTHETIC opening journal only. No deposit, transfer, cash or bank receipt.', cacheUpdate: { available: amount } });
      else await ledger.ensureLedger(pair.landlordId);
    }
    await connection.transaction(async session => {
      await Pair.updateMany({ fixtureVersion: manifestHash, active: false }, { $set: { active: true } }, { session });
      await Seed.updateOne({ _id: 'judge-core-v1', manifestHash, state: 'starting' }, { $set: { state: 'ready', finishedAt: new Date() } }, { session });
    });
    return { alreadySeeded: false, manifestHash, pairCount: count, syntheticOpeningPerPairMinor: manifest.syntheticOpeningWalletMinor, realDeposits: 0 };
  } catch (e) { await Seed.updateOne({ _id: 'judge-core-v1', state: 'starting' }, { $set: { state: 'failed' } });throw e; }
}
function makePrivateCredentials(count) {
  return Array.from({ length: count }, (_, i) => ({ ordinal: i + 1, landlord: crypto.randomBytes(24).toString('base64url'), tenant: crypto.randomBytes(24).toString('base64url') }));
}
module.exports = { seedFixtures, validateManifest, syntheticDatabase, makePrivateCredentials };
