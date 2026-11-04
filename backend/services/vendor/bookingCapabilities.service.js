// Presentation of owned current records, never a substitute for mutation-time
// transaction checks. Retained preparation.phase is not current work authority.
const id = value => String(value?._id || value || '');
const CLOSED = new Set(['completed', 'cancelled', 'rejected']);
function project({ preparation, request, appointment, completion, audience, rescheduleEnabled = false, now = new Date() }) {
  const result = (state, reasonCode, actions = {}) => ({ state, reasonCode,
    canConfirmInitial: false, canSuggestInitialAlternatives: false, canProposeInitialTime: false,
    canRequestReschedule: false, requiresRescheduleReason: audience === 'landlord', ...actions });
  if (!['landlord', 'tenant', 'vendor'].includes(audience) || !request || !preparation ||
      id(request) !== id(preparation.requestId) || id(request.landlordId) !== id(preparation.landlordId)) return result('unavailable', 'booking_context_unavailable');
  if (!preparation.active || request.archivedAt || CLOSED.has(request.status)) return result('closed', 'request_closed');
  if (!preparation.appointmentId) return result('unbooked', null, {
    canProposeInitialTime: audience === 'vendor' && ['awaiting_vendor', 'awaiting_tenant'].includes(preparation.phase) });
  if (!appointment || id(appointment) !== id(preparation.appointmentId) || id(appointment.requestId) !== id(request) ||
      id(appointment.landlordId) !== id(request.landlordId) || (completion &&
        (id(completion.appointmentId) !== id(appointment) || id(completion.requestId) !== id(request) || id(completion.landlordId) !== id(request.landlordId)))) return result('unavailable', 'booking_context_unavailable');
  if (['cancelled', 'failed', 'completed'].includes(appointment.status)) return result('closed', 'visit_closed');
  if (completion?.report?.submittedAt || ['awaiting_tenant', 'in_review', 'confirmed', 'closed', 'disputed'].includes(completion?.status) ||
      ['work_verifying', 'in_review', 'disputed'].includes(appointment.status)) return result('completion_submitted', 'work_already_started');
  if (completion?.checkIn != null || appointment.workMutationStartedAt) return result('work_started', 'work_already_started');
  if (completion && completion.status !== 'draft') return result('unavailable', 'work_state_unavailable');
  if (appointment.status === 'scheduled') {
    if (appointment.tenantConfirmation?.accepted !== true) return result('confirmation_unknown', 'tenant_confirmation_unavailable');
    if (!appointment.confirmedStart || !appointment.confirmedEnd || !Number.isFinite(new Date(appointment.confirmedStart).getTime()) ||
        !Number.isFinite(new Date(appointment.confirmedEnd).getTime())) return result('confirmation_unknown', 'confirmed_time_unavailable');
    const windowOpen = require('./bookingReschedule.contract').hasResponseWindow({ originalStart: appointment.confirmedStart, now });
    return result('confirmed', !rescheduleEnabled ? 'reschedule_protocol_not_ready' : windowOpen ? null : 'reschedule_response_window_closed', {
      canRequestReschedule: rescheduleEnabled === true && audience === 'landlord' && windowOpen });
  }
  if (!['proposed', 'awaiting_tenant'].includes(appointment.status)) return result('unavailable', 'booking_context_unavailable');
  const initial = preparation.phase === 'awaiting_tenant' && appointment.status === 'awaiting_tenant';
  return result('awaiting_confirmation', null, {
    canConfirmInitial: initial && audience !== 'vendor',
    canSuggestInitialAlternatives: initial && audience !== 'vendor',
    canProposeInitialTime: audience === 'vendor' && ['awaiting_vendor', 'awaiting_tenant'].includes(preparation.phase) });
}
function createLoader(models) {
  return async (preparation, audience, { rescheduleEnabled = false, now = new Date() } = {}) => {
    if (!preparation) return project({ audience });
    const request = await models.Request.findOne({ _id: preparation.requestId, landlordId: preparation.landlordId })
      .select('_id landlordId status archivedAt').lean();
    let appointment = null, completion = null;
    if (preparation.appointmentId && request) {
      [appointment, completion] = await Promise.all([
        models.Appointment.findOne({ _id: preparation.appointmentId, requestId: preparation.requestId, landlordId: preparation.landlordId })
          .select('_id requestId landlordId status tenantConfirmation.accepted confirmedStart confirmedEnd +workMutationStartedAt').lean(),
        models.Completion.findOne({ appointmentId: preparation.appointmentId, requestId: preparation.requestId, landlordId: preparation.landlordId })
          .select('appointmentId requestId landlordId status report.submittedAt checkIn').lean(),
      ]);
    }
    const result = project({ preparation, request, appointment, completion, audience, rescheduleEnabled, now });
    if (result.canRequestReschedule && models.Changes && await models.Changes.exists({ preparationId: preparation._id, landlordId: preparation.landlordId, active: true })) {
      result.canRequestReschedule = false; result.reasonCode = 'reschedule_already_pending';
    }
    return result;
  };
}
async function load(preparation, audience, options) {
  return createLoader({ Request: require('../../models/MaintenanceRequest'), Appointment: require('../../models/Appointment'),
    Completion: require('../../models/JobCompletion'), Changes: require('../../models/BookingReschedule') })(preparation, audience, options);
}
module.exports = { project, createLoader, load };
