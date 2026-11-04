const { contract, error, id } = require('./contract.service');
const HOUR = 3600000;
const stopped = code => Object.assign(error(code), { execution: 'not_started' });
const recoveryStoryFor = run => [contract.storyVersions.declineRecovery, contract.storyVersions.containedFaucet].includes(run.storyVersion);
function hasVerifiedDelivery({ request, outreach, deliveryReceipt }) {
  return Boolean(request && id(request._id) && id(request.landlordId) && outreach && id(outreach._id) && id(outreach.vendorId) && id(outreach.identityId) &&
    outreach.simulatedDelivery === true && !outreach.deliveryUnconfirmed && deliveryReceipt && id(deliveryReceipt._id) &&
    deliveryReceipt.channel === 'simulation' && deliveryReceipt.realDelivery === false && deliveryReceipt.acceptedAt &&
    Number.isFinite(new Date(deliveryReceipt.acceptedAt).getTime()) &&
    id(deliveryReceipt.outreachId) === id(outreach) && id(deliveryReceipt.requestId) === id(request) &&
    id(deliveryReceipt.landlordId) === id(request.landlordId) && id(deliveryReceipt.vendorId) === id(outreach.vendorId) &&
    id(deliveryReceipt.identityId) === id(outreach.identityId));
}
function declineRecoveryProof(data) {
  const { run, firstOutreach, outreach } = data;
  if (!recoveryStoryFor(run) || run.stepCode !== 'routing' || run.state !== 'failed' || run.error?.code !== 'action_unknown' ||
      run.inFlightActionId || !(run.completedDirectives || []).includes('vendor_decline')) return null;
  if (!firstOutreach || !id(firstOutreach._id) || !id(firstOutreach.vendorId) || !id(firstOutreach.identityId) ||
      firstOutreach.status !== 'declined' || firstOutreach.response?.outcome !== 'declined' ||
      !firstOutreach.respondedAt || !Number.isFinite(new Date(firstOutreach.respondedAt).getTime()) ||
      !outreach || !['sent', 'viewed'].includes(outreach.status) || outreach.respondedAt ||
      id(outreach) === id(firstOutreach) || id(outreach.vendorId) === id(firstOutreach.vendorId) ||
      !hasVerifiedDelivery(data)) return null;
  const observation = projectDomain(data);
  if (observation.error) return null;
  return { observation, declineReceiptRef: id(firstOutreach), deliveryReceiptRef: id(data.deliveryReceipt) };
}
function invoiceClarificationMatches({ request, completion, appointment, invoiceClarification: row }, now = new Date()) {
  const snapshot = completion?.report?.finalStatement, review = completion?.invoiceReview;
  return Boolean(request && completion?.quoteContractVersion === 2 && completion.report?.submittedAt &&
    ['awaiting_tenant', 'confirmed', 'in_review'].includes(completion.status) && snapshot &&
    Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0 && snapshot.hash && review?.contextHash &&
    review.state === 'waiting_clarification' &&
    row?.stage === 'invoice' && ['draft', 'ready'].includes(row.state) && new Date(row.expiresAt) > now &&
    id(row.landlordId) === id(request.landlordId) && id(row.requestId) === id(request) && id(row.subjectId) === id(completion) &&
    id(completion.landlordId) === id(request.landlordId) && id(completion.requestId) === id(request) &&
    id(row) === id(review.clarificationId) && row.quoteRevision === snapshot.revision && row.quoteHash === snapshot.hash &&
    review.quoteHash === snapshot.hash && row.contextHash === review.contextHash &&
    appointment && id(completion.appointmentId) === id(appointment) && id(appointment.requestId) === id(request) &&
    id(appointment.landlordId) === id(request.landlordId) && id(completion.vendorId) &&
    id(completion.vendorId) === id(appointment.vendorId));
}
function projectDomain({ run, request = null, approval = null, outreach = null, firstOutreach = null, deliveryReceipt = null, preparation = null, appointment = null, changes = [], completion = null, clarification = null, invoiceClarification = null, now = new Date() }) {
  const recoveryStory = recoveryStoryFor(run);
  const requestId = request ? id(request) : null;
  const state = (stepCode, status, detail, kind = null, approvalId = null, failure = null) => ({ requestId, stepCode, state: status, detail,
    checkpoint: kind ? { kind, requestId, approvalId: approvalId ? id(approvalId) : null } : null,
    error: failure ? { code: failure, retryable: false, retryAfterSeconds: null, nextAvailableAt: null } : null,
    completedAt: stepCode === 'complete' ? run.completedAt || new Date() : null });
  if (!request) return state('tenant_submit', 'waiting_on_tenant', 'The paired tenant submits through the ordinary request form and admissions.', 'tenant_submit');
  if (run.storyVersion === contract.storyVersions.containedFaucet && !require('./scenario.service').supportsContainedFaucet(request))
    return state('routing', 'failed', 'This guided demo supports a contained non-emergency faucet drip. This request is outside that scenario. Open the existing request for ordinary handling; safety classification is unchanged. Do not restart or submit another request to force progress.', 'approval', null, 'unsupported_scenario');
  if (request.status === 'completed') return (run.completedDirectives || []).includes('iris_segment')
    ? state('complete', 'completed', 'The maintenance workflow is closed. The guide does not verify a physical repair, bank transfer or model use.')
    : state('iris_segment', 'ready_to_continue', 'Open this request and Ask Iris: history, understand Policy, change and receipt. Continue only acknowledges this guide step.', 'iris_review');
  if (['cancelled', 'rejected'].includes(request.status)) return state(run.stepCode, 'failed', 'This request is closed without completing the guided repair. Ask for a spare pair.', null, null, 'step_not_ready');
  if (request.intakeFollowUp?.state === 'awaiting_answers') return state('tenant_submit', 'waiting_on_tenant', 'The tenant supplies the ordinary intake follow-up before routing can continue.', 'tenant_submit');
  if (request.intakeFollowUp?.state === 'ready_for_review' || ['needs_review', 'confirmed_hazard'].includes(request.safetyAssessment?.state) && !request.safetyAssessment?.reviewedAt)
    return state('routing', 'waiting_on_landlord', 'Review the recorded intake or safety checkpoint on the existing request page.', 'approval');
  if (!completion?.report?.submittedAt && clarification && ['draft', 'ready'].includes(clarification.state) && clarification.stage === 'quote') return state('quote_resolution', 'ready_to_continue', 'A bounded clarification is open. Continue supplies a labelled simulated-vendor answer; no human decision is made.');
  if (approval) return state(completion?.report?.submittedAt ? 'landlord_review' : outreach?.respondedAt ? 'quote_resolution' : 'routing', 'waiting_on_landlord', 'Review the actual pending Decision on its normal screen. Continue cannot approve it.', 'approval', approval._id);
  if (completion?.report?.submittedAt && completion.invoiceReview?.state === 'waiting_clarification') {
    if (invoiceClarificationMatches({ request, completion, appointment, invoiceClarification }, now))
      return state('landlord_review', 'ready_to_continue', 'Waiting for the vendor to clarify the final statement. Continue supplies a labelled simulated-vendor answer only; costs and tenant confirmation stay unchanged. The normal cost review runs again; no human approval or payment is made.');
    return state('landlord_review', 'waiting_on_landlord', 'Waiting for the vendor follow-up on the final statement. A current answerable clarification is not available; inspect the recorded follow-up on the request. No Decision or automatic retry is offered.');
  }
  if (completion?.invoiceReview?.state === 'rejected') {
    const payableKnown = completion.closeRecovery?.payableCents != null ||
      completion.overage?.decision === 'approved' && completion.overage?.approvedAmount != null;
    return state('landlord_review', 'waiting_on_landlord', `Final scope review was declined; financial close is blocked. ${payableKnown ? 'The recorded payable does not clear scope review.' : 'Approved payable is not decided.'} Open the request and choose Reopen scope review, then explicitly Confirm scope review in Decisions. Reopening does not authorize spending or payment.`, 'approval');
  }
  if (outreach?.quoteReview?.state === 'rejected') return state('quote_resolution', 'waiting_on_landlord',
    'Quote scope review was declined; booking remains blocked. Open the request and choose Reopen scope review, then explicitly Confirm scope review in Decisions. Scope review does not authorize spending or payment; other booking checks still apply.', 'approval');
  if (completion?.report?.submittedAt) {
    if (!completion.tenantConfirmation?.outcome) return state('tenant_completion', 'waiting_on_tenant', 'The paired tenant reviews the simulated completion on the ordinary request page.', 'tenant_completion');
    return state('landlord_review', 'waiting_on_landlord', 'Review the actual completion and evidence checkpoint. No real repair or payment is established by the simulation.', 'approval');
  }
  if (preparation?.phase === 'awaiting_funds') return state('booking', 'waiting_on_landlord', 'The ordinary synthetic Wallet funding checks block this booking.', 'wallet_funding');
  const activeChange = changes.find(c => c.active);
  if (activeChange) {
    if (activeChange.status === 'awaiting_vendor') return state('vendor_reschedule', 'ready_to_continue', 'Continue submits the simulated vendor response. The original visit stays authoritative until both parties agree.');
    return state('tenant_reschedule', 'waiting_on_tenant', 'The paired tenant must accept or decline the exact replacement time themselves.', 'visit_change');
  }
  if (appointment?.status === 'scheduled') {
    if (appointment.tenantConfirmation?.accepted !== true) return state('booking', 'waiting_on_tenant', 'The paired tenant confirms the original visit on the existing request page.', 'booking');
    if (!changes.length) return state('visit_change', 'waiting_on_landlord', 'Request a reasoned visit change on the existing visit card. The guide cannot invent the manager reason or tenant consent.', 'visit_change');
    return state('vendor_work', 'ready_to_continue', 'The visit-change outcome is recorded. Continue submits a labelled simulated work report, not proof of a physical repair.');
  }
  if (appointment && ['proposed', 'awaiting_tenant'].includes(appointment.status)) return preparation?.phase === 'awaiting_vendor'
    ? state('booking', 'ready_to_continue', 'Continue supplies a simulated vendor time from the actual proposed windows. Tenant confirmation remains separate.')
    : state('booking', 'waiting_on_tenant', 'The paired tenant confirms the original visit on the existing request page.', 'booking');
  if (outreach?.counterOffer?.status === 'pending') return state('quote_resolution', 'ready_to_continue', 'Continue lets the simulated vendor confirm the exact human-authorized counteroffer; it cannot change the amount.');
  if (outreach && ['sent', 'viewed'].includes(outreach.status) && !outreach.respondedAt) {
    if (recoveryStory) {
      if (!firstOutreach) return state('routing', 'running', 'Waiting for the recorded first and current outreach to agree. No vendor response was simulated.');
      const delivered = hasVerifiedDelivery({ request, outreach, deliveryReceipt });
      if (!delivered) return state('routing', 'failed', 'The current simulated vendor delivery could not be verified. No response or automatic retry was started.', null, null, 'action_unknown');
      if (id(firstOutreach) === id(outreach) && ['sent', 'viewed'].includes(firstOutreach.status) && !firstOutreach.respondedAt) {
        if ((run.completedDirectives || []).includes('vendor_decline')) return state('routing', 'failed', 'A prior refusal action was recorded, but the current outreach still appears unanswered. No repeat was started.', null, null, 'action_unknown');
        return state('vendor_decline', 'ready_to_continue', 'Continue records the first simulated vendor declining. The normal backend Policy decides whether another vendor may be contacted.');
      }
      const declined = firstOutreach.status === 'declined' && firstOutreach.response?.outcome === 'declined';
      return state('vendor_quote', 'ready_to_continue', declined
        ? 'The first vendor refusal is recorded and the backend recorded delivery to the current vendor. Continue supplies that vendor’s simulated itemized quote.'
        : 'The current vendor delivery is recorded. Continue supplies its simulated itemized quote; the earlier outreach outcome remains as recorded.');
    }
    return state('vendor_quote', 'ready_to_continue', 'Continue submits a labelled simulated itemized quote through the existing quote validation.');
  }
  if (outreach?.status === 'accepted') return state('booking', 'ready_to_continue', 'Re-check the accepted quote through the normal booking preparation, current quote ceiling and synthetic funds checks.');
  if (outreach?.status === 'scheduled') return state('routing', 'waiting_on_landlord', 'Outreach is scheduled under the real operating-hours rule. The guide cannot advance the clock.', 'approval');
  if (outreach?.deliveryUnconfirmed) return state('routing', 'failed', 'Delivery outcome is unknown. No automatic resend is permitted.', null, null, 'action_unknown');
  if (request.initialRouting?.status === 'processing' && new Date(request.initialRouting.leaseUntil) > new Date()) return state('routing', 'running', 'The ordinary routing claim is already working. The guide does not submit a second claim.');
  if (request.initialRouting?.status === 'failed') return state('routing', 'waiting_on_landlord', 'Routing exhausted its normal retry allowance. Review its recorded failure on the request page.', 'approval');
  if (request.agentPaused || request.routingStatus === 'paused') return state('routing', 'waiting_on_landlord', 'This request is paused under its normal controls. Review routing or Policy; Resume on this guide does not change the request.', 'approval');
  if (recoveryStory && outreach?.status === 'declined' && id(outreach) === id(firstOutreach)) {
    if ((run.completedDirectives || []).includes('vendor_decline') && outreach.response?.outcome !== 'declined')
      return state('routing', 'failed', 'The recorded refusal disagrees with the current response. No repeat was started.', null, null, 'action_unknown');
    return state('routing', 'waiting_on_landlord', 'The vendor refusal is recorded. A next-vendor delivery is not established yet. Review the existing request and any actual human or Policy hold; no automatic repeat was started.', 'approval');
  }
  return state('routing', 'ready_to_continue', 'Continue re-checks normal routing. Policy and any real human checkpoint stay authoritative.');
}
function chooseWindow(windows, now = new Date(), durationMinutes = 120, minimumLeadMs = 6 * HOUR + 15 * 60000) {
  // Give both original and replacement visits real future room. No clock or
  // calendar mutation is used to make the short demonstration fit.
  const earliest = new Date(now.getTime() + minimumLeadMs), duration = durationMinutes * 60000;
  for (const window of windows || []) {
    if (window.kind === 'flexible' || !window.start && !window.end) return { slotId: window.slotId, start: earliest.toISOString(), durationMinutes };
    const start = new Date(Math.max(new Date(window.start).getTime(), earliest.getTime()));
    if (Number.isFinite(start.getTime()) && new Date(window.end).getTime() - start.getTime() >= duration) return { slotId: window.slotId, start: start.toISOString(), durationMinutes };
  }
  throw stopped('no_free_visit_time');
}
const itemization = (labourMinor = 21500, materialsMinor = 6000) => ({ pricingMode: 'fixed', currency: 'CAD',
  items: [{ category: 'labour', description: 'SIMULATED faucet repair labour', amountMinor: labourMinor }, { category: 'materials', description: 'SIMULATED replacement faucet parts', amountMinor: materialsMinor }],
  totals: { lowMinor: labourMinor + materialsMinor, highMinor: labourMinor + materialsMinor } });
