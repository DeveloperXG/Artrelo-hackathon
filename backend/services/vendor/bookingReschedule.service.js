const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const Changes = require('../../models/BookingReschedule');
const Preparation = require('../../models/BookingPreparation');
const Appointment = require('../../models/Appointment');
const Request = require('../../models/MaintenanceRequest');
const Completion = require('../../models/JobCompletion');
const calendar = require('./vendorCalendar.service');
const contract = require('./bookingReschedule.contract');
const capabilities = require('./bookingCapabilities.service');
const { nudge } = require('./bookingPreparation.service');
const id = value => String(value?._id || value || '');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = (code = 'reschedule_changed') => Object.assign(new Error(code === 'reschedule_party_required'
  ? 'You cannot give another participant\'s response. Refresh to see the actions available to you; the original visit has not been replaced.'
  : code === 'reschedule_deadline_changed' ? 'The response deadline was shortened to protect the original visit. Refresh before responding.'
    : 'The visit change is no longer current. Refresh the request; the original visit has not been replaced.'), { code, status: 409 });
function checkActor(preparation, actor) {
  const expected = { landlord: preparation.landlordId, tenant: preparation.tenantId, vendor: preparation.identityId }[actor?.role];
  if (!expected || id(expected) !== id(actor.id)) throw Object.assign(error('reschedule_party_required'), { status: 403 });
}
async function context(preparation, session) {
  const request = await Request.findOne({ _id: preparation.requestId, landlordId: preparation.landlordId, tenantId: preparation.tenantId }).session(session).lean();
  const appointment = await Appointment.findOne({ _id: preparation.appointmentId, landlordId: preparation.landlordId,
    requestId: preparation.requestId, tenantId: preparation.tenantId, vendorId: preparation.vendorId }).select('+workMutationStartedAt').session(session).lean();
  const completion = appointment ? await Completion.findOne({ appointmentId: appointment._id, requestId: preparation.requestId,
    landlordId: preparation.landlordId }).select('appointmentId requestId landlordId status checkIn report.submittedAt').session(session).lean() : null;
  const projected = capabilities.project({ preparation, request, appointment, completion, audience: 'landlord', rescheduleEnabled: true });
  // Starting a new change needs a minimum response window. Existing accepted
  // candidates may still be answered until their own earlier safe deadline.
  return { request, appointment, completion, allowed: preparation.phase === 'scheduled' && projected.state === 'confirmed' && !appointment?.workMutationStartedAt };
}
async function lockPreparation(preparation, session) {
  const locked = await Preparation.updateOne({ _id: preparation._id, active: true, revision: preparation.revision },
    { $inc: { rescheduleFence: 1 } }, { session });
  if (!locked.matchedCount) throw error();
}
function envelope(proposal) {
  return { proposal, revision: proposal.revision, status: proposal.status, active: proposal.active, expiresAt: new Date(proposal.expiresAt) };
}
async function queue(proposal, session, previousRevision = proposal.revision - 1) {
  await require('./coordinationNotices.service').queueRescheduleNotices(proposal, session);
  await Request.updateOne({ _id: proposal.requestId, landlordId: proposal.landlordId }, { $set: { rescheduleState: {
    proposalId: proposal.id, revision: proposal.revision, active: proposal.active, status: proposal.status, expiresAt: new Date(proposal.expiresAt),
  } } }, { session });
  const summaries = { requested: 'A reasoned visit change was requested; the original visit remains confirmed.',
    vendor_confirmed_slot: 'The vendor confirmed a proposed replacement; tenant confirmation is still required.',
    tenant_confirmed_slot: 'The tenant confirmed the exact proposed replacement time.',
    tenant_declined_slot: 'The tenant declined the replacement; the original visit was retained.',
    vendor_declined_change: 'The vendor declined the change; the original visit was retained.',
    tenant_declined_change: 'The tenant declined the change; the original visit was retained.',
    landlord_declined_change: 'The manager withdrew the change request; the original visit was retained.',
    committed: 'The backend changed the visit time after vendor and tenant confirmations.',
    response_deadline_shortened: 'The response deadline was shortened to keep a two-hour buffer before either visit; the original booking is unchanged.',
    expired: 'The change request expired without replacing the original visit.',
    candidate_unavailable: 'The replacement time was unavailable; the original visit was retained.',
    original_basis_changed: 'The change request was invalidated; no replacement was applied.' };
  const logs = proposal.events.filter(event => event.revision > previousRevision).map(event => ({
    landlordId: proposal.landlordId, requestId: proposal.requestId, actor: event.actor.role,
    actionType: `booking_reschedule_${event.type}`, summary: summaries[event.type] || 'A visit change transition was recorded.',
    input: { rescheduleId: proposal.id, revision: event.revision }, output: { status: proposal.status, source: 'backend' },
  }));
  if (logs.length) await require('../../models/AgentActionLog').create(logs, { session, ordered: true });
}
async function publish(preparation) {
  try { nudge(preparation); require('./coordinationNotices.service').nudge(); }
  catch (_) { /* Durable notice outbox is recovered; a wake cannot undo a committed transition. */ }
}
async function open({ preparationId, actor, revision, reason, windows, clientActionId }) {
  await Changes.init();
  if (actor?.role !== 'landlord' || typeof clientActionId !== 'string' || !/^[A-Za-z0-9_-]{12,80}$/.test(clientActionId)) throw error('reschedule_action_reference_required');
  const creationKey = hash({ preparationId: id(preparationId), actor: id(actor.id), clientActionId });
  const inputHash = hash({ revision, reason, windows });
  let prepared;
  const result = await mongoose.connection.transaction(async session => {
    const preparation = await Preparation.findById(preparationId).session(session).lean();
    if (!preparation) throw error(); checkActor(preparation, actor); prepared = preparation;
    const existing = await Changes.findOne({ creationKey, preparationId, landlordId: preparation.landlordId }).session(session).lean();
    if (existing) { if (existing.inputHash !== inputHash) throw error('idempotency_key_reused'); return { change: existing, duplicate: true }; }
    if (!Number.isInteger(revision) || preparation.revision !== revision || preparation.phase !== 'scheduled') throw error();
    await lockPreparation(preparation, session);
    const basis = await context(preparation, session);
    if (!basis.allowed) throw error('work_already_started');
    if (await Changes.exists({ preparationId, active: true }).session(session)) throw error('reschedule_already_pending');
    const proposal = contract.begin({ id: String(new mongoose.Types.ObjectId()), actor: { role: actor.role, id: id(actor.id) },
      ownership: { requestId: id(preparation.requestId), preparationId: id(preparation), appointmentId: id(preparation.appointmentId),
        landlordId: id(preparation.landlordId), tenantId: id(preparation.tenantId), identityId: id(preparation.identityId) },
      reason, oldSlot: { start: basis.appointment.confirmedStart, end: basis.appointment.confirmedEnd }, windows }).proposal;
    const [change] = await Changes.create([{ _id: proposal.id, preparationId, requestId: preparation.requestId,
      appointmentId: preparation.appointmentId, landlordId: preparation.landlordId, creationKey, inputHash, ...envelope(proposal) }], { session });
    await queue(proposal, session);
    return { change: change.toObject(), duplicate: false };
  });
  await publish(prepared); return result;
}
async function respond({ preparationId, actor, proposalRef, expectedRevision, action, start, durationMinutes, slotKey, accepted }) {
  if (!mongoose.isValidObjectId(proposalRef) || !Number.isInteger(expectedRevision)) throw error('reschedule_revision_conflict');
  if (!['decline', 'vendor_confirm', 'tenant_respond'].includes(action)) throw error('invalid_reschedule_action');
  if ((action === 'vendor_confirm' && actor?.role !== 'vendor') || (action === 'tenant_respond' && actor?.role !== 'tenant')) throw Object.assign(error('reschedule_party_required'), { status: 403 });
  const receipt = hash({ actor: { role: actor?.role, id: id(actor?.id) }, proposalRef: id(proposalRef), expectedRevision, action, start, durationMinutes, slotKey, accepted });
  let prepared;
  const result = await mongoose.connection.transaction(async session => {
    const preparation = await Preparation.findById(preparationId).session(session).lean();
    if (!preparation) throw error(); checkActor(preparation, actor); prepared = preparation;
    await lockPreparation(preparation, session);
    const change = await Changes.findOne({ _id: proposalRef, preparationId, landlordId: preparation.landlordId }).session(session).lean();
    if (!change) throw error();
    if ((change.receipts || []).includes(receipt)) return { change, duplicate: true };
    if (!change.active || change.revision !== expectedRevision) throw error('reschedule_revision_conflict');
    const basis = await context(preparation, session), now = new Date();
    let transition;
    let deadlineAdjusted = false;
    if (!basis.allowed || basis.appointment.confirmedStart.toISOString() !== change.proposal.oldSlot.start ||
      basis.appointment.confirmedEnd.toISOString() !== change.proposal.oldSlot.end) transition = contract.invalidate({ proposal: change.proposal, now });
    else if (contract.effectiveDeadline(change.proposal) <= now) transition = contract.expire({ proposal: change.proposal, now });
    else if (contract.effectiveDeadline(change.proposal).toISOString() !== change.proposal.expiresAt) {
      // Commit the server policy correction, not the stale submitted response.
      // Returning409 after this transaction requires a fresh version/consent.
      transition = contract.enforceDeadline({ proposal: change.proposal, now }); deadlineAdjusted = true;
    }
    else if (action === 'decline') transition = contract.decline({ proposal: change.proposal, expectedRevision, actor: { role: actor.role, id: id(actor.id) }, now });
    else if (action === 'vendor_confirm') {
      if (!Number.isInteger(durationMinutes) || typeof start !== 'string') throw error('invalid_reschedule_duration');
      const proposedSlot = { start, end: new Date(new Date(start).getTime() + durationMinutes * 60000) };
      transition = contract.confirmVendorSlot({ proposal: change.proposal, expectedRevision, actor: { role: actor.role, id: id(actor.id) }, proposedSlot, now });
      const identityId = await calendar.canonicalId(preparation.identityId);
      await calendar.lockCalendar(identityId, session);
      await calendar.assertAvailable(identityId, new Date(transition.proposal.proposedSlot.start), new Date(transition.proposal.proposedSlot.end),
        { session, excludingAppointmentId: preparation.appointmentId });
    } else if (action === 'tenant_respond') {
      transition = contract.tenantResponse({ proposal: change.proposal, expectedRevision, actor: { role: actor.role, id: id(actor.id) }, slotKey, accepted, now });
      if (transition.proposal.status === 'ready_to_commit') {
        if (require('../../config/env').booking_confirmations_paused) throw error('booking_confirmation_paused');
        if (preparation.paymentMode === 'platform') {
          const Ledger = require('../../models/LandlordLedger');
          const ledger = await Ledger.findOne({ landlordId: preparation.landlordId }).session(session);
          if (!ledger || ledger.bankOwed > 0 || ledger.arrears > 0) throw error('funding_obligations_outstanding');
          await Ledger.updateOne({ _id: ledger._id }, { $set: { updatedAt: new Date() } }, { session });
        }
        const identityId = await calendar.canonicalId(preparation.identityId);
        await calendar.lockCalendar(identityId, session);
        let available = true;
        try { await calendar.assertAvailable(identityId, new Date(transition.proposal.proposedSlot.start), new Date(transition.proposal.proposedSlot.end), { session, excludingAppointmentId: preparation.appointmentId }); }
        catch (failure) { if (!['time_unavailable', 'calendar_needs_review'].includes(failure.code)) throw failure; available = false; }
        transition = contract.finalize({ proposal: transition.proposal, expectedRevision: transition.proposal.revision,
          originalSlot: { start: basis.appointment.confirmedStart, end: basis.appointment.confirmedEnd }, workAllowed: true, calendarAvailable: available, now });
        if (transition.effect) {
          const effect = transition.effect;
          await calendar.reserveVisit({ identityId, appointmentId: preparation.appointmentId, preparationId: preparation._id,
            start: new Date(effect.next.start), end: new Date(effect.next.end), session });
          const swapped = await Appointment.updateOne({ _id: preparation.appointmentId, landlordId: preparation.landlordId,
            requestId: preparation.requestId, status: 'scheduled', workMutationStartedAt: null,
            confirmedStart: new Date(effect.expectedOld.start), confirmedEnd: new Date(effect.expectedOld.end) }, { $set: {
            confirmedStart: new Date(effect.next.start), confirmedEnd: new Date(effect.next.end),
            'tenantConfirmation.accepted': true, 'tenantConfirmation.confirmedBy': 'tenant', 'tenantConfirmation.respondedAt': now,
            'vendorConfirmation.accepted': true, 'vendorConfirmation.respondedAt': new Date(transition.proposal.vendorResponse.at),
            vendorArrivalReminderSentAt: null,
          } }, { session });
          if (!swapped.matchedCount) throw error('work_already_started');
          await Preparation.updateOne({ _id: preparation._id, revision: preparation.revision }, { $set: {
            arrivalAt: new Date(effect.next.start), durationMinutes: (new Date(effect.next.end) - new Date(effect.next.start)) / 60000,
          }, $inc: { revision: 1 } }, { session });
          // The required transactional AgentActionLog below is the scheduling
          // event. A fake assigned lifecycle event mislabels this as a tenant
          // assigning a vendor. Keep the request-state write fence, not that row.
          const updatedRequest = await Request.updateOne({ _id: preparation.requestId, landlordId: preparation.landlordId, archivedAt: null,
            status: { $nin: ['completed', 'cancelled', 'rejected'] } }, { $set: { updatedAt: now } }, { session });
          if (!updatedRequest.matchedCount) throw error('request_changed');
        }
      }
    } else throw error('invalid_reschedule_action');
    const saved = await Changes.findOneAndUpdate({ _id: change._id, active: true, revision: expectedRevision },
      { $set: envelope(transition.proposal), ...(!deadlineAdjusted ? { $push: { receipts: receipt } } : {}) }, { session, new: true, lean: true });
    if (!saved) throw error();
    await queue(transition.proposal, session, change.revision); return { change: saved, duplicate: false, deadlineAdjusted };
  });
  await publish(prepared);
  if (result.deadlineAdjusted) throw error('reschedule_deadline_changed');
  return result;
}
async function sweep(now = new Date()) {
  const due = await Changes.find({ active: true, nextCheckAt: { $lte: now } }).sort({ nextCheckAt: 1 }).limit(20).lean();
  for (const record of due) {
    await mongoose.connection.transaction(async session => {
      const change = await Changes.findOne({ _id: record._id, active: true, revision: record.revision }).session(session).lean();
      if (!change) return;
      const preparation = await Preparation.findById(change.preparationId).session(session).lean();
      const basis = preparation ? await context(preparation, session) : null;
      const valid = basis?.allowed && basis.appointment.confirmedStart.toISOString() === change.proposal.oldSlot.start &&
        basis.appointment.confirmedEnd.toISOString() === change.proposal.oldSlot.end;
      const deadline = valid ? contract.enforceDeadline({ proposal: change.proposal, now }) : null;
      if (valid && deadline.proposal.revision === change.revision && change.expiresAt > now) {
        await Changes.updateOne({ _id: change._id, active: true, revision: change.revision }, { $set: { nextCheckAt: new Date(now.getTime() + 30000) } }, { session });
        return;
      }
      const transition = valid ? deadline : contract.invalidate({ proposal: change.proposal, now });
      await Changes.updateOne({ _id: change._id, active: true, revision: change.revision }, { $set: envelope(transition.proposal) }, { session });
      await queue(transition.proposal, session, change.revision);
    });
    const preparation = await Preparation.findById(record.preparationId).lean(); if (preparation) await publish(preparation);
  }
  return due.length;
}
async function view(preparation, audience) {
  const current = await context(preparation, null);
  const rows = await Changes.find({ preparationId: preparation._id, landlordId: preparation.landlordId }).sort({ createdAt: -1 }).limit(5).lean();
  const deliveries = await require('../../models/CoordinationNotice').find({ rescheduleId: { $in: rows.map(row => row._id) }, purpose: 'reschedule' })
    .select('rescheduleId revision audience status notificationCreatedAt').lean();
  const now = new Date();
  return rows.map(row => {
    const expiresAt = row.active ? contract.effectiveDeadline(row.proposal) : row.expiresAt;
    return ({ ref: id(row), revision: row.revision, status: row.status, active: row.active,
    reason: row.proposal.reason, original: row.proposal.oldSlot, proposed: row.proposal.proposedSlot,
    outsideSuggestedWindows: row.proposal.outsideSuggestedWindows === true,
    slotKey: row.proposal.slotKey, windows: row.proposal.windows, expiresAt,
    vendorResponse: row.proposal.vendorResponse.status, tenantResponse: row.proposal.tenantResponse.status,
    canVendorConfirm: current.allowed && audience === 'vendor' && row.active && row.proposal.rounds < 2 && expiresAt - now >= contract.MIN_RESPONSE_WINDOW_MS && ['awaiting_vendor', 'awaiting_tenant'].includes(row.status),
    canTenantRespond: current.allowed && audience === 'tenant' && row.active && expiresAt > now && row.status === 'awaiting_tenant',
    canDecline: current.allowed && row.active && expiresAt > now && ['landlord', 'vendor', 'tenant'].includes(audience),
    delivery: deliveries.filter(notice => id(notice.rescheduleId) === id(row) && notice.revision === row.revision)
      .map(notice => ({ audience: notice.audience, status: notice.status, inAppRecorded: Boolean(notice.notificationCreatedAt) })),
    events: row.proposal.events.map(event => ({ type: event.type, revision: event.revision, actor: event.actor.role, at: event.at,
      deadlineAt: event.deadlineAt, previousDeadlineAt: event.previousDeadlineAt, responseBufferMinutes: event.responseBufferMinutes,
      reason: event.reason, original: event.oldSlot, proposed: event.proposedSlot, vendorResponse: event.vendorResponse, tenantResponse: event.tenantResponse })),
  }); });
}
module.exports = { open, respond, sweep, view };
