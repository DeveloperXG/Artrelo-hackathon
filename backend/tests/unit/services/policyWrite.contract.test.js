const assert = require('assert/strict');
const mongoose = require('mongoose');
const Policy = require('../../../models/LandlordPolicy');
const writer = require('../../../services/policy/policyWrite.service');
const contract = require('../../../contracts/iris.v2.json');
const fixtures = require('../../../contracts/iris.v2.fixtures.json');
const { errors } = require('../../../contracts/validate.cjs');
for (const entry of fixtures.cases) assert.equal(errors(contract.$defs[entry.schema], entry.value, contract.$defs).length === 0, entry.valid, entry.name);
for (const value of [0, -1, false, true, NaN, Infinity, {}, [], 'no', '']) {
  if (value === '') continue; // Existing ordinary Policy UI may clear quota.
  assert.throws(() => writer.normalizePatch({ defaultQuota: value }), { code: 'invalid_input' });
}
assert.deepEqual(writer.normalizePatch({ defaultQuota: '250', maxOutreachAttempts: '0', lowFundsThreshold: '0' }), { defaultQuota: 250, maxOutreachAttempts: 0, lowFundsThreshold: 0 });
for (const value of [null, '', true, 2.5, 6]) assert.throws(() => writer.normalizePatch({ maxOutreachAttempts: value }));
assert.throws(() => writer.normalizePatch({ landlordId: new mongoose.Types.ObjectId() }));
assert.throws(() => writer.normalizePatch({ categoryQuotas: { plumbing: 0 } }));
const legacy = writer.presentPolicy({ _id: new mongoose.Types.ObjectId(), landlordId: new mongoose.Types.ObjectId(), defaultQuota: 300 });
assert.equal(legacy.maxOutreachAttempts, 3);
assert.equal(legacy.autoAdvanceOnVendorDecline, true);
assert.deepEqual(legacy.categoryQuotas, {});
assert.equal(legacy.policyRevision, 0);
assert.deepEqual(errors(contract.$defs.PolicyDTO, legacy, contract.$defs), []);
const policy = new Policy({ landlordId: new mongoose.Types.ObjectId(), defaultQuota: 300 });
const raw = policy.toObject({ flattenMaps: true });
const changedFence = { ...raw, checkpointFence: 99, updatedAt: new Date() };
assert.equal(writer.policyHash(raw), writer.policyHash(changedFence), 'internal fence/time do not invalidate a business policy basis');
assert.notEqual(writer.policyHash(raw), writer.policyHash({ ...raw, defaultQuota: 250 }));
assert.equal(writer.stable({ unitQuotas: { b: 2, a: 1 } }), writer.stable({ unitQuotas: { a: 1, b: 2 } }));
console.log('Policy writer boundary / legacy DTO / frozen v2 fixtures passed.');
