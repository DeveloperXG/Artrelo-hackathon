const { AsyncLocalStorage } = require('async_hooks');
const { error, id } = require('./contract.service');
const scopes = new AsyncLocalStorage(), capabilities = new WeakSet();
// No default registration/environment lookup. Only an explicit isolated
// bootstrap may supply both fresh binding verification and durable receipts.
function createSimulationScope({ verifyPair, verifyVendor, acceptDelivery } = {}) {
  if (![verifyPair, verifyVendor, acceptDelivery].every(fn => typeof fn === 'function')) throw TypeError('Explicit verified simulation capabilities required');
  const capability = Object.freeze({ acceptDelivery });capabilities.add(capability);
  async function withPair(ctx, work) {
    const pair = await verifyPair(ctx);
    return scopes.run(Object.freeze({ capability, pair, requestId: null, vendorId: null, actionId: null, actor: null }), work);
  }
  async function withVendor(ctx, requestId, vendorId, actionId, work) {
    const pair = await verifyPair(ctx);
    await verifyVendor(pair, requestId, vendorId);
    return scopes.run(Object.freeze({ capability, pair, requestId: id(requestId), vendorId: id(vendorId), actionId: id(actionId), actor: 'simulated_vendor' }), work);
  }
  return { withPair, withVendor };
}
async function acceptOutreachDelivery({ outreachId, requestId, landlordId, vendorId }) {
  const scope = scopes.getStore();
  if (!scope || !capabilities.has(scope.capability)) return null;
  if (id(landlordId) !== id(scope.pair.landlordId) || !scope.pair.vendorIds.some(v => id(v) === id(vendorId)) || scope.requestId && scope.requestId !== id(requestId)) throw error('record_not_found');
  // The supplied verifier/receipt writer re-reads current pair, request,
  // vendor and identity scope. No raw token, destination or user body is sent.
  const receipt = await scope.capability.acceptDelivery({ pair: scope.pair, outreachId: id(outreachId), requestId: id(requestId), landlordId: id(landlordId), vendorId: id(vendorId) });
  if (!receipt?.receiptRef) throw error('service_unavailable');
  return { delivered: true, provider: 'judge_simulation', simulated: true, messageId: receipt.receiptRef };
}
function metadataForRecord(row) {
  const scope = scopes.getStore();
  if (!scope || !capabilities.has(scope.capability) || id(row.landlordId) !== id(scope.pair.landlordId) || !row.requestId || scope.requestId && id(row.requestId) !== scope.requestId) return null;
  const vendorAction = row.actor === 'vendor' && scope.actor === 'simulated_vendor' && scope.vendorId;
  const delivery = row.output?.provider === 'judge_simulation';
  if (!vendorAction && !delivery) return null;
  // A vendor refusal can synchronously cause another vendor's delivery. That
  // delivery belongs to its own verified row, not the refusing vendor's scope.
  const deliveryVendor = row.output?.vendorId && scope.pair.vendorIds.some(v => id(v) === id(row.output.vendorId))
    ? id(row.output.vendorId) : 'delivery-only';
  return { version: 1, pairId: id(scope.pair), landlordId: id(row.landlordId), requestId: id(row.requestId),
    vendorId: vendorAction ? scope.vendorId : deliveryVendor, actionId: scope.actionId };
}
function requireVendorScope() {
  const scope = scopes.getStore();
  if (!scope || !capabilities.has(scope.capability) || scope.actor !== 'simulated_vendor' || !scope.requestId || !scope.vendorId) throw error('forbidden_role');
  return Object.freeze({ pairId: id(scope.pair), landlordId: id(scope.pair.landlordId), requestId: scope.requestId, vendorId: scope.vendorId, actionId: scope.actionId });
}
function notificationSimulation(userId) {
  const scope = scopes.getStore();
  return !!scope && capabilities.has(scope.capability) && scope.actor === 'simulated_vendor' &&
    [scope.pair.landlordId, scope.pair.tenantId].some(profile => id(profile) === id(userId));
}
// Presentation only: this verified sandbox has no action for settling a
// synthetic manual payout. Ordinary requests and other ledger work keep
// their normal badge semantics. No caller-supplied flag grants this scope.
function syntheticManualPayoutBadgeExclusion(landlordId) {
  const scope = scopes.getStore();
  if (!scope || !capabilities.has(scope.capability) || id(landlordId) !== id(scope.pair.landlordId) ||
      !Array.isArray(scope.pair.identityIds) || !scope.pair.identityIds.length) return null;
  return { landlordId: id(scope.pair.landlordId), type: 'payout', provider: 'offline', providerStatus: 'pending_manual',
    identityId: { $in: scope.pair.identityIds.map(id) } };
}
module.exports = { createSimulationScope, acceptOutreachDelivery, metadataForRecord, requireVendorScope, notificationSimulation,
  syntheticManualPayoutBadgeExclusion };
