const Request = require('../../models/MaintenanceRequest');
const Outreach = require('../../models/VendorOutreach');
const Checkpoint = require('../../models/PolicyCheckpoint');
const Contact = require('../../models/FirstContactDecision');
const { resolveQuotaLimit } = require('../vendor/routingDecision.service');
const { quotaSource } = require('../quotes/quoteCheckpoint.service');
const { resolveOutreachTier } = require('../vendor/vendorOutreachPolicy.service');
const { checkpointBasis, legacyEvidence } = require('../vendor/routingCheckpoint.service');
const { stable } = require('../policy/policyWrite.service');
const { hash, error, iso, safeText, validate } = require('./contract.service');
const { cents } = require('./readContext.service');
const querySession = (q, session) => session ? q.session(session) : q;
function createImpact({ Requests = Request, Outreaches = Outreach, Checkpoints = Checkpoint, Contacts = Contact, now = () => new Date() } = {}) {
  async function capture(auth, policy, patch, { session = null, registry = null, scope = 'impact', turnRef = 'impact' } = {}) {
    const at = iso(now());
    const requests = await querySession(Requests.find({ landlordId: auth.subjectId, status: { $nin: ['completed', 'cancelled', 'rejected'] }, archivedAt: null }).sort({ _id: 1 }).limit(201), session).lean();
    if (requests.length > 200) throw error('impact_incomplete', 'There are too many active requests to establish a complete safe preview. Review Policy directly.');
    const rows = [], signatures = [];
    const changedFields = Object.keys(patch).filter(field => stable(policy?.[field] ?? null) !== stable(patch[field]));
    for (const request of requests) {
      const requestId = String(request._id), filter = { requestId: request._id, landlordId: auth.subjectId };
      const snapshot = request.vendorRecommendationSnapshot;
      const candidate = snapshot?.candidateLedger?.find(x => x.candidateKey === snapshot.decision?.candidateKey) || snapshot?.recommendations?.[0];
      const currentCandidateKey = candidate?.candidateKey || (candidate ? `${candidate.providerName || 'manual'}__${candidate.providerVendorId || candidate.vendorId || 'unknown'}` : null);
      const currentBasis = candidate ? checkpointBasis(request, candidate, candidate.priceEstimate) : null;
      const [outreaches, checks, contacts] = await Promise.all([
        querySession(Outreaches.find(filter).sort({ _id: 1 }), session).lean(),
        querySession(Checkpoints.find(filter).sort({ evaluatedAt: 1, _id: 1 }), session).lean(),
        querySession(Contacts.find(filter).sort({ evaluatedAt: 1, _id: 1 }), session).lean(),
      ]);
      const observedVersion = hash(stable({ id: requestId, updatedAt: iso(request.updatedAt), status: request.status, quotaOverride: request.quotaOverride,
        routingStatus: request.routingStatus, vendorId: request.vendorId, selectedVendorId: request.selectedVendorId,
        routingCheckpoints: snapshot?.routingCheckpoints, currentCandidateKey, currentBasis,
        quotes: outreaches.map(x => [String(x._id), x.currentQuoteRevision, x.status, x.quoteRevisions?.map(y => y.hash)]),
        checks: checks.map(x => [String(x._id), x.basisHash, x.state]), contacts: contacts.map(x => [String(x._id), x.basisHash, x.state]) }));
      const requestRef = registry ? registry.reference('req', requestId, scope) : 'req_' + requestId;
      let requestEvidenceRef = 'ev_' + requestId;
      if (registry) requestEvidenceRef = registry.source({ ref: 'placeholder', kind: 'request', recordId: requestId, requestId, routeKind: 'request_current', publicRouteKind: null, lastVerifiedAt: null, revision: null, hash: observedVersion, occurredAt: at, label: safeText(request.issueTitle || 'Maintenance request', 120) }, { model: 'request', id: requestId }, scope, turnRef);
      const add = (field, checkpoint, disposition, reasonCode, reasonLabel, extra = {}) => {
        const row = validate('ImpactRow', { requestRef, requestId, requestTitle: safeText(request.issueTitle || 'Maintenance request', 160), requestEvidenceRef, field, checkpoint, disposition, reasonCode, reasonLabel,
          oldEffectiveMinor: null, newEffectiveMinor: null, quotaSource: 'unknown', basisRef: null, policyRevisionAtPass: null, nextActor: 'system', observedVersion, observedAt: at, ...extra });
        rows.push(row);
        signatures.push({ requestId, field, checkpoint, disposition, reasonCode, oldEffectiveMinor: row.oldEffectiveMinor, newEffectiveMinor: row.newEffectiveMinor, quotaSource: row.quotaSource, policyRevisionAtPass: row.policyRevisionAtPass, observedVersion });
      };
      for (const field of changedFields) {
        if (field === 'defaultQuota') {
          const source = quotaSource(policy || {}, request), oldLimit = cents(resolveQuotaLimit(policy || {}, request)), newLimit = cents(resolveQuotaLimit({ ...(policy || {}), ...patch }, request));
          const amount = { oldEffectiveMinor: oldLimit, newEffectiveMinor: newLimit, quotaSource: source };
          const screening = Array.isArray(snapshot?.routingCheckpoints) ? snapshot.routingCheckpoints : candidate ? legacyEvidence(snapshot, request, candidate, candidate.priceEstimate) : [];
          const estimatePassed = screening.find(x => x.stage === 'estimate' && x.state === 'passed' && x.candidateKey === currentCandidateKey && x.basisHash === currentBasis?.estimate);
          if (source !== 'default' && source !== 'unset') {
            add(field, 'estimate', 'shadowed', 'quota_override', 'A recorded more-specific quota controls this request.', amount);
            add(field, 'vendor_quote', 'shadowed', 'quota_override', 'The default does not replace the recorded more-specific quote limit.', amount);
            continue;
          }
          if (estimatePassed) add(field, 'estimate', 'retained_passed', 'checkpoint_passed', 'An already passed estimate check is retained for its recorded basis.', { ...amount, policyRevisionAtPass: estimatePassed.policyRevision ?? null });
          else if (outreaches.length || request.vendorId || request.selectedVendorId) add(field, 'estimate', 'legacy_unknown', 'legacy_evidence_missing', 'Earlier estimate passage is not established by the available records.', amount);
          else add(field, 'estimate', 'eligible_next', 'estimate_pending', 'An unpassed future estimate check uses the applicable current rule; no human decision is auto-approved.', { ...amount, nextActor: 'system' });
          const current = outreaches.flatMap(o => (o.quoteRevisions || []).filter(q => q.revision === o.currentQuoteRevision).map(q => ({ o, q })));
          if (!current.length) add(field, 'vendor_quote', 'eligible_next', 'quote_not_submitted', 'No quote has been submitted; its future quote check uses the new applicable limit.', { ...amount, nextActor: 'vendor' });
          for (const { o, q } of current) {
            const passed = checks.find(x => String(x.subjectId) === String(o._id) && x.quoteRevision === q.revision && x.quoteHash === q.hash && x.state === 'passed');
            if (passed) add(field, 'vendor_quote', 'retained_passed', 'checkpoint_passed', 'The passed check for this exact quote is retained; a different quote basis gets its own check.', { ...amount, policyRevisionAtPass: passed.policyRevision });
            else add(field, 'vendor_quote', 'eligible_next', 'quote_review_pending', 'An unpassed quote check may use the current limit; an outstanding human financial decision is not approved by this change.', { ...amount, nextActor: 'landlord' });
          }
        } else {
          const requiredTier = field === 'allowAutopilotForLowSeverity' ? 'low' : 'normal';
          const tier = resolveOutreachTier(request);
          if (tier !== requiredTier) { add(field, 'contact', 'not_applicable', 'other_severity', 'This start setting does not govern this request severity or next-vendor advance.');continue; }
          const passed = contacts.find(x => x.state === 'permitted' && x.candidateKey === currentCandidateKey);
          if (passed) add(field, 'contact', 'retained_passed', 'contact_already_claimed', 'An already authorized initial contact retains its recorded permission and policy revision.', { policyRevisionAtPass: passed.policyRevision });
          else if (outreaches.length || request.vendorId || request.selectedVendorId) add(field, 'contact', 'legacy_unknown', 'legacy_evidence_missing', 'Earlier contact permission has no recorded policy version; current settings cannot fill that history.');
          else add(field, 'contact', 'eligible_next', requiredTier === 'low' ? 'contact_not_started_low' : 'contact_not_started_medium', 'This setting applies at a future eligible initial-contact check; all other reviews still apply.');
        }
      }
    }
    return { rows, hash: hash(stable(signatures)), observedAt: at, activeCount: requests.length, changedFields };
  }
  return { capture };
}
module.exports = { createImpact };
