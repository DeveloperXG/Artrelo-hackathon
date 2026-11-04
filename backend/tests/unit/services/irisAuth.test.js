const assert = require('assert/strict');
const { createAuthorizer } = require('../../../services/iris/auth.service');
let profile = { _id: 'profile1', accountId: 'account1', status: 'active', role: 'landlord' };
let account = { _id: 'account1' };
const query = get => ({ select: () => ({ lean: async () => get() }) });
const authorize = createAuthorizer({ Profiles: { findOne: () => query(() => profile) }, Accounts: { findOne: () => query(() => account) }, now: () => 1000 });
async function main() {
  for (const role of ['landlord', 'property_manager', 'admin']) {
    profile.role = role;
    assert.deepEqual(await authorize({ id: 'profile1', accountId: 'account1', role, expiresAt: 2000 }), { subjectId: 'profile1', accountId: 'account1', role });
  }
  await assert.rejects(authorize({ id: 'profile1', role: 'tenant' }), { code: 'forbidden' });
  profile.role = 'landlord';
  await assert.rejects(authorize({ id: 'profile1', role: 'landlord', expiresAt: 999 }), { code: 'auth_expired' });
  await assert.rejects(authorize({ id: 'profile1', accountId: 'other-account', role: 'landlord' }), { code: 'auth_expired' });
  await assert.rejects(authorize({ id: 'profile1', role: 'admin' }), { code: 'auth_expired' });
  profile.status = 'inactive';await assert.rejects(authorize({ id: 'profile1', role: 'landlord' }), { code: 'auth_expired' });
  profile.status = 'active';account = null;await assert.rejects(authorize({ id: 'profile1', role: 'landlord' }), { code: 'auth_expired' });
  console.log('Iris fresh profile/account/expiry/role own-scope controls passed.');
}
main().catch(e => { console.error(e);process.exitCode = 1; });
