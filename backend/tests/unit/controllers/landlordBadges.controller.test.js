const assert = require('assert/strict');
const LedgerEntry = require('../../../models/LedgerEntry');
const ApprovalRequest = require('../../../models/ApprovalRequest');
const Appointment = require('../../../models/Appointment');
const LandlordLedger = require('../../../models/LandlordLedger');
const Landlord = require('../../../models/Landlord');
const MaintenanceRequest = require('../../../models/MaintenanceRequest');
const { createSimulationScope } = require('../../../services/judgeSandbox/simulationScope.service');

let entries = [], arrears = 0, directDue = 0;
const now = new Date('2026-11-04T00:00:00Z');
const row = (extra = {}) => ({ landlordId: 'll1', type: 'payout', provider: 'offline',
  providerStatus: 'pending_manual', identityId: 'vendor-identity-1', createdAt: now, ...extra });
function matches(entry, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$nor') return value.every(part => !matches(entry, part));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('$in' in value) return value.$in.map(String).includes(String(entry[key]));
      if ('$gt' in value) return entry[key] > value.$gt;
    }
    return String(entry[key]) === String(value);
  });
}
LedgerEntry.countDocuments = async query => entries.filter(entry => matches(entry, query)).length;
ApprovalRequest.countDocuments = async () => 2;
Appointment.countDocuments = async () => 0;
MaintenanceRequest.countDocuments = async () => 0;
LandlordLedger.findOne = () => ({ select: () => ({ lean: async () => ({ arrears }) }) });
Landlord.findById = () => ({ select: () => ({ lean: async () => ({ paymentMode: 'platform' }) }) });
require('../../../services/request/decisionQueue.service').listRoutingDecisions = async () => [{}];
require('../../../services/vendor/vendorQuoteDismissal.service').expireOrphanedQuoteApprovals = async () => {};
require('../../../services/ledger/directPayment.service').countDirectPaymentsDue = async () => directDue;
const { getBadgeCounts } = require('../../../controllers/landlord.controller');

const pair = { _id: 'pair-1', landlordId: 'll1', tenantId: 'tenant-1', identityIds: ['vendor-identity-1'] };
const scope = createSimulationScope({ verifyPair: async () => pair,
  verifyVendor: async () => {}, acceptDelivery: async () => ({ receiptRef: 'inert-test-only' }) });
async function badges({ landlordId = 'll1', seen = false, hints = false } = {}) {
  const req = { user: { id: landlordId }, query: seen ? { walletSeenAt: '2026-11-03T00:00:00Z' } : {} };
  if (hints) { req.query.sandbox = 'true';req.judgeSandbox = true; }
  const res = { code: 200, status(code) { this.code = code;return this; }, json(body) { this.body = body;return this; } };
  await getBadgeCounts(req, res);assert.equal(res.code, 200);assert.equal(res.body.success, true);
  return res.body.data;
}
(async () => {
  entries = [row()];
  assert.equal((await badges()).wallet, 1, 'ordinary pending manual payments still require attention');
  assert.equal((await badges({ hints: true })).wallet, 1, 'caller hints cannot masquerade as a trusted judge scope');
  const synthetic = await scope.withPair({}, () => badges());
  assert.equal(synthetic.wallet, 0, 'verified judge synthetic payout has no available payment action');
  assert.deepEqual(synthetic.walletBreakdown, { stuck: 0, unread: 0, directDue: 0 });
  assert.equal(synthetic.decisions, 3, 'approval and routing counts remain authoritative');
  assert.equal((await scope.withPair({}, () => badges({ seen: true }))).wallet, 0,
    'the same synthetic payout must not reappear as unread activity');
  assert.equal((await badges()).wallet, 1, 'async pair context does not leak after the request');

  entries = [row(), row({ identityId: 'another-identity' }), row({ provider: 'stripe' }),
    row({ providerStatus: 'failed' }), row({ providerStatus: 'awaiting_funds' }),
    row({ type: 'hold_release', provider: 'internal', providerStatus: 'none' }), row({ landlordId: 'll2' })];
  arrears = 50;directDue = 2;
  const ordinary = await badges({ seen: true });
  const judge = await scope.withPair({}, () => badges({ seen: true }));
  assert.deepEqual(ordinary.walletBreakdown, { stuck: 8, unread: 6, directDue: 2 });
  assert.deepEqual(judge.walletBreakdown, { stuck: 7, unread: 5, directDue: 2 },
    'exclude only the scoped offline pending manual payout, retaining other identities, rails, failures and work');
  assert.equal(ordinary.wallet, 14);assert.equal(judge.wallet, 12);
  assert.deepEqual(Object.keys(judge).sort(), Object.keys(ordinary).sort(), 'API shape is unchanged');
  arrears = 0;directDue = 0;
  assert.equal((await scope.withPair({}, () => badges({ landlordId: 'll2' }))).wallet, 1,
    'a verified pair cannot suppress another landlord\'s counts');
  console.log('PASS landlord badges: capability-scoped synthetic payment exclusion, unread parity, ordinary/other-rail/foreign-owner regressions.');
})().catch(error => { console.error(error);process.exitCode = 1; });
