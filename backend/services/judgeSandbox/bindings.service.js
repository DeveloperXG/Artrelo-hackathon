const mongoose = require('mongoose');
const { error, id } = require('./contract.service');
const { createPairAuthorizer } = require('./auth.service');
const { createSimulationScope } = require('./simulationScope.service');
function createBindings({ connection = mongoose.connection, authorize = createPairAuthorizer(), now = () => new Date() } = {}) {
  if (connection !== mongoose.connection || !/^artrelo_(?:iris_judge_|judge_)[a-z0-9_]+_test$/.test(connection.name || '')) throw error('sandbox_disabled');
  const Requests = require('../../models/MaintenanceRequest'), Vendors = require('../../models/Vendor'), Pairs = require('../../models/JudgeSandboxPair');
  const Identity = require('../../models/VendorIdentity'), Deliveries = require('../../models/JudgeSandboxDelivery');
  async function verifyPair(ctx) {
    const actual = await authorize({ id: ctx.actorId, accountId: ctx.accountId, role: ctx.profileRole || ctx.role });
    if (id(actual.pair) !== id(ctx.pair)) throw error('record_not_found');return actual.pair;
  }
  async function verifyVendor(pair, requestId, vendorId) {
    if (!pair.vendorIds.some(v => id(v) === id(vendorId))) throw error('record_not_found');
    const [fresh, request, vendor] = await Promise.all([
      Pairs.findOne({ _id: pair._id, active: true, landlordId: pair.landlordId, tenantId: pair.tenantId }).lean(),
      Requests.findOne({ _id: requestId, landlordId: pair.landlordId, tenantId: pair.tenantId, unitId: pair.unitId, propertyId: pair.propertyId, archivedAt: null }).lean(),
      Vendors.findOne({ _id: vendorId, landlordId: pair.landlordId, identityId: { $in: pair.identityIds } }).lean()
    ]);
    if (!fresh || !request || !vendor || !fresh.vendorIds.some(v => id(v) === id(vendorId))) throw error('record_not_found');
    const identity = await Identity.findOne({ _id: vendor.identityId, mergedInto: null }).select('_id').lean();
    if (!identity) throw error('record_not_found');return { request, vendor };
  }
  const scope = createSimulationScope({ verifyPair, verifyVendor, acceptDelivery: async ({ pair, outreachId, requestId, landlordId, vendorId }) => {
    if (id(pair.landlordId) !== landlordId) throw error('record_not_found');
    const { request, vendor } = await verifyVendor(pair, requestId, vendorId);
    require('../request/requestWorkflow.service').assertContactAllowed(request);
    const outreach = await require('../../models/VendorOutreach').findOne({ _id: outreachId, requestId, landlordId, vendorId, identityId: vendor.identityId }).select('_id').lean();
    if (!outreach) throw error('record_not_found');
    const receipt = await Deliveries.findOneAndUpdate({ outreachId, pairId: pair._id, landlordId, requestId, vendorId, identityId: vendor.identityId },
      { $setOnInsert: { channel: 'simulation', realDelivery: false, acceptedAt: now() } }, { upsert: true, new: true, runValidators: true }).lean();
    return { receiptRef: id(receipt) };
  } });
  return { ...scope, verifyPair, verifyVendor };
}
module.exports = { createBindings };
