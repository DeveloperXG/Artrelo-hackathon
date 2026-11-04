const Request = require('../../models/MaintenanceRequest');
const Policy = require('../../models/LandlordPolicy');
const Revision = require('../../models/LandlordPolicyRevision');
const Outreach = require('../../models/VendorOutreach');
const Completion = require('../../models/JobCompletion');
const Approval = require('../../models/ApprovalRequest');
const Checkpoint = require('../../models/PolicyCheckpoint');
const Reschedule = require('../../models/BookingReschedule');
const Appointment = require('../../models/Appointment');
const Audit = require('../../models/AgentActionLog');
const Contact = require('../../models/FirstContactDecision');
const { createActivityService } = require('../request/irisActivity.service');
const { presentPolicy, policyHash } = require('../policy/policyWrite.service');
const { contract, validate, error, hash, iso, safeText } = require('./contract.service');
const { humanInstant, slotText, decisionLabel } = require('./display.service');
const actor = value => ({ Landlord: 'landlord', Tenant: 'tenant', Vendor: 'vendor', System: 'system' }[value] || (['landlord', 'tenant', 'vendor', 'system'].includes(value) ? value : 'unknown'));
const cents = value => typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100)) ? Math.round(value * 100) : null;
const money = minor => 'CAD' + (minor / 100).toFixed(2);
const restrictedDescription = value => /\b(backend|frontend|api.?key|jwt|database|secret|system prompt)\b/i.test(String(value || '')) ? 'Description omitted.' : safeText(value, 240);
function createReadContext({ Requests = Request, Policies = Policy, Revisions = Revision, Outreaches = Outreach, Completions = Completion, Approvals = Approval, Checkpoints = Checkpoint, Contacts = Contact, Reschedules = Reschedule, Appointments = Appointment, Logs = Audit, activity = createActivityService(), knowledge, now = () => new Date() } = {}) {
  async function ownRequest(subject, requestId) {
    if (typeof requestId !== 'string' || !/^[a-f0-9]{24}$/i.test(requestId)) throw error('record_not_found', 'This request is not available.');
    const row = await Requests.findOne({ _id: requestId, landlordId: subject }).lean();
    if (!row) throw error('record_not_found', 'This request is not available.');
    return row;
  }
  async function read(tool, args, context) {
    validate('ToolInput_' + tool, args);
    const { auth, registry, turnRef, origin } = context, scope = origin.segmentId, observedAt = iso(now());
    const facts = [], evidence = [];
    const source = (kind, recordId, label, pointer, extra = {}) => {
      const ref = registry.source({ ref: 'placeholder', kind, recordId: String(recordId), requestId: origin.requestContextId,
        routeKind: 'request_current', publicRouteKind: null, lastVerifiedAt: null, revision: null, hash: null, occurredAt: observedAt, label: safeText(label, 120), ...extra }, pointer, scope, turnRef);
      evidence.push(registry.sources.get(ref).evidence); return ref;
    };
    const fact = (code, text, refs, metadata = {}) => {
      const value = registry.fact({ code, text: text.slice(0, 800), evidenceRefs: refs, observedAt }, scope, turnRef, metadata); facts.push(value); return value.factId;
    };
    let data, nextCursor = null, status = 'ok';
    if (tool === 'search_landlord_help') {
      if (args.featureRef !== null) registry.resolve(args.featureRef, 'setting', scope);
      const result = knowledge.search(args.query, args.limit);
      if (result.status === 'stale') return { result: validate('ToolResult_' + tool, { schemaVersion: 2, tool, status: 'unavailable', observedAt, facts: [], evidence: [], data: null, nextCursor: null, truncated: false, errorCode: 'service_unavailable' }), notice: 'stale_guide' };
      if (result.status === 'restricted') return { result: validate('ToolResult_' + tool, { schemaVersion: 2, tool, status: 'forbidden', observedAt, facts: [], evidence: [], data: null, nextCursor: null, truncated: false, errorCode: 'forbidden' }), notice: 'restricted_topic' };
      data = { bundleVersion: knowledge.bundleVersion, articles: result.articles.map(article => {
        const ev = source('help_article', article.articleId, article.title, { model: 'help', articleId: article.articleId, revision: article.articleRevision }, { requestId: null, routeKind: 'help_context', publicRouteKind: 'policy', revision: article.articleRevision, lastVerifiedAt: article.lastVerifiedAt, occurredAt: article.publishedAt });
        const fid = fact('guide_' + article.articleId, article.summary, [ev], { section: 'guide' });
        return { articleRef: ev, articleId: article.articleId, revision: article.articleRevision, title: article.title, lastVerifiedAt: article.lastVerifiedAt, availabilityLabel: 'Published landlord Policy guide', stepFactIds: [fid], relatedArticleRefs: [] };
      }), coverage: result.partial ? 'page' : 'complete' };
    } else if (tool === 'read_policy') {
      const raw = await Policies.findOne({ landlordId: auth.subjectId }).lean();
      const policy = raw ? presentPolicy(raw) : new Policies({ landlordId: auth.subjectId }).toObject({ flattenMaps: true });
      const ev = source('policy_revision', raw?._id || 'unsaved-policy', 'Your current Policy', { model: 'policy', id: raw?._id ? String(raw._id) : null }, { requestId: null, routeKind: 'policy_current', revision: raw ? raw.policyRevision ?? 0 : null, hash: policyHash(raw), occurredAt: iso(raw?.updatedAt) });
      const qualifier = raw ? 'Recorded' : 'Current default (not explicitly saved)';
      const defaultMinor = policy.defaultQuota === null ? null : cents(policy.defaultQuota);
      const displayValue = value => value + (raw ? '' : ' (default, not explicitly saved)');
      fact('policy_default_quota', `${qualifier} default quota: ${defaultMinor === null ? 'not set; human approval required' : money(defaultMinor)}.`, [ev], { section: 'policy', label: 'Default quota', displayValue: displayValue(defaultMinor === null ? 'Not set; human approval required' : money(defaultMinor)) });
      fact('policy_low', `${qualifier} Low-severity autopilot: ${policy.allowAutopilotForLowSeverity ? 'On' : 'Off'}.`, [ev], { section: 'policy', label: 'Low autopilot', displayValue: displayValue(policy.allowAutopilotForLowSeverity ? 'On' : 'Off') });
      fact('policy_medium', `${qualifier} Medium-severity autopilot: ${policy.allowAutopilotForMediumSeverity ? 'On' : 'Off'}.`, [ev], { section: 'policy', label: 'Medium autopilot', displayValue: displayValue(policy.allowAutopilotForMediumSeverity ? 'On' : 'Off') });
      fact('policy_next_vendor', `${qualifier} Auto-contact next vendor: ${policy.autoAdvanceOnVendorDecline ? 'On' : 'Off'}.`, [ev], { section: 'policy', label: 'Auto-contact next vendor', displayValue: displayValue(policy.autoAdvanceOnVendorDecline ? 'On' : 'Off') });
      fact('policy_max_vendors', `${qualifier} Max vendors contacted per request: ${policy.maxOutreachAttempts}${policy.maxOutreachAttempts === 0 ? ' (no automatic vendor contact)' : ''}.`, [ev], { section: 'policy', label: 'Max vendors', displayValue: displayValue(String(policy.maxOutreachAttempts) + (policy.maxOutreachAttempts === 0 ? ' (no automatic vendor contact)' : '')) });
      data = { policyRef: ev, exists: Boolean(raw), revision: raw ? raw.policyRevision ?? 0 : null, updatedAt: iso(raw?.updatedAt), currency: 'CAD', defaultQuotaMinor: defaultMinor, lowAutopilot: policy.allowAutopilotForLowSeverity, mediumAutopilot: policy.allowAutopilotForMediumSeverity,
        otherControls: [{ settingRef: registry.reference('setting', 'autoAdvanceOnVendorDecline', scope), label: 'Auto-contact next vendor', valueLabel: policy.autoAdvanceOnVendorDecline ? 'On' : 'Off', availabilityLabel: 'Read only in Iris' }, { settingRef: registry.reference('setting', 'maxOutreachAttempts', scope), label: 'Max vendors contacted per request', valueLabel: String(policy.maxOutreachAttempts), availabilityLabel: 'Read only in Iris' }], coverage: 'complete' };
    } else {
      if (!origin.requestContextId) throw error('invalid_input', 'Open a request to read its history.');
      const requestId = registry.resolve(args.requestRef, 'req', scope);
      if (requestId !== origin.requestContextId) throw error('record_not_found', 'This request is not available.');
      const request = await ownRequest(auth.subjectId, requestId);
      const filter = { requestId, landlordId: auth.subjectId };
      if (tool === 'read_request_history') {
        const originalCursor = args.cursor === null ? null : registry.resolve(args.cursor, 'history_cursor', scope + ':history');
        const result = await activity.detail(auth.subjectId, requestId, { ...(originalCursor === null ? {} : { cursor: originalCursor }), limit: String(Math.min(args.limit, 8)) });
        data = { requestRef: args.requestRef, status: request.status, events: result.events.map(event => {
          const auditId = event.id.startsWith('audit:') ? event.id.slice(6) : null;
          const ev = source(auditId ? 'audit' : 'request', auditId || requestId, event.title, { model: auditId ? 'audit' : 'request', id: auditId || requestId }, { occurredAt: event.at });
          const label = event.actorLabel || (event.actor === 'Iris' ? 'not established as a human or backend actor by this legacy record' : event.actor || 'Unknown');
          const canonicalActor = ['landlord', 'tenant', 'vendor'].includes(event.actorKind) ? event.actorKind : event.actorKind === 'simulated_vendor' ? 'vendor' : ['automation', 'system'].includes(event.actorKind) ? 'system' : event.actorKind ? 'unknown' : actor(event.actor);
          const fid = fact('history_' + event.type, `${event.at || 'Time not recorded'} — ${event.title}. ${event.summary} Recorded actor: ${label}.${event.simulated ? ' This participant action was simulated; no physical repair or real delivery is established.' : ''}`, [ev], { section: 'history', actor: canonicalActor, at: event.at, title: event.title,
            displayText: event.summary === event.title + '.' ? '' : safeText(event.summary, 700) });
          return { eventRef: ev, type: event.type, actor: canonicalActor, at: event.at, factIds: [fid] };
        }), coverage: result.nextCursor ? 'page' : 'complete' }; nextCursor = result.nextCursor ? registry.reference('history_cursor', result.nextCursor, scope + ':history') : null;
      } else if (tool === 'read_costs') {
        const subject = args.subjectRef === null ? null : registry.sources.get(args.subjectRef);
        if (args.subjectRef !== null && (!subject || subject.scope !== scope || !['outreach', 'completion'].includes(subject.pointer.model))) throw error('record_not_found', 'This quote or final statement is not available.');
        const rows = await Outreaches.find(filter).sort({ createdAt: 1, _id: 1 }).lean();
        const completion = await Completions.findOne(filter).sort({ createdAt: -1 }).lean();
        const snapshots = rows.flatMap(row => (row.quoteRevisions || []).map(snapshot => ({ row, snapshot }))).filter(x => (args.revision === null || x.snapshot.revision === args.revision) && (!subject || subject.pointer.model === 'outreach' && String(x.row._id) === subject.pointer.id));
        const page = registry.page(snapshots, { cursor: args.cursor, limit: Math.min(args.limitSnapshots, 2), scope: scope + ':costs', version: hash(snapshots.map(x => x.snapshot.hash)) }); nextCursor = page.nextCursor;
        const quotes = page.selected.map(({ row, snapshot }) => {
          const ev = source('quote_revision', row._id, `Itemized quote revision ${snapshot.revision}`, { model: 'outreach', id: String(row._id) }, { revision: snapshot.revision, hash: snapshot.hash, occurredAt: snapshot.revision === 1 ? iso(row.respondedAt) : null });
          fact('quote_total', `Recorded vendor quote revision ${snapshot.revision}: ${money(snapshot.itemization.totals.lowMinor)}${snapshot.itemization.pricingMode === 'range' ? ' to ' + money(snapshot.itemization.totals.highMinor) : ''}.`, [ev], { section: 'cost', quote: { ...snapshot, itemization: { ...snapshot.itemization, items: snapshot.itemization.items.map(line => ({ ...line, description: restrictedDescription(line.description) })) } } });
          return { quoteRef: ev, revision: snapshot.revision, hash: snapshot.hash, current: row.currentQuoteRevision === snapshot.revision, pricingMode: snapshot.itemization.pricingMode, currency: 'CAD', lowMinor: snapshot.itemization.totals.lowMinor, highMinor: snapshot.itemization.totals.highMinor,
            lines: snapshot.itemization.items.map(line => ({ lineRef: registry.reference('line', line.lineId, scope), category: line.category, description: restrictedDescription(line.description), lowMinor: line.amountMinor ?? line.lowMinor, highMinor: line.amountMinor ?? line.highMinor })) };
        });
        let final = null;
        if (completion?.report?.finalStatement && (!subject || subject.pointer.model === 'completion' && String(completion._id) === subject.pointer.id)) {
          const snapshot = completion.report.finalStatement, agreed = completion.approvedQuoteSnapshot?.itemization?.totals?.highMinor ?? cents(completion.approvedCeiling), submitted = snapshot.itemization.totals.highMinor;
          const ev = source('final_statement', completion._id, 'Final itemized charges', { model: 'completion', id: String(completion._id) }, { revision: snapshot.revision, hash: snapshot.hash, occurredAt: iso(completion.report.receivedAt || completion.report.submittedAt) });
          fact('final_total', `Final itemized charges: ${money(submitted)}.${agreed === null ? ' Original agreed value is not recorded.' : ' Difference from the agreed quote: ' + money(submitted - agreed) + '.'} This is a recorded charge, not verification of bank payment.`, [ev], { section: 'cost', final: { ...snapshot, itemization: { ...snapshot.itemization, items: snapshot.itemization.items.map(line => ({ ...line, description: restrictedDescription(line.description) })) } }, agreed });
          final = { statementRef: ev, invoiceReference: completion.report.invoiceReference ? safeText(completion.report.invoiceReference, 120) : null, agreedMinor: agreed, submittedMinor: submitted, approvedPayableMinor: completion.closeRecovery?.payableCents ?? null, payableStatus: completion.ledger?.payoutStatus || null, deltaMinor: agreed === null ? null : submitted - agreed };
        }
        data = { requestRef: args.requestRef, quotes, final, coverage: page.complete ? 'complete' : 'page' };
      } else if (tool === 'read_decisions_and_policy_basis') {
        const all = await Approvals.find(filter).sort({ createdAt: -1, _id: -1 }).lean();
        const page = registry.page(all, { cursor: args.cursor, limit: args.limit, scope: scope + ':decisions', version: hash(all.map(x => [String(x._id), x.status, x.updatedAt])) }); nextCursor = page.nextCursor;
        const decisions = page.selected.map(row => {
          const ev = source('decision', row._id, 'Recorded human decision', { model: 'approval', id: String(row._id) }, { occurredAt: iso(row.decidedAt || row.createdAt) });
          const label = decisionLabel(row), requested = cents(row.amountRequested);
          const lineage = row.payload?.reopenedFromApprovalId ? ' Reopened after an earlier declined review; that decision remains historical.' : '';
          const scopeOnly = row.type === 'cost_review' ? ' Scope review does not authorize spending or payment.' : '';
          fact('decision_' + row.type, `Decision type: ${label}. Recorded status: ${row.status}.${requested === null ? '' : ' Requested amount: ' + money(requested) + '; a request for approval is not approval.'} Actor: ${row.status === 'approved' || row.status === 'rejected' ? 'Landlord decision recorded' : 'No completed human decision recorded'}.${lineage}${scopeOnly}`, [ev], { section: 'decision', label,
            displayValue: safeText(row.status, 80) + (requested === null ? '' : ' · Requested ' + money(requested)) + lineage + scopeOnly });
          return { decisionRef: ev, type: row.type, status: row.status, decidedAt: iso(row.decidedAt), expiresAt: iso(row.expiresAt), requestedMinor: cents(row.amountRequested), authorityRef: row.status === 'approved' ? ev : null, quoteRef: null };
        });
        const rows = await Checkpoints.find(filter).sort({ evaluatedAt: 1 }).lean();
        const checkpoints = rows.map(row => {
          const ev = source('checkpoint', row._id, 'Submitted quote policy check', { model: 'checkpoint', id: String(row._id) }, { revision: row.policyRevision, occurredAt: iso(row.evaluatedAt), hash: row.basisHash });
          fact('quote_policy_basis', `Submitted quote revision ${row.quoteRevision} was checked under recorded policy revision ${row.policyRevision}: ${row.state === 'passed' ? 'passed for that exact quote' : 'human review required'}. Effective limit: ${row.effectiveLimit === null ? 'not set' : 'CAD' + Number(row.effectiveLimit).toFixed(2)}.`, [ev], { section: 'decision', label: 'Submitted quote policy check',
            displayValue: `Quote revision ${row.quoteRevision} · Policy revision ${row.policyRevision} · ${row.state === 'passed' ? 'Passed for that exact quote' : 'Human review required'} · Limit ${row.effectiveLimit === null ? 'not set' : 'CAD' + Number(row.effectiveLimit).toFixed(2)}` });
          return { checkpointRef: ev, stage: 'vendor_quote', state: row.state === 'passed' ? 'passed' : 'pending', policyRevision: row.policyRevision, policyValuesKnown: true, effectiveLimitMinor: cents(row.effectiveLimit), quotaSource: row.quotaSource, basisRef: ev, evaluatedAt: iso(row.evaluatedAt) };
        });
        const contact = await Contacts.findOne(filter).sort({ evaluatedAt: -1, _id: -1 }).lean();
        if (contact) {
          const ev = source('checkpoint', contact._id, 'Recorded initial-contact authorization', { model: 'contact', id: String(contact._id) }, { revision: contact.policyRevision, occurredAt: iso(contact.evaluatedAt), hash: contact.basisHash });
          fact('contact_policy_basis', `Initial contact was ${contact.state === 'permitted' ? 'permitted' : 'refused'} under recorded policy revision ${contact.policyRevision}. This permission is not quote or spending approval.`, [ev], { section: 'decision', label: 'Initial-contact policy check',
            displayValue: `${contact.state === 'permitted' ? 'Permitted' : 'Refused'} · Policy revision ${contact.policyRevision}. Not quote or spending approval.` });
          checkpoints.push({ checkpointRef: ev, stage: 'contact', state: contact.state === 'permitted' ? 'passed' : 'pending', policyRevision: contact.policyRevision, policyValuesKnown: Boolean(contact.policyValues), effectiveLimitMinor: null, quotaSource: 'unknown', basisRef: ev, evaluatedAt: iso(contact.evaluatedAt) });
        } else {
          const ev = source('request', requestId, 'Historical contact policy evidence', { model: 'request', id: requestId });
          fact('contact_policy_unknown', 'Historical contact policy revision was not recorded in these legacy records. The current Policy cannot establish which revision governed that earlier contact.', [ev], { section: 'decision', label: 'Initial-contact policy check', displayValue: 'Unknown historical policy revision; current Policy cannot establish it.' });
          checkpoints.push({ checkpointRef: ev, stage: 'contact', state: 'unknown', policyRevision: null, policyValuesKnown: false, effectiveLimitMinor: null, quotaSource: 'unknown', basisRef: null, evaluatedAt: null });
        }
        data = { requestRef: args.requestRef, decisions, checkpoints, coverage: page.complete ? 'complete' : 'page' };
      } else if (tool === 'read_scheduling') {
        const all = await Reschedules.find(filter).sort({ createdAt: 1 }).lean();
        const page = registry.page(all, { cursor: args.cursor, limit: args.limit, scope: scope + ':scheduling', version: hash(all.map(x => [String(x._id), x.revision])) }); nextCursor = page.nextCursor;
        const appointment = await Appointments.findOne(filter).sort({ createdAt: -1 }).lean();
        const changes = page.selected.map(row => {
          const p = row.proposal, ev = source('scheduling_event', row._id, 'Recorded visit change', { model: 'reschedule', id: String(row._id) }, { revision: row.revision, occurredAt: iso(row.updatedAt) });
          const zone = p.timeZone || p.timezone || 'UTC';
          fact('visit_change', `Visit change: ${row.status}. Reason reported by the manager: ${safeText(p.reason)} Original visit: ${p.oldSlot.start} to ${p.oldSlot.end}. Proposed replacement: ${p.proposedSlot ? p.proposedSlot.start + ' to ' + p.proposedSlot.end : 'not yet proposed'}. Vendor response: ${p.vendorResponse?.status || 'not recorded'}; tenant response: ${p.tenantResponse?.status || 'not recorded'}. ${row.status === 'committed' ? 'Backend replacement was recorded after both-party consent.' : 'A declined or expired proposal keeps the original visit; it is not a cancellation.'}`, [ev], { section: 'scheduling', label: 'Visit change', displayRows: [
            { label: 'Change status', value: safeText(row.status, 80) + (row.status === 'committed' ? ' · Replacement recorded after both parties confirmed' : ' · Original visit retained until backend replacement') },
            { label: 'Manager reason', value: safeText(p.reason, 800) },
            { label: 'Original visit', value: slotText(p.oldSlot, zone) },
            { label: 'Proposed replacement', value: slotText(p.proposedSlot, zone) },
            { label: 'Party responses', value: 'Vendor: ' + (p.vendorResponse?.status || 'not recorded') + ' · Tenant: ' + (p.tenantResponse?.status || 'not recorded') },
            { label: 'Response deadline', value: humanInstant(row.expiresAt, zone) },
          ] });
          return { changeRef: ev, status: row.status, reason: safeText(p.reason), originalStart: p.oldSlot.start, originalEnd: p.oldSlot.end, candidateStart: p.proposedSlot?.start || null, candidateEnd: p.proposedSlot?.end || null, expiresAt: iso(row.expiresAt), vendorResponse: p.vendorResponse?.status || 'unknown', tenantResponse: p.tenantResponse?.status || 'unknown', outsideSuggestedWindows: Boolean(p.outsideSuggestedWindows), events: (p.events || []).slice(-50).map(e => ({ eventRef: registry.reference('event', null, scope), actor: actor(e.actor?.role), type: e.type, at: e.at })) };
        });
        if (changes.length) fact('visit_protections', 'The current visit-change rule requires a reason and the vendor and tenant each consenting themselves. The original slot remains authoritative until backend replacement. The cutoff is two hours before the earlier visit or an earlier expiry, with a minimum 15-minute new response window. This describes the current rule; historical deadlines remain as recorded, not retroactively rewritten.', [changes[0].changeRef], { section: 'scheduling', label: 'Current visit protections' });
        data = { requestRef: args.requestRef, appointment: appointment ? { ref: registry.reference('appointment', String(appointment._id), scope), status: appointment.status, start: iso(appointment.confirmedStart), end: iso(appointment.confirmedEnd) } : null, changes, coverage: page.complete ? 'complete' : 'page' };
      } else throw error('invalid_input', 'This Iris tool is not available.');
    }
    const result = { schemaVersion: 2, tool, status, observedAt, facts, evidence, data, nextCursor, truncated: data.coverage === 'page', errorCode: null };
    validate('ToolResult_' + tool, result);
    if (Buffer.byteLength(JSON.stringify(result)) > contract.limits.toolBytes) throw error('service_unavailable', 'The record page is too large. Request a smaller page.');
    return { result, notice: tool === 'search_landlord_help' && !data.articles.length ? 'missing_guide' : null };
  }
  async function verifyEvidence(auth, source) {
    const { pointer: p, evidence: e } = source;
    if (e.requestId) await ownRequest(auth.subjectId, e.requestId);
    if (p.model === 'help' || (p.model === 'policy' && p.id === null)) return;
    const models = { request: Requests, policy: Policies, outreach: Outreaches, completion: Completions, approval: Approvals, checkpoint: Checkpoints, contact: Contacts, reschedule: Reschedules, audit: Logs };
    const Model = models[p.model];
    if (!Model || !p.id) throw error('record_not_found', 'This historical source is not available.');
    const row = await Model.findOne({ _id: p.id, landlordId: auth.subjectId, ...(e.requestId && p.model !== 'request' ? { requestId: e.requestId } : {}) }).lean();
    if (!row) throw error('record_not_found', 'This historical source is not available.');
    // Return the saved customer-safe snapshot, never silently replace it with
    // a newer fact. Immutable quote/final bases must still exist unchanged.
    if (p.model === 'outreach' && !(row.quoteRevisions || []).some(q => q.revision === e.revision && q.hash === e.hash)) throw error('stale_evidence', 'This recorded quote revision is no longer available.');
    if (p.model === 'completion' && e.hash && row.report?.finalStatement?.hash !== e.hash) throw error('stale_evidence', 'This recorded final statement is no longer available.');
  }
  return { read, ownRequest, verifyEvidence };
}
module.exports = { createReadContext, cents, money, actor };
