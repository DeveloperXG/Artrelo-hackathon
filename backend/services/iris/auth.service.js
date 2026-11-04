const Landlord = require('../../models/Landlord');
const Account = require('../../models/Account');
const { error } = require('./contract.service');
function createAuthorizer({ Profiles = Landlord, Accounts = Account, now = () => Date.now() } = {}) {
  return async function authorize(user) {
    if (!user?.id || !['landlord', 'property_manager', 'admin'].includes(user.role)) throw error('forbidden', 'Iris is available only for your signed-in landlord profile.');
    if (user.expiresAt && user.expiresAt <= now()) throw error('auth_expired', 'Sign in again to continue.');
    const profile = await Profiles.findOne({ _id: user.id }).select('_id accountId status role').lean();
    if (!profile || profile.status !== 'active' || (profile.role || 'landlord') !== user.role || (user.accountId && String(profile.accountId) !== String(user.accountId))) throw error('auth_expired', 'Sign in again to continue.');
    const account = await Accounts.findOne({ _id: profile.accountId, status: 'active' }).select('_id').lean();
    if (!account) throw error('auth_expired', 'Sign in again to continue.');
    return Object.freeze({ subjectId: String(profile._id), accountId: String(account._id), role: user.role });
  };
}
module.exports = { createAuthorizer, authorize: createAuthorizer() };
