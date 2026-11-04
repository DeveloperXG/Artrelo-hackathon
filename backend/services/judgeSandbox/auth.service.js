const { error, id } = require('./contract.service');
function createPairAuthorizer({ Landlords = require('../../models/Landlord'), Tenants = require('../../models/Tenant'),
  Accounts = require('../../models/Account'), Pairs = require('../../models/JudgeSandboxPair'),
  Units = require('../../models/Unit'), Properties = require('../../models/Property'), Vendors = require('../../models/Vendor') } = {}) {
  return async user => {
    const landlordRole = ['landlord', 'property_manager', 'admin'].includes(user?.role), tenantRole = ['tenant', 'co-tenant', 'primary_tenant'].includes(user?.role);
    if (!user?.id || !landlordRole && !tenantRole) throw error('forbidden_role');
    const profile = await (landlordRole ? Landlords : Tenants).findById(user.id).select('_id accountId role status landlord unit').lean();
    if (!profile || profile.status !== 'active' || (profile.role || (landlordRole ? 'landlord' : 'tenant')) !== user.role || user.accountId && id(profile.accountId) !== id(user.accountId)) throw error('auth_expired');
    if (!await Accounts.exists({ _id: profile.accountId, status: 'active' })) throw error('auth_expired');
    const pair = await Pairs.findOne({ [landlordRole ? 'landlordId' : 'tenantId']: profile._id, active: true }).lean();
    if (!pair) throw error('record_not_found');
    const [unit, property, tenant, vendors] = await Promise.all([
      Units.findOne({ _id: pair.unitId, propertyId: pair.propertyId, archivedAt: null }).select('_id').lean(),
      Properties.findOne({ _id: pair.propertyId, landlordId: pair.landlordId, archivedAt: null }).select('_id').lean(),
      Tenants.findOne({ _id: pair.tenantId, landlord: pair.landlordId, unit: pair.unitId, status: 'active' }).select('_id').lean(),
      Vendors.find({ _id: { $in: pair.vendorIds }, landlordId: pair.landlordId, identityId: { $in: pair.identityIds } }).select('_id identityId').lean()
    ]);
    if (!unit || !property || !tenant || vendors.length !== pair.vendorIds.length || vendors.length !== pair.identityIds.length || new Set(vendors.map(v => id(v.identityId))).size !== vendors.length) throw error('record_not_found');
    return Object.freeze({ pair, role: landlordRole ? 'landlord' : 'tenant', profileRole: user.role, actorId: id(profile), accountId: id(profile.accountId) });
  };
}
module.exports = { createPairAuthorizer };