async function invoke(handler, req) {
  let status = 200, output;
  const response = { status(code) { status = code;return this; }, json(data) { output = data;return this; } };
  await handler({ ip: '127.0.0.1', get: () => 'judge-core-simulation', ...req }, response);
  if (status >= 400 || output?.success === false) throw Object.assign(error('step_not_ready'), { domainStatus: status, domainCode: typeof output?.code === 'string' ? output.code : null });
  return output;
}
function createDomain({ bindings, now = () => new Date() } = {}) {
  if (!bindings) throw TypeError('Verified synthetic binding capability required');
  const Request = require('../../models/MaintenanceRequest'), Approval = require('../../models/ApprovalRequest'), Outreach = require('../../models/VendorOutreach');
  const Preparation = require('../../models/BookingPreparation'), Appointment = require('../../models/Appointment'), Changes = require('../../models/BookingReschedule');
  const Completion = require('../../models/JobCompletion'), Clarification = require('../../models/QuoteClarification');
  const Delivery = require('../../models/JudgeSandboxDelivery');
  async function load(ctx, run) {
    await bindings.verifyPair(ctx);
    const filter = { landlordId: ctx.pair.landlordId, tenantId: ctx.pair.tenantId, unitId: ctx.pair.unitId, propertyId: ctx.pair.propertyId, archivedAt: null };
    let request;
    if (run.requestId) request = await Request.findOne({ ...filter, _id: run.requestId }).lean();
    else {
      const rows = await Request.find({ ...filter, createdAt: { $gte: run.startedAt } }).sort({ createdAt: 1, _id: 1 }).limit(2).lean();
      if (rows.length > 1) throw stopped('ambiguous_request');request = rows[0] || null;
    }
    if (run.requestId && !request) throw stopped('record_not_found');
    if (!request) return { run, request: null };
    const owned = { landlordId: ctx.pair.landlordId, requestId: request._id };
    const [approval, outreach, preparation, appointment, changes, completion, clarification, firstOutreach] = await Promise.all([
      Approval.findOne({ ...owned, status: 'pending', expiresAt: { $gt: now() } }).sort({ createdAt: 1 }).lean(),
      Outreach.findOne(owned).sort({ createdAt: -1, _id: -1 }).lean(), Preparation.findOne(owned).sort({ active: -1, createdAt: -1 }).lean(),
      Appointment.findOne(owned).sort({ createdAt: -1 }).select('+workMutationStartedAt').lean(), Changes.find(owned).sort({ createdAt: -1 }).lean(),
      Completion.findOne(owned).sort({ createdAt: -1 }).lean(), Clarification.findOne({ ...owned, stage: 'quote', state: { $in: ['draft', 'ready'] }, expiresAt: { $gt: now() } }).select('+nonce').lean(),
      recoveryStoryFor(run) ? Outreach.findOne(owned).sort({ createdAt: 1, _id: 1 }).lean() : Promise.resolve(null)
    ]);
    const invoiceClarification = completion?.report?.submittedAt && completion.invoiceReview?.state === 'waiting_clarification' &&
      completion.invoiceReview.clarificationId && completion.report.finalStatement
      ? await Clarification.findOne({ ...owned, _id: completion.invoiceReview.clarificationId, stage: 'invoice', subjectId: completion._id,
        quoteRevision: completion.report.finalStatement.revision, quoteHash: completion.report.finalStatement.hash,
        contextHash: completion.invoiceReview.contextHash, state: { $in: ['draft', 'ready'] }, expiresAt: { $gt: now() } }).select('+nonce').lean()
      : null;
    const deliveryReceipt = recoveryStoryFor(run) && outreach
      ? await Delivery.findOne({ ...owned, pairId: ctx.pair._id, outreachId: outreach._id, vendorId: outreach.vendorId,
        identityId: outreach.identityId, channel: 'simulation', realDelivery: false }).lean() : null;
    return { run, request, approval, outreach, firstOutreach, deliveryReceipt, preparation, appointment, changes, completion, clarification, invoiceClarification, now: now() };
  }
  const inspect = async (ctx, run) => projectDomain(await load(ctx, run));
  const inspectDeclineRecovery = async (ctx, run) => declineRecoveryProof(await load(ctx, run));
  async function execute(ctx, run, { actionId }) {
    const data = await load(ctx, run), current = projectDomain(data);
    if (current.state !== 'ready_to_continue' || current.stepCode !== run.stepCode) throw stopped('checkpoint_requires_human');
    const { request, outreach, preparation, appointment, changes, clarification, invoiceClarification, completion } = data;
    if (!request) throw stopped('step_not_ready');
    if (run.stepCode === 'iris_segment') return { receiptRef: 'guide_ack_' + actionId };
    if (run.stepCode === 'routing') return bindings.withPair(ctx, async () => {
      const started = await require('../request/initialRouting.service').processInitialRouting(request._id);
      if (!started) {
        const controller = require('../../controllers/request.controller');
        const req = { user: { id: ctx.actorId, accountId: ctx.accountId, role: ctx.profileRole || ctx.role }, params: { id: id(request) }, body: {} };
        if (outreach?.status === 'delivery_failed' && !outreach.deliveryUnconfirmed) await invoke(controller.resendVendorOutreach, { ...req, params: { ...req.params, vendorId: outreach.candidateKey } });
        else if (!outreach) await invoke(controller.generateVendorRecommendations, req);
      }
      return { receiptRef: 'routing_check_' + actionId };
    });
    const invoiceAnswer = run.stepCode === 'landlord_review' && invoiceClarificationMatches(data, now());
    const vendorId = invoiceAnswer ? completion.vendorId : outreach?.vendorId || appointment?.vendorId;
    if (!vendorId) throw stopped('record_not_found');
    return bindings.withVendor(ctx, request._id, vendorId, actionId, async () => {
      if (invoiceAnswer) {
        const service = require('../quotes/clarification.service');
        // The ordinary single-use service rechecks the bound subject/hash in
        // its transaction. Invoice answers never include revised itemization.
        await service.submitClarification(service.deliveryToken(invoiceClarification), {
          expectedQuoteRevision: invoiceClarification.quoteRevision, expectedQuoteHash: invoiceClarification.quoteHash,
          answers: invoiceClarification.questions.map(q => ({ questionId: q.id,
            answer: 'SIMULATED vendor clarification: the final statement covers the reported faucet repair; labour and materials are separate charges. No extra work or revised price is requested.' }))
        });
        return { receiptRef: id(invoiceClarification) };
      }
      const portal = require('../../controllers/vendorPortal.controller');
      if (run.stepCode === 'vendor_decline') {
        const result = await portal.submitSimulatedOutreach(outreach._id, { outcome: 'declined',
          declineReason: 'SIMULATED vendor cannot take this job. The normal backend Policy decides the next contact.' });
        if (result.status >= 400) throw error('step_not_ready');
        return { receiptRef: id(outreach) };
      }
      if (run.stepCode === 'vendor_quote') {
        // The ordinary portal refreshes/clips calendar windows before input
        // validation. Select from that same current list, including its slot
        // IDs, rather than submitting a stale pre-refresh snapshot.
        await require('../vendor/offeredWindows.service').refreshOutreachWindows(outreach, { now: now() });
        const window = chooseWindow(outreach.offeredWindows, now());
        const result = await portal.submitSimulatedOutreach(outreach._id, { outcome: 'accepted', selectedSlotId: window.slotId, scheduledArrivalAt: window.start,
          durationMinutes: window.durationMinutes, expectedRevision: 0, quoteContractVersion: 2, itemization: itemization(), quoteNotes: 'SIMULATED itemized vendor response. No real vendor message.' });
        if (result.status >= 400) throw error('step_not_ready');return { receiptRef: id(outreach) };
      }
      if (run.stepCode === 'quote_resolution' && clarification) {
        const service = require('../quotes/clarification.service');
        const body = { expectedQuoteRevision: clarification.quoteRevision, expectedQuoteHash: clarification.quoteHash,
          answers: clarification.questions.map(q => ({ questionId: q.id, answer: 'SIMULATED vendor clarification: labour and materials are distinct; revised work remains faucet repair.' })), itemization: itemization(18000, 6000) };
        await service.submitClarification(service.deliveryToken(clarification), body);return { receiptRef: id(clarification) };
      }
      if (run.stepCode === 'quote_resolution' && outreach.counterOffer?.status === 'pending') {
        const result = await portal.submitSimulatedCounterOffer(outreach._id);if (result.status >= 400) throw error('step_not_ready');return { receiptRef: id(outreach) };
      }
      if (run.stepCode === 'booking') {
        if (preparation?.phase === 'awaiting_vendor' && preparation.proposals?.length) {
          const window = chooseWindow(preparation.proposals.map((w, i) => ({ ...w, slotId: String(i), kind: 'window' })), now(), 120, 2 * HOUR + 15 * 60000);
          await require('../vendor/bookingCoordination.service').proposeVendorTime({ preparationId: preparation._id, revision: preparation.revision, start: window.start, durationMinutes: window.durationMinutes });
        } else await require('../vendor/vendorAcceptance.service').finalizeVendorAcceptance({ outreachId: outreach._id });
        return { receiptRef: id(preparation || outreach) };
      }
      if (run.stepCode === 'vendor_reschedule') {
        const change = changes.find(c => c.active);if (!change || !preparation) throw stopped('step_not_ready');
        const window = chooseWindow(change.proposal.windows.map((w, i) => ({ ...w, slotId: String(i), kind: 'window' })), now(), 120, 2 * HOUR + 15 * 60000);
        await require('../vendor/bookingReschedule.service').respond({ preparationId: preparation._id, actor: { role: 'vendor', id: preparation.identityId }, proposalRef: change._id,
          expectedRevision: change.revision, action: 'vendor_confirm', start: window.start, durationMinutes: window.durationMinutes });
        return { receiptRef: id(change) };
      }
      if (run.stepCode === 'vendor_work') {
        if (!appointment || appointment.status !== 'scheduled' || appointment.tenantConfirmation?.accepted !== true || changes.some(c => c.active)) throw stopped('checkpoint_requires_human');
        const jobToken = await require('../../models/JobToken').findOne({ appointmentId: appointment._id, requestId: request._id, landlordId: ctx.pair.landlordId, vendorId,
          scope: 'job', revokedAt: null, expiresAt: { $gt: now() } }).select('-tokenHash -jobCode').lean();
        if (!jobToken) throw stopped('step_not_ready');
        const controller = require('../../controllers/vendorCompletion.controller');
        const req = { appointment, jobToken };
        for (const kind of ['checkIn', 'checkOut']) if (!data.completion?.[kind]) await invoke(controller.recordCheckpoint, { ...req, body: { kind, denied: true } });
        await invoke(controller.submitCompletion, { ...req, body: { workPerformed: 'SIMULATED work report for the judge flow; no physical repair is verified.', partsUsed: 'SIMULATED faucet parts',
          actualCost: 240, expectedRevision: 0, quoteContractVersion: 2, itemization: itemization(18000, 6000), invoiceReference: 'SYNTHETIC-' + id(run), followUpNeeded: false } });
        const completion = await Completion.findOne({ appointmentId: appointment._id, ...{ landlordId: ctx.pair.landlordId, requestId: request._id } }).select('_id').lean();
        return { receiptRef: id(completion) };
      }
      throw stopped('step_not_ready');
    });
  }
  return { inspect, inspectDeclineRecovery, execute, load };
}
module.exports = { createDomain, projectDomain, chooseWindow, itemization, declineRecoveryProof };
