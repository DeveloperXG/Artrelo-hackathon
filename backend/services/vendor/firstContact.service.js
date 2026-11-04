const mongoose = require('mongoose');
const Request = require('../../models/MaintenanceRequest');
const Policy = require('../../models/LandlordPolicy');
const Contact = require('../../models/FirstContactDecision');
const Audit = require('../../models/AgentActionLog');
const Outreach = require('../../models/VendorOutreach');
const Vendor = require('../../models/Vendor');
const Appointment = require('../../models/Appointment');
const { evaluateAutopilot } = require('./autopilotPolicy.service');
const { checkpointBasis, screenCandidate, legacyEvidence } = require('./routingCheckpoint.service');
const { routingDigest } = require('../ai/triageReceipt.service');
const { stable, values } = require('../policy/policyWrite.service');
const { hash } = require('../iris/contract.service');
const stopped = message => Object.assign(new Error(message || 'Initial contact changed. Review the request before trying again.'), { code: 'contact_authorization_changed', statusCode: 409 });
function contactBasis(request, candidate) {
  const basis = checkpointBasis(request, candidate, candidate.priceEstimate);
  return hash(stable({ candidateKey: candidate.candidateKey, ...basis, routing: routingDigest(request),
    reopenedContactReview: request.initialRouting?.requiresContactReview === true,
    approval: candidate.contactApproval || null, selection: candidate.manualSelection || null }));
}
function createFirstContact({ Requests = Request, Policies = Policy, Contacts = Contact, Logs = Audit, Outreaches = Outreach, Vendors = Vendor, Appointments = Appointment, connection = mongoose.connection,
  now = () => new Date(), beforePolicyFence = async () => {}, afterPolicyFence = async () => {} } = {}) {
  async function claim({ requestId, landlordId, candidateKey, mode, actorUserId = null, initialRoutingToken = null }) {
    if (!['policy_auto_start', 'human_contact'].includes(mode)) throw stopped();
    if (mode === 'human_contact' && String(actorUserId) !== String(landlordId)) throw stopped('The signed-in manager must authorize this contact.');
    const result = await connection.transaction(async session => {
      const filter = { _id: requestId, landlordId, status: { $in: ['queued', 'approved'] }, archivedAt: null, vendorId: null, selectedVendorId: null };
      if (mode === 'policy_auto_start') {
        if (!initialRoutingToken) throw stopped('The initial routing claim is no longer active.');
        Object.assign(filter, { 'initialRouting.status': 'processing', 'initialRouting.leaseToken': initialRoutingToken, 'initialRouting.leaseUntil': { $gt: now() } });
      }
      const fenced = await Requests.updateOne(filter, { $inc: { policyCheckpointFence: 1 } }, { session });
      if (!fenced.matchedCount) throw stopped();
      const request = await Requests.findOne({ _id: requestId, landlordId }).session(session).lean();
      require('../request/requestWorkflow.service').assertContactAllowed(request);
      if (mode === 'policy_auto_start' && (request.agentPaused || request.initialRouting?.requiresContactReview)) throw stopped('Review this request before automatic contact.');
      const snapshot = request.vendorRecommendationSnapshot, candidate = snapshot?.candidateLedger?.find(c => c.candidateKey === candidateKey) || snapshot?.recommendations?.find(c => c.candidateKey === candidateKey);
      if (!candidate || !['approved_for_contact', 'selected'].includes(candidate.state)) throw stopped('The current candidate is not approved for contact.');
      if (await Appointments.exists({ requestId, landlordId, status: { $in: ['proposed', 'awaiting_vendor', 'awaiting_tenant', 'scheduled', 'work_verifying', 'in_review', 'disputed'] } }).session(session)) throw stopped('An existing visit must be resolved before initial contact.');
      // Advance, replacement and resend remain their existing separate paths.
      if (await Outreaches.exists({ requestId, landlordId }).session(session)) return { notInitial: true, record: null };
      if (mode === 'policy_auto_start') {
        const vendor = candidate.vendorId ? await Vendors.findOne({ _id: candidate.vendorId, landlordId, status: 'active', source: { $in: ['preset', 'manual_dispatch'] }, isDemoVendor: { $ne: true }, verificationStatus: 'trusted' }).session(session).lean() : null;
        if (!vendor?.email) throw stopped('The vendor is no longer available for automatic contact.');
      }
      const basisHash = contactBasis(request, candidate), scope = { landlordId, requestId, candidateKey, basisHash, mode };
      const passed = await Contacts.findOne({ ...scope, state: 'permitted' }).session(session).lean();
      if (passed) return { record: passed, reused: true };
      // Same policy row as ordinary Policy CAS and Iris confirmation. A Mongo
      // conflict retries the whole decision against one actual policy version.
      await beforePolicyFence({ request, session });
      const policy = await Policies.findOneAndUpdate({ landlordId }, { $inc: { checkpointFence: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true, session, lean: true });
      await afterPolicyFence({ policy, request, session });
      const policyRevision = policy.policyRevision ?? 0;
      const prior = await Contacts.findOne({ ...scope, policyRevision }).session(session).lean();
      if (prior) return { record: prior, reused: true };
      let allowed = true, reasonCode = 'authenticated_contact_command';
      if (mode === 'human_contact') {
        // The authenticated approve/send command is actual human authority.
        // An autopilot flag is never required for that existing manual path.
        if (candidate.contactApproval?.status !== 'approved' && candidate.manualSelection?.status !== 'selected') throw stopped('Approve vendor contact before sending outreach.');
      } else {
        const screened = screenCandidate({ request, policy, candidate, previousSnapshot: snapshot, vendorTypeNeeded: request.vendorTypeNeeded, eligibleCount: 1, lowestEligibleCost: candidate.priceEstimate?.amountHigh ?? 0, now: now() });
        const gate = evaluateAutopilot({ request, policy, candidate, decision: screened.decision });
        allowed = gate.allowed;reasonCode = gate.reasonCode;
        if (allowed) {
          const vendor = candidate.vendorId ? await Vendors.findOne({ _id: candidate.vendorId, landlordId, status: 'active', source: { $in: ['preset', 'manual_dispatch'] }, isDemoVendor: { $ne: true }, verificationStatus: 'trusted' }).session(session).lean() : null;
          if (!vendor?.email) { allowed = false;reasonCode = 'vendor_not_contactable'; }
        }
      }
      const basis = checkpointBasis(request, candidate, candidate.priceEstimate);
      const history = snapshot.routingCheckpoints || legacyEvidence(snapshot, request, candidate, candidate.priceEstimate);
      const priorScreening = history.filter(r => r.state === 'passed' && r.candidateKey === candidateKey && r.basisHash === basis[r.stage]);
      const auditId = new mongoose.Types.ObjectId(), decisionId = new mongoose.Types.ObjectId();
      const authoritySource = mode === 'human_contact' ? { kind: 'authenticated_contact_command', actorSubjectId: String(actorUserId), priorContactApproval: candidate.contactApproval || null, manualSelection: candidate.manualSelection || null }
        : { kind: 'policy_auto_start', policyRevision, initialClaimPresent: true };
      let record;
      try {
        [record] = await Contacts.create([{ _id: decisionId, ...scope, policyRevision, policyValues: values(policy), state: allowed ? 'permitted' : 'refused', reasonCode, auditId,
          actorSubjectId: actorUserId, authoritySource, priorScreening, evaluatedAt: now() }], { session });
        await Logs.create([{ _id: auditId, landlordId, requestId, actor: mode === 'human_contact' ? 'landlord' : 'system', actionType: allowed ? 'initial_contact_authorized' : 'initial_contact_refused',
          summary: allowed ? 'Initial vendor contact authorized; delivery is a separate action.' : 'Initial automatic contact was not authorized under the current Policy.',
          input: { candidateKey, mode, basisHash }, output: { decisionId: String(decisionId), policyRevision, permitted: allowed, reasonCode }, metadata: { authoritySource, priorScreening } }], { session });
      } catch {
        throw Object.assign(new Error('Contact authorization could not be recorded. No outreach was started.'), { code: 'contact_audit_unavailable', statusCode: 503 });
      }
      return { record: record.toObject(), reused: false };
    });
    if (result.record && result.record.state !== 'permitted') throw Object.assign(stopped('Current Policy requires manager approval before this initial contact.'), { code: result.record.reasonCode, decisionId: String(result.record._id) });
    return result;
  }
  return { claim };
}
module.exports = { createFirstContact, contactBasis, ...createFirstContact() };
